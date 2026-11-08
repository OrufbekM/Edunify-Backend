import { randomUUID } from 'node:crypto';

import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { app } from '../../app.js';
import { sequelize } from '../../db/index.js';
import { FileRecord, Homework, Submission } from '../../db/models/index.js';
import { resetRateLimits } from '../../middleware/rateLimit.js';
import { storage } from '../../storage/index.js';
import { useTestDatabase } from '../../test/database.js';
import { addSubmission, getFile, isStored, waitUntilBlocked } from '../../test/files.js';
import { api, createTestUser, type TestUser } from '../../test/users.js';

useTestDatabase();

afterEach(() => {
  vi.restoreAllMocks();
});

const MD = Buffer.from('# Kasrlar\n\nYarim va chorak.\n');
const PDF = Buffer.from('%PDF-1.7\nslides');
const ISO_MILLIS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

let teacher: TestUser;
let otherTeacher: TestUser;
let student: TestUser;
let schoolClass: { id: string; publicId: string };
let lessonId: string;

beforeEach(async () => {
  await resetRateLimits();
  teacher = await createTestUser('teacher');
  otherTeacher = await createTestUser('teacher');
  student = await createTestUser('student');

  const category = await api(teacher).post('/api/v1/categories', { name: 'Maths' });
  const created = await api(teacher).post('/api/v1/classes', { categoryId: category.body.id, subject: 'Maths' });
  schoolClass = created.body;
  lessonId = (await api(teacher).post(`/api/v1/classes/${schoolClass.id}/lessons`, { title: 'Fractions' })).body.id;
});

const lessonFilePath = (id = lessonId) => `/api/v1/lessons/${id}/lesson-file`;
const homeworkPath = (id = lessonId) => `/api/v1/lessons/${id}/homework`;
const homeworkFilePath = (id = lessonId) => `/api/v1/lessons/${id}/homework/file`;

function expectError(res: request.Response, status: number, code: string): void {
  expect(res.status).toBe(status);
  expect(res.body.error.code).toBe(code);
}

function fileRefFor(id: string, name: string, mime: string, size: number) {
  return {
    id,
    name,
    mime,
    size,
    url: expect.stringMatching(new RegExp(`^/api/v1/files/${id}\\?exp=\\d+&sig=[0-9a-f]{64}$`)),
    expiresAt: expect.stringMatching(ISO_MILLIS),
  };
}

async function putHomework(body: object = { type: 'text' }, user = teacher) {
  const res = await api(user).put(homeworkPath(), body);
  expect(res.status).toBe(200);
  return res.body;
}

async function linkStudentRow(): Promise<string> {
  const row = await api(teacher).post(`/api/v1/classes/${schoolClass.id}/students`, {
    fullName: 'Ali',
    studentPublicId: student.publicId,
  });
  await api(student).post('/api/v1/student/claims', { classPublicId: schoolClass.publicId });
  return row.body.id;
}

// A body multer can't parse, so a 404 for it proves the check ran before multer did.
function unparsableUpload(user: TestUser, path: string) {
  return request(app)
    .put(path)
    .set('Authorization', `Bearer ${user.token}`)
    .set('Content-Type', 'multipart/form-data; boundary=x')
    .send('this is not multipart');
}

