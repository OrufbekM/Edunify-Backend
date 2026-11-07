import { randomUUID } from 'node:crypto';

import type request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';

import { ClassClaim, ClassStudent, LinkAudit } from '../../db/models/index.js';
import { generatePublicId } from '../../lib/publicId.js';
import { resetRateLimits } from '../../middleware/rateLimit.js';
import { useTestDatabase } from '../../test/database.js';
import { api, createTestUser, type TestUser } from '../../test/users.js';
import { getActiveClassStudent } from './service.js';

useTestDatabase();

interface RosterRow {
  id: string;
  fullName: string;
  studentPublicId: string | null;
  linkState: 'no_id' | 'awaiting_student' | 'active';
}

const ROSTER_KEYS = ['fullName', 'id', 'linkState', 'studentPublicId'];
const STUDENT_CLASS_KEYS = ['classStudentId', 'id', 'name', 'subject', 'teacherName'];

let teacher: TestUser;
let otherTeacher: TestUser;
let student: TestUser;
let classId: string;
let classPublicId: string;

async function createClass(user: TestUser, body: object = {}) {
  const category = await api(user).post('/api/v1/categories', { name: `C ${randomUUID()}` });
  expect(category.status).toBe(201);

  const res = await api(user).post('/api/v1/classes', {
    categoryId: category.body.id,
    subject: 'Maths',
    ...body,
  });
  expect(res.status).toBe(201);
  return res.body as { id: string; publicId: string };
}

beforeEach(async () => {
  await resetRateLimits();
  teacher = await createTestUser('teacher', 'Ms Teacher');
  otherTeacher = await createTestUser('teacher');
  student = await createTestUser('student');
  ({ id: classId, publicId: classPublicId } = await createClass(teacher, { name: '7A' }));
});

function publicIdOf(user: TestUser): string {
  if (!user.publicId) {
    throw new Error('Only students have a publicId');
  }
  return user.publicId;
}

function rosterPath(forClass = classId): string {
  return `/api/v1/classes/${forClass}/students`;
}

async function addStudent(body: object, forClass = classId, user = teacher): Promise<RosterRow> {
  const res = await api(user).post(rosterPath(forClass), { fullName: 'Ali', ...body });
  expect(res.status).toBe(201);
  return res.body;
}

async function linkStudent(user: TestUser, fullName = 'Ali'): Promise<RosterRow> {
  return addStudent({ fullName, studentPublicId: publicIdOf(user) });
}

async function patchStudent(rowId: string, body: object): Promise<request.Response> {
  return api(teacher).patch(`${rosterPath()}/${rowId}`, body);
}

async function claim(user: TestUser, publicId = classPublicId): Promise<request.Response> {
  return api(user).post('/api/v1/student/claims', { classPublicId: publicId });
}

async function rosterRow(rowId: string): Promise<RosterRow | undefined> {
  const res = await api(teacher).get(rosterPath());
  expect(res.status).toBe(200);
  return (res.body.items as RosterRow[]).find((row) => row.id === rowId);
}

async function myClasses(user: TestUser): Promise<Record<string, unknown>[]> {
  const res = await api(user).get('/api/v1/student/classes');
  expect(res.status).toBe(200);
  return res.body.items;
}

function expectError(res: request.Response, status: number, code: string): void {
  expect(res.status).toBe(status);
  expect(res.body.error.code).toBe(code);
}

