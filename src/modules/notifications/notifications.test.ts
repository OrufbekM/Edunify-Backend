import { randomUUID } from 'node:crypto';

import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';

import { app } from '../../app.js';
import { Notification, Submission } from '../../db/models/index.js';
import { resetRateLimits } from '../../middleware/rateLimit.js';
import { useTestDatabase } from '../../test/database.js';
import { api, createTestUser, type TestUser } from '../../test/users.js';
import { notify, removeUnread } from './service.js';

useTestDatabase();

const ISO_MILLIS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

let teacher: TestUser;
let student: TestUser;
let schoolClass: { id: string; publicId: string };
let rowId: string;
let lessonId: string;
let homeworkId: string;

beforeEach(async () => {
  await resetRateLimits();
  teacher = await createTestUser('teacher');
  student = await createTestUser('student', 'Account Name');

  const category = await api(teacher).post('/api/v1/categories', { name: 'Maths' });
  schoolClass = (await api(teacher).post('/api/v1/classes', { categoryId: category.body.id, subject: 'Algebra', name: null })).body;
  rowId = (await api(teacher).post(`/api/v1/classes/${schoolClass.id}/students`, {
    fullName: 'Roster Name',
    studentPublicId: student.publicId,
  })).body.id;
  await api(student).post('/api/v1/student/claims', { classPublicId: schoolClass.publicId });
  lessonId = (await api(teacher).post(`/api/v1/classes/${schoolClass.id}/lessons`, { title: 'Equations' })).body.id;
  homeworkId = (await api(teacher).put(`/api/v1/lessons/${lessonId}/homework`, { type: 'text' })).body.homework.id;
});

async function submit(text = 'answer'): Promise<string> {
  const res = await api(student).post(`/api/v1/homeworks/${homeworkId}/submissions`, { text });
  expect(res.status).toBe(201);
  return res.body.id;
}

async function items(user: TestUser) {
  const res = await api(user).get('/api/v1/notifications');
  expect(res.status).toBe(200);
  return res.body.items as Array<Record<string, unknown> & { id: string }>;
}

async function unreadCount(user: TestUser): Promise<number> {
  const res = await api(user).get('/api/v1/notifications/count');
  expect(res.status).toBe(200);
  return res.body.unreadCount;
}

function expectError(res: request.Response, status: number, code: string): void {
  expect(res.status).toBe(status);
  expect(res.body.error.code).toBe(code);
}

describe('notify', () => {
  it('keeps one notification per user and submission; a later event updates it and makes it unread again', async () => {
    const submissionId = await submit();
    await notify(student.id, submissionId, 'graded');
    const first = (await Notification.findOne({ where: { userId: student.id } })) as Notification;
    await first.update({ readAt: new Date() });

    await notify(student.id, submissionId, 'denied');

    const rows = await Notification.findAll({ where: { userId: student.id } });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: first.id, kind: 'denied', readAt: null });
    expect(rows[0]?.createdAt.getTime()).toBeGreaterThan(first.createdAt.getTime());
  });

  it('removeUnread deletes an unread notification and leaves a read one', async () => {
    const [unread, read] = [await submit('one'), await submit('two')];
    await notify(student.id, unread, 'graded');
    await notify(student.id, read, 'graded');
    await Notification.update({ readAt: new Date() }, { where: { userId: student.id, submissionId: read } });

    await removeUnread(student.id, unread);
    await removeUnread(student.id, read);

    await expect(Notification.findAll({ where: { userId: student.id }, attributes: ['submissionId'], raw: true })).resolves.toEqual([
      { submissionId: read },
    ]);
  });
});