describe('PUT /lessons/:id/lesson-file', () => {
  it('stores the file and returns the LessonDetail with a signed FileRef', async () => {
    const res = await api(teacher).upload(lessonFilePath(), MD, 'kasrlar.md');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      id: lessonId,
      classId: schoolClass.id,
      unitId: null,
      title: 'Fractions',
      order: 0,
      lessonFile: fileRefFor(res.body.lessonFile.id, 'kasrlar.md', 'text/markdown', MD.length),
      homework: null,
    });
    await expect(FileRecord.findByPk(res.body.lessonFile.id)).resolves.toMatchObject({
      ownerUserId: teacher.id,
      kind: 'lesson',
      mime: 'text/markdown',
    });
    expect((await getFile(res.body.lessonFile.url)).body).toEqual(MD);
  });

  it('keeps a file name outside ASCII', async () => {
    const res = await api(teacher).upload(lessonFilePath(), PDF, 'Урок 1.pdf');

    expect(res.body.lessonFile.name).toBe('Урок 1.pdf');
  });

  it('replaces the earlier file and removes its row and bytes', async () => {
    const first = (await api(teacher).upload(lessonFilePath(), MD, 'notes.md')).body.lessonFile;
    const { storageKey } = (await FileRecord.findByPk(first.id)) as FileRecord;

    const res = await api(teacher).upload(lessonFilePath(), PDF, 'slides.pdf');

    expect(res.status).toBe(200);
    expect(res.body.lessonFile).toEqual(fileRefFor(res.body.lessonFile.id, 'slides.pdf', 'application/pdf', PDF.length));
    await expect(FileRecord.count()).resolves.toBe(1);
    await expect(isStored(storageKey)).resolves.toBe(false);
    expect((await getFile(first.url)).status).toBe(404);
    expect((await getFile(res.body.lessonFile.url)).body).toEqual(PDF);
  });

  it.each([
    ['a file type it does not take', Buffer.from('PK'), 'notes.docx', 415, 'UNSUPPORTED_MEDIA_TYPE'],
    ['markdown over 1 MB', Buffer.alloc(1024 * 1024 + 1, 'a'), 'notes.md', 413, 'PAYLOAD_TOO_LARGE'],
    ['content that does not match', Buffer.from('not a pdf'), 'slides.pdf', 415, 'UNSUPPORTED_MEDIA_TYPE'],
    ['an empty file', Buffer.alloc(0), 'notes.md', 400, 'VALIDATION_ERROR'],
  ])('gives %s %i and stores nothing', async (_case, content, name, status, code) => {
    expectError(await api(teacher).upload(lessonFilePath(), content, name), status, code);
    await expect(FileRecord.count()).resolves.toBe(0);
  });

  it('gives 400 when no file is sent', async () => {
    const res = await api(teacher).put(lessonFilePath(), { file: 'nope' });

    expectError(res, 400, 'VALIDATION_ERROR');
    expect(res.body.error.details).toEqual([{ path: 'file', message: 'Required' }]);
  });

  it("checks ownership before reading the body: another teacher's lesson is 404 even for a body multer can't parse", async () => {
    expectError(await unparsableUpload(otherTeacher, lessonFilePath()), 404, 'NOT_FOUND');
    expectError(await unparsableUpload(teacher, lessonFilePath(randomUUID())), 404, 'NOT_FOUND');
    // The same body on an own lesson does reach multer.
    expectError(await unparsableUpload(teacher, lessonFilePath()), 400, 'VALIDATION_ERROR');
  });

  it("gives 404 for another teacher's lesson and stores nothing", async () => {
    expectError(await api(otherTeacher).upload(lessonFilePath(), MD, 'notes.md'), 404, 'NOT_FOUND');
    await expect(FileRecord.count()).resolves.toBe(0);
  });

  it('leaves exactly one file after two simultaneous uploads', async () => {
    const written: string[] = [];
    const realPut = storage.put.bind(storage);
    vi.spyOn(storage, 'put').mockImplementation(async (data) => {
      const key = await realPut(data);
      written.push(key);
      return key;
    });

    const results = await Promise.all([
      api(teacher).upload(lessonFilePath(), MD, 'one.md'),
      api(teacher).upload(lessonFilePath(), PDF, 'two.pdf'),
    ]);

    expect(results.map((res) => res.status)).toEqual([200, 200]);
    const files = await FileRecord.findAll();
    expect(files).toHaveLength(1);
    expect(written).toHaveLength(2);
    await expect(Promise.all(written.map(isStored))).resolves.toEqual(
      written.map((key) => key === files[0]?.storageKey),
    );
  });
});

