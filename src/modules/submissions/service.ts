import { QueryTypes, Transaction } from 'sequelize';
import { z } from 'zod';

import { sequelize } from '../../db/index.js';
import type {
  GradeSource,
  HomeworkType,
  Role,
  SubmissionStatus,
} from '../../db/models/enums.js';
import {
  ClassStudent,
  Homework,
  Lesson,
  SchoolClass,
  Submission,
  SubmissionPage,
} from '../../db/models/index.js';
import { AppError, notFoundAs } from '../../lib/errors.js';
import { toFileRef, type FileRef } from '../../lib/signedUrl.js';
import type { Upload } from '../../middleware/upload.js';
import { getOwnClass } from '../classes/service.js';
import { createFileRecord, withStoredFiles } from '../files/service.js';
import { notify, removeUnread } from '../notifications/service.js';
import { getActiveClassStudent } from '../students/service.js';

const VERSION_CAP = 30;

// Contract section 3.
export type Grade = 2 | 3 | 4 | 5;
export type PageType = 'draw' | 'math' | 'photo';

export type NewSubmissionContent =
  | { type: 'text'; text: string }
  | { type: 'code'; html: string; css: string; js: string }
  | { type: PageType; pages: Upload[] };

export type SubmissionContentDto =
  | { type: 'text'; text: string }
  | { type: 'code'; html: string; css: string; js: string }
  | { type: PageType; pages: FileRef[] };

export interface GradeInfoDto {
  value: Grade | null;
  denied: boolean;
  comment: string | null;
  source: GradeSource;
  gradedAt: string;
}

export interface AiSuggestionDto {
  value: Grade;
  comment: string;
  createdAt: string;
}

export interface SubmissionDto {
  id: string;
  homeworkId: string;
  lessonId: string;
  classId: string;
  classStudentId: string;
  version: number;
  isLatest: boolean;
  status: SubmissionStatus;
  content: SubmissionContentDto;
  grade: GradeInfoDto | null;
  aiSuggestion?: AiSuggestionDto | null;
  createdAt: string;
  updatedAt: string;
}

export interface SubmissionVersionDto {
  id: string;
  version: number;
  status: SubmissionStatus;
  grade: { value: Grade | null; denied: boolean } | null;
  createdAt: string;
}

export interface StudentSubmissionItemDto {
  submission: SubmissionDto;
  lesson: { id: string; title: string };
  class: { id: string; subject: string; name: string | null };
}

interface SubmissionRow {
  id: string;
  homeworkId: string;
  classStudentId: string;
  version: number;
  status: SubmissionStatus;
  content: unknown;
  gradeValue: number | null;
  gradeDenied: boolean;
  gradeComment: string | null;
  gradeSource: GradeSource | null;
  gradedAt: Date | null;
  aiSuggestion: unknown;
  createdAt: Date;
  updatedAt: Date;
  homeworkType: HomeworkType;
  lessonId: string;
  classId: string;
  isLatest: boolean;
}

// isLatest is computed, never stored (plan, Phase 8).
const SELECT_SUBMISSIONS = `
  SELECT s.id,
         s.homework_id AS "homeworkId",
         s.class_student_id AS "classStudentId",
         s.version,
         s.status,
         s.content,
         s.grade_value AS "gradeValue",
         s.grade_denied AS "gradeDenied",
         s.grade_comment AS "gradeComment",
         s.grade_source AS "gradeSource",
         s.graded_at AS "gradedAt",
         s.ai_suggestion AS "aiSuggestion",
         s.created_at AS "createdAt",
         s.updated_at AS "updatedAt",
         h.type AS "homeworkType",
         h.lesson_id AS "lessonId",
         l.class_id AS "classId",
         s.version = (SELECT max(v.version) FROM submissions v
                       WHERE v.homework_id = s.homework_id
                         AND v.class_student_id = s.class_student_id) AS "isLatest"
    FROM submissions s
    JOIN homeworks h ON h.id = s.homework_id
    JOIN lessons l ON l.id = h.lesson_id`;

async function submissionRows(
  where: string,
  bind: Record<string, unknown>,
  transaction?: Transaction,
): Promise<SubmissionRow[]> {
  return sequelize.query<SubmissionRow>(`${SELECT_SUBMISSIONS} ${where}`, {
    bind,
    type: QueryTypes.SELECT,
    transaction,
  });
}

