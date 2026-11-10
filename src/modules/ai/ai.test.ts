import { randomUUID } from 'node:crypto';

import request from 'supertest';
import { Transaction } from 'sequelize';
import sharp from 'sharp';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { app } from '../../app.js';
import { env } from '../../config/env.js';
import { sequelize } from '../../db/index.js';
import { AiJob, Lesson, Submission } from '../../db/models/index.js';
import { startAiWorker } from '../../jobs/aiWorker.js';
import { resetRateLimits } from '../../middleware/rateLimit.js';
import { useTestDatabase } from '../../test/database.js';
import { getFile, waitUntilBlocked } from '../../test/files.js';
import { api, createTestUser, type TestUser } from '../../test/users.js';
import { model, type ModelRequest, type ModelResponse } from './model.js';
import { SYSTEM_PROMPT } from './prompt.js';
import { onJobQueued, requeueRunningJobs, runNextJob } from './service.js';

useTestDatabase();

const ISO_MILLIS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
// Real images: the worker decodes each page to check that it fits the model's limits.
const blank = (width: number, height: number) =>
  sharp({ create: { width, height, channels: 3, background: '#ffffff' } });
const PNG = await blank(4, 3).png().toBuffer();
const JPEG = await blank(4, 3).jpeg().toBuffer();
const WEBP = await blank(4, 3).webp().toBuffer();
const PDF = Buffer.from('%PDF-1.4\nsecret pdf body\n%%EOF\n');

const realKey = env.ANTHROPIC_API_KEY;
const realModel = env.AI_MODEL;

let teacher: TestUser;
let student: TestUser;
let schoolClass: { id: string; publicId: string };
let lessonId: string;
let homeworkId: string;

beforeEach(async () => {
  await resetRateLimits();
  env.ANTHROPIC_API_KEY = 'test-key';
  teacher = await createTestUser('teacher');
  student = await createTestUser('student');
  schoolClass = await createClass(teacher);
  await link(student, 'Ali Valiyev');
  ({ lessonId, homeworkId } = await addHomework('text', { instructionsText: 'Solve x + 2 = 5' }));
});

afterEach(() => {
  env.ANTHROPIC_API_KEY = realKey;
  env.AI_MODEL = realModel;
  vi.restoreAllMocks();
});

async function createClass(owner: TestUser) {
  const category = await api(owner).post('/api/v1/categories', { name: `C ${randomUUID()}` });
  return (await api(owner).post('/api/v1/classes', { categoryId: category.body.id, subject: 'Maths', name: null }))
    .body as { id: string; publicId: string };
}

async function link(account: TestUser, fullName: string): Promise<string> {
  const row = await api(teacher).post(`/api/v1/classes/${schoolClass.id}/students`, {
    fullName,
    studentPublicId: account.publicId,
  });
  await api(account).post('/api/v1/student/claims', { classPublicId: schoolClass.publicId });
  return row.body.id as string;
}

async function addStudent(fullName: string): Promise<TestUser> {
  const account = await createTestUser('student');
  await link(account, fullName);
  return account;
}

async function addHomework(type: string, options: { instructionsText?: string; title?: string } = {}) {
  const lesson = (await api(teacher).post(`/api/v1/classes/${schoolClass.id}/lessons`, { title: options.title ?? 'Equations' }))
    .body.id as string;
  const res = await api(teacher).put(`/api/v1/lessons/${lesson}/homework`, {
    type,
    ...(options.instructionsText ? { instructionsText: options.instructionsText } : {}),
  });
  return { lessonId: lesson, homeworkId: res.body.homework.id as string };
}

async function submitText(text: string, user = student, forHomework = homeworkId): Promise<string> {
  const res = await api(user).post(`/api/v1/homeworks/${forHomework}/submissions`, { text });
  expect(res.status).toBe(201);
  return res.body.id as string;
}

async function grade(submissionId: string, body: object = { value: 5 }): Promise<void> {
  expect((await api(teacher).put(`/api/v1/submissions/${submissionId}/grade`, body)).status).toBe(200);
}

const aiGradePath = (forLesson = lessonId) => `/api/v1/lessons/${forLesson}/ai-grade`;

function startJob(body?: object, forLesson = lessonId, user = teacher) {
  const pending = request(app).post(aiGradePath(forLesson)).set('Authorization', `Bearer ${user.token}`);
  return body === undefined ? pending : pending.send(body);
}

