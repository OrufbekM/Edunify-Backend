import { randomUUID } from 'node:crypto';

import { Transaction } from 'sequelize';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { app } from '../../app.js';
import { sequelize } from '../../db/index.js';
import type { HomeworkType } from '../../db/models/enums.js';
import { ClassStudent, FileRecord, Homework, Submission } from '../../db/models/index.js';
import { resetRateLimits } from '../../middleware/rateLimit.js';
import { storage } from '../../storage/index.js';
import { useTestDatabase } from '../../test/database.js';
import { getFile, isStored, waitUntilBlocked } from '../../test/files.js';
import { api, createTestUser, type TestUser } from '../../test/users.js';

useTestDatabase();

afterEach(() => {
  vi.restoreAllMocks();
});

const ISO_MILLIS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x01, 0x02]);
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);
const WEBP = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBPVP8 ')]);

let teacher: TestUser;
let student: TestUser;
let schoolClass: { id: string; publicId: string };
let rowId: string;

async function createClass(user: TestUser, name: string | null = '7A') {
  const category = await api(user).post('/api/v1/categories', { name: `C ${randomUUID()}` });
  return (await api(user).post('/api/v1/classes', { categoryId: category.body.id, subject: 'Maths', name }))
    .body as { id: string; publicId: string };
}

// Teacher adds the student under `fullName`, student enters the class ID.
async function linkActive(user: TestUser, fullName: string, forClass = schoolClass, owner = teacher) {
  const row = await api(owner).post(`/api/v1/classes/${forClass.id}/students`, {
    fullName,
    studentPublicId: user.publicId,
  });
  await api(user).post('/api/v1/student/claims', { classPublicId: forClass.publicId });
  return row.body.id as string;
}

async function addHomework(type: HomeworkType, title = 'Fractions', forClass = schoolClass.id, owner = teacher) {
  const lessonId = (await api(owner).post(`/api/v1/classes/${forClass}/lessons`, { title })).body.id as string;
  const lesson = await api(owner).put(`/api/v1/lessons/${lessonId}/homework`, { type });
  return { lessonId, homeworkId: lesson.body.homework.id as string };
}

const submissionsPath = (homeworkId: string) => `/api/v1/homeworks/${homeworkId}/submissions`;

function submitPages(user: TestUser, homeworkId: string, pages: Array<[Buffer, string]>) {
  let pending = request(app).post(submissionsPath(homeworkId)).set('Authorization', `Bearer ${user.token}`);
  for (const [content, name] of pages) {
    pending = pending.attach('pages', content, name);
  }
  return pending;
}

async function submitText(homeworkId: string, text = 'My answer', user = student) {
  const res = await api(user).post(submissionsPath(homeworkId), { text });
  expect(res.status).toBe(201);
  return res.body;
}

function expectError(res: request.Response, status: number, code: string): void {
  expect(res.status).toBe(status);
  expect(res.body.error.code).toBe(code);
}

function detailPaths(res: request.Response): string[] {
  return res.body.error.details.map((detail: { path: string }) => detail.path);
}

// Records the keys of everything stored, to check later that a failed request left nothing.
function recordStoredKeys(): string[] {
  const keys: string[] = [];
  const realPut = storage.put.bind(storage);
  vi.spyOn(storage, 'put').mockImplementation(async (data) => {
    const key = await realPut(data);
    keys.push(key);
    return key;
  });
  return keys;
}

// Rows written straight to the database, as the 30-version cap and grades need.
function fillVersions(homeworkId: string, classStudentId: string, count: number) {
  return Submission.bulkCreate(
    Array.from({ length: count }, (_, index) => ({
      homeworkId,
      classStudentId,
      version: index + 1,
      status: 'submitted' as const,
      content: { text: `v${index + 1}` },
      gradeValue: null,
      gradeComment: null,
      gradeSource: null,
      gradedAt: null,
      aiSuggestion: null,
    })),
  );
}

const AI_SUGGESTION = { value: 4, comment: 'Mostly right', createdAt: '2026-11-01T10:00:00.000Z' };

beforeEach(async () => {
  await resetRateLimits();
  teacher = await createTestUser('teacher', 'Ms Teacher');
  student = await createTestUser('student', 'Ali (account name)');
  schoolClass = await createClass(teacher);
  rowId = await linkActive(student, 'Ali Valiyev');
});