// What the database holds for each kind of content; pages live in submission_pages.
const storedText = z.object({ text: z.string() });
const storedCode = z.object({ html: z.string(), css: z.string(), js: z.string() });
const storedAiSuggestion = z
  .object({
    value: z.union([z.literal(2), z.literal(3), z.literal(4), z.literal(5)]),
    comment: z.string(),
    createdAt: z.string(),
  })
  .nullable();

function contentToStore(content: NewSubmissionContent): object | null {
  switch (content.type) {
    case 'text':
      return { text: content.text };
    case 'code':
      return { html: content.html, css: content.css, js: content.js };
    default:
      return null;
  }
}

function contentOf(row: SubmissionRow, pages: Map<string, FileRef[]>): SubmissionContentDto {
  switch (row.homeworkType) {
    case 'text':
      return { type: 'text', ...storedText.parse(row.content) };
    case 'code':
      return { type: 'code', ...storedCode.parse(row.content) };
    default:
      return { type: row.homeworkType, pages: pages.get(row.id) ?? [] };
  }
}

function isGraded(row: { gradeValue: number | null; gradeDenied: boolean }): boolean {
  return row.gradeValue !== null || row.gradeDenied;
}

function gradeOf(row: SubmissionRow): GradeInfoDto | null {
  if (!isGraded(row)) {
    return null;
  }

  if (row.gradeSource === null || row.gradedAt === null) {
    throw new Error(`Submission ${row.id} has a grade without its source or time`);
  }

  return {
    value: row.gradeValue as Grade | null,
    denied: row.gradeDenied,
    comment: row.gradeComment,
    source: row.gradeSource,
    gradedAt: row.gradedAt.toISOString(),
  };
}

async function pagesBySubmission(
  submissionIds: string[],
  transaction?: Transaction,
): Promise<Map<string, FileRef[]>> {
  const pages = new Map<string, FileRef[]>();

  if (submissionIds.length === 0) {
    return pages;
  }

  const rows = await sequelize.query<{
    submissionId: string;
    id: string;
    originalName: string;
    mime: string;
    size: number;
  }>(
    `SELECT sp.submission_id AS "submissionId", f.id, f.original_name AS "originalName",
            f.mime, f.size
       FROM submission_pages sp
       JOIN files f ON f.id = sp.file_id
      WHERE sp.submission_id = ANY($submissionIds::uuid[])
      ORDER BY sp.submission_id, sp.position`,
    { bind: { submissionIds }, type: QueryTypes.SELECT, transaction },
  );

  for (const { submissionId, ...file } of rows) {
    pages.set(submissionId, [...(pages.get(submissionId) ?? []), toFileRef(file)]);
  }

  return pages;
}

// Built from the caller's role, so aiSuggestion can't reach a student by accident: their
// responses don't have the key at all (contract 3 and 9).
async function toDtos(
  rows: SubmissionRow[],
  role: Role,
  transaction?: Transaction,
): Promise<SubmissionDto[]> {
  const pages = await pagesBySubmission(
    rows.filter((row) => isPageType(row.homeworkType)).map((row) => row.id),
    transaction,
  );

  return rows.map((row) => {
    const dto: SubmissionDto = {
      id: row.id,
      homeworkId: row.homeworkId,
      lessonId: row.lessonId,
      classId: row.classId,
      classStudentId: row.classStudentId,
      version: row.version,
      isLatest: row.isLatest,
      status: row.status,
      content: contentOf(row, pages),
      grade: gradeOf(row),
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };

    return role === 'teacher'
      ? { ...dto, aiSuggestion: storedAiSuggestion.parse(row.aiSuggestion ?? null) }
      : dto;
  });
}

// For changes to an existing submission (a grade, an AI suggestion): the locks a new
// version takes, in its order (homework FOR SHARE, then the roster row), so the change and
// a new version go one after the other and "latest" is judged on what has committed. A
// delete of the homework, lesson, unit, class or row waits for these locks or has already
// happened; then the submission is gone and this returns null.
export async function lockSubmission(
  submissionId: string,
  transaction: Transaction,
): Promise<{ submission: Submission; row: ClassStudent; isLatest: boolean } | null> {
  const found = await Submission.findByPk(submissionId, {
    attributes: ['homeworkId', 'classStudentId'],
    transaction,
  });
  const homework =
    found &&
    (await Homework.findByPk(found.homeworkId, { lock: Transaction.LOCK.SHARE, transaction }));
  const row =
    homework &&
    (await ClassStudent.findByPk(found.classStudentId, {
      lock: Transaction.LOCK.NO_KEY_UPDATE,
      transaction,
    }));
  const submission = row && (await Submission.findByPk(submissionId, { transaction }));

  if (!row || !submission) {
    return null;
  }

  const latest = await Submission.max<number, Submission>('version', {
    where: { homeworkId: submission.homeworkId, classStudentId: submission.classStudentId },
    transaction,
  });

  return { submission, row, isLatest: submission.version === latest };
}

