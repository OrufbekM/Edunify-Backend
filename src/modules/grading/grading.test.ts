import { randomUUID } from 'node:crypto';

import request from 'supertest';
import { Transaction } from 'sequelize';
import { beforeEach, describe, expect, it } from 'vitest';

import { app } from '../../app.js';
import { sequelize } from '../../db/index.js';
import type { HomeworkType } from '../../db/models/enums.js';
import { ClassStudent, Homework, Lesson, Notification, Submission } from '../../db/models/index.js';
import { resetRateLimits } from '../../middleware/rateLimit.js';
import { useTestDatabase } from '../../test/database.js';
import { waitUntilBlocked } from '../../test/files.js';
import { api, createTestUser, type TestUser } from '../../test/users.js';

useTestDatabase();

const ISO_MILLIS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const AI_SUGGESTION = { value: 4, comment: 'Mostly right', createdAt: '2026-11-01T10:00:00.000Z' };

let teacher: TestUser;
let student: TestUser;
let schoolClass: { id: string; publicId: string };
let rowId: string;
let lessonId: string;
let homeworkId: string;

async function createClass(owner: TestUser) {
  const category = await api(owner).post('/api/v1/categories', { name: `C ${randomUUID()}` });
  return (await api(owner).post('/api/v1/classes', { categoryId: category.body.id, subject: 'Maths', name: '7A' }))
    .body as { id: string; publicId: string };
}

async function addRow(fullName: string, account?: TestUser, claim = true): Promise<string> {
  const row = await api(teacher).post(`/api/v1/classes/${schoolClass.id}/students`, {
    fullName,
    ...(account ? { studentPublicId: account.publicId } : {}),
  });
  if (account && claim) {
    await api(account).post('/api/v1/student/claims', { classPublicId: schoolClass.publicId });
  }
  return row.body.id as string;
}

async function addHomework(type: HomeworkType = 'text', title = 'Fractions') {
  const lesson = (await api(teacher).post(`/api/v1/classes/${schoolClass.id}/lessons`, { title })).body.id as string;
  const res = await api(teacher).put(`/api/v1/lessons/${lesson}/homework`, { type, instructionsText: 'Solve it' });
  return { lessonId: lesson, homeworkId: res.body.homework.id as string };
}

async function submit(text = 'My answer', user = student, forHomework = homeworkId): Promise<string> {
  const res = await api(user).post(`/api/v1/homeworks/${forHomework}/submissions`, { text });
  expect(res.status).toBe(201);
  return res.body.id as string;
}

const gradePath = (submissionId: string) => `/api/v1/submissions/${submissionId}/grade`;
const gradingPath = (forLesson: string) => `/api/v1/lessons/${forLesson}/grading`;

function expectError(res: request.Response, status: number, code: string): void {
  expect(res.status).toBe(status);
  expect(res.body.error.code).toBe(code);
}

function detailPaths(res: request.Response): string[] {
  return res.body.error.details.map((detail: { path: string }) => detail.path);
}

async function setSuggestion(submissionId: string): Promise<void> {
  await Submission.update({ aiSuggestion: AI_SUGGESTION }, { where: { id: submissionId } });
}

async function stored(submissionId: string) {
  return (await Submission.findByPk(submissionId)) as Submission;
}

async function itemsOf(user: TestUser) {
  const res = await api(user).get('/api/v1/notifications');
  expect(res.status).toBe(200);
  return res.body.items as Array<Record<string, unknown> & { id: string }>;
}

// Opens a transaction, runs `work` in it and leaves it open, holding whatever it locked.
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

beforeEach(async () => {
  await resetRateLimits();
  teacher = await createTestUser('teacher', 'Ms Teacher');
  student = await createTestUser('student', 'Ali (account name)');
  schoolClass = await createClass(teacher);
  rowId = await addRow('Ali Valiyev', student);
  ({ lessonId, homeworkId } = await addHomework());
});