describe('POST /homeworks/:homeworkId/submissions, text', () => {
  it('creates version 1 and returns exactly the contract Submission, without aiSuggestion', async () => {
    const { lessonId, homeworkId } = await addHomework('text');

    const res = await api(student).post(submissionsPath(homeworkId), { text: '  My answer  ' });

    expect(res.status).toBe(201);
    expect(res.body).toEqual({
      id: expect.any(String),
      homeworkId,
      lessonId,
      classId: schoolClass.id,
      classStudentId: rowId,
      version: 1,
      isLatest: true,
      status: 'submitted',
      content: { type: 'text', text: 'My answer' },
      grade: null,
      createdAt: expect.stringMatching(ISO_MILLIS),
      updatedAt: expect.stringMatching(ISO_MILLIS),
    });
    expect(res.body).not.toHaveProperty('aiSuggestion');
  });

  it('accepts 20 000 characters', async () => {
    const { homeworkId } = await addHomework('text');

    expect((await submitText(homeworkId, 'x'.repeat(20_000))).content.text).toHaveLength(20_000);
  });

  it.each([
    ['text over 20 000 characters', { text: 'x'.repeat(20_001) }, 'text'],
    ['blank text', { text: '   ' }, 'text'],
    ['no text', {}, 'text'],
    ['code fields', { html: '<p>' }, 'html'],
  ])('gives VALIDATION_ERROR for %s', async (_case, body, path) => {
    const { homeworkId } = await addHomework('text');

    const res = await api(student).post(submissionsPath(homeworkId), body);

    expectError(res, 400, 'VALIDATION_ERROR');
    expect(detailPaths(res)).toContain(path);
  });

  it('gives VALIDATION_ERROR for pages sent to a text homework, and stores nothing', async () => {
    const { homeworkId } = await addHomework('text');

    expectError(await submitPages(student, homeworkId, [[PNG, 'page.png']]), 400, 'VALIDATION_ERROR');
    await expect(Submission.count()).resolves.toBe(0);
    await expect(FileRecord.count()).resolves.toBe(0);
  });
});

describe('POST /homeworks/:homeworkId/submissions, code', () => {
  it('stores all three fields, trimmed, and takes one with content', async () => {
    const { homeworkId } = await addHomework('code');

    const res = await api(student).post(submissionsPath(homeworkId), { html: '  <h1>Hi</h1>\n', css: '', js: '   ' });

    expect(res.status).toBe(201);
    expect(res.body.content).toEqual({ type: 'code', html: '<h1>Hi</h1>', css: '', js: '' });
  });

  it('accepts 100 000 characters in each field', async () => {
    const { homeworkId } = await addHomework('code');
    const big = 'x'.repeat(100_000);

    expect((await api(student).post(submissionsPath(homeworkId), { html: big, css: big, js: big })).status).toBe(201);
  });

  it.each([
    ['all three empty', { html: '', css: ' ', js: '\n' }, ''],
    ['a field over 100 000 characters', { html: 'x'.repeat(100_001), css: '', js: '' }, 'html'],
    ['a missing field', { html: '<p>', js: '' }, 'css'],
    ['an unknown field', { html: '<p>', css: '', js: '', python: 'print()' }, 'python'],
    ['a text body', { text: 'answer' }, 'text'],
  ])('gives VALIDATION_ERROR for %s', async (_case, body, path) => {
    const { homeworkId } = await addHomework('code');

    const res = await api(student).post(submissionsPath(homeworkId), body);

    expectError(res, 400, 'VALIDATION_ERROR');
    expect(detailPaths(res)).toContain(path);
  });
});

