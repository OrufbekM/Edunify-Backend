import { EventEmitter } from 'node:events';

import { QueryTypes, Transaction } from 'sequelize';
import type { Logger } from 'pino';
import { z } from 'zod';

import { sequelize } from '../../db/index.js';
import type { HomeworkType, JobStatus, SubmissionStatus } from '../../db/models/enums.js';
import { AiJob, FileRecord, Homework, Lesson } from '../../db/models/index.js';
import { AppError, notFoundAs } from '../../lib/errors.js';
import { logger } from '../../lib/logger.js';
import { storage } from '../../storage/index.js';
import { getOwnClass } from '../classes/service.js';
import { lockSubmission } from '../submissions/service.js';
import { fitForModel, MAX_BASE64_LENGTH, MAX_LONG_EDGE } from './images.js';
import type { Answer, GradingInput, Page } from './prompt.js';
import { aiConfigured, gradeWith, providersFor } from './providers.js';

// Contract 9: up to 3 submissions of a job at a time.
const PARALLEL = 3;

export interface AiJobDto {
  id: string;
  lessonId: string;
  status: JobStatus;
  total: number;
  completed: number;
  failed: number;
  error: string | null;
  createdAt: string;
  finishedAt: string | null;
}

function toJobDto(job: AiJob): AiJobDto {
  return {
    id: job.id,
    lessonId: job.lessonId,
    status: job.status,
    total: job.total,
    completed: job.completed,
    failed: job.failed,
    error: job.error,
    createdAt: job.createdAt.toISOString(),
    finishedAt: job.finishedAt?.toISOString() ?? null,
  };
}

function lessonNotFound(): AppError {
  return new AppError('NOT_FOUND', 'Lesson not found');
}

function jobNotFound(): AppError {
  return new AppError('NOT_FOUND', 'AI job not found');
}

// The worker listens here, so a new job starts right away instead of at the next poll.
const jobEvents = new EventEmitter();

export function onJobQueued(listener: () => void): () => void {
  jobEvents.on('queued', listener);
  return () => jobEvents.off('queued', listener);
}

// Latest versions only: grading, and so a suggestion, is for the latest version alone.
async function latestSubmissions(
  lessonId: string,
  transaction: Transaction,
): Promise<Array<{ id: string; status: SubmissionStatus }>> {
  return sequelize.query(
    `SELECT s.id, s.status
       FROM submissions s
       JOIN homeworks h ON h.id = s.homework_id
      WHERE h.lesson_id = $lessonId
        AND s.version = (SELECT max(v.version) FROM submissions v
                          WHERE v.homework_id = s.homework_id
                            AND v.class_student_id = s.class_student_id)
      ORDER BY s.created_at, s.id`,
    { bind: { lessonId }, type: QueryTypes.SELECT, transaction },
  );
}

// Given ids must each be the latest version of a submission in this lesson; a graded one
// may be asked for. Without ids: every latest version still waiting for a grade (contract
// 8.11 and 9).
function pickSubmissions(
  requested: string[] | undefined,
  latest: Array<{ id: string; status: SubmissionStatus }>,
): string[] {
  if (requested === undefined) {
    return latest.filter((submission) => submission.status === 'submitted').map(({ id }) => id);
  }

  const latestIds = new Set(latest.map(({ id }) => id));
  const outside = requested.flatMap((id, index) =>
    latestIds.has(id)
      ? []
      : [{ path: `submissionIds.${index}`, message: 'Not the latest version of a submission in this lesson' }],
  );

  if (outside.length > 0) {
    throw new AppError('VALIDATION_ERROR', 'Invalid request', outside);
  }

  return requested;
}

export async function startAiGrading(
  teacherId: string,
  lessonId: string,
  input: { submissionIds?: string[] },
): Promise<AiJobDto> {
  // Nothing configured at all: no need to look at the lesson.
  if (!aiConfigured()) {
    throw new AppError('AI_UNAVAILABLE');
  }

  const job = await sequelize.transaction(async (transaction) => {
    const found = await Lesson.findByPk(lessonId, { attributes: ['classId'], transaction });

    if (!found) {
      throw lessonNotFound();
    }

    await notFoundAs(getOwnClass(teacherId, found.classId, transaction), lessonNotFound);

    // The check for an active job and the insert happen under this lock, so a double click
    // can't start two jobs (plan, Phase 10).
    const lesson = await Lesson.findByPk(lessonId, {
      attributes: ['id'],
      lock: Transaction.LOCK.NO_KEY_UPDATE,
      transaction,
    });

    if (!lesson) {
      throw lessonNotFound();
    }

    // Text and page homework can go to different providers; this one may have none.
    const homework = await Homework.findOne({ attributes: ['type'], where: { lessonId }, transaction });

    if (homework && providersFor(homework.type).length === 0) {
      throw new AppError('AI_UNAVAILABLE');
    }

    const active = await AiJob.findOne({
      attributes: ['id'],
      where: { lessonId, status: ['queued', 'running'] },
      transaction,
    });

    if (active) {
      throw new AppError('AI_JOB_ACTIVE', undefined, { jobId: active.id });
    }

    const submissionIds = pickSubmissions(
      input.submissionIds,
      await latestSubmissions(lessonId, transaction),
    );

    if (submissionIds.length === 0) {
      throw new AppError('VALIDATION_ERROR', 'Invalid request', [{ path: '', message: 'Nothing to grade' }]);
    }

    return AiJob.create(
      {
        lessonId,
        createdBy: teacherId,
        status: 'queued',
        submissionIds,
        total: submissionIds.length,
        error: null,
        finishedAt: null,
      },
      { transaction },
    );
  });

  jobEvents.emit('queued');
  return toJobDto(job);
}