describe('GET /lessons/:lessonId/grading', () => {
  it('lists every roster row sorted by name, each with its latest version built for a teacher', async () => {
    const awaiting = await createTestUser('student');
    const zRow = await addRow('Zafar Awaiting', awaiting, false);
    const bRow = await addRow('bobur (no account)');
    await submit('first');
    const latest = await submit('second');

    const res = await api(teacher).get(gradingPath(lessonId));

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      lesson: { id: lessonId, title: 'Fractions' },
      homework: { id: homeworkId, lessonId, type: 'text', instructionsText: 'Solve it', instructionsFile: null },
      items: [
        { classStudentId: rowId, fullName: 'Ali Valiyev', submission: expect.objectContaining({ id: latest }) },
        { classStudentId: bRow, fullName: 'bobur (no account)', submission: null },
        { classStudentId: zRow, fullName: 'Zafar Awaiting', submission: null },
      ],
    });
    expect(res.body.items[0].submission).toMatchObject({
      version: 2,
      isLatest: true,
      status: 'submitted',
      content: { type: 'text', text: 'second' },
      grade: null,
      aiSuggestion: null,
    });
  });

  it('includes the AI suggestion', async () => {
    const submissionId = await submit();
    await setSuggestion(submissionId);

    const res = await api(teacher).get(gradingPath(lessonId));

    expect(res.body.items[0].submission.aiSuggestion).toEqual(AI_SUGGESTION);
  });

  it('reads the roster and the submissions from one snapshot', async () => {
    const first = await submit('first');

    // Commits a second version from another connection right after the lesson is read.
    Lesson.addHook('afterFind', 'commitAfterLessonRead', async () => {
      Lesson.removeHook('afterFind', 'commitAfterLessonRead');
      await Submission.create({
        homeworkId,
        classStudentId: rowId,
        version: 2,
        status: 'submitted',
        content: { text: 'late' },
        gradeValue: null,
        gradeComment: null,
        gradeSource: null,
        gradedAt: null,
        aiSuggestion: null,
      });
    });

    try {
      const res = await api(teacher).get(gradingPath(lessonId));

      expect(res.status).toBe(200);
      expect(res.body.items[0].submission).toMatchObject({ id: first, version: 1, isLatest: true });
    } finally {
      Lesson.removeHook('afterFind', 'commitAfterLessonRead');
    }
  });

  it('gives a lesson without homework the same 404 as a missing lesson', async () => {
    const bare = (await api(teacher).post(`/api/v1/classes/${schoolClass.id}/lessons`, { title: 'Bare' })).body.id;

    const withoutHomework = await api(teacher).get(gradingPath(bare));
    const missing = await api(teacher).get(gradingPath(randomUUID()));

    expectError(withoutHomework, 404, 'NOT_FOUND');
    expect(withoutHomework.body).toEqual(missing.body);
  });

  it("gives another teacher's lesson the same 404 as a missing one", async () => {
    const other = await createTestUser('teacher');

    const res = await api(other).get(gradingPath(lessonId));

    expectError(res, 404, 'NOT_FOUND');
    expect(res.body).toEqual((await api(other).get(gradingPath(randomUUID()))).body);
  });

  it('refuses students, anonymous callers, a malformed id and query parameters', async () => {
    expectError(await api(student).get(gradingPath(lessonId)), 403, 'FORBIDDEN');
    expectError(await request(app).get(gradingPath(lessonId)), 401, 'UNAUTHENTICATED');
    expectError(await api(teacher).get(gradingPath('nope')), 400, 'VALIDATION_ERROR');
    expectError(await api(teacher).get(`${gradingPath(lessonId)}?all=1`), 400, 'VALIDATION_ERROR');
  });
});