describe('POST /homeworks/:homeworkId/submissions, pages', () => {
  it('stores draw pages in order and returns them as signed FileRefs', async () => {
    const { homeworkId } = await addHomework('draw');
    const first = Buffer.concat([PNG, Buffer.from('first')]);
    const second = Buffer.concat([PNG, Buffer.from('second')]);

    const res = await submitPages(student, homeworkId, [[first, 'page-1.png'], [second, 'page-2.png']]);

    expect(res.status).toBe(201);
    expect(res.body.content).toEqual({
      type: 'draw',
      pages: [
        expect.objectContaining({ name: 'page-1.png', mime: 'image/png', size: first.length }),
        expect.objectContaining({ name: 'page-2.png', mime: 'image/png', size: second.length }),
      ],
    });
    expect((await getFile(res.body.content.pages[0].url)).body).toEqual(first);
    expect((await getFile(res.body.content.pages[1].url)).body).toEqual(second);
    await expect(FileRecord.findByPk(res.body.content.pages[0].id)).resolves.toMatchObject({
      kind: 'page',
      ownerUserId: student.id,
    });
    await expect(Submission.findByPk(res.body.id)).resolves.toMatchObject({ content: null });
  });

  it('keeps math as its own type with the draw rules', async () => {
    const { homeworkId } = await addHomework('math');

    const res = await submitPages(student, homeworkId, [[PNG, 'page-1.png']]);

    expect(res.body.content.type).toBe('math');
    expectError(await submitPages(student, homeworkId, [[JPEG, 'photo.jpg']]), 415, 'UNSUPPORTED_MEDIA_TYPE');
  });

  it('takes JPEG, PNG and WebP photos', async () => {
    const { homeworkId } = await addHomework('photo');

    const res = await submitPages(student, homeworkId, [
      [JPEG, 'one.jpg'],
      [PNG, 'two.png'],
      [WEBP, 'three.webp'],
    ]);

    expect(res.body.content.pages.map((page: { mime: string }) => page.mime)).toEqual([
      'image/jpeg',
      'image/png',
      'image/webp',
    ]);
  });

  it.each([
    ['a JPEG on a draw homework', 'draw' as const, [[JPEG, 'page.jpg']] as Array<[Buffer, string]>, 415, 'UNSUPPORTED_MEDIA_TYPE'],
    ['a GIF photo', 'photo' as const, [[Buffer.from('GIF89a'), 'photo.gif']] as Array<[Buffer, string]>, 415, 'UNSUPPORTED_MEDIA_TYPE'],
    ['a 10th page', 'draw' as const, Array.from({ length: 10 }, (_, i): [Buffer, string] => [PNG, `page-${i}.png`]), 409, 'LIMIT_REACHED'],
    ['a page over 10 MB', 'photo' as const, [[Buffer.concat([JPEG, Buffer.alloc(10 * 1024 * 1024)]), 'big.jpg']] as Array<[Buffer, string]>, 413, 'PAYLOAD_TOO_LARGE'],
  ])('gives %s %i and stores nothing', async (_case, type, pages, status, code) => {
    const { homeworkId } = await addHomework(type);
    const stored = recordStoredKeys();

    expectError(await submitPages(student, homeworkId, pages), status, code);
    await expect(Submission.count()).resolves.toBe(0);
    await expect(FileRecord.count()).resolves.toBe(0);
    await expect(Promise.all(stored.map(isStored))).resolves.toEqual(stored.map(() => false));
  });

  it('gives VALIDATION_ERROR for JSON sent to a page homework', async () => {
    const { homeworkId } = await addHomework('photo');

    const res = await api(student).post(submissionsPath(homeworkId), { text: 'A photo of my work' });

    expectError(res, 400, 'VALIDATION_ERROR');
    expect(detailPaths(res)).toEqual(['pages']);
  });
});

