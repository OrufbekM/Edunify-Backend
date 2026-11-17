import { randomUUID } from 'node:crypto';

import type request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';

import { ClassGroup, ClassLesson, ClassUnit, Lesson, Unit } from '../../db/models/index.js';
import { resetRateLimits } from '../../middleware/rateLimit.js';
import { useTestDatabase } from '../../test/database.js';
import { api, createTestUser, type TestUser } from '../../test/users.js';

// Class groups (contract 4.1 and 8.3): PATCH /classes/:id with linkedClassIds, the preview,
// and deleting a class of a group.

useTestDatabase();

interface ClassRef {
  id: string;
  publicId: string;
  name: string;
}

interface OutlineLesson {
  id: string;
  unitId: string;
  number: number;
  title: string;
  order: number;
  linked?: boolean;
  visible?: boolean;
}

let teacher: TestUser;
let categoryId: string;
let a: ClassRef;
let b: ClassRef;
let c: ClassRef;

async function createClass(name: string, owner = teacher, inCategory = categoryId): Promise<ClassRef> {
  const res = await api(owner).post('/api/v1/classes', { categoryId: inCategory, name });
  expect(res.status).toBe(201);
  return { id: res.body.id, publicId: res.body.publicId, name };
}

async function outline(forClass: ClassRef, user = teacher) {
  const res = await api(user).get(`/api/v1/classes/${forClass.id}/outline`);
  expect(res.status).toBe(200);
  return res.body as { units: Array<{ id: string; title: string; order: number }>; lessons: OutlineLesson[] };
}

async function unitIds(forClass: ClassRef): Promise<string[]> {
  return (await outline(forClass)).units.map((unit) => unit.id);
}

async function titles(forClass: ClassRef, user = teacher): Promise<string[]> {
  return (await outline(forClass, user)).lessons.map((lesson) => lesson.title);
}

function link(forClass: ClassRef, others: ClassRef[]) {
  return api(teacher).patch(`/api/v1/classes/${forClass.id}`, { linkedClassIds: others.map((other) => other.id) });
}

async function linked(forClass: ClassRef, others: ClassRef[]) {
  const res = await link(forClass, others);
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return res.body;
}

function preview(forClass: ClassRef, others: ClassRef[]) {
  return api(teacher).post(`/api/v1/classes/${forClass.id}/linked-classes/preview`, {
    linkedClassIds: others.map((other) => other.id),
  });
}

async function addUnit(forClass: ClassRef, title: string): Promise<string> {
  const res = await api(teacher).post(`/api/v1/classes/${forClass.id}/units`, { title });
  expect(res.status).toBe(201);
  return res.body.id;
}

async function addLesson(forClass: ClassRef, title: string, options: { unitId?: string; linked?: boolean } = {}) {
  const unitId = options.unitId ?? (await unitIds(forClass))[0];
  const res = await api(teacher).post(`/api/v1/classes/${forClass.id}/lessons`, { title, unitId, linked: options.linked });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body.id as string;
}

async function addHomework(forClass: ClassRef, lessonId: string): Promise<string> {
  const res = await api(teacher).put(`/api/v1/lessons/${lessonId}/homework?classId=${forClass.id}`, { type: 'text' });
  expect(res.status).toBe(200);
  return res.body.homework.id;
}

async function connect(student: TestUser, forClass: ClassRef, fullName = 'Ali'): Promise<string> {
  const row = await api(teacher).post(`/api/v1/classes/${forClass.id}/students`, { fullName, studentPublicId: student.publicId });
  await api(student).post('/api/v1/student/claims', { classPublicId: forClass.publicId });
  return row.body.id;
}

async function submit(student: TestUser, forClass: ClassRef, homeworkId: string, text = 'answer'): Promise<string> {
  const res = await api(student).post(`/api/v1/homeworks/${homeworkId}/submissions?classId=${forClass.id}`, { text });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body.id;
}

async function show(forClass: ClassRef, lessonId: string): Promise<void> {
  const res = await api(teacher).patch(`/api/v1/lessons/${lessonId}?classId=${forClass.id}`, { visible: true });
  expect(res.status).toBe(200);
}

function expectError(res: request.Response, status: number, code: string): void {
  expect(res.status, JSON.stringify(res.body)).toBe(status);
  expect(res.body.error.code).toBe(code);
}