describe('PUT /submissions/:id/grade', () => {
  it('grades the latest version and returns the teacher Submission', async () => {
    const submissionId = await submit();
    const before = await stored(submissionId);

    const res = await api(teacher).put(gradePath(submissionId), { value: 5, comment: '  Well done  ' });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      id: submissionId,
      status: 'graded',
      isLatest: true,
      grade: { value: 5, denied: false, comment: 'Well done', source: 'teacher', gradedAt: expect.stringMatching(ISO_MILLIS) },
      aiSuggestion: null,
    });
    expect(Object.keys(res.body.grade).sort()).toEqual(['comment', 'denied', 'gradedAt', 'source', 'value']);
    expect(new Date(res.body.updatedAt).getTime()).toBeGreaterThan(before.updatedAt.getTime());
    await expect(stored(submissionId)).resolves.toMatchObject({
      status: 'graded',
      gradeValue: 5,
      gradeDenied: false,
      gradeComment: 'Well done',
      gradeSource: 'teacher',
    });
  });

  it('stores an empty or missing comment as null', async () => {
    const submissionId = await submit();

    const blank = await api(teacher).put(gradePath(submissionId), { value: 3, comment: '   ' });
    expect(blank.body.grade.comment).toBeNull();

    const missing = await api(teacher).put(gradePath(submissionId), { value: 4 });
    expect(missing.body.grade).toMatchObject({ value: 4, comment: null });
  });

  it('denies with a comment', async () => {
    const submissionId = await submit();

    const res = await api(teacher).put(gradePath(submissionId), { denied: true, comment: ' Show your working ' });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      status: 'denied',
      grade: { value: null, denied: true, comment: 'Show your working', source: 'teacher' },
    });
  });

  it('overwrites an earlier grade or denial', async () => {
    const submissionId = await submit();
    await api(teacher).put(gradePath(submissionId), { denied: true, comment: 'Redo' });

    const graded = await api(teacher).put(gradePath(submissionId), { value: 4 });
    expect(graded.body).toMatchObject({ status: 'graded', grade: { value: 4, denied: false, comment: null } });

    const denied = await api(teacher).put(gradePath(submissionId), { denied: true, comment: 'Again' });
    expect(denied.body).toMatchObject({ status: 'denied', grade: { value: null, denied: true, comment: 'Again' } });
    await expect(stored(submissionId)).resolves.toMatchObject({ gradeValue: null, gradeDenied: true });
  });

  it.each([
    ['nothing', {}, ['']],
    ['both value and denied', { value: 4, denied: true, comment: 'x' }, ['']],
    ['only a comment', { comment: 'x' }, ['']],
    ['a denial without a comment', { denied: true }, ['comment']],
    ['a denial with a blank comment', { denied: true, comment: '   ' }, ['comment']],
    ['denied: false', { denied: false, comment: 'x' }, ['denied']],
    ['value 1', { value: 1 }, ['value']],
    ['value 6', { value: 6 }, ['value']],
    ['a fractional value', { value: 4.5 }, ['value']],
    ['a value as a string', { value: '4' }, ['value']],
    ['a null comment', { value: 4, comment: null }, ['comment']],
    ['a comment over 2000 characters', { value: 4, comment: 'x'.repeat(2001) }, ['comment']],
    ['a denial comment over 2000 characters', { denied: true, comment: 'x'.repeat(2001) }, ['comment']],
    ['fromAi on a denial', { denied: true, comment: 'x', fromAi: true }, ['fromAi']],
    ['fromAi: false on a denial', { denied: true, comment: 'x', fromAi: false }, ['fromAi']],
    ['fromAi that is not a boolean', { value: 4, fromAi: 'yes' }, ['fromAi']],
    ['an unknown field', { value: 4, source: 'teacher' }, ['source']],
  ])('gives VALIDATION_ERROR for %s and changes nothing', async (_case, body, paths) => {
    const submissionId = await submit();

    const res = await api(teacher).put(gradePath(submissionId), body);

    expectError(res, 400, 'VALIDATION_ERROR');
    expect(detailPaths(res)).toEqual(paths);
    await expect(stored(submissionId)).resolves.toMatchObject({ status: 'submitted', gradedAt: null });
  });

  it('accepts the boundary values and a 2000-character comment', async () => {
    const submissionId = await submit();
    const longest = `  ${'x'.repeat(2000)}  `;

    expect((await api(teacher).put(gradePath(submissionId), { value: 2, comment: longest })).status).toBe(200);
    expect((await api(teacher).put(gradePath(submissionId), { value: 5 })).status).toBe(200);
    const denied = await api(teacher).put(gradePath(submissionId), { denied: true, comment: longest });
    expect(denied.status).toBe(200);
    expect(denied.body.grade.comment).toHaveLength(2000);
  });

  it('confirms the AI suggestion with fromAi, clearing it, even with a changed value', async () => {
    const submissionId = await submit();
    await setSuggestion(submissionId);

    const res = await api(teacher).put(gradePath(submissionId), { value: 3, comment: 'Edited', fromAi: true });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      status: 'graded',
      grade: { value: 3, denied: false, comment: 'Edited', source: 'ai_confirmed' },
      aiSuggestion: null,
    });
    await expect(stored(submissionId)).resolves.toMatchObject({ aiSuggestion: null, gradeSource: 'ai_confirmed' });
  });

  it('refuses fromAi when there is no suggestion to confirm', async () => {
    const submissionId = await submit();

    const res = await api(teacher).put(gradePath(submissionId), { value: 4, fromAi: true });

    expectError(res, 400, 'VALIDATION_ERROR');
    expect(detailPaths(res)).toEqual(['fromAi']);
    await expect(stored(submissionId)).resolves.toMatchObject({ status: 'submitted', gradeSource: null });
  });

  it('keeps the AI suggestion when the teacher grades by hand', async () => {
    const submissionId = await submit();
    await setSuggestion(submissionId);

    const manual = await api(teacher).put(gradePath(submissionId), { value: 5 });
    const explicit = await api(teacher).put(gradePath(submissionId), { value: 5, fromAi: false });

    for (const res of [manual, explicit]) {
      expect(res.body).toMatchObject({ grade: { source: 'teacher' }, aiSuggestion: AI_SUGGESTION });
    }
  });

  it('overwrites an AI-confirmed grade with a teacher one', async () => {
    const submissionId = await submit();
    await setSuggestion(submissionId);
    await api(teacher).put(gradePath(submissionId), { value: 4, fromAi: true });

    const res = await api(teacher).put(gradePath(submissionId), { value: 2 });

    expect(res.body.grade).toMatchObject({ value: 2, source: 'teacher' });
  });

  it('gives 409 SUBMISSION_NOT_LATEST for an earlier version and leaves it alone', async () => {
    const first = await submit('first');
    await submit('second');

    const res = await api(teacher).put(gradePath(first), { value: 5 });

    expectError(res, 409, 'SUBMISSION_NOT_LATEST');
    await expect(stored(first)).resolves.toMatchObject({ status: 'submitted', gradeValue: null });
  });

  it("gives another teacher's submission the same 404 as a missing one, but checks the body first", async () => {
    const submissionId = await submit();
    const other = await createTestUser('teacher');

    const foreign = await api(other).put(gradePath(submissionId), { value: 5 });
    const missing = await api(other).put(gradePath(randomUUID()), { value: 5 });

    expectError(foreign, 404, 'NOT_FOUND');
    expect(foreign.body).toEqual(missing.body);
    expectError(await api(other).put(gradePath(submissionId), {}), 400, 'VALIDATION_ERROR');
    await expect(stored(submissionId)).resolves.toMatchObject({ status: 'submitted' });
  });

  it('refuses students, anonymous callers and a malformed id', async () => {
    const submissionId = await submit();

    expectError(await api(student).put(gradePath(submissionId), { value: 5 }), 403, 'FORBIDDEN');
    expectError(await request(app).put(gradePath(submissionId)).send({ value: 5 }), 401, 'UNAUTHENTICATED');
    expectError(await api(teacher).put(gradePath('nope'), { value: 5 }), 400, 'VALIDATION_ERROR');
  });
});