// For other modules: the submissions with these ids, keyed by id, built for the role.
export async function submissionDtosById(
  ids: string[],
  role: Role,
  transaction?: Transaction,
): Promise<Map<string, SubmissionDto>> {
  if (ids.length === 0) {
    return new Map();
  }

  const rows = await submissionRows('WHERE s.id = ANY($ids::uuid[])', { ids }, transaction);

  return new Map((await toDtos(rows, role, transaction)).map((dto) => [dto.id, dto]));
}

function toVersionDto(submission: Submission): SubmissionVersionDto {
  return {
    id: submission.id,
    version: submission.version,
    status: submission.status,
    grade: isGraded(submission)
      ? { value: submission.gradeValue as Grade | null, denied: submission.gradeDenied }
      : null,
    createdAt: submission.createdAt.toISOString(),
  };
}

function homeworkNotFound(): AppError {
  return new AppError('NOT_FOUND', 'Homework not found');
}

function submissionNotFound(): AppError {
  return new AppError('NOT_FOUND', 'Submission not found');
}

function isPageType(type: HomeworkType): type is PageType {
  return type === 'draw' || type === 'math' || type === 'photo';
}

async function classIdOf(homework: Homework, transaction?: Transaction): Promise<string> {
  const lesson = await Lesson.findByPk(homework.lessonId, { attributes: ['classId'], transaction });

  if (!lesson) {
    throw homeworkNotFound();
  }

  return lesson.classId;
}

// For the route to call before multer reads a body (plan, Phase 8): the homework exists and
// the caller has an active link to its class. Returns the type, which picks the body.
export async function assertCanSubmit(userId: string, homeworkId: string): Promise<HomeworkType> {
  const homework = await Homework.findByPk(homeworkId, { attributes: ['lessonId', 'type'] });

  if (!homework) {
    throw homeworkNotFound();
  }

  await notFoundAs(getActiveClassStudent(userId, await classIdOf(homework)), homeworkNotFound);

  return homework.type;
}

// One transaction (plan, Phase 8). Locks the homework FOR SHARE first: a type change and
// every delete that collects this homework's files take FOR UPDATE on it, so they and this
// submission go one after the other. Then the roster row, which numbers this student's
// versions one at a time and keeps a re-link or unlink from slipping past the link check.
export async function createSubmission(
  userId: string,
  homeworkId: string,
  content: NewSubmissionContent,
): Promise<SubmissionDto> {
  const pages = 'pages' in content ? content.pages : [];

  return withStoredFiles(
    pages.map((page) => page.data),
    (storageKeys) =>
      sequelize.transaction(async (transaction) => {
        const homework = await Homework.findByPk(homeworkId, {
          lock: Transaction.LOCK.SHARE,
          transaction,
        });

        if (!homework) {
          throw homeworkNotFound();
        }

        // Only while it had no submissions could the teacher have changed the type since the
        // body was read.
        if (homework.type !== content.type) {
          throw new AppError('VALIDATION_ERROR', 'Content does not match the homework type', [
            { path: '', message: `This homework takes ${homework.type} submissions` },
          ]);
        }

        const classId = await classIdOf(homework, transaction);
        const row: ClassStudent = await notFoundAs(
          getActiveClassStudent(userId, classId, transaction, { lock: true }),
          homeworkNotFound,
        );
        const previous = await Submission.findOne({
          where: { homeworkId, classStudentId: row.id },
          order: [['version', 'DESC']],
          transaction,
        });
        const version = (previous?.version ?? 0) + 1;

        if (version > VERSION_CAP) {
          throw new AppError('LIMIT_REACHED', `At most ${VERSION_CAP} versions of one homework`);
        }

        const submission = await Submission.create(
          {
            homeworkId,
            classStudentId: row.id,
            version,
            status: 'submitted',
            content: contentToStore(content),
            gradeValue: null,
            gradeComment: null,
            gradeSource: null,
            gradedAt: null,
            aiSuggestion: null,
          },
          { transaction },
        );

        for (const [position, page] of pages.entries()) {
          const file = await createFileRecord(
            userId,
            'page',
            page,
            storageKeys[position] as string,
            transaction,
          );
          await SubmissionPage.create(
            { submissionId: submission.id, position, fileId: file.id },
            { transaction },
          );
        }

        const { teacherId } = (await SchoolClass.findByPk(classId, {
          attributes: ['teacherId'],
          transaction,
        })) as SchoolClass;

        if (previous) {
          // An AI suggestion for the old version no longer fits (plan, Phase 8), and the new
          // version's notice replaces the teacher's unread one for it (plan, open item 6).
          if (previous.aiSuggestion !== null) {
            await previous.update({ aiSuggestion: null }, { transaction });
          }
          await removeUnread(teacherId, previous.id, transaction);
        }

        await notify(teacherId, submission.id, 'submitted', transaction);

        const [dto] = await toDtos(
          await submissionRows('WHERE s.id = $id', { id: submission.id }, transaction),
          'student',
          transaction,
        );
        return dto as SubmissionDto;
      }),
  );
}