// Everything a class's outline says, for checking that a step changed nothing a teacher sees
// but the ids of copies.
async function shape(forClass: ClassRef) {
  const body = await outline(forClass);
  return {
    units: body.units.map((unit) => unit.title),
    lessons: body.lessons.map(({ title, number, order, visible }) => ({ title, number, order, visible })),
  };
}

beforeEach(async () => {
  await resetRateLimits();
  teacher = await createTestUser('teacher');
  categoryId = (await api(teacher).post('/api/v1/categories', { name: 'Maths' })).body.id;
  a = await createClass('7A');
  b = await createClass('7B');
  c = await createClass('7C');
});

describe('PATCH /classes/:id with linkedClassIds: a new group', () => {
  it("shares every unit in one order, the saving class's first, and keeps every lesson class-only", async () => {
    const [aUnit1] = await unitIds(a);
    const aUnit2 = await addUnit(a, 'Fractions');
    const [bUnit1] = await unitIds(b);
    await addLesson(a, 'A lesson');
    await addLesson(b, 'B lesson');

    const res = await linked(a, [b]);

    expect(res.linkedClasses).toEqual([{ id: b.id, name: '7B' }]);
    expect(await unitIds(a)).toEqual([aUnit1, aUnit2, bUnit1]);
    expect(await unitIds(b)).toEqual([aUnit1, aUnit2, bUnit1]);
    expect((await outline(b)).units.map((unit) => unit.title)).toEqual(['Unit 1', 'Fractions', 'Unit 1']);
    expect(await titles(a)).toEqual(['A lesson']);
    expect(await titles(b)).toEqual(['B lesson']);
    expect((await outline(a)).lessons[0]).toMatchObject({ linked: false, number: 1 });
    await expect(Unit.count({ where: { classId: null } })).resolves.toBe(3);
    await expect(ClassGroup.count()).resolves.toBe(1);
  });

  it('shows linkedClasses on every class of the group, by name, in the list and on each class', async () => {
    await linked(c, [a, b]);

    const list = (await api(teacher).get('/api/v1/classes')).body.items as Array<{ id: string; linkedClasses: unknown }>;

    expect(list.map((item) => item.linkedClasses)).toEqual([
      [{ id: b.id, name: '7B' }, { id: c.id, name: '7C' }],
      [{ id: a.id, name: '7A' }, { id: c.id, name: '7C' }],
      [{ id: a.id, name: '7A' }, { id: b.id, name: '7B' }],
    ]);
    expect((await api(teacher).get(`/api/v1/classes/${b.id}`)).body.linkedClasses).toEqual([
      { id: a.id, name: '7A' },
      { id: c.id, name: '7C' },
    ]);
  });

  it('takes other fields in the same save', async () => {
    const res = await api(teacher).patch(`/api/v1/classes/${a.id}`, { name: '7A maths', linkedClassIds: [b.id] });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ name: '7A maths', linkedClasses: [{ id: b.id, name: '7B' }] });
  });

  it('leaves the group alone when linkedClassIds is left out', async () => {
    await linked(a, [b]);

    expect((await api(teacher).patch(`/api/v1/classes/${a.id}`, { name: 'Renamed' })).body.linkedClasses).toEqual([
      { id: b.id, name: '7B' },
    ]);
  });
});

describe('joining an existing group', () => {
  it("gets the group's units first, then its own, and every linked lesson hidden; the others get its units last", async () => {
    await linked(a, [b]);
    const shared = await unitIds(a);
    const lessonId = await addLesson(a, 'Linked', { linked: true });
    await addLesson(c, 'C own');
    const [cUnit] = await unitIds(c);

    await linked(b, [a, c]);

    expect(await unitIds(c)).toEqual([...shared, cUnit]);
    expect(await unitIds(a)).toEqual([...shared, cUnit]);
    expect((await outline(c)).lessons).toEqual([
      expect.objectContaining({ id: lessonId, title: 'Linked', linked: true, visible: false, number: 1 }),
      expect.objectContaining({ title: 'C own', linked: false, visible: true, number: 2 }),
    ]);
    expect(await titles(a)).toEqual(['Linked']);
  });
});