describe('grading notifies the student', () => {
  it('with a graded notification, then denied, unread again each time', async () => {
    const submissionId = await submit();

    await api(teacher).put(gradePath(submissionId), { value: 5 });
    const [graded] = await itemsOf(student);
    expect(graded).toMatchObject({ kind: 'graded', submissionId, lessonId, studentName: null });

    await api(student).post(`/api/v1/notifications/${graded?.id}/read`);
    await expect(itemsOf(student)).resolves.toEqual([]);

    await api(teacher).put(gradePath(submissionId), { denied: true, comment: 'Redo' });
    await expect(itemsOf(student)).resolves.toEqual([expect.objectContaining({ id: graded?.id, kind: 'denied' })]);
  });

  it("leaves the teacher's own submitted notification alone", async () => {
    const submissionId = await submit();

    await api(teacher).put(gradePath(submissionId), { value: 5 });

    await expect(itemsOf(teacher)).resolves.toEqual([expect.objectContaining({ kind: 'submitted', submissionId })]);
  });

  it('notifies nobody when the row has no account', async () => {
    const submissionId = await submit();
    await api(teacher).patch(`/api/v1/classes/${schoolClass.id}/students/${rowId}`, { studentPublicId: null });

    const res = await api(teacher).put(gradePath(submissionId), { value: 5 });

    expect(res.status).toBe(200);
    await expect(Notification.count({ where: { kind: ['graded', 'denied'] } })).resolves.toBe(0);
  });

  it('notifies the account the row is linked to now', async () => {
    const submissionId = await submit();
    const newAccount = await createTestUser('student');
    await api(teacher).patch(`/api/v1/classes/${schoolClass.id}/students/${rowId}`, {
      studentPublicId: newAccount.publicId,
    });
    await api(newAccount).post('/api/v1/student/claims', { classPublicId: schoolClass.publicId });

    await api(teacher).put(gradePath(submissionId), { value: 4 });

    await expect(itemsOf(newAccount)).resolves.toEqual([expect.objectContaining({ kind: 'graded', submissionId })]);
    await expect(Notification.count({ where: { userId: student.id } })).resolves.toBe(0);
  });
});