// The teacher of the lesson's class only (contract 8.11).
export async function getAiJob(teacherId: string, jobId: string): Promise<AiJobDto> {
  const job = await AiJob.findByPk(jobId);
  const lesson = job && (await Lesson.findByPk(job.lessonId, { attributes: ['classId'] }));

  if (!job || !lesson) {
    throw jobNotFound();
  }

  await notFoundAs(getOwnClass(teacherId, lesson.classId), jobNotFound);
  return toJobDto(job);
}

// Contract 9: on server start, jobs left running go back to queued.
export async function requeueRunningJobs(): Promise<number> {
  const [count] = await AiJob.update({ status: 'queued' }, { where: { status: 'running' } });
  return count;
}

// The oldest queued job. SKIP LOCKED: two workers never claim one job and never wait for
// each other. A job that runs again starts its counters from zero (plan, Phase 10).
async function claimJob(): Promise<{ id: string; lessonId: string; submissionIds: string[] } | null> {
  const [job] = await sequelize.query<{ id: string; lessonId: string; submissionIds: string[] }>(
    `UPDATE ai_jobs
        SET status = 'running', completed = 0, failed = 0, updated_at = now()
      WHERE id = (SELECT id FROM ai_jobs
                   WHERE status = 'queued'
                   ORDER BY created_at, id
                   LIMIT 1
                     FOR UPDATE SKIP LOCKED)
      RETURNING id, lesson_id AS "lessonId", submission_ids AS "submissionIds"`,
    { type: QueryTypes.SELECT },
  );

  return job ?? null;
}

// Counted as each submission finishes, so polling shows progress (contract 9). A job whose
// lesson was deleted is gone, and so are its submissions: the rest are skipped without a
// request, and these updates find no row.
async function countItem(jobId: string, succeeded: boolean): Promise<void> {
  const counter = succeeded ? 'completed' : 'failed';

  await sequelize.query(
    `UPDATE ai_jobs SET ${counter} = ${counter} + 1, updated_at = now()
      WHERE id = $jobId AND status = 'running'`,
    { bind: { jobId } },
  );
}

async function finishJob(jobId: string, status: 'done' | 'failed', error: string | null): Promise<void> {
  await sequelize.query(
    `UPDATE ai_jobs SET status = $status, error = $error, finished_at = now(), updated_at = now()
      WHERE id = $jobId AND status = 'running'`,
    { bind: { jobId, status, error } },
  );
}

const storedText = z.object({ text: z.string() });
const storedCode = z.object({ html: z.string(), css: z.string(), js: z.string() });

// Markdown only: PDFs are never sent to the model (contract 9).
async function markdownOf(fileId: string | null): Promise<string | null> {
  const file = fileId ? await FileRecord.findByPk(fileId) : null;

  return file?.mime === 'text/markdown' ? (await storage.get(file.storageKey)).toString('utf8') : null;
}

// Images in one request, base64-encoded, in total: under Gemini's 20 MB request limit, the
// strictest of the three (Claude takes 32 MB, OpenAI 50 MB). Each page also stays within
// Claude's 10 MB per image.
const REQUEST_IMAGE_BUDGET = 18_000_000;

export function pageBudget(pageCount: number): number {
  return Math.min(MAX_BASE64_LENGTH, Math.floor(REQUEST_IMAGE_BUDGET / Math.max(1, pageCount)));
}

async function pagesOf(submissionId: string): Promise<Page[]> {
  const files = await sequelize.query<{ mime: Page['mime']; storageKey: string }>(
    `SELECT f.mime, f.storage_key AS "storageKey"
       FROM submission_pages sp
       JOIN files f ON f.id = sp.file_id
      WHERE sp.submission_id = $submissionId
      ORDER BY sp.position`,
    { bind: { submissionId }, type: QueryTypes.SELECT },
  );

  // One page at a time, so a submission holds at most one full-size original in memory. All
  // pages share one request, so each gets a share of a budget every provider accepts.
  const limits = { maxLongEdge: MAX_LONG_EDGE, maxBase64Length: pageBudget(files.length) };
  const pages: Page[] = [];

  for (const file of files) {
    pages.push(await fitForModel({ mime: file.mime, data: await storage.get(file.storageKey) }, limits));
  }

  return pages;
}