describe('POST /classes/:id/linked-classes/preview', () => {
  it('counts what each class gets, changes nothing, and matches the save', async () => {
    await linked(a, [b]);
    await addUnit(a, 'Shared 2');
    await addLesson(a, 'Linked', { linked: true });
    for (const title of ['C1', 'C2', 'C3']) {
      await addLesson(c, title);
    }
    const before = await shape(c);

    const res = await preview(a, [b, c]);

    expect(res.status).toBe(200);
    expect(res.body.items).toEqual([
      { classId: a.id, name: '7A', addedUnits: 1, addedLessons: 0, convertedUnits: 0, convertedLessons: 0 },
      { classId: b.id, name: '7B', addedUnits: 1, addedLessons: 0, convertedUnits: 0, convertedLessons: 0 },
      { classId: c.id, name: '7C', addedUnits: 3, addedLessons: 1, convertedUnits: 0, convertedLessons: 0 },
    ]);
    expect(await shape(c)).toEqual(before);

    await linked(a, [b, c]);
    expect((await outline(c)).units).toHaveLength(1 + 3);
    expect((await outline(c)).lessons).toHaveLength(3 + 1);
    expect((await outline(a)).units).toHaveLength(3 + 1);
  });

  it('counts the copies of a dissolve, and the saved result has them', async () => {
    await linked(a, [b]);
    await addLesson(a, 'Linked one', { linked: true });
    await addLesson(a, 'Linked two', { linked: true });

    expect((await preview(a, [])).body.items).toEqual([
      { classId: a.id, name: '7A', addedUnits: 0, addedLessons: 0, convertedUnits: 2, convertedLessons: 2 },
      { classId: b.id, name: '7B', addedUnits: 0, addedLessons: 0, convertedUnits: 2, convertedLessons: 2 },
    ]);

    await linked(a, []);
    for (const forClass of [a, b]) {
      expect((await outline(forClass)).units).toHaveLength(2);
      expect((await outline(forClass)).lessons.map((lesson) => lesson.linked)).toEqual([false, false]);
    }
  });

  it('gives an empty list when nothing would change, and the save errors for the same input', async () => {
    expect((await preview(a, [])).body).toEqual({ items: [] });

    await linked(b, [c]);
    const elsewhere = await preview(a, [b]);

    expectError(elsewhere, 409, 'CLASS_IN_OTHER_GROUP');
    expect((await link(a, [b])).body).toEqual(elsewhere.body);
  });
});

describe('leaving a group', () => {
  it('keeps every unit and linked lesson as class-only copies, in the same places, with the work and grades moved over', async () => {
    await linked(a, [b, c]);
    const linkedId = await addLesson(a, 'Linked');
    await api(teacher).patch(`/api/v1/lessons/${linkedId}?classId=${a.id}`, { linked: true });
    const homeworkId = await addHomework(a, linkedId);
    await addLesson(b, 'B own', { unitId: (await unitIds(b))[1] });
    await show(b, linkedId);
    const student = await createTestUser('student');
    const rowId = await connect(student, b);
    const submissionId = await submit(student, b, homeworkId);
    await api(teacher).put(`/api/v1/submissions/${submissionId}/grade`, { value: 4, comment: 'Good' });
    const before = await shape(b);
    const sharedBefore = await unitIds(b);

    await linked(a, [c]);

    expect(await shape(b)).toEqual(before);
    const after = await outline(b);
    expect(after.units.map((unit) => unit.id).some((id) => sharedBefore.includes(id))).toBe(false);
    expect(after.lessons.every((lesson) => lesson.linked === false)).toBe(true);
    const copy = after.lessons.find((lesson) => lesson.title === 'Linked') as OutlineLesson;
    expect(copy.id).not.toBe(linkedId);

    const submission = (await api(teacher).get(`/api/v1/submissions/${submissionId}`)).body;
    expect(submission).toMatchObject({ lessonId: copy.id, classId: b.id, classStudentId: rowId, grade: { value: 4, comment: 'Good' } });
    expect((await api(student).get(`/api/v1/lessons/${copy.id}?classId=${b.id}`)).body.mySubmission).toMatchObject({
      id: submissionId,
    });
    expect((await api(teacher).get(`/api/v1/classes/${b.id}/journal`)).body.rows[0].cells).toEqual([
      { lessonId: copy.id, status: 'graded', value: 4, submissionId },
    ]);

    // The group goes on without it, with the original lesson.
    expect(await unitIds(a)).toEqual(sharedBefore);
    expect((await outline(c)).lessons).toEqual([expect.objectContaining({ id: linkedId, linked: true })]);
    expect((await api(teacher).get(`/api/v1/classes/${b.id}`)).body.linkedClasses).toEqual([]);
    expect((await api(teacher).get(`/api/v1/classes/${a.id}`)).body.linkedClasses).toEqual([{ id: c.id, name: '7C' }]);
  });

  it('dissolves a group left with one class: it gets copies too, with its work, and the group is gone', async () => {
    await linked(a, [b]);
    const lessonId = await addLesson(a, 'Linked', { linked: true });
    const homeworkId = await addHomework(a, lessonId);
    const student = await createTestUser('student');
    await connect(student, a);
    const submissionId = await submit(student, a, homeworkId);
    await api(teacher).put(`/api/v1/submissions/${submissionId}/grade`, { denied: true, comment: 'Redo' });
    const before = { a: await shape(a), b: await shape(b) };

    await linked(b, []);

    expect({ a: await shape(a), b: await shape(b) }).toEqual(before);
    const copy = (await outline(a)).lessons[0] as OutlineLesson;
    expect(copy.id).not.toBe(lessonId);
    expect((await api(student).get(`/api/v1/submissions/${submissionId}`)).body).toMatchObject({
      lessonId: copy.id,
      status: 'denied',
      grade: { denied: true, comment: 'Redo' },
    });
    await expect(ClassGroup.count()).resolves.toBe(0);
    await expect(Unit.count({ where: { classId: null } })).resolves.toBe(0);
    await expect(Lesson.count({ where: { classId: null } })).resolves.toBe(0);
    expect((await api(teacher).get(`/api/v1/classes/${a.id}`)).body.linkedClasses).toEqual([]);
  });

  it('deletes a linked lesson that only the leaving class held', async () => {
    await linked(a, [b, c]);
    const onlyA = await addLesson(a, 'Only A', { linked: true });
    for (const forClass of [b, c]) {
      expect((await api(teacher).delete(`/api/v1/lessons/${onlyA}?classId=${forClass.id}`)).status).toBe(204);
    }

    await linked(b, [c]);

    await expect(Lesson.findByPk(onlyA)).resolves.toBeNull();
    expect(await titles(a)).toEqual(['Only A']);
  });
});