describe('DELETE /lessons/:id/lesson-file', () => {
  it('removes the file, its row and its bytes', async () => {
    const uploaded = (await api(teacher).upload(lessonFilePath(), MD, 'notes.md')).body.lessonFile;
    const { storageKey } = (await FileRecord.findByPk(uploaded.id)) as FileRecord;

    const res = await api(teacher).delete(lessonFilePath());

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ id: lessonId, lessonFile: null, homework: null });
    await expect(FileRecord.count()).resolves.toBe(0);
    await expect(isStored(storageKey)).resolves.toBe(false);
  });

  it('gives 404 NOT_FOUND when the lesson has no file', async () => {
    expectError(await api(teacher).delete(lessonFilePath()), 404, 'NOT_FOUND');
  });

  it("gives 404 for another teacher's lesson and keeps the file", async () => {
    await api(teacher).upload(lessonFilePath(), MD, 'notes.md');

    expectError(await api(otherTeacher).delete(lessonFilePath()), 404, 'NOT_FOUND');
    await expect(FileRecord.count()).resolves.toBe(1);
  });
});

describe('PUT /lessons/:id/homework', () => {
  it('creates the homework with trimmed instructions', async () => {
    const body = await putHomework({ type: 'text', instructionsText: '  Read page 5.  ' });

    expect(body).toMatchObject({ id: lessonId, lessonFile: null });
    expect(body.homework).toEqual({
      id: expect.any(String),
      lessonId,
      type: 'text',
      instructionsText: 'Read page 5.',
      instructionsFile: null,
    });
    const outline = await api(teacher).get(`/api/v1/classes/${schoolClass.id}/outline`);
    expect(outline.body.lessons[0].homeworkType).toBe('text');
  });

  it('replaces type and text, clearing text that is left out or empty', async () => {
    const created = await putHomework({ type: 'text', instructionsText: 'Old' });

    const changed = await putHomework({ type: 'draw' });
    expect(changed.homework).toMatchObject({ id: created.homework.id, type: 'draw', instructionsText: null });

    await putHomework({ type: 'draw', instructionsText: 'New' });
    expect((await putHomework({ type: 'draw', instructionsText: '   ' })).homework.instructionsText).toBeNull();
  });

  it('keeps the instructions file', async () => {
    await putHomework({ type: 'text' });
    const file = (await api(teacher).upload(homeworkFilePath(), PDF, 'task.pdf')).body.homework.instructionsFile;

    const body = await putHomework({ type: 'photo', instructionsText: 'Photograph your work' });

    expect(body.homework.instructionsFile).toMatchObject({ id: file.id, name: 'task.pdf' });
  });

  it('accepts instructions of exactly 10 000 characters', async () => {
    expect((await putHomework({ type: 'code', instructionsText: 'x'.repeat(10_000) })).homework.instructionsText).toHaveLength(10_000);
  });

  it.each([
    ['instructions over 10 000 characters', { type: 'text', instructionsText: 'x'.repeat(10_001) }, 'instructionsText'],
    ['a type that does not exist', { type: 'essay' }, 'type'],
    ['no type', { instructionsText: 'Read' }, 'type'],
    ['an unknown field', { type: 'text', dueAt: '2026-12-01' }, 'dueAt'],
  ])('gives VALIDATION_ERROR for %s', async (_case, body, path) => {
    const res = await api(teacher).put(homeworkPath(), body);

    expectError(res, 400, 'VALIDATION_ERROR');
    expect(res.body.error.details.map((detail: { path: string }) => detail.path)).toContain(path);
  });

  it('gives HOMEWORK_TYPE_LOCKED for a new type once a submission exists, and still takes new text', async () => {
    const { homework } = await putHomework({ type: 'text', instructionsText: 'Old' });
    await addSubmission({ homeworkId: homework.id, classStudentId: await linkStudentRow(), ownerUserId: student.id, pages: 0 });

    expectError(await api(teacher).put(homeworkPath(), { type: 'draw' }), 409, 'HOMEWORK_TYPE_LOCKED');
    await expect(Homework.findByPk(homework.id)).resolves.toMatchObject({ type: 'text', instructionsText: 'Old' });

    expect((await putHomework({ type: 'text', instructionsText: 'New' })).homework.instructionsText).toBe('New');
  });

  it('counts a submission that is being saved while the type change waits', async () => {
    const { homework } = await putHomework({ type: 'text' });
    const classStudentId = await linkStudentRow();
    const saving = await sequelize.transaction();

    try {
      await addSubmission({ homeworkId: homework.id, classStudentId, ownerUserId: student.id, pages: 0, transaction: saving });
      const change = api(teacher).put(homeworkPath(), { type: 'draw' }).then((res) => res);

      await waitUntilBlocked();
      await saving.commit();

      expectError(await change, 409, 'HOMEWORK_TYPE_LOCKED');
    } finally {
      if (!(saving as unknown as { finished?: string }).finished) {
        await saving.rollback();
      }
    }
  });

  it('creates one homework from two simultaneous PUTs', async () => {
    const results = await Promise.all([
      api(teacher).put(homeworkPath(), { type: 'text' }),
      api(teacher).put(homeworkPath(), { type: 'draw' }),
    ]);

    expect(results.map((res) => res.status)).toEqual([200, 200]);
    await expect(Homework.count()).resolves.toBe(1);
  });

  it("gives 404 for another teacher's lesson and creates nothing", async () => {
    expectError(await api(otherTeacher).put(homeworkPath(), { type: 'text' }), 404, 'NOT_FOUND');
    await expect(Homework.count()).resolves.toBe(0);
  });
});