describe('who may submit', () => {
  it('gives a teacher 403 FORBIDDEN, even on an own class', async () => {
    const { homeworkId } = await addHomework('text');

    expectError(await api(teacher).post(submissionsPath(homeworkId), { text: 'x' }), 403, 'FORBIDDEN');
  });

  it('gives no token 401 UNAUTHENTICATED', async () => {
    const { homeworkId } = await addHomework('text');

    expectError(await api().post(submissionsPath(homeworkId), { text: 'x' }), 401, 'UNAUTHENTICATED');
  });

  it('gives a student without an active link 404, the same as a homework that does not exist', async () => {
    const { homeworkId } = await addHomework('text');
    const stranger = await createTestUser('student');
    const awaiting = await createTestUser('student');
    await api(teacher).post(`/api/v1/classes/${schoolClass.id}/students`, { fullName: 'B', studentPublicId: awaiting.publicId });
    const claimOnly = await createTestUser('student');
    await api(claimOnly).post('/api/v1/student/claims', { classPublicId: schoolClass.publicId });

    const missing = await api(stranger).post(submissionsPath(randomUUID()), { text: 'x' });

    expectError(missing, 404, 'NOT_FOUND');
    for (const user of [stranger, awaiting, claimOnly]) {
      const res = await api(user).post(submissionsPath(homeworkId), { text: 'x' });
      expect(res.status).toBe(404);
      expect(res.body).toEqual(missing.body);
    }
    await expect(Submission.count()).resolves.toBe(0);
  });

  it("gives 404 for a homework in another class the student isn't linked to", async () => {
    const other = await createClass(teacher);
    const { homeworkId } = await addHomework('text', 'Elsewhere', other.id);

    expectError(await api(student).post(submissionsPath(homeworkId), { text: 'x' }), 404, 'NOT_FOUND');
  });

  it('gives 404 once the teacher has re-linked the row to another account', async () => {
    const { homeworkId } = await addHomework('text');
    const newAccount = await createTestUser('student');
    await api(teacher).patch(`/api/v1/classes/${schoolClass.id}/students/${rowId}`, { studentPublicId: newAccount.publicId });

    expectError(await api(student).post(submissionsPath(homeworkId), { text: 'x' }), 404, 'NOT_FOUND');
  });

  it('checks access before reading the body: 404 even for a body multer cannot parse', async () => {
    const { homeworkId } = await addHomework('draw');
    const stranger = await createTestUser('student');
    const send = (user: TestUser) =>
      request(app)
        .post(submissionsPath(homeworkId))
        .set('Authorization', `Bearer ${user.token}`)
        .set('Content-Type', 'multipart/form-data; boundary=x')
        .send('this is not multipart');

    expectError(await send(stranger), 404, 'NOT_FOUND');
    expectError(await send(student), 400, 'VALIDATION_ERROR');
  });

  it('gives VALIDATION_ERROR for a malformed homework id', async () => {
    expectError(await api(student).post(submissionsPath('nope'), { text: 'x' }), 400, 'VALIDATION_ERROR');
  });
});

describe('versions', () => {
  it('numbers each new version and marks only the newest as latest', async () => {
    const { homeworkId } = await addHomework('text');
    const ids = [
      (await submitText(homeworkId, 'one')).id,
      (await submitText(homeworkId, 'two')).id,
      (await submitText(homeworkId, 'three')).id,
    ];

    const first = await api(teacher).get(`/api/v1/submissions/${ids[0]}`);

    expect(first.body).toMatchObject({ id: ids[0], version: 1, isLatest: false });
    expect(first.body.versions).toEqual([
      { id: ids[2], version: 3, status: 'submitted', grade: null, createdAt: expect.stringMatching(ISO_MILLIS) },
      { id: ids[1], version: 2, status: 'submitted', grade: null, createdAt: expect.any(String) },
      { id: ids[0], version: 1, status: 'submitted', grade: null, createdAt: expect.any(String) },
    ]);
    expect((await api(teacher).get(`/api/v1/submissions/${ids[2]}`)).body).toMatchObject({ version: 3, isLatest: true });
  });

  it('keeps versions per homework', async () => {
    const one = await addHomework('text', 'One');
    const two = await addHomework('text', 'Two');
    await submitText(one.homeworkId);

    expect((await submitText(two.homeworkId)).version).toBe(1);
  });

  it('takes a 30th version and gives LIMIT_REACHED for a 31st', async () => {
    const { homeworkId } = await addHomework('text');
    await fillVersions(homeworkId, rowId, 29);

    expect((await submitText(homeworkId)).version).toBe(30);
    expectError(await api(student).post(submissionsPath(homeworkId), { text: 'again' }), 409, 'LIMIT_REACHED');
    await expect(Submission.count()).resolves.toBe(30);
  });

  it('leaves no stored pages behind when the 31st version is refused', async () => {
    const { homeworkId } = await addHomework('draw');
    await fillVersions(homeworkId, rowId, 30);
    const stored = recordStoredKeys();

    expectError(await submitPages(student, homeworkId, [[PNG, 'page.png'], [PNG, 'page2.png']]), 409, 'LIMIT_REACHED');
    expect(stored).toHaveLength(2);
    await expect(Promise.all(stored.map(isStored))).resolves.toEqual([false, false]);
    await expect(FileRecord.count()).resolves.toBe(0);
  });

  it('numbers simultaneous submissions one after the other', async () => {
    const { homeworkId } = await addHomework('text');

    const results = await Promise.all(
      Array.from({ length: 4 }, (_, index) => api(student).post(submissionsPath(homeworkId), { text: `v${index}` })),
    );

    expect(results.map((res) => res.status)).toEqual([201, 201, 201, 201]);
    expect(results.map((res) => res.body.version).sort()).toEqual([1, 2, 3, 4]);
  });

  it("starts each version ungraded, keeps earlier grades, and clears the previous version's AI suggestion", async () => {
    const { homeworkId } = await addHomework('text');
    const first = await submitText(homeworkId, 'one');
    await Submission.update(
      {
        status: 'graded',
        gradeValue: 3,
        gradeComment: 'Try again',
        gradeSource: 'teacher',
        gradedAt: new Date('2026-11-02T09:00:00.000Z'),
        aiSuggestion: AI_SUGGESTION,
      },
      { where: { id: first.id } },
    );

    const second = await submitText(homeworkId, 'two');

    expect(second).toMatchObject({ version: 2, status: 'submitted', grade: null });
    await expect(Submission.findByPk(first.id)).resolves.toMatchObject({
      status: 'graded',
      gradeValue: 3,
      aiSuggestion: null,
    });
  });
});