// Teacher: a submission in an own class. Student: one of their own roster row's, while the
// link is active (contract 5).
export async function getSubmission(
  viewer: { id: string; role: Role },
  submissionId: string,
): Promise<SubmissionDto & { versions: SubmissionVersionDto[] }> {
  const [row] = await submissionRows('WHERE s.id = $id', { id: submissionId });

  if (!row) {
    throw submissionNotFound();
  }

  if (viewer.role === 'teacher') {
    await notFoundAs(getOwnClass(viewer.id, row.classId), submissionNotFound);
  } else {
    const own = await notFoundAs(getActiveClassStudent(viewer.id, row.classId), submissionNotFound);

    if (own.id !== row.classStudentId) {
      throw submissionNotFound();
    }
  }

  const [dto] = await toDtos([row], viewer.role);
  const versions = await Submission.findAll({
    where: { homeworkId: row.homeworkId, classStudentId: row.classStudentId },
    order: [['version', 'DESC']],
  });

  return { ...(dto as SubmissionDto), versions: versions.map(toVersionDto) };
}

// The latest version per homework, newest first, from active links only (contract 8.8).
export async function listMySubmissions(
  userId: string,
  filter: { classId?: string },
): Promise<StudentSubmissionItemDto[]> {
  const items = await sequelize.query<{
    submissionId: string;
    lessonId: string;
    lessonTitle: string;
    classId: string;
    classSubject: string;
    className: string | null;
  }>(
    `SELECT s.id AS "submissionId",
            l.id AS "lessonId",
            l.title AS "lessonTitle",
            c.id AS "classId",
            c.subject AS "classSubject",
            c.name AS "className"
       FROM submissions s
       JOIN class_students cs ON cs.id = s.class_student_id
       JOIN homeworks h ON h.id = s.homework_id
       JOIN lessons l ON l.id = h.lesson_id
       JOIN classes c ON c.id = l.class_id
      WHERE cs.student_user_id = $userId
        ${filter.classId ? 'AND cs.class_id = $classId' : ''}
        AND EXISTS (SELECT 1 FROM class_claims cc
                     WHERE cc.student_user_id = cs.student_user_id
                       AND cc.class_id = cs.class_id)
        AND s.version = (SELECT max(v.version) FROM submissions v
                          WHERE v.homework_id = s.homework_id
                            AND v.class_student_id = s.class_student_id)
      ORDER BY s.created_at DESC, s.id DESC`,
    {
      bind: filter.classId ? { userId, classId: filter.classId } : { userId },
      type: QueryTypes.SELECT,
    },
  );

  if (items.length === 0) {
    return [];
  }

  const dtos = await submissionDtosById(
    items.map((item) => item.submissionId),
    'student',
  );

  return items.map((item) => ({
    submission: dtos.get(item.submissionId) as SubmissionDto,
    lesson: { id: item.lessonId, title: item.lessonTitle },
    class: { id: item.classId, subject: item.classSubject, name: item.className },
  }));
}

// A student's latest version for LessonDetail.mySubmission, or null (contract 8.6). The
// caller has already checked the link.
export async function latestSubmissionOf(
  classStudentId: string,
  homeworkId: string,
): Promise<SubmissionDto | null> {
  const rows = await submissionRows(
    `WHERE s.homework_id = $homeworkId AND s.class_student_id = $classStudentId
     ORDER BY s.version DESC
     LIMIT 1`,
    { homeworkId, classStudentId },
  );
  const [dto] = await toDtos(rows, 'student');

  return dto ?? null;
}