describe('PUT /lessons/:id/homework/file', () => {
  it('needs a homework, checked before the body is read', async () => {
    expectError(await unparsableUpload(teacher, homeworkFilePath()), 404, 'NOT_FOUND');
    expectError(await api(teacher).upload(homeworkFilePath(), PDF, 'task.pdf'), 404, 'NOT_FOUND');
    await expect(FileRecord.count()).resolves.toBe(0);
  });

  it('stores the instructions file and replaces an earlier one', async () => {
    await putHomework({ type: 'text' });

    const first = await api(teacher).upload(homeworkFilePath(), MD, 'task.md');
    expect(first.status).toBe(200);
    expect(first.body.homework.instructionsFile).toEqual(
      fileRefFor(first.body.homework.instructionsFile.id, 'task.md', 'text/markdown', MD.length),
    );
    const { storageKey } = (await FileRecord.findByPk(first.body.homework.instructionsFile.id)) as FileRecord;
    await expect(FileRecord.findByPk(first.body.homework.instructionsFile.id)).resolves.toMatchObject({ kind: 'instructions' });

    const second = await api(teacher).upload(homeworkFilePath(), PDF, 'task.pdf');

    expect(second.body.homework.instructionsFile.name).toBe('task.pdf');
    await expect(FileRecord.count()).resolves.toBe(1);
    await expect(isStored(storageKey)).resolves.toBe(false);
  });

  it('applies the same type rules as the lesson file', async () => {
    await putHomework({ type: 'text' });

    expectError(await api(teacher).upload(homeworkFilePath(), PDF, 'task.png'), 415, 'UNSUPPORTED_MEDIA_TYPE');
  });
});

describe('DELETE /lessons/:id/homework/file', () => {
  it('removes the instructions file and keeps the homework', async () => {
    await putHomework({ type: 'text', instructionsText: 'Read' });
    const file = (await api(teacher).upload(homeworkFilePath(), PDF, 'task.pdf')).body.homework.instructionsFile;
    const { storageKey } = (await FileRecord.findByPk(file.id)) as FileRecord;

    const res = await api(teacher).delete(homeworkFilePath());

    expect(res.status).toBe(200);
    expect(res.body.homework).toMatchObject({ type: 'text', instructionsText: 'Read', instructionsFile: null });
    await expect(isStored(storageKey)).resolves.toBe(false);
  });

  it('gives 404 NOT_FOUND without a file, and without a homework', async () => {
    expectError(await api(teacher).delete(homeworkFilePath()), 404, 'NOT_FOUND');

    await putHomework({ type: 'text' });
    expectError(await api(teacher).delete(homeworkFilePath()), 404, 'NOT_FOUND');
  });
});