describe('GET /notifications and /notifications/count', () => {
  it("gives a student's graded item with the lesson and class, and no studentName", async () => {
    const submissionId = await submit();
    await notify(student.id, submissionId, 'graded');

    await expect(items(student)).resolves.toEqual([
      {
        id: expect.any(String),
        kind: 'graded',
        submissionId,
        lessonId,
        classId: schoolClass.id,
        lessonTitle: 'Equations',
        classSubject: 'Algebra',
        className: null,
        studentName: null,
        createdAt: expect.stringMatching(ISO_MILLIS),
      },
    ]);
    await expect(unreadCount(student)).resolves.toBe(1);
  });

  it("names the student as on the teacher's roster", async () => {
    await submit();

    await expect(items(teacher)).resolves.toMatchObject([{ kind: 'submitted', studentName: 'Roster Name' }]);
  });

  it('lists unread items only, newest first', async () => {
    const [older, newer, read] = [await submit('a'), await submit('b'), await submit('c')];
    for (const submissionId of [older, newer, read]) {
      await notify(student.id, submissionId, 'graded');
    }
    await Notification.update({ readAt: new Date() }, { where: { userId: student.id, submissionId: read } });

    await expect(items(student)).resolves.toMatchObject([{ submissionId: newer }, { submissionId: older }]);
    await expect(unreadCount(student)).resolves.toBe(2);
  });

  it('lists at most 100 items while counting all of them', async () => {
    const submissions = await Submission.bulkCreate(
      Array.from({ length: 101 }, (_, index) => ({
        homeworkId,
        classStudentId: rowId,
        version: index + 1,
        status: 'submitted' as const,
        content: { text: `v${index}` },
        gradeValue: null,
        gradeComment: null,
        gradeSource: null,
        gradedAt: null,
        aiSuggestion: null,
      })),
    );
    for (const submission of submissions) {
      await notify(student.id, submission.id, 'graded');
    }

    const listed = await items(student);

    expect(listed).toHaveLength(100);
    expect(listed[0]?.submissionId).toBe(submissions[100]?.id);
    await expect(unreadCount(student)).resolves.toBe(101);
  });

  it("shows nobody else's notifications", async () => {
    await notify(student.id, await submit(), 'graded');
    const stranger = await createTestUser('student');

    await expect(items(stranger)).resolves.toEqual([]);
    await expect(unreadCount(stranger)).resolves.toBe(0);
  });

  it('leaves out notifications for a row the student is no longer linked to', async () => {
    await notify(student.id, await submit(), 'graded');

    await api(teacher).patch(`/api/v1/classes/${schoolClass.id}/students/${rowId}`, { studentPublicId: null });

    await expect(items(student)).resolves.toEqual([]);
    await expect(unreadCount(student)).resolves.toBe(0);
  });

  it('leaves out notifications for a linked row until the student has claimed the class', async () => {
    const submissionId = await submit();
    const newAccount = await createTestUser('student');
    await api(teacher).patch(`/api/v1/classes/${schoolClass.id}/students/${rowId}`, { studentPublicId: newAccount.publicId });
    await notify(newAccount.id, submissionId, 'graded');

    await expect(unreadCount(newAccount)).resolves.toBe(0);

    await api(newAccount).post('/api/v1/student/claims', { classPublicId: schoolClass.publicId });
    await expect(items(newAccount)).resolves.toMatchObject([{ submissionId, kind: 'graded' }]);
  });

  it('gives VALIDATION_ERROR for a query parameter', async () => {
    expectError(await api(student).get('/api/v1/notifications?all=1'), 400, 'VALIDATION_ERROR');
    expectError(await api(student).get('/api/v1/notifications/count?all=1'), 400, 'VALIDATION_ERROR');
  });
});

describe('POST /notifications/:id/read', () => {
  it('marks it read with an empty 204, and again changes nothing', async () => {
    await submit();
    const [item] = await items(teacher);

    const res = await api(teacher).post(`/api/v1/notifications/${item?.id}/read`);
    const again = await api(teacher).post(`/api/v1/notifications/${item?.id}/read`);

    expect(res.status).toBe(204);
    expect(res.text).toBe('');
    expect(again.status).toBe(204);
    await expect(items(teacher)).resolves.toEqual([]);
    await expect(unreadCount(teacher)).resolves.toBe(0);
  });

  it("gives 404 NOT_FOUND for someone else's notification, the same as a missing one, and leaves it unread", async () => {
    await submit();
    const [item] = await items(teacher);

    const forOther = await api(student).post(`/api/v1/notifications/${item?.id}/read`);
    const forMissing = await api(student).post(`/api/v1/notifications/${randomUUID()}/read`);

    expectError(forOther, 404, 'NOT_FOUND');
    expect(forOther.body).toEqual(forMissing.body);
    await expect(unreadCount(teacher)).resolves.toBe(1);
  });

  it('gives VALIDATION_ERROR for a malformed id or a body field', async () => {
    await submit();
    const [item] = await items(teacher);

    expectError(await api(teacher).post('/api/v1/notifications/nope/read'), 400, 'VALIDATION_ERROR');
    expectError(await api(teacher).post(`/api/v1/notifications/${item?.id}/read`, { read: true }), 400, 'VALIDATION_ERROR');
  });
});

describe('access', () => {
  it.each([
    ['GET /notifications/count', () => request(app).get('/api/v1/notifications/count')],
    ['GET /notifications', () => request(app).get('/api/v1/notifications')],
    ['POST /notifications/:id/read', () => request(app).post(`/api/v1/notifications/${randomUUID()}/read`)],
  ])('gives no token 401 UNAUTHENTICATED on %s', async (_route, send) => {
    expectError(await send(), 401, 'UNAUTHENTICATED');
  });
});