describe('GET /classes/:classId/students', () => {
  it('starts empty', async () => {
    const res = await api(teacher).get(rosterPath());

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ items: [] });
  });

  it('returns exactly the contract ClassStudent', async () => {
    const unlinked = await addStudent({ fullName: 'Bea' });
    const linked = await linkStudent(student, 'Ali');

    const res = await api(teacher).get(rosterPath());

    for (const item of res.body.items) {
      expect(Object.keys(item).sort()).toEqual(ROSTER_KEYS);
    }
    expect(res.body.items).toEqual([
      {
        id: linked.id,
        fullName: 'Ali',
        studentPublicId: publicIdOf(student),
        linkState: 'awaiting_student',
      },
      { id: unlinked.id, fullName: 'Bea', studentPublicId: null, linkState: 'no_id' },
    ]);
  });

  it('sorts by fullName, ignoring letter case', async () => {
    for (const fullName of ['beta', 'Gamma', 'alpha 2', 'Alpha']) {
      await addStudent({ fullName });
    }

    const res = await api(teacher).get(rosterPath());

    expect(res.body.items.map((item: RosterRow) => item.fullName)).toEqual([
      'Alpha',
      'alpha 2',
      'beta',
      'Gamma',
    ]);
  });

  it('lists only the rows of that class', async () => {
    const other = await createClass(teacher);
    await addStudent({ fullName: 'Elsewhere' }, other.id);

    expect((await api(teacher).get(rosterPath())).body).toEqual({ items: [] });
  });

  it('rejects unknown query parameters', async () => {
    expectError(await api(teacher).get(`${rosterPath()}?sort=name`), 400, 'VALIDATION_ERROR');
  });

  it('gives VALIDATION_ERROR for a malformed classId', async () => {
    const res = await api(teacher).get(rosterPath('not-a-uuid'));

    expectError(res, 400, 'VALIDATION_ERROR');
    expect(res.body.error.details).toEqual([{ path: 'classId', message: expect.any(String) }]);
  });
});