describe('DELETE /lessons/:id/homework', () => {
  it('deletes the homework with its submissions and their files, keeping the lesson file', async () => {
    const lessonFile = (await api(teacher).upload(lessonFilePath(), MD, 'notes.md')).body.lessonFile;
    const { homework } = await putHomework({ type: 'draw' });
    const instructions = (await api(teacher).upload(homeworkFilePath(), PDF, 'task.pdf')).body.homework.instructionsFile;
    const { pages } = await addSubmission({ homeworkId: homework.id, classStudentId: await linkStudentRow(), ownerUserId: student.id, pages: 2 });
    const doomedKeys = [
      ((await FileRecord.findByPk(instructions.id)) as FileRecord).storageKey,
      ...pages.map((page) => page.storageKey),
    ];

    const res = await api(teacher).delete(homeworkPath());

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ id: lessonId, homework: null, lessonFile: { id: lessonFile.id } });
    await expect(Submission.count()).resolves.toBe(0);
    await expect(FileRecord.findAll({ attributes: ['id'], raw: true })).resolves.toEqual([{ id: lessonFile.id }]);
    await expect(Promise.all(doomedKeys.map(isStored))).resolves.toEqual([false, false, false]);
    const outline = await api(teacher).get(`/api/v1/classes/${schoolClass.id}/outline`);
    expect(outline.body.lessons[0].homeworkType).toBeNull();
  });

  it('gives 404 NOT_FOUND when there is no homework', async () => {
    expectError(await api(teacher).delete(homeworkPath()), 404, 'NOT_FOUND');
  });
});

describe('GET /lessons/:id with files', () => {
  it('gives a student with an active link working URLs for the lesson file and the instructions', async () => {
    await linkStudentRow();
    await api(teacher).upload(lessonFilePath(), MD, 'notes.md');
    await putHomework({ type: 'text', instructionsText: 'Read' });
    await api(teacher).upload(homeworkFilePath(), PDF, 'task.pdf');

    const res = await api(student).get(`/api/v1/lessons/${lessonId}`);

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      lessonFile: { name: 'notes.md', mime: 'text/markdown' },
      homework: { type: 'text', instructionsText: 'Read', instructionsFile: { name: 'task.pdf' } },
      mySubmission: null,
    });
    expect((await getFile(res.body.lessonFile.url)).body).toEqual(MD);
    expect((await getFile(res.body.homework.instructionsFile.url)).body).toEqual(PDF);
  });
});

describe('access', () => {
  const routes = [
    ['PUT /lessons/:id/lesson-file', (user?: TestUser) => api(user).upload(lessonFilePath(), MD, 'notes.md')],
    ['DELETE /lessons/:id/lesson-file', (user?: TestUser) => api(user).delete(lessonFilePath())],
    ['PUT /lessons/:id/homework', (user?: TestUser) => api(user).put(homeworkPath(), { type: 'text' })],
    ['DELETE /lessons/:id/homework', (user?: TestUser) => api(user).delete(homeworkPath())],
    ['PUT /lessons/:id/homework/file', (user?: TestUser) => api(user).upload(homeworkFilePath(), PDF, 'task.pdf')],
    ['DELETE /lessons/:id/homework/file', (user?: TestUser) => api(user).delete(homeworkFilePath())],
  ] as const;

  it.each(routes)('gives a student 403 FORBIDDEN on %s, even with an active link', async (_route, send) => {
    await linkStudentRow();

    expectError(await send(student), 403, 'FORBIDDEN');
    await expect(FileRecord.count()).resolves.toBe(0);
  });

  it.each(routes)('gives no token 401 UNAUTHENTICATED on %s', async (_route, send) => {
    expectError(await send(), 401, 'UNAUTHENTICATED');
  });
});