function expectError(res: request.Response, status: number, code: string): void {
  expect(res.status).toBe(status);
  expect(res.body.error.code).toBe(code);
}

function detailPaths(res: request.Response): string[] {
  return res.body.error.details.map((detail: { path: string }) => detail.path);
}

function reply(output: unknown, stopReason = 'end_turn'): ModelResponse {
  return {
    id: 'msg_test',
    type: 'message',
    role: 'assistant',
    model: 'test-model',
    stop_reason: stopReason,
    stop_sequence: null,
    content: [
      { type: 'thinking', thinking: '', signature: 'sig' },
      { type: 'text', text: typeof output === 'string' ? output : JSON.stringify(output) },
    ],
    usage: { input_tokens: 1, output_tokens: 1 },
  } as unknown as ModelResponse;
}

function stubModel(answer: (request: ModelRequest) => ModelResponse | Promise<ModelResponse>) {
  return vi.spyOn(model, 'send').mockImplementation(async (request) => answer(request));
}

type Block = { type: string; text?: string; source?: { media_type: string; data: string } };

function blocksOf(sent: ModelRequest): Block[] {
  const [message] = sent.messages;
  return message?.content as Block[];
}

function textOf(sent: ModelRequest): string {
  return blocksOf(sent)
    .flatMap((block) => (block.type === 'text' ? [block.text] : []))
    .join('\n');
}

function holdOpen(work: (transaction: Transaction) => Promise<unknown>) {
  return sequelize.transaction().then(async (transaction) => {
    try {
      await work(transaction);
      return transaction;
    } catch (err) {
      await transaction.rollback();
      throw err;
    }
  });
}

async function until(check: () => Promise<boolean>): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (await check()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error('timed out');
}

async function jobRow(id: string) {
  return (await AiJob.findByPk(id)) as AiJob;
}