describe('POST /classes/:classId/students', () => {
  it('adds a row with a trimmed name and no ID', async () => {
    const res = await api(teacher).post(rosterPath(), { fullName: '  Ali Valiyev  ' });

    expect(res.status).toBe(201);
    expect(res.body).toEqual({
      id: expect.any(String),
      fullName: 'Ali Valiyev',
      studentPublicId: null,
      linkState: 'no_id',
    });
  });

  it('treats studentPublicId null as no ID', async () => {
    expect(await addStudent({ studentPublicId: null })).toMatchObject({
      studentPublicId: null,
      linkState: 'no_id',
    });
  });

  it('normalizes the studentPublicId before looking it up', async () => {
    const id = publicIdOf(student).toUpperCase();

    const row = await addStudent({ studentPublicId: ` #${id.slice(0, 4)}-${id.slice(4)} ` });

    expect(row).toMatchObject({ studentPublicId: publicIdOf(student), linkState: 'awaiting_student' });
    await expect(ClassStudent.findByPk(row.id)).resolves.toMatchObject({ studentUserId: student.id });
  });

  it('does not audit a new row', async () => {
    await linkStudent(student);

    await expect(LinkAudit.count()).resolves.toBe(0);
  });

  it('gives STUDENT_ID_NOT_FOUND for an ID no student has, and adds nothing', async () => {
    const res = await api(teacher).post(rosterPath(), {
      fullName: 'Ali',
      studentPublicId: generatePublicId(),
    });

    expectError(res, 404, 'STUDENT_ID_NOT_FOUND');
    await expect(ClassStudent.count()).resolves.toBe(0);
  });

  it('gives STUDENT_ID_IN_USE when the account already has a row in this class', async () => {
    await linkStudent(student);

    expectError(
      await api(teacher).post(rosterPath(), { fullName: 'Ali again', studentPublicId: publicIdOf(student) }),
      409,
      'STUDENT_ID_IN_USE',
    );
    await expect(ClassStudent.count()).resolves.toBe(1);
  });

  it('lets one account have a row in each of several classes', async () => {
    const other = await createClass(teacher);
    await linkStudent(student);

    await addStudent({ studentPublicId: publicIdOf(student) }, other.id);
  });

  it('gives STUDENT_ID_IN_USE to the loser of two simultaneous adds of one account', async () => {
    const body = { fullName: 'Ali', studentPublicId: publicIdOf(student) };

    const results = await Promise.all([
      api(teacher).post(rosterPath(), body),
      api(teacher).post(rosterPath(), body),
    ]);

    expect(results.map((res) => res.status).sort()).toEqual([201, 409]);
    expect(results.find((res) => res.status === 409)?.body.error.code).toBe('STUDENT_ID_IN_USE');
    await expect(ClassStudent.count()).resolves.toBe(1);
  });

  it('accepts a fullName of exactly 100 characters', async () => {
    await addStudent({ fullName: 'x'.repeat(100) });
  });

  it.each([
    ['a blank fullName', { fullName: '   ' }, 'fullName'],
    ['a fullName over 100 characters', { fullName: 'x'.repeat(101) }, 'fullName'],
    ['no fullName', {}, 'fullName'],
    ['a studentPublicId that is too short', { fullName: 'Ali', studentPublicId: 'abc123' }, 'studentPublicId'],
    ['a studentPublicId with other characters', { fullName: 'Ali', studentPublicId: 'abcd_123' }, 'studentPublicId'],
    ['an empty studentPublicId', { fullName: 'Ali', studentPublicId: '' }, 'studentPublicId'],
    ['a studentPublicId that is not a string', { fullName: 'Ali', studentPublicId: 12345678 }, 'studentPublicId'],
    ['an unknown field', { fullName: 'Ali', email: 'ali@example.com' }, 'email'],
  ])('gives VALIDATION_ERROR for %s', async (_name, body, path) => {
    const res = await api(teacher).post(rosterPath(), body);

    expectError(res, 400, 'VALIDATION_ERROR');
    expect(res.body.error.details.map((detail: { path: string }) => detail.path)).toContain(path);
  });

  it('gives LIMIT_REACHED for a 201st student', async () => {
    await ClassStudent.bulkCreate(
      Array.from({ length: 200 }, (_, index) => ({ classId, fullName: `S${index}` })),
    );

    expectError(await api(teacher).post(rosterPath(), { fullName: 'One too many' }), 409, 'LIMIT_REACHED');
  });

  it('counts the cap per class', async () => {
    const other = await createClass(teacher);
    await ClassStudent.bulkCreate(
      Array.from({ length: 200 }, (_, index) => ({ classId: other.id, fullName: `S${index}` })),
    );

    await addStudent({ fullName: 'Still room here' });
  });

  it('never lets simultaneous adds pass the cap together', async () => {
    await ClassStudent.bulkCreate(
      Array.from({ length: 195 }, (_, index) => ({ classId, fullName: `S${index}` })),
    );

    const results = await Promise.all(
      Array.from({ length: 10 }, (_, index) =>
        api(teacher).post(rosterPath(), { fullName: `Race ${index}` }),
      ),
    );

    expect(results.filter((res) => res.status === 201)).toHaveLength(5);
    expect(results.filter((res) => res.body.error?.code === 'LIMIT_REACHED')).toHaveLength(5);
    await expect(ClassStudent.count({ where: { classId } })).resolves.toBe(200);
  });
});