describe('errors', () => {
  it('gives CLASS_IN_OTHER_GROUP for a class in another group and changes nothing', async () => {
    const d = await createClass('7D');
    await linked(a, [b]);
    await linked(c, [d]);

    expectError(await link(a, [b, c]), 409, 'CLASS_IN_OTHER_GROUP');
    expectError(await link(d, [b]), 409, 'CLASS_IN_OTHER_GROUP');
    expect((await api(teacher).get(`/api/v1/classes/${a.id}`)).body.linkedClasses).toEqual([{ id: b.id, name: '7B' }]);
  });

  it.each([
    ['the class itself', () => [a.id], 'linkedClassIds'],
    ['the same id twice', () => [b.id, b.id], 'linkedClassIds'],
    ['more than 9 ids', () => Array.from({ length: 10 }, () => randomUUID()), 'linkedClassIds'],
  ])('gives VALIDATION_ERROR for %s', async (_case, ids, path) => {
    const res = await api(teacher).patch(`/api/v1/classes/${a.id}`, { linkedClassIds: ids() });

    expectError(res, 400, 'VALIDATION_ERROR');
    expect(res.body.error.details.map((detail: { path: string }) => detail.path)).toContain(path);
  });

  it("answers another teacher's class like a missing one, and changes nothing", async () => {
    const other = await createTestUser('teacher');
    const otherCategory = (await api(other).post('/api/v1/categories', { name: 'Theirs' })).body.id;
    const theirs = await createClass('Theirs', other, otherCategory);
    const missing = await api(teacher).patch(`/api/v1/classes/${a.id}`, { linkedClassIds: [randomUUID()] });

    expectError(missing, 404, 'NOT_FOUND');
    expect((await link(a, [theirs])).body).toEqual(missing.body);
    expect((await preview(a, [theirs])).body).toEqual(missing.body);
    await expect(ClassGroup.count()).resolves.toBe(0);
  });

  it('takes 10 classes in a group; an 11th is more than linkedClassIds can name', async () => {
    const more = [];
    for (let index = 0; index < 7; index += 1) {
      more.push(await createClass(`Extra ${index}`));
    }

    const res = await linked(a, [b, c, ...more]);

    expect(res.linkedClasses).toHaveLength(9);
    const eleventh = await createClass('Eleventh');
    expectError(await link(a, [b, c, ...more, eleventh]), 400, 'VALIDATION_ERROR');
  });

  it('gives LIMIT_REACHED with every class when the group would hold over 100 units, and changes nothing', async () => {
    const units = await Unit.bulkCreate(Array.from({ length: 99 }, (_, index) => ({ classId: b.id, groupId: null, title: `U${index}` })));
    await ClassUnit.bulkCreate(units.map((unit, index) => ({ classId: b.id, unitId: unit.id, position: index + 1 })));

    const res = await link(a, [b]);

    expectError(res, 409, 'LIMIT_REACHED');
    expect(res.body.error.details).toEqual({ classIds: [a.id, b.id].sort() });
    await expect(ClassGroup.count()).resolves.toBe(0);
  });

  it('gives LIMIT_REACHED naming the joining class that would hold over 500 lessons', async () => {
    await linked(a, [b]);
    await addLesson(a, 'Linked', { linked: true });
    const [unitId] = await unitIds(c);
    const lessons = await Lesson.bulkCreate(
      Array.from({ length: 500 }, (_, index) => ({ classId: c.id, groupId: null, unitId: unitId as string, title: `L${index}`, position: null, lessonFileId: null })),
    );
    await ClassLesson.bulkCreate(lessons.map((lesson, index) => ({ classId: c.id, lessonId: lesson.id, position: index })));

    const res = await link(a, [b, c]);

    expectError(res, 409, 'LIMIT_REACHED');
    expect(res.body.error.details).toEqual({ classIds: [c.id] });
    expect((await api(teacher).get(`/api/v1/classes/${a.id}`)).body.linkedClasses).toEqual([{ id: b.id, name: '7B' }]);
  });
});