describe('DELETE /submissions/:id/grade', () => {
  it('puts the submission back to submitted and keeps the AI suggestion', async () => {
    const submissionId = await submit();
    await setSuggestion(submissionId);
    await api(teacher).put(gradePath(submissionId), { value: 5, comment: 'Good' });

    const res = await api(teacher).delete(gradePath(submissionId));

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ id: submissionId, status: 'submitted', grade: null, aiSuggestion: AI_SUGGESTION });
    await expect(stored(submissionId)).resolves.toMatchObject({
      status: 'submitted',
      gradeValue: null,
      gradeDenied: false,
      gradeComment: null,
      gradeSource: null,
      gradedAt: null,
    });
  });

  it('clears a denial', async () => {
    const submissionId = await submit();
    await api(teacher).put(gradePath(submissionId), { denied: true, comment: 'Redo' });

    const res = await api(teacher).delete(gradePath(submissionId));

    expect(res.body).toMatchObject({ status: 'submitted', grade: null });
    await expect(stored(submissionId)).resolves.toMatchObject({ gradeDenied: false });
  });

  it("removes the student's unread notification but not a read one, nor the teacher's", async () => {
    const [unread, read] = [await submit('one'), await submit('two', student, (await addHomework('text', 'B')).homeworkId)];
    await api(teacher).put(gradePath(unread), { value: 5 });
    await api(teacher).put(gradePath(read), { value: 4 });
    await Notification.update({ readAt: new Date() }, { where: { userId: student.id, submissionId: read } });

    await api(teacher).delete(gradePath(unread));
    await api(teacher).delete(gradePath(read));

    await expect(
      Notification.findAll({ where: { userId: student.id }, attributes: ['submissionId'], raw: true }),
    ).resolves.toEqual([{ submissionId: read }]);
    await expect(Notification.count({ where: { userId: teacher.id, kind: 'submitted' } })).resolves.toBe(2);
  });

  it('also removes the unread notice of an account the row was re-linked away from', async () => {
    const submissionId = await submit();
    await api(teacher).put(gradePath(submissionId), { value: 5 });
    const newAccount = await createTestUser('student');
    await api(teacher).patch(`/api/v1/classes/${schoolClass.id}/students/${rowId}`, {
      studentPublicId: newAccount.publicId,
    });

    await api(teacher).delete(gradePath(submissionId));

    await expect(Notification.count({ where: { userId: student.id } })).resolves.toBe(0);
  });

  it('changes nothing on a submission without a grade', async () => {
    const submissionId = await submit();
    const before = await stored(submissionId);

    const res = await api(teacher).delete(gradePath(submissionId));

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: 'submitted', grade: null });
    expect((await stored(submissionId)).updatedAt).toEqual(before.updatedAt);
  });

  it('gives 409 SUBMISSION_NOT_LATEST for an earlier version, whose grade stays', async () => {
    const first = await submit('first');
    await api(teacher).put(gradePath(first), { value: 3 });
    await submit('second');

    expectError(await api(teacher).delete(gradePath(first)), 409, 'SUBMISSION_NOT_LATEST');
    await expect(stored(first)).resolves.toMatchObject({ status: 'graded', gradeValue: 3 });
  });

  it("gives another teacher's submission the same 404 as a missing one", async () => {
    const submissionId = await submit();
    await api(teacher).put(gradePath(submissionId), { value: 5 });
    const other = await createTestUser('teacher');

    const foreign = await api(other).delete(gradePath(submissionId));

    expectError(foreign, 404, 'NOT_FOUND');
    expect(foreign.body).toEqual((await api(other).delete(gradePath(randomUUID()))).body);
    await expect(stored(submissionId)).resolves.toMatchObject({ status: 'graded' });
  });

  it('refuses students, anonymous callers and a malformed id', async () => {
    const submissionId = await submit();

    expectError(await api(student).delete(gradePath(submissionId)), 403, 'FORBIDDEN');
    expectError(await request(app).delete(gradePath(submissionId)), 401, 'UNAUTHENTICATED');
    expectError(await api(teacher).delete(gradePath('nope')), 400, 'VALIDATION_ERROR');
  });
});