describe('POST /lessons/:lessonId/ai-grade', () => {
  it('queues every latest version still waiting for a grade, and nothing graded or older', async () => {
    const [bek, cora, dan] = [await addStudent('Bek'), await addStudent('Cora'), await addStudent('Dan')];
    await submitText('first');
    const latest = await submitText('second');
    await grade(await submitText('graded', bek));
    await grade(await submitText('denied', cora), { denied: true, comment: 'Redo' });
    const waiting = await submitText('waiting', dan);

    const res = await startJob();

    expect(res.status).toBe(202);
    expect(res.body).toEqual({
      id: expect.any(String),
      lessonId,
      status: 'queued',
      total: 2,
      completed: 0,
      failed: 0,
      error: null,
      createdAt: expect.stringMatching(ISO_MILLIS),
      finishedAt: null,
    });
    expect((await jobRow(res.body.id)).submissionIds).toEqual([latest, waiting]);
  });

  it('takes given ids, a graded one included, and also an empty body', async () => {
    const graded = await submitText('answer');
    await grade(graded);

    const res = await startJob({ submissionIds: [graded.toUpperCase()] });

    expect(res.status).toBe(202);
    expect((await jobRow(res.body.id)).submissionIds).toEqual([graded]);
    await AiJob.destroy({ where: {} });

    const empty = await startJob(undefined);
    expectError(empty, 400, 'VALIDATION_ERROR');
    expect(detailPaths(empty)).toEqual(['']);
  });

  it('refuses ids that are not the latest version of a submission in this lesson', async () => {
    const older = await submitText('first');
    await submitText('second');
    const other = await addHomework('text', { title: 'Other' });
    const elsewhere = await submitText('elsewhere', student, other.homeworkId);

    const res = await startJob({ submissionIds: [older, elsewhere, randomUUID()] });

    expectError(res, 400, 'VALIDATION_ERROR');
    expect(detailPaths(res)).toEqual(['submissionIds.0', 'submissionIds.1', 'submissionIds.2']);
    await expect(AiJob.count()).resolves.toBe(0);
  });

  it.each([
    ['a repeated id, in any case', (id: string) => ({ submissionIds: [id, id.toUpperCase()] }), ['submissionIds.1']],
    ['an empty list', () => ({ submissionIds: [] }), ['submissionIds']],
    ['an id that is not a UUID', () => ({ submissionIds: ['nope'] }), ['submissionIds.0']],
    ['ids that are not a list', (id: string) => ({ submissionIds: id }), ['submissionIds']],
    ['an unknown field', () => ({ all: true }), ['all']],
  ])('gives VALIDATION_ERROR for %s', async (_case, body, paths) => {
    const submissionId = await submitText('answer');

    const res = await startJob(body(submissionId));

    expectError(res, 400, 'VALIDATION_ERROR');
    expect(detailPaths(res)).toEqual(paths);
  });

  it('gives VALIDATION_ERROR when there is nothing to grade', async () => {
    const bare = (await api(teacher).post(`/api/v1/classes/${schoolClass.id}/lessons`, { title: 'Bare' })).body.id;

    for (const forLesson of [lessonId, bare]) {
      const res = await startJob(undefined, forLesson);
      expectError(res, 400, 'VALIDATION_ERROR');
      expect(detailPaths(res)).toEqual(['']);
    }

    await grade(await submitText('answer'));
    expectError(await startJob(), 400, 'VALIDATION_ERROR');
  });

  it('gives 503 AI_UNAVAILABLE without an API key, and queues nothing', async () => {
    await submitText('answer');
    env.ANTHROPIC_API_KEY = undefined;

    expectError(await startJob(), 503, 'AI_UNAVAILABLE');
    await expect(AiJob.count()).resolves.toBe(0);
  });

  it('gives 409 AI_JOB_ACTIVE with the jobId while a job is queued or running, but not after', async () => {
    await submitText('answer');
    const first = (await startJob()).body.id as string;

    for (const status of ['queued', 'running'] as const) {
      await AiJob.update({ status }, { where: { id: first } });
      const res = await startJob();
      expectError(res, 409, 'AI_JOB_ACTIVE');
      expect(res.body.error.details).toEqual({ jobId: first });
    }

    await AiJob.update({ status: 'done', finishedAt: new Date() }, { where: { id: first } });
    expect((await startJob()).status).toBe(202);
  });

  it('starts one job when two requests arrive together', async () => {
    const submissionId = await submitText('answer');
    let heldJob = '';
    const other = await holdOpen(async (t) => {
      await Lesson.findByPk(lessonId, { lock: Transaction.LOCK.NO_KEY_UPDATE, transaction: t });
      heldJob = (
        await AiJob.create(
          { lessonId, createdBy: teacher.id, status: 'queued', submissionIds: [submissionId], total: 1, error: null, finishedAt: null },
          { transaction: t },
        )
      ).id;
    });

    const second = startJob().then((res) => res);
    await waitUntilBlocked();
    await other.commit();

    const res = await second;
    expectError(res, 409, 'AI_JOB_ACTIVE');
    expect(res.body.error.details).toEqual({ jobId: heldJob });
    await expect(AiJob.count()).resolves.toBe(1);
  });

  it('tells the worker once the job is committed, and not when it is refused', async () => {
    await submitText('answer');
    const listener = vi.fn(async () => expect(await AiJob.count()).toBe(1));
    const unsubscribe = onJobQueued(listener);

    try {
      expect((await startJob()).status).toBe(202);
      expect((await startJob()).status).toBe(409);
    } finally {
      unsubscribe();
    }

    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("gives another teacher's lesson the same 404 as a missing one", async () => {
    await submitText('answer');
    const other = await createTestUser('teacher');

    const foreign = await startJob(undefined, lessonId, other);

    expectError(foreign, 404, 'NOT_FOUND');
    expect(foreign.body).toEqual((await startJob(undefined, randomUUID(), other)).body);
  });

  it('refuses students, anonymous callers and a malformed id', async () => {
    expectError(await startJob(undefined, lessonId, student), 403, 'FORBIDDEN');
    expectError(await request(app).post(aiGradePath()), 401, 'UNAUTHENTICATED');
    expectError(await startJob(undefined, 'nope'), 400, 'VALIDATION_ERROR');
  });

  it('allows 5 requests a minute per teacher', async () => {
    await submitText('answer');

    for (let attempt = 0; attempt < 5; attempt += 1) {
      expect((await startJob()).status).not.toBe(429);
    }

    const limited = await startJob();
    expectError(limited, 429, 'RATE_LIMITED');
    expect(limited.headers['retry-after']).toMatch(/^\d+$/);
  });
});

describe('GET /ai-jobs/:id', () => {
  it('gives the job to its teacher', async () => {
    await submitText('answer');
    const job = (await startJob()).body;

    const res = await api(teacher).get(`/api/v1/ai-jobs/${job.id}`);

    expect(res.status).toBe(200);
    expect(res.body).toEqual(job);
  });

  it('gives another teacher the same 404 as a missing job, and refuses the rest', async () => {
    await submitText('answer');
    const { id } = (await startJob()).body;
    const other = await createTestUser('teacher');

    const foreign = await api(other).get(`/api/v1/ai-jobs/${id}`);

    expectError(foreign, 404, 'NOT_FOUND');
    expect(foreign.body).toEqual((await api(other).get(`/api/v1/ai-jobs/${randomUUID()}`)).body);
    expectError(await api(student).get(`/api/v1/ai-jobs/${id}`), 403, 'FORBIDDEN');
    expectError(await request(app).get(`/api/v1/ai-jobs/${id}`), 401, 'UNAUTHENTICATED');
    expectError(await api(teacher).get('/api/v1/ai-jobs/nope'), 400, 'VALIDATION_ERROR');
    expectError(await api(teacher).get(`/api/v1/ai-jobs/${id}?x=1`), 400, 'VALIDATION_ERROR');
  });
});

describe('the worker', () => {
  it('stores the suggestion for the teacher only, and finishes the job', async () => {
    const submissionId = await submitText('x = 3');
    const before = (await Submission.findByPk(submissionId)) as Submission;
    stubModel(() => reply({ value: 4, comment: '  Correct, but show the check.  ' }));
    const { id } = (await startJob()).body;

    await expect(runNextJob()).resolves.toBe(true);

    const job = await api(teacher).get(`/api/v1/ai-jobs/${id}`);
    expect(job.body).toMatchObject({ status: 'done', total: 1, completed: 1, failed: 0, error: null });
    expect(job.body.finishedAt).toMatch(ISO_MILLIS);
    const forTeacher = await api(teacher).get(`/api/v1/submissions/${submissionId}`);
    expect(forTeacher.body).toMatchObject({
      status: 'submitted',
      grade: null,
      aiSuggestion: { value: 4, comment: 'Correct, but show the check.', createdAt: expect.stringMatching(ISO_MILLIS) },
      updatedAt: before.updatedAt.toISOString(),
    });
    expect((await api(student).get(`/api/v1/submissions/${submissionId}`)).body).not.toHaveProperty('aiSuggestion');
  });

  it('sends the lesson material, the instructions and the answer, with no sampling settings', async () => {
    await api(teacher).upload(`/api/v1/lessons/${lessonId}/lesson-file`, Buffer.from('# Linear equations\nMove terms.'), 'lesson.md');
    await api(teacher).upload(`/api/v1/lessons/${lessonId}/homework/file`, Buffer.from('Also check your answer.'), 'task.md');
    await submitText('x = 3');
    const send = stubModel(() => reply({ value: 5, comment: 'Good' }));
    await startJob();

    await runNextJob();

    const [sent] = send.mock.calls[0] as [ModelRequest];
    expect(sent).toEqual({
      model: 'test-model',
      max_tokens: 16000,
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: expect.any(Array) }],
      output_config: {
        format: {
          type: 'json_schema',
          schema: {
            type: 'object',
            properties: { value: { type: 'integer', enum: [2, 3, 4, 5] }, comment: { type: 'string' } },
            required: ['value', 'comment'],
            additionalProperties: false,
          },
        },
      },
    });
    expect(textOf(sent)).toBe(
      [
        '<lesson_material>\n# Linear equations\nMove terms.\n</lesson_material>',
        '<homework_instructions>\nSolve x + 2 = 5\n\nAlso check your answer.\n</homework_instructions>',
        '<student_answer type="text">\nx = 3\n</student_answer>',
        'Suggest a grade and a comment for this answer.',
      ].join('\n'),
    );
  });

  it('never sends a PDF', async () => {
    await api(teacher).upload(`/api/v1/lessons/${lessonId}/lesson-file`, PDF, 'lesson.pdf');
    await api(teacher).upload(`/api/v1/lessons/${lessonId}/homework/file`, PDF, 'task.pdf');
    await submitText('x = 3');
    const send = stubModel(() => reply({ value: 5, comment: 'Good' }));
    await startJob();

    await runNextJob();

    const [sent] = send.mock.calls[0] as [ModelRequest];
    expect(blocksOf(sent).map((block) => block.type)).toEqual(['text', 'text', 'text']);
    expect(textOf(sent)).not.toContain('secret pdf body');
    expect(textOf(sent)).not.toContain('lesson_material');
  });

  it('sends code in its three parts', async () => {
    const code = await addHomework('code', { title: 'Page' });
    await api(student).post(`/api/v1/homeworks/${code.homeworkId}/submissions`, { html: '<p>Hi</p>', css: '', js: 'go()' });
    const send = stubModel(() => reply({ value: 3, comment: 'Add CSS' }));
    await startJob(undefined, code.lessonId);

    await runNextJob();

    expect(textOf(send.mock.calls[0]?.[0] as ModelRequest)).toContain(
      '<student_answer type="code">\n<html>\n<p>Hi</p>\n</html>\n<css>\n\n</css>\n<js>\ngo()\n</js>\n</student_answer>',
    );
  });

  it('sends pages as base64 images, in order, with their own types', async () => {
    const photo = await addHomework('photo', { title: 'Photo' });
    await request(app)
      .post(`/api/v1/homeworks/${photo.homeworkId}/submissions`)
      .set('Authorization', `Bearer ${student.token}`)
      .attach('pages', JPEG, 'one.jpg')
      .attach('pages', WEBP, 'two.webp')
      .attach('pages', PNG, 'three.png');
    const send = stubModel(() => reply({ value: 4, comment: 'Neat' }));
    await startJob(undefined, photo.lessonId);

    await runNextJob();

    const images = blocksOf(send.mock.calls[0]?.[0] as ModelRequest).filter((block) => block.type === 'image');
    expect(images.map((block) => block.source)).toEqual([
      { type: 'base64', media_type: 'image/jpeg', data: JPEG.toString('base64') },
      { type: 'base64', media_type: 'image/webp', data: WEBP.toString('base64') },
      { type: 'base64', media_type: 'image/png', data: PNG.toString('base64') },
    ]);
    expect(textOf(send.mock.calls[0]?.[0] as ModelRequest)).toContain('Page 3:');
  });

  it('scales down a page too large for the model, and leaves the stored page as it was', async () => {
    const wide = await blank(3000, 100).png().toBuffer();
    const photo = await addHomework('photo', { title: 'Wide' });
    const submitted = await request(app)
      .post(`/api/v1/homeworks/${photo.homeworkId}/submissions`)
      .set('Authorization', `Bearer ${student.token}`)
      .attach('pages', wide, 'wide.png');
    const send = stubModel(() => reply({ value: 4, comment: 'Neat' }));
    await startJob(undefined, photo.lessonId);

    await runNextJob();

    const [image] = blocksOf(send.mock.calls[0]?.[0] as ModelRequest).filter((block) => block.type === 'image');
    expect(image?.source?.media_type).toBe('image/png');
    expect(await sharp(Buffer.from(image?.source?.data ?? '', 'base64')).metadata()).toMatchObject({
      width: 2576,
      height: 86,
    });
    expect((await getFile(submitted.body.content.pages[0].url)).body).toEqual(wide);
  });

  it('asks for refusal fallbacks on a model that takes them', async () => {
    env.AI_MODEL = 'claude-opus-5-5';
    await submitText('x = 3');
    const send = stubModel(() => reply({ value: 5, comment: 'Good' }));
    await startJob();

    await runNextJob();

    expect(send.mock.calls[0]?.[0]).toMatchObject({
      model: 'claude-opus-5-5',
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
    });
  });

  it('counts each bad answer as failed and carries on', async () => {
    const answers: Record<string, () => ModelResponse> = {
      'not json': () => reply('Grade: 5'),
      'value 6': () => reply({ value: 6, comment: 'x' }),
      'long comment': () => reply({ value: 4, comment: 'x'.repeat(2001) }),
      'extra field': () => reply({ value: 4, comment: 'x', confidence: 1 }),
      refusal: () => reply({ value: 4, comment: 'x' }, 'refusal'),
      'cut off': () => reply('{"value": 4, "comm', 'max_tokens'),
      'api error': () => {
        throw new Error('overloaded');
      },
      fine: () => reply({ value: 5, comment: 'x'.repeat(2000) }),
    };
    const ids: Record<string, string> = {};
    for (const [name] of Object.entries(answers)) {
      ids[name] = await submitText(name, await addStudent(`Student ${name}`));
    }
    stubModel((sent) => {
      const name = Object.keys(answers).find((key) => textOf(sent).includes(`\n${key}\n</student_answer>`)) as string;
      return (answers[name] as () => ModelResponse)();
    });
    const { id } = (await startJob()).body;

    await runNextJob();

    expect(await jobRow(id)).toMatchObject({ status: 'done', total: 8, completed: 1, failed: 7, error: null });
    const suggestions = await Submission.findAll({ attributes: ['id', 'aiSuggestion'], raw: true });
    expect(suggestions.filter((row) => row.aiSuggestion !== null).map((row) => row.id)).toEqual([ids.fine]);
  });

  it('skips a submission replaced by a new version before its turn, without a request', async () => {
    await submitText('first');
    const send = stubModel(() => reply({ value: 5, comment: 'Good' }));
    const { id } = (await startJob()).body;
    await submitText('second');

    await runNextJob();

    expect(send).not.toHaveBeenCalled();
    expect(await jobRow(id)).toMatchObject({ status: 'done', completed: 0, failed: 1 });
  });

  it('skips a submission deleted before its turn', async () => {
    await submitText('answer');
    const send = stubModel(() => reply({ value: 5, comment: 'Good' }));
    const { id } = (await startJob()).body;
    await api(teacher).delete(`/api/v1/lessons/${lessonId}/homework`);

    await runNextJob();

    expect(send).not.toHaveBeenCalled();
    expect(await jobRow(id)).toMatchObject({ status: 'done', failed: 1 });
  });

  it('drops the suggestion when a new version arrives while the model is working', async () => {
    const first = await submitText('first');
    stubModel(async () => {
      await submitText('second');
      return reply({ value: 5, comment: 'Good' });
    });
    const { id } = (await startJob()).body;

    await runNextJob();

    expect(await jobRow(id)).toMatchObject({ completed: 0, failed: 1 });
    await expect(Submission.count({ where: { aiSuggestion: null } })).resolves.toBe(2);
    expect(((await Submission.findByPk(first)) as Submission).aiSuggestion).toBeNull();
  });

  it('grades at most 3 submissions at once', async () => {
    for (const name of ['A', 'B', 'C', 'D', 'E']) {
      await submitText(`answer ${name}`, await addStudent(name));
    }
    let active = 0;
    let most = 0;
    stubModel(async () => {
      active += 1;
      most = Math.max(most, active);
      await new Promise((resolve) => setTimeout(resolve, 30));
      active -= 1;
      return reply({ value: 4, comment: 'Ok' });
    });
    const { id } = (await startJob()).body;

    await runNextJob();

    expect(most).toBe(3);
    expect(await jobRow(id)).toMatchObject({ status: 'done', total: 5, completed: 5, failed: 0 });
  });

  it('moves the counters as each submission finishes, not at the end', async () => {
    const other = await addStudent('Bek');
    await submitText('one');
    await submitText('two', other);
    const { id } = (await startJob()).body;
    let calls = 0;
    stubModel(async () => {
      calls += 1;
      if (calls === 1) {
        throw new Error('first one fails');
      }
      // The first one's failure is counted while this one is still running.
      await until(async () => (await jobRow(id)).failed === 1);
      return reply({ value: 4, comment: 'Ok' });
    });

    await runNextJob();

    expect(await jobRow(id)).toMatchObject({ status: 'done', completed: 1, failed: 1 });
  });

  it('fails the whole job, with an error, when AI is not configured at run time', async () => {
    await submitText('answer');
    const send = stubModel(() => reply({ value: 5, comment: 'Good' }));
    const { id } = (await startJob()).body;
    env.ANTHROPIC_API_KEY = undefined;

    await runNextJob();

    expect(send).not.toHaveBeenCalled();
    const job = await api(teacher).get(`/api/v1/ai-jobs/${id}`);
    expect(job.body).toMatchObject({ status: 'failed', error: 'AI grading is not configured' });
    expect(job.body.finishedAt).toMatch(ISO_MILLIS);
  });

  it('fails the whole job when it cannot keep count', async () => {
    await submitText('answer');
    stubModel(() => reply({ value: 5, comment: 'Good' }));
    const { id } = (await startJob()).body;
    const realQuery = sequelize.query.bind(sequelize) as (...args: unknown[]) => Promise<unknown>;
    vi.spyOn(sequelize, 'query').mockImplementation((async (...args: unknown[]) => {
      if (String(args[0]).includes('completed = completed + 1')) {
        throw new Error('database went away');
      }
      return realQuery(...args);
    }) as never);

    await runNextJob();

    vi.restoreAllMocks();
    expect(await jobRow(id)).toMatchObject({ status: 'failed', error: 'The job stopped because of a server error' });
    expect((await jobRow(id)).finishedAt).not.toBeNull();
  });

  it('stops quietly when the lesson, and with it the job, is deleted mid-run', async () => {
    for (const name of ['A', 'B', 'C', 'D', 'E', 'F']) {
      await submitText(`answer ${name}`, await addStudent(name));
    }
    let calls = 0;
    let deletion: Promise<unknown> | undefined;
    // The first call deletes the lesson; every call in flight answers only after that.
    stubModel(async () => {
      calls += 1;
      deletion ??= api(teacher)
        .delete(`/api/v1/lessons/${lessonId}`)
        .then((res) => expect(res.status).toBe(204));
      await deletion;
      return reply({ value: 4, comment: 'Ok' });
    });
    await startJob();

    await expect(runNextJob()).resolves.toBe(true);

    expect(calls).toBeLessThanOrEqual(3);
    await expect(AiJob.count()).resolves.toBe(0);
  });

  it('runs the oldest queued job first, and says when there is none', async () => {
    await submitText('answer');
    const second = await addHomework('text', { title: 'Second' });
    await submitText('answer', student, second.homeworkId);
    stubModel(() => reply({ value: 5, comment: 'Good' }));
    const older = (await startJob()).body.id;
    const newer = (await startJob(undefined, second.lessonId)).body.id;

    await runNextJob();
    expect([(await jobRow(older)).status, (await jobRow(newer)).status]).toEqual(['done', 'queued']);

    await runNextJob();
    expect((await jobRow(newer)).status).toBe('done');
    await expect(runNextJob()).resolves.toBe(false);
  });

  it('passes over a job another worker holds instead of waiting for it', async () => {
    await submitText('answer');
    const send = stubModel(() => reply({ value: 5, comment: 'Good' }));
    const { id } = (await startJob()).body;
    const held = await holdOpen((t) => AiJob.findByPk(id, { lock: Transaction.LOCK.UPDATE, transaction: t }));

    try {
      await expect(runNextJob()).resolves.toBe(false);
    } finally {
      await held.rollback();
    }

    expect(send).not.toHaveBeenCalled();
    expect((await jobRow(id)).status).toBe('queued');
  });

  it('queues jobs left running, which then start again from zero', async () => {
    await submitText('answer');
    stubModel(() => reply({ value: 5, comment: 'Good' }));
    const { id } = (await startJob()).body;
    await AiJob.update({ status: 'running', completed: 1, failed: 2 }, { where: { id } });

    await expect(requeueRunningJobs()).resolves.toBe(1);
    expect(await jobRow(id)).toMatchObject({ status: 'queued', completed: 1, failed: 2 });

    await runNextJob();
    expect(await jobRow(id)).toMatchObject({ status: 'done', total: 1, completed: 1, failed: 0 });
  });
});

describe('the worker loop', () => {
  it('requeues on start, runs a job as soon as one is queued, and stops', async () => {
    await submitText('answer');
    stubModel(() => reply({ value: 5, comment: 'Good' }));
    const stale = (await startJob()).body.id;
    await AiJob.update({ status: 'running' }, { where: { id: stale } });

    // A long poll, so only the requeue on start and the wake-up can explain the jobs running.
    const worker = startAiWorker({ pollMs: 60_000 });
    try {
      await until(async () => (await jobRow(stale)).status === 'done');

      const second = await addHomework('text', { title: 'Second' });
      await submitText('answer', student, second.homeworkId);
      const fresh = (await startJob(undefined, second.lessonId)).body.id;
      await until(async () => (await jobRow(fresh)).status === 'done');
    } finally {
      await worker.stop();
    }
  });
});