describe('DELETE /classes/:id in a group', () => {
  it('leaves without copies: linked lessons only it held go, the rest stay with the group', async () => {
    await linked(a, [b, c]);
    const onlyA = await addLesson(a, 'Only A', { linked: true });
    const everywhere = await addLesson(a, 'Everywhere', { linked: true });
    for (const forClass of [b, c]) {
      await api(teacher).delete(`/api/v1/lessons/${onlyA}?classId=${forClass.id}`);
    }

    expect((await api(teacher).delete(`/api/v1/classes/${a.id}`)).status).toBe(204);

    await expect(Lesson.findByPk(onlyA)).resolves.toBeNull();
    expect((await outline(b)).lessons).toEqual([expect.objectContaining({ id: everywhere, linked: true })]);
    expect((await api(teacher).get(`/api/v1/classes/${b.id}`)).body.linkedClasses).toEqual([{ id: c.id, name: '7C' }]);
  });

  it('dissolves a group left with one class, which keeps copies of everything', async () => {
    await linked(a, [b]);
    await addLesson(a, 'Linked', { linked: true });
    const student = await createTestUser('student');
    await connect(student, a);
    const before = await shape(b);

    expect((await api(teacher).delete(`/api/v1/classes/${a.id}`)).status).toBe(204);

    expect(await shape(b)).toEqual(before);
    await expect(ClassGroup.count()).resolves.toBe(0);
    await expect(Unit.count({ where: { classId: null } })).resolves.toBe(0);
    expect((await api(teacher).get(`/api/v1/classes/${b.id}`)).body.linkedClasses).toEqual([]);
  });

  it("removes the deleted class's student work on linked lessons and keeps the other classes'", async () => {
    await linked(a, [b, c]);
    const lessonId = await addLesson(a, 'Linked', { linked: true });
    const homeworkId = await addHomework(a, lessonId);
    await show(b, lessonId);
    const [inA, inB] = [await createTestUser('student'), await createTestUser('student')];
    await connect(inA, a);
    await connect(inB, b);
    await submit(inA, a, homeworkId);
    const kept = await submit(inB, b, homeworkId);

    await api(teacher).delete(`/api/v1/classes/${a.id}`);

    expect((await api(teacher).get(`/api/v1/lessons/${lessonId}/impact?classId=${b.id}`)).body.classes).toEqual([
      { id: b.id, name: '7B', submissionCount: 1 },
      { id: c.id, name: '7C', submissionCount: 0 },
    ]);
    expect((await api(teacher).get(`/api/v1/submissions/${kept}`)).status).toBe(200);
  });
});