describe('races', () => {
  async function holdOpen(work: (transaction: Transaction) => Promise<unknown>) {
    const transaction = await sequelize.transaction();
    try {
      await work(transaction);
      return transaction;
    } catch (err) {
      await transaction.rollback();
      throw err;
    }
  }

  it('a submission made while the row is being re-linked gets 404 and stores nothing', async () => {
    const { homeworkId } = await addHomework('draw');
    const newAccount = await createTestUser('student');
    const stored = recordStoredKeys();
    const relink = await holdOpen((t) =>
      ClassStudent.update({ studentUserId: newAccount.id }, { where: { id: rowId }, transaction: t }),
    );

    const submitting = submitPages(student, homeworkId, [[PNG, 'page.png']]).then((res) => res);
    await waitUntilBlocked();
    await relink.commit();

    expectError(await submitting, 404, 'NOT_FOUND');
    await expect(Submission.count()).resolves.toBe(0);
    await expect(Promise.all(stored.map(isStored))).resolves.toEqual([false]);
  });

  it('a submission made while the type is being changed is checked against the new type', async () => {
    const { homeworkId } = await addHomework('text');
    const change = await holdOpen(async (t) => {
      await Homework.findByPk(homeworkId, { lock: Transaction.LOCK.UPDATE, transaction: t });
      await Homework.update({ type: 'draw' }, { where: { id: homeworkId }, transaction: t });
    });

    const submitting = api(student).post(submissionsPath(homeworkId), { text: 'answer' }).then((res) => res);
    await waitUntilBlocked();
    await change.commit();

    expectError(await submitting, 400, 'VALIDATION_ERROR');
    await expect(Submission.count()).resolves.toBe(0);
  });
});

describe('the teacher is notified', () => {
  async function teacherItems() {
    return (await api(teacher).get('/api/v1/notifications')).body.items as Array<Record<string, unknown>>;
  }

  it('with a submitted notification that names the student as on the roster', async () => {
    const { lessonId, homeworkId } = await addHomework('text', 'Kasrlar');

    const submission = await submitText(homeworkId);

    await expect(teacherItems()).resolves.toEqual([
      {
        id: expect.any(String),
        kind: 'submitted',
        submissionId: submission.id,
        lessonId,
        classId: schoolClass.id,
        lessonTitle: 'Kasrlar',
        classSubject: 'Maths',
        className: '7A',
        studentName: 'Ali Valiyev',
        createdAt: expect.stringMatching(ISO_MILLIS),
      },
    ]);
  });

  it("and a new version replaces the unread notification for the previous one", async () => {
    const { homeworkId } = await addHomework('text');
    await submitText(homeworkId, 'one');

    const second = await submitText(homeworkId, 'two');

    await expect(teacherItems()).resolves.toMatchObject([{ submissionId: second.id }]);
    expect((await api(teacher).get('/api/v1/notifications/count')).body).toEqual({ unreadCount: 1 });
  });

  it('but a notification the teacher has read stays as it was', async () => {
    const { homeworkId } = await addHomework('text');
    const first = await submitText(homeworkId, 'one');
    const [notice] = await teacherItems();
    await api(teacher).post(`/api/v1/notifications/${notice?.id}/read`);

    await submitText(homeworkId, 'two');

    await expect(sequelize.query('SELECT submission_id FROM notifications WHERE read_at IS NOT NULL', { plain: true })).resolves.toEqual({
      submission_id: first.id,
    });
  });
});