describe('the two-sided link', () => {
  it('teacher first: awaiting_student until the student claims, then active', async () => {
    const row = await linkStudent(student);

    expect(row.linkState).toBe('awaiting_student');
    await expect(myClasses(student)).resolves.toEqual([]);

    const res = await claim(student);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ saved: true });
    await expect(rosterRow(row.id)).resolves.toMatchObject({ linkState: 'active' });
    await expect(myClasses(student)).resolves.toEqual([
      { id: classId, subject: 'Maths', name: '7A', teacherName: 'Ms Teacher', classStudentId: row.id },
    ]);
  });

  it('student first: the claim alone shows nothing, the link is active once the teacher adds the ID', async () => {
    expect((await claim(student)).body).toEqual({ saved: true });
    await expect(myClasses(student)).resolves.toEqual([]);

    const row = await linkStudent(student);

    expect(row.linkState).toBe('active');
    await expect(myClasses(student)).resolves.toMatchObject([{ id: classId, classStudentId: row.id }]);
  });

  it('a claim by another student does not activate the row', async () => {
    const row = await linkStudent(student);
    await claim(await createTestUser('student'));

    await expect(rosterRow(row.id)).resolves.toMatchObject({ linkState: 'awaiting_student' });
  });

  it("a claim of another class does not activate this class's row", async () => {
    const other = await createClass(teacher);
    const row = await linkStudent(student);
    await claim(student, other.publicId);

    await expect(rosterRow(row.id)).resolves.toMatchObject({ linkState: 'awaiting_student' });
  });

  it('links a row that had no ID through PATCH, audited', async () => {
    const row = await addStudent({});

    const res = await patchStudent(row.id, { studentPublicId: publicIdOf(student) });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      id: row.id,
      fullName: 'Ali',
      studentPublicId: publicIdOf(student),
      linkState: 'awaiting_student',
    });
    await expect(LinkAudit.findAll({ raw: true })).resolves.toMatchObject([
      { classStudentId: row.id, oldUserId: null, newUserId: student.id, changedBy: teacher.id },
    ]);

    await claim(student);
    await expect(rosterRow(row.id)).resolves.toMatchObject({ linkState: 'active' });
  });
});

describe('POST /student/claims', () => {
  it('gives the same neutral answer whether or not the teacher has linked the student', async () => {
    const unlinked = await createTestUser('student');
    await linkStudent(student);

    const forLinked = await claim(student);
    const forUnlinked = await claim(unlinked);

    expect(forLinked.status).toBe(200);
    expect(forUnlinked.status).toBe(200);
    expect(forLinked.body).toEqual({ saved: true });
    expect(forUnlinked.body).toEqual(forLinked.body);
  });

  it('is idempotent', async () => {
    expect((await claim(student)).body).toEqual({ saved: true });
    expect((await claim(student)).body).toEqual({ saved: true });

    await expect(ClassClaim.count({ where: { studentUserId: student.id } })).resolves.toBe(1);
  });

  it('normalizes the classPublicId', async () => {
    const id = classPublicId.toUpperCase();

    expect((await claim(student, `  #${id.slice(0, 4)}-${id.slice(4)}`)).status).toBe(200);
    await expect(ClassClaim.findOne({ where: { studentUserId: student.id } })).resolves.toMatchObject({
      classId,
    });
  });

  it('gives CLASS_ID_NOT_FOUND for an ID no class has, and saves nothing', async () => {
    expectError(await claim(student, generatePublicId()), 404, 'CLASS_ID_NOT_FOUND');
    await expect(ClassClaim.count()).resolves.toBe(0);
  });

  it('does not take a student publicId for a class one', async () => {
    expectError(await claim(student, publicIdOf(student)), 404, 'CLASS_ID_NOT_FOUND');
  });

  it.each([
    ['a malformed classPublicId', { classPublicId: 'abc' }, 'classPublicId'],
    ['no classPublicId', {}, 'classPublicId'],
    ['an unknown field', { classPublicId: 'abcd1234', note: 'hi' }, 'note'],
  ])('gives VALIDATION_ERROR for %s', async (_name, body, path) => {
    const res = await api(student).post('/api/v1/student/claims', body);

    expectError(res, 400, 'VALIDATION_ERROR');
    expect(res.body.error.details.map((detail: { path: string }) => detail.path)).toContain(path);
  });
});