// What the model sees for one submission, or null when it is gone or no longer the latest
// version, which skips it without a request (plan, Phase 10).
async function gradingInput(submissionId: string): Promise<GradingInput | null> {
  const [row] = await sequelize.query<{
    content: unknown;
    type: HomeworkType;
    instructionsText: string | null;
    instructionsFileId: string | null;
    lessonFileId: string | null;
    isLatest: boolean;
  }>(
    `SELECT s.content,
            h.type,
            h.instructions_text AS "instructionsText",
            h.instructions_file_id AS "instructionsFileId",
            l.lesson_file_id AS "lessonFileId",
            s.version = (SELECT max(v.version) FROM submissions v
                          WHERE v.homework_id = s.homework_id
                            AND v.class_student_id = s.class_student_id) AS "isLatest"
       FROM submissions s
       JOIN homeworks h ON h.id = s.homework_id
       JOIN lessons l ON l.id = h.lesson_id
      WHERE s.id = $submissionId`,
    { bind: { submissionId }, type: QueryTypes.SELECT },
  );

  if (!row?.isLatest) {
    return null;
  }

  let answer: Answer;

  switch (row.type) {
    case 'text':
      answer = { type: 'text', ...storedText.parse(row.content) };
      break;
    case 'code':
      answer = { type: 'code', ...storedCode.parse(row.content) };
      break;
    default:
      answer = { type: row.type, pages: await pagesOf(submissionId) };
  }

  return {
    lessonMarkdown: await markdownOf(row.lessonFileId),
    instructionsText: row.instructionsText,
    instructionsMarkdown: await markdownOf(row.instructionsFileId),
    answer,
  };
}

// Stored only on a submission that is still there and still the latest, under the locks a
// new version takes. Never touches status or the grade (contract 9), and `silent` leaves
// updatedAt alone: nothing about the submission changes for the student.
async function storeSuggestion(
  submissionId: string,
  suggestion: { value: number; comment: string; createdAt: string },
): Promise<boolean> {
  return sequelize.transaction(async (transaction) => {
    const locked = await lockSubmission(submissionId, transaction);

    if (!locked?.isLatest) {
      return false;
    }

    await locked.submission.update({ aiSuggestion: suggestion }, { transaction, silent: true });
    return true;
  });
}

// True when a suggestion was stored. The homework type's provider is tried first, then the
// fallback (contract 9, extended). Anything else (the submission gone or replaced, every
// provider failing: an API error, a refusal, output off the schema) counts the submission
// as failed, and the job carries on.
async function gradeOne(submissionId: string, log: Logger): Promise<boolean> {
  try {
    const input = await gradingInput(submissionId);

    if (!input) {
      log.info({ submissionId }, 'AI grading skipped a submission that is gone or not the latest');
      return false;
    }

    for (const provider of providersFor(input.answer.type)) {
      const outcome = await gradeWith(provider, input);

      if (!outcome.ok) {
        log.warn({ submissionId, provider, reason: outcome.reason }, 'AI grading attempt failed');
        continue;
      }

      const stored = await storeSuggestion(submissionId, {
        value: outcome.value,
        comment: outcome.comment,
        createdAt: new Date().toISOString(),
      });

      if (stored) {
        log.info({ submissionId, provider }, 'AI suggestion stored');
      } else {
        log.info({ submissionId }, 'AI suggestion dropped: the submission is gone or was replaced');
      }

      return stored;
    }

    return false;
  } catch (err) {
    log.error({ err, submissionId }, 'AI grading of a submission failed');
    return false;
  }
}

async function eachLimited<T>(items: T[], limit: number, work: (item: T) => Promise<void>): Promise<void> {
  let next = 0;

  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const item = items[next] as T;
        next += 1;
        await work(item);
      }
    }),
  );
}

// Done once every submission was processed, failures included; failed only when the job
// itself couldn't run, with `error` set. finished_at is set either way (contract 9).
async function runJob(job: { id: string; lessonId: string; submissionIds: string[] }): Promise<void> {
  const log = logger.child({ aiJobId: job.id });

  try {
    // Keys can change between queueing and running (a restart with a new .env). A deleted
    // homework leaves each submission to fail on its own.
    const homework = await Homework.findOne({ attributes: ['type'], where: { lessonId: job.lessonId } });

    if (homework && providersFor(homework.type).length === 0) {
      await finishJob(job.id, 'failed', 'AI grading is not configured');
      return;
    }

    await eachLimited(job.submissionIds, PARALLEL, async (submissionId) => {
      await countItem(job.id, await gradeOne(submissionId, log));
    });

    await finishJob(job.id, 'done', null);
  } catch (err) {
    log.error({ err }, 'AI job could not run');
    await finishJob(job.id, 'failed', 'The job stopped because of a server error');
  }
}

// Claims and runs the oldest queued job; false when there was none to claim.
export async function runNextJob(): Promise<boolean> {
  const job = await claimJob();

  if (!job) {
    return false;
  }

  await runJob(job);
  return true;
}