describe('GET /submissions/:id', () => {
  it('gives the teacher the submission with aiSuggestion and the grade', async () => {
    const { homeworkId } = await addHomework('text');
    const submission = await submitText(homeworkId);
    await Submission.update(
      {
        status: 'graded',
        gradeValue: 5,
        gradeComment: 'Excellent',
        gradeSource: 'ai_confirmed',
        gradedAt: new Date('2026-11-03T08:00:00.000Z'),
        aiSuggestion: AI_SUGGESTION,
      },
      { where: { id: submission.id } },
    );

    const res = await api(teacher).get(`/api/v1/submissions/${submission.id}`);

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      status: 'graded',
      grade: { value: 5, denied: false, comment: 'Excellent', source: 'ai_confirmed', gradedAt: '2026-11-03T08:00:00.000Z' },
      aiSuggestion: AI_SUGGESTION,
    });
    expect(res.body.versions).toEqual([expect.objectContaining({ status: 'graded', grade: { value: 5, denied: false } })]);
  });

  it('shows a denial as value null and denied true', async () => {
    const { homeworkId } = await addHomework('text');
    const submission = await submitText(homeworkId);
    await Submission.update(
      { status: 'denied', gradeDenied: true, gradeComment: 'Redo it', gradeSource: 'teacher', gradedAt: new Date() },
      { where: { id: submission.id } },
    );

    const res = await api(teacher).get(`/api/v1/submissions/${submission.id}`);

    expect(res.body.grade).toMatchObject({ value: null, denied: true, comment: 'Redo it' });
    expect(res.body.versions[0].grade).toEqual({ value: null, denied: true });
  });

  it('gives the teacher aiSuggestion null when there is none', async () => {
    const { homeworkId } = await addHomework('text');
    const submission = await submitText(homeworkId);

    expect((await api(teacher).get(`/api/v1/submissions/${submission.id}`)).body.aiSuggestion).toBeNull();
  });

  it('gives the student their own submission without the aiSuggestion key, even when there is one', async () => {
    const { homeworkId } = await addHomework('text');
    const submission = await submitText(homeworkId);
    await Submission.update({ aiSuggestion: AI_SUGGESTION }, { where: { id: submission.id } });

    const res = await api(student).get(`/api/v1/submissions/${submission.id}`);

    expect(res.status).toBe(200);
    expect(res.body).not.toHaveProperty('aiSuggestion');
    expect(JSON.stringify(res.body)).not.toContain('Mostly right');
  });

  it('answers everyone else the same as a submission that does not exist', async () => {
    const { homeworkId } = await addHomework('text');
    const submission = await submitText(homeworkId);
    const otherTeacher = await createTestUser('teacher');
    const classmate = await createTestUser('student');
    await linkActive(classmate, 'Classmate');
    const missing = await api(otherTeacher).get(`/api/v1/submissions/${randomUUID()}`);

    expectError(missing, 404, 'NOT_FOUND');
    for (const user of [otherTeacher, classmate]) {
      const res = await api(user).get(`/api/v1/submissions/${submission.id}`);
      expect(res.status).toBe(404);
      expect(res.body).toEqual(missing.body);
    }
  });

  it('gives the old account 404 after a re-link, and the new account the same row', async () => {
    const { homeworkId } = await addHomework('text');
    const submission = await submitText(homeworkId);
    const newAccount = await createTestUser('student');
    await api(teacher).patch(`/api/v1/classes/${schoolClass.id}/students/${rowId}`, { studentPublicId: newAccount.publicId });
    await api(newAccount).post('/api/v1/student/claims', { classPublicId: schoolClass.publicId });

    expectError(await api(student).get(`/api/v1/submissions/${submission.id}`), 404, 'NOT_FOUND');
    expect((await api(newAccount).get(`/api/v1/submissions/${submission.id}`)).body).toMatchObject({
      id: submission.id,
      classStudentId: rowId,
    });
  });

  it('gives VALIDATION_ERROR for a malformed id or a query parameter', async () => {
    expectError(await api(teacher).get('/api/v1/submissions/nope'), 400, 'VALIDATION_ERROR');
    expectError(await api(teacher).get(`/api/v1/submissions/${randomUUID()}?all=1`), 400, 'VALIDATION_ERROR');
  });
});