describe('GET /student/classes', () => {
  it('lists active links only, sorted by subject ignoring letter case, without the class publicId', async () => {
    const artTeacher = await createTestUser('teacher', 'Mr Other');
    const classes = [
      await createClass(teacher, { subject: 'physics' }),
      await createClass(artTeacher, { subject: 'Art' }),
      await createClass(teacher, { subject: 'biology' }),
    ];
    const awaiting = await createClass(teacher, { subject: 'Awaiting' });
    const claimedOnly = await createClass(teacher, { subject: 'Claimed only' });

    for (const [index, { id, publicId }] of classes.entries()) {
      const owner = index === 1 ? artTeacher : teacher;
      await addStudent({ fullName: 'Ali', studentPublicId: publicIdOf(student) }, id, owner);
      await claim(student, publicId);
    }
    await addStudent({ studentPublicId: publicIdOf(student) }, awaiting.id);
    await claim(student, claimedOnly.publicId);

    const items = await myClasses(student);

    for (const item of items) {
      expect(Object.keys(item).sort()).toEqual(STUDENT_CLASS_KEYS);
    }
    expect(items.map((item) => [item.subject, item.teacherName])).toEqual([
      ['Art', 'Mr Other'],
      ['biology', 'Ms Teacher'],
      ['physics', 'Ms Teacher'],
    ]);
    expect(items.map((item) => item.name)).toEqual([null, null, null]);
  });

  it('rejects unknown query parameters', async () => {
    expectError(await api(student).get('/api/v1/student/classes?all=1'), 400, 'VALIDATION_ERROR');
  });
});