describe('grading at the same moment as', () => {
  it('a new version being submitted gives 409, because latest is checked under the row lock', async () => {
    const first = await submit('first');
    const newVersion = await holdOpen(async (t) => {
      await ClassStudent.findByPk(rowId, { lock: Transaction.LOCK.NO_KEY_UPDATE, transaction: t });
      await Submission.create(
        {
          homeworkId,
          classStudentId: rowId,
          version: 2,
          status: 'submitted',
          content: { text: 'second' },
          gradeValue: null,
          gradeComment: null,
          gradeSource: null,
          gradedAt: null,
          aiSuggestion: null,
        },
        { transaction: t },
      );
    });

    const grading = api(teacher).put(gradePath(first), { value: 5 }).then((res) => res);
    await waitUntilBlocked();
    await newVersion.commit();

    expectError(await grading, 409, 'SUBMISSION_NOT_LATEST');
    await expect(stored(first)).resolves.toMatchObject({ status: 'submitted' });
  });

  it('the homework being deleted gives 404, not a server error', async () => {
    const submissionId = await submit();
    const deletion = await holdOpen(async (t) => {
      const homework = await Homework.findByPk(homeworkId, { lock: Transaction.LOCK.UPDATE, transaction: t });
      await homework?.destroy({ transaction: t });
    });

    const grading = api(teacher).put(gradePath(submissionId), { value: 5 }).then((res) => res);
    await waitUntilBlocked();
    await deletion.commit();

    expectError(await grading, 404, 'NOT_FOUND');
    await expect(Notification.count({ where: { kind: 'graded' } })).resolves.toBe(0);
  });
});