describe('GET /student/submissions', () => {
  it('lists the latest version per homework, newest first, with its lesson and class', async () => {
    const fractions = await addHomework('text', 'Fractions');
    const angles = await addHomework('text', 'Angles');
    await submitText(fractions.homeworkId, 'one');
    await submitText(angles.homeworkId, 'angles');
    const latest = await submitText(fractions.homeworkId, 'two');
    await Submission.update({ aiSuggestion: AI_SUGGESTION }, { where: { id: latest.id } });

    const res = await api(student).get('/api/v1/student/submissions');

    expect(res.status).toBe(200);
    expect(res.body.items).toEqual([
      {
        submission: expect.objectContaining({ id: latest.id, version: 2, isLatest: true }),
        lesson: { id: fractions.lessonId, title: 'Fractions' },
        class: { id: schoolClass.id, subject: 'Maths', name: '7A' },
      },
      expect.objectContaining({ lesson: { id: angles.lessonId, title: 'Angles' } }),
    ]);
    expect(res.body.items[0].submission).not.toHaveProperty('aiSuggestion');
  });

  it('filters by classId and leaves out classes without an active link', async () => {
    const other = await createClass(teacher, null);
    await linkActive(student, 'Ali', other);
    const here = await addHomework('text', 'Here');
    const there = await addHomework('text', 'There', other.id);
    await submitText(here.homeworkId);
    await submitText(there.homeworkId);

    const filtered = await api(student).get(`/api/v1/student/submissions?classId=${other.id}`);
    expect(filtered.body.items.map((item: { lesson: { title: string } }) => item.lesson.title)).toEqual(['There']);
    expect(filtered.body.items[0].class).toEqual({ id: other.id, subject: 'Maths', name: null });

    await api(teacher).patch(`/api/v1/classes/${schoolClass.id}/students/${rowId}`, { studentPublicId: null });
    const all = await api(student).get('/api/v1/student/submissions');
    expect(all.body.items.map((item: { lesson: { title: string } }) => item.lesson.title)).toEqual(['There']);
    expect((await api(student).get(`/api/v1/student/submissions?classId=${schoolClass.id}`)).body).toEqual({ items: [] });
  });

  it("shows a re-linked row's work to the new account only once it has claimed the class", async () => {
    const { homeworkId } = await addHomework('text');
    await submitText(homeworkId);
    const newAccount = await createTestUser('student');
    await api(teacher).patch(`/api/v1/classes/${schoolClass.id}/students/${rowId}`, { studentPublicId: newAccount.publicId });

    expect((await api(newAccount).get('/api/v1/student/submissions')).body).toEqual({ items: [] });

    await api(newAccount).post('/api/v1/student/claims', { classPublicId: schoolClass.publicId });
    expect((await api(newAccount).get('/api/v1/student/submissions')).body.items).toHaveLength(1);
  });

  it('gives VALIDATION_ERROR for a malformed classId or another parameter, and 403 to a teacher', async () => {
    expectError(await api(student).get('/api/v1/student/submissions?classId=nope'), 400, 'VALIDATION_ERROR');
    expectError(await api(student).get('/api/v1/student/submissions?page=2'), 400, 'VALIDATION_ERROR');
    expectError(await api(teacher).get('/api/v1/student/submissions'), 403, 'FORBIDDEN');
  });
});

describe('LessonDetail.mySubmission', () => {
  it("is the student's latest version, without aiSuggestion", async () => {
    const { lessonId, homeworkId } = await addHomework('text');
    await submitText(homeworkId, 'one');
    const latest = await submitText(homeworkId, 'two');
    await Submission.update({ aiSuggestion: AI_SUGGESTION }, { where: { id: latest.id } });

    const res = await api(student).get(`/api/v1/lessons/${lessonId}`);

    expect(res.body.mySubmission).toMatchObject({ id: latest.id, version: 2, content: { type: 'text', text: 'two' } });
    expect(res.body.mySubmission).not.toHaveProperty('aiSuggestion');
  });

  it('is null before the first submission, and absent for the teacher', async () => {
    const { lessonId } = await addHomework('text');

    expect((await api(student).get(`/api/v1/lessons/${lessonId}`)).body.mySubmission).toBeNull();
    expect((await api(teacher).get(`/api/v1/lessons/${lessonId}`)).body).not.toHaveProperty('mySubmission');
  });
});