describe('PATCH /classes/:classId/students/:id', () => {
  async function activeRow(user = student): Promise<RosterRow> {
    const row = await linkStudent(user);
    await claim(user);
    expect((await rosterRow(row.id))?.linkState).toBe('active');
    return row;
  }

  it('re-links: the old account loses the class at once, the new one gains it after its claim', async () => {
    const row = await activeRow();
    const newAccount = await createTestUser('student');

    const res = await patchStudent(row.id, { studentPublicId: publicIdOf(newAccount) });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      id: row.id,
      fullName: 'Ali',
      studentPublicId: publicIdOf(newAccount),
      linkState: 'awaiting_student',
    });
    await expect(getActiveClassStudent(student.id, classId)).rejects.toMatchObject({
      code: 'NOT_FOUND',
      status: 404,
    });
    await expect(myClasses(student)).resolves.toEqual([]);
    await expect(myClasses(newAccount)).resolves.toEqual([]);
    await expect(getActiveClassStudent(newAccount.id, classId)).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });

    await claim(newAccount);

    await expect(rosterRow(row.id)).resolves.toMatchObject({ linkState: 'active' });
    await expect(myClasses(newAccount)).resolves.toMatchObject([{ id: classId, classStudentId: row.id }]);
    await expect(getActiveClassStudent(newAccount.id, classId)).resolves.toMatchObject({ id: row.id });
    await expect(LinkAudit.findAll({ raw: true })).resolves.toMatchObject([
      { classStudentId: row.id, oldUserId: student.id, newUserId: newAccount.id, changedBy: teacher.id },
    ]);
  });

  it('activates at once when the new account has already claimed the class', async () => {
    const row = await activeRow();
    const newAccount = await createTestUser('student');
    await claim(newAccount);

    expect((await patchStudent(row.id, { studentPublicId: publicIdOf(newAccount) })).body.linkState).toBe(
      'active',
    );
  });

  it('unlinks with null, audited', async () => {
    const row = await activeRow();

    const res = await patchStudent(row.id, { studentPublicId: null });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ id: row.id, fullName: 'Ali', studentPublicId: null, linkState: 'no_id' });
    await expect(getActiveClassStudent(student.id, classId)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(myClasses(student)).resolves.toEqual([]);
    await expect(LinkAudit.findAll({ raw: true })).resolves.toMatchObject([
      { classStudentId: row.id, oldUserId: student.id, newUserId: null, changedBy: teacher.id },
    ]);
  });

  it('keeps the old claim, so linking the old account again is active at once', async () => {
    const row = await activeRow();
    await patchStudent(row.id, { studentPublicId: null });

    const res = await patchStudent(row.id, { studentPublicId: publicIdOf(student) });

    expect(res.body.linkState).toBe('active');
    await expect(LinkAudit.count()).resolves.toBe(2);
  });

  it('changes nothing and audits nothing when the same ID is sent again', async () => {
    const row = await activeRow();
    const before = await ClassStudent.findByPk(row.id);

    const res = await patchStudent(row.id, { studentPublicId: publicIdOf(student).toUpperCase() });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ...row, linkState: 'active' });
    await expect(LinkAudit.count()).resolves.toBe(0);
    await expect(ClassStudent.findByPk(row.id)).resolves.toMatchObject({ updatedAt: before?.updatedAt });
  });

  it('audits nothing when an unlinked row is unlinked again', async () => {
    const row = await addStudent({});

    expect((await patchStudent(row.id, { studentPublicId: null })).status).toBe(200);
    await expect(LinkAudit.count()).resolves.toBe(0);
  });

  it('renames with a trimmed name and leaves the link alone', async () => {
    const row = await activeRow();

    const res = await patchStudent(row.id, { fullName: '  Ali Valiyev ' });

    expect(res.body).toEqual({
      id: row.id,
      fullName: 'Ali Valiyev',
      studentPublicId: publicIdOf(student),
      linkState: 'active',
    });
    await expect(LinkAudit.count()).resolves.toBe(0);
  });

  it('accepts an empty body and changes nothing', async () => {
    const row = await linkStudent(student);

    const res = await patchStudent(row.id, {});

    expect(res.status).toBe(200);
    expect(res.body).toEqual(row);
  });

  it("gives STUDENT_ID_IN_USE for an account that has another row in the class, and changes nothing", async () => {
    await linkStudent(student, 'Ali');
    const other = await addStudent({ fullName: 'Bea' });

    expectError(
      await patchStudent(other.id, { fullName: 'Renamed', studentPublicId: publicIdOf(student) }),
      409,
      'STUDENT_ID_IN_USE',
    );
    await expect(ClassStudent.findByPk(other.id)).resolves.toMatchObject({
      fullName: 'Bea',
      studentUserId: null,
    });
    await expect(LinkAudit.count()).resolves.toBe(0);
  });

  it('gives STUDENT_ID_NOT_FOUND for an ID no student has, and changes nothing', async () => {
    const row = await linkStudent(student);

    expectError(
      await patchStudent(row.id, { studentPublicId: generatePublicId() }),
      404,
      'STUDENT_ID_NOT_FOUND',
    );
    await expect(ClassStudent.findByPk(row.id)).resolves.toMatchObject({ studentUserId: student.id });
    await expect(LinkAudit.count()).resolves.toBe(0);
  });

  it('gives 404 NOT_FOUND for a row of another class, even an own one, before any lookup', async () => {
    const other = await createClass(teacher);
    const row = await addStudent({}, other.id);

    expectError(
      await patchStudent(row.id, { fullName: 'Moved?', studentPublicId: generatePublicId() }),
      404,
      'NOT_FOUND',
    );
    await expect(ClassStudent.findByPk(row.id)).resolves.toMatchObject({ fullName: 'Ali' });
  });

  it.each([
    ['a blank fullName', { fullName: ' ' }, 'fullName'],
    ['a malformed studentPublicId', { studentPublicId: 'nope' }, 'studentPublicId'],
    ['an unknown field', { classId: randomUUID() }, 'classId'],
  ])('gives VALIDATION_ERROR for %s', async (_name, body, path) => {
    const row = await addStudent({});

    const res = await patchStudent(row.id, body);

    expectError(res, 400, 'VALIDATION_ERROR');
    expect(res.body.error.details.map((detail: { path: string }) => detail.path)).toContain(path);
  });

  it('gives VALIDATION_ERROR for a malformed id', async () => {
    expectError(await patchStudent('not-a-uuid', { fullName: 'X' }), 400, 'VALIDATION_ERROR');
  });
});

describe('DELETE /classes/:classId/students/:id', () => {
  it('deletes the row with its audit trail, and the student loses the class', async () => {
    const row = await linkStudent(student);
    await claim(student);
    await patchStudent(row.id, { studentPublicId: null });
    await patchStudent(row.id, { studentPublicId: publicIdOf(student) });

    const res = await api(teacher).delete(`${rosterPath()}/${row.id}`);

    expect(res.status).toBe(204);
    expect(res.text).toBe('');
    await expect(ClassStudent.findByPk(row.id)).resolves.toBeNull();
    await expect(LinkAudit.count()).resolves.toBe(0);
    await expect(myClasses(student)).resolves.toEqual([]);
    await expect(getActiveClassStudent(student.id, classId)).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('gives 404 NOT_FOUND the second time', async () => {
    const row = await addStudent({});
    await api(teacher).delete(`${rosterPath()}/${row.id}`);

    expectError(await api(teacher).delete(`${rosterPath()}/${row.id}`), 404, 'NOT_FOUND');
  });

  it('gives 404 NOT_FOUND for a row of another class, and keeps it', async () => {
    const other = await createClass(teacher);
    const row = await addStudent({}, other.id);

    expectError(await api(teacher).delete(`${rosterPath()}/${row.id}`), 404, 'NOT_FOUND');
    await expect(ClassStudent.findByPk(row.id)).resolves.not.toBeNull();
  });
});

describe('getActiveClassStudent', () => {
  it('returns the row while the link is active', async () => {
    const row = await linkStudent(student);
    await claim(student);

    await expect(getActiveClassStudent(student.id, classId)).resolves.toMatchObject({
      id: row.id,
      classId,
      studentUserId: student.id,
    });
  });

  it('gives NOT_FOUND while the row awaits the claim', async () => {
    await linkStudent(student);

    await expect(getActiveClassStudent(student.id, classId)).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('gives NOT_FOUND for a claim the teacher has not linked', async () => {
    await addStudent({});
    await claim(student);

    await expect(getActiveClassStudent(student.id, classId)).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('gives NOT_FOUND for another class, even when linked elsewhere', async () => {
    await linkStudent(student);
    await claim(student);
    const other = await createClass(teacher);
    await claim(student, other.publicId);

    await expect(getActiveClassStudent(student.id, other.id)).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('gives NOT_FOUND for a class that does not exist', async () => {
    await expect(getActiveClassStudent(student.id, randomUUID())).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  });
});

describe("another teacher's class", () => {
  let theirs: { id: string; publicId: string };
  let theirRow: RosterRow;

  beforeEach(async () => {
    theirs = await createClass(otherTeacher);
    theirRow = await addStudent({ fullName: 'Theirs' }, theirs.id, otherTeacher);
  });

  it.each([
    ['GET', () => api(teacher).get(rosterPath(theirs.id))],
    ['POST', () => api(teacher).post(rosterPath(theirs.id), { fullName: 'Mine now' })],
    ['PATCH', () => api(teacher).patch(`${rosterPath(theirs.id)}/${theirRow.id}`, { fullName: 'Mine now' })],
    ['DELETE', () => api(teacher).delete(`${rosterPath(theirs.id)}/${theirRow.id}`)],
  ])('gives 404 NOT_FOUND on %s and changes nothing', async (_method, send) => {
    expectError(await send(), 404, 'NOT_FOUND');
    await expect(ClassStudent.findAll({ where: { classId: theirs.id }, raw: true })).resolves.toMatchObject([
      { id: theirRow.id, fullName: 'Theirs' },
    ]);
  });

  it('answers the same as a class that does not exist', async () => {
    const forOther = await api(teacher).get(rosterPath(theirs.id));
    const forMissing = await api(teacher).get(rosterPath(randomUUID()));

    expect(forOther.status).toBe(forMissing.status);
    expect(forOther.body).toEqual(forMissing.body);
  });

  it('does not let the ID lookup run against it', async () => {
    expectError(
      await api(teacher).post(rosterPath(theirs.id), { fullName: 'Ali', studentPublicId: generatePublicId() }),
      404,
      'NOT_FOUND',
    );
  });
});

describe('public-ID lookup rate limit', () => {
  async function exhaust(send: (index: number) => Promise<request.Response>): Promise<void> {
    for (let index = 0; index < 30; index += 1) {
      expect((await send(index)).status).not.toBe(429);
    }
  }

  it('allows 30 roster lookups per user, shared by POST and PATCH, then gives RATE_LIMITED', async () => {
    const row = await addStudent({});

    await exhaust((index) =>
      index % 2 === 0
        ? api(teacher).post(rosterPath(), { fullName: 'Ali', studentPublicId: generatePublicId() })
        : patchStudent(row.id, { studentPublicId: generatePublicId() }),
    );

    const res = await api(teacher).post(rosterPath(), {
      fullName: 'Ali',
      studentPublicId: publicIdOf(student),
    });

    expectError(res, 429, 'RATE_LIMITED');
    expect(Number(res.headers['retry-after'])).toBeGreaterThan(0);
    expect(Number(res.headers['retry-after'])).toBeLessThanOrEqual(600);
    await expect(ClassStudent.count()).resolves.toBe(1);
  });

  it('does not count requests that look nothing up', async () => {
    const row = await addStudent({});

    await exhaust(() => api(teacher).post(rosterPath(), { fullName: 'Ali', studentPublicId: generatePublicId() }));

    await addStudent({ fullName: 'No ID' });
    await addStudent({ fullName: 'Null ID', studentPublicId: null });
    expect((await patchStudent(row.id, { fullName: 'Renamed' })).status).toBe(200);
    expect((await patchStudent(row.id, { studentPublicId: null })).status).toBe(200);
  });

  it('counts per user', async () => {
    await exhaust(() => api(teacher).post(rosterPath(), { fullName: 'Ali', studentPublicId: generatePublicId() }));

    const ownClass = await createClass(otherTeacher);
    await addStudent({ studentPublicId: publicIdOf(student) }, ownClass.id, otherTeacher);
  });

  it('allows 30 claims per user, then gives RATE_LIMITED', async () => {
    await exhaust(() => claim(student, generatePublicId()));

    const res = await claim(student);

    expectError(res, 429, 'RATE_LIMITED');
    expect(res.headers['retry-after']).toBeDefined();
    await expect(ClassClaim.count()).resolves.toBe(0);
    expect((await claim(await createTestUser('student'))).status).toBe(200);
  });
});

describe('access', () => {
  const teacherRoutes = [
    ['GET /classes/:classId/students', (user?: TestUser) => api(user).get(rosterPath(randomUUID()))],
    ['POST /classes/:classId/students', (user?: TestUser) => api(user).post(rosterPath(randomUUID()), { fullName: 'X' })],
    ['PATCH /classes/:classId/students/:id', (user?: TestUser) => api(user).patch(`${rosterPath(randomUUID())}/${randomUUID()}`, { fullName: 'X' })],
    ['DELETE /classes/:classId/students/:id', (user?: TestUser) => api(user).delete(`${rosterPath(randomUUID())}/${randomUUID()}`)],
  ] as const;

  const studentRoutes = [
    ['POST /student/claims', (user?: TestUser) => api(user).post('/api/v1/student/claims', { classPublicId: 'abcd1234' })],
    ['GET /student/classes', (user?: TestUser) => api(user).get('/api/v1/student/classes')],
  ] as const;

  it.each(teacherRoutes)('gives a student 403 FORBIDDEN on %s', async (_route, send) => {
    expectError(await send(student), 403, 'FORBIDDEN');
  });

  it.each(studentRoutes)('gives a teacher 403 FORBIDDEN on %s', async (_route, send) => {
    expectError(await send(teacher), 403, 'FORBIDDEN');
  });

  it.each([...teacherRoutes, ...studentRoutes])('gives no token 401 UNAUTHENTICATED on %s', async (_route, send) => {
    expectError(await send(), 401, 'UNAUTHENTICATED');
  });
});
