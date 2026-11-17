import { randomUUID } from 'node:crypto';

import type request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { env } from '../../config/env.js';
import { AiJob, ClassLesson, ClassUnit, FileRecord, Lesson, SchoolClass, Submission, Unit } from '../../db/models/index.js';
import { resetRateLimits } from '../../middleware/rateLimit.js';
import { useTestDatabase } from '../../test/database.js';
import { getFile, isStored } from '../../test/files.js';
import { api, createTestUser, type TestUser } from '../../test/users.js';

// Linked lessons and group units (contract 4.1, 8.6 and 8.7): content shared by a class
// group, with visibility, slots and student work per class.

useTestDatabase();

const MD = Buffer.from('# Notes\n');

interface ClassRef {
  id: string;
  publicId: string;
  name: string;
}

interface Summary {
  id: string;
  unitId: string;
  number: number;
  title: string;
  order: number;
  linked?: boolean;
  visible?: boolean;
}

let teacher: TestUser;
let a: ClassRef;
let b: ClassRef;
// The group's first unit (A's Unit 1) and second (B's Unit 1).
let unit1: string;
let unit2: string;

const realKey = env.ANTHROPIC_API_KEY;

async function createClass(name: string): Promise<ClassRef> {
  const category = await api(teacher).post('/api/v1/categories', { name: `C ${randomUUID()}` });
  const res = await api(teacher).post('/api/v1/classes', { categoryId: category.body.id, name });
  return { id: res.body.id, publicId: res.body.publicId, name };
}

async function outline(forClass: ClassRef, user = teacher) {
  const res = await api(user).get(`/api/v1/classes/${forClass.id}/outline`);
  expect(res.status).toBe(200);
  return res.body as { units: Array<{ id: string; title: string; order: number }>; lessons: Summary[] };
}

async function titles(forClass: ClassRef, user = teacher): Promise<string[]> {
  return (await outline(forClass, user)).lessons.map((lesson) => lesson.title);
}

const lessonPath = (lessonId: string, forClass: ClassRef) => `/api/v1/lessons/${lessonId}?classId=${forClass.id}`;

async function addLesson(forClass: ClassRef, title: string, options: { unitId?: string; linked?: boolean } = {}) {
  const res = await api(teacher).post(`/api/v1/classes/${forClass.id}/lessons`, {
    title,
    unitId: options.unitId ?? unit1,
    ...(options.linked === undefined ? {} : { linked: options.linked }),
  });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body.id as string;
}

async function patchLesson(lessonId: string, forClass: ClassRef, body: object) {
  const res = await api(teacher).patch(lessonPath(lessonId, forClass), body);
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return res.body;
}

async function addHomework(lessonId: string, forClass = a): Promise<string> {
  const res = await api(teacher).put(`/api/v1/lessons/${lessonId}/homework?classId=${forClass.id}`, { type: 'text' });
  expect(res.status).toBe(200);
  return res.body.homework.id;
}

async function connect(student: TestUser, forClass: ClassRef, fullName = 'Ali'): Promise<string> {
  const row = await api(teacher).post(`/api/v1/classes/${forClass.id}/students`, { fullName, studentPublicId: student.publicId });
  await api(student).post('/api/v1/student/claims', { classPublicId: forClass.publicId });
  return row.body.id;
}

async function submit(student: TestUser, forClass: ClassRef, homeworkId: string): Promise<string> {
  const res = await api(student).post(`/api/v1/homeworks/${homeworkId}/submissions?classId=${forClass.id}`, { text: 'answer' });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body.id;
}

function expectError(res: request.Response, status: number, code: string): void {
  expect(res.status, JSON.stringify(res.body)).toBe(status);
  expect(res.body.error.code).toBe(code);
}

// A linked lesson with homework, shown in both classes, and one connected student in each.
async function sharedHomework(title = 'Shared') {
  const lessonId = await addLesson(a, title, { linked: true });
  const homeworkId = await addHomework(lessonId);
  await patchLesson(lessonId, b, { visible: true });
  const [inA, inB] = [await createTestUser('student'), await createTestUser('student')];
  await connect(inA, a);
  await connect(inB, b);
  return { lessonId, homeworkId, inA, inB };
}

// Rows written straight to the database, to reach a cap without 500 requests.
async function fillLessons(forClass: ClassRef, count: number): Promise<void> {
  const lessons = await Lesson.bulkCreate(
    Array.from({ length: count }, (_, index) => ({
      classId: forClass.id,
      groupId: null,
      unitId: unit2,
      title: `Filler ${index}`,
      position: null,
      lessonFileId: null,
    })),
  );
  await ClassLesson.bulkCreate(lessons.map((lesson, index) => ({ classId: forClass.id, lessonId: lesson.id, position: index })));
}

beforeEach(async () => {
  await resetRateLimits();
  teacher = await createTestUser('teacher');
  a = await createClass('7A');
  b = await createClass('7B');
  const res = await api(teacher).patch(`/api/v1/classes/${a.id}`, { linkedClassIds: [b.id] });
  expect(res.status).toBe(200);
  [unit1, unit2] = (await outline(a)).units.map((unit) => unit.id) as [string, string];
});

afterEach(() => {
  env.ANTHROPIC_API_KEY = realKey;
});

describe('linked lessons in the outline', () => {
  it('follows the contract 4.1 example: linked lesson1 and lesson3, and class A\'s lesson2 at slot 1', async () => {
    await addLesson(a, 'lesson1', { linked: true });
    await addLesson(a, 'lesson2');
    await addLesson(a, 'lesson3', { linked: true });

    expect((await outline(a)).lessons.map(({ title, number, order, linked }) => ({ title, number, order, linked }))).toEqual([
      { title: 'lesson1', number: 1, order: 0, linked: true },
      { title: 'lesson2', number: 2, order: 1, linked: false },
      { title: 'lesson3', number: 3, order: 2, linked: true },
    ]);
    expect((await outline(b)).lessons.map(({ title, number, order }) => ({ title, number, order }))).toEqual([
      { title: 'lesson1', number: 1, order: 0 },
      { title: 'lesson3', number: 2, order: 1 },
    ]);
  });

  it('is visible where it was made and hidden in the other classes; visibility stays per class', async () => {
    const lessonId = await addLesson(a, 'Shared', { linked: true });
    const student = await createTestUser('student');
    await connect(student, b);

    expect((await outline(b)).lessons).toEqual([expect.objectContaining({ id: lessonId, linked: true, visible: false })]);
    expect(await titles(b, student)).toEqual([]);
    expectError(await api(student).get(lessonPath(lessonId, b)), 404, 'NOT_FOUND');

    await patchLesson(lessonId, b, { visible: true });
    await patchLesson(lessonId, a, { visible: false });

    expect(await titles(b, student)).toEqual(['Shared']);
    expect((await outline(a)).lessons[0]).toMatchObject({ visible: false });
  });

  it('takes edits to its title, file and homework in every class', async () => {
    const lessonId = await addLesson(a, 'Old title', { linked: true });

    await patchLesson(lessonId, b, { title: 'New title' });
    await api(teacher).upload(`/api/v1/lessons/${lessonId}/lesson-file?classId=${b.id}`, MD, 'notes.md');
    await api(teacher).put(`/api/v1/lessons/${lessonId}/homework?classId=${b.id}`, { type: 'code', instructionsText: 'Build it' });

    const inA = (await api(teacher).get(lessonPath(lessonId, a))).body;
    expect(inA).toMatchObject({
      title: 'New title',
      linked: true,
      lessonFile: { name: 'notes.md' },
      homework: { type: 'code', instructionsText: 'Build it' },
    });
  });
});

describe('moving a linked lesson', () => {
  it('moves it in every class, within its unit and to another unit', async () => {
    const [l1, l2, l3] = [
      await addLesson(a, 'L1', { linked: true }),
      await addLesson(a, 'L2', { linked: true }),
      await addLesson(a, 'L3', { linked: true }),
    ];

    await patchLesson(l3, a, { order: 0 });
    expect(await titles(a)).toEqual(['L3', 'L1', 'L2']);
    expect(await titles(b)).toEqual(['L3', 'L1', 'L2']);

    await patchLesson(l1, b, { unitId: unit2, order: 0 });
    for (const forClass of [a, b]) {
      const lessons = (await outline(forClass)).lessons;
      expect(lessons.map(({ id, unitId, number }) => ({ id, unitId, number }))).toEqual([
        { id: l3, unitId: unit1, number: 1 },
        { id: l2, unitId: unit1, number: 2 },
        { id: l1, unitId: unit2, number: 3 },
      ]);
    }
    await expect(Lesson.findAll({ where: { unitId: unit1 }, order: [['position', 'ASC']], attributes: ['id', 'position'], raw: true })).resolves.toEqual([
      { id: l3, position: 0 },
      { id: l2, position: 1 },
    ]);
  });

  it("lands right after the linked lesson before it in this class's list; class-only lessons keep their slots", async () => {
    await addLesson(a, 'L1', { linked: true });
    await addLesson(a, 'Own');
    await addLesson(a, 'L2', { linked: true });
    const l3 = await addLesson(a, 'L3', { linked: true });

    await patchLesson(l3, a, { order: 1 });

    expect(await titles(a)).toEqual(['L1', 'Own', 'L3', 'L2']);
    expect(await titles(b)).toEqual(['L1', 'L3', 'L2']);
  });
});

describe('PATCH /lessons/:id with linked', () => {
  it('links a class-only lesson where it is, and adds it hidden to every other class', async () => {
    await addLesson(a, 'Before');
    const own = await addLesson(a, 'Own');
    await addLesson(a, 'After');

    const res = await patchLesson(own, a, { linked: true });

    expect(res).toMatchObject({ id: own, linked: true, order: 1, number: 2 });
    expect(await titles(a)).toEqual(['Before', 'Own', 'After']);
    expect((await outline(b)).lessons).toEqual([expect.objectContaining({ id: own, linked: true, visible: false })]);
  });

  it('unlinks into a class-only copy at the same place, with this class\'s work; the other class keeps the original and its work', async () => {
    await addLesson(a, 'First', { linked: true });
    const { lessonId, homeworkId, inA, inB } = await sharedHomework('Shared');
    const fromA = await submit(inA, a, homeworkId);
    const fromB = await submit(inB, b, homeworkId);

    const copy = await patchLesson(lessonId, a, { linked: false, title: 'Renamed copy' });

    expect(copy).toMatchObject({ linked: false, number: 2, order: 1, title: 'Renamed copy', homework: { type: 'text' } });
    expect(copy.id).not.toBe(lessonId);
    expect(copy.homework.id).not.toBe(homeworkId);
    await expect(Submission.findByPk(fromA)).resolves.toMatchObject({ homeworkId: copy.homework.id });
    await expect(Submission.findByPk(fromB)).resolves.toMatchObject({ homeworkId });
    expect((await outline(b)).lessons.map(({ id, title, linked }) => ({ id, title, linked }))).toEqual([
      expect.objectContaining({ title: 'First' }),
      { id: lessonId, title: 'Shared', linked: true },
    ]);
    expect((await api(inA).get(lessonPath(copy.id, a))).body.mySubmission).toMatchObject({ id: fromA });
  });

  it('deletes the original when the class that unlinks it was the last one holding it', async () => {
    const lessonId = await addLesson(a, 'Shared', { linked: true });
    expect((await api(teacher).delete(lessonPath(lessonId, b))).status).toBe(204);

    const copy = await patchLesson(lessonId, a, { linked: false });

    await expect(Lesson.findByPk(lessonId)).resolves.toBeNull();
    expect(await titles(a)).toEqual(['Shared']);
    expect(copy.linked).toBe(false);
  });

  it('gives VALIDATION_ERROR for linked: true once the class has left its group', async () => {
    const own = await addLesson(a, 'Own');
    await api(teacher).patch(`/api/v1/classes/${a.id}`, { linkedClassIds: [] });

    const res = await api(teacher).patch(lessonPath(own, a), { linked: true });

    expectError(res, 400, 'VALIDATION_ERROR');
    expect(res.body.error.details[0].path).toBe('linked');
  });
});

describe('DELETE /lessons/:id on a linked lesson', () => {
  it("scope=class takes it and this class's work out of this class only; from the last class it is deleted", async () => {
    const { lessonId, homeworkId, inA, inB } = await sharedHomework();
    const fromA = await submit(inA, a, homeworkId);
    const fromB = await submit(inB, b, homeworkId);
    expect((await api(teacher).get(`/api/v1/lessons/${lessonId}/impact?classId=${a.id}`)).body.classes).toEqual([
      { id: a.id, name: '7A', submissionCount: 1 },
      { id: b.id, name: '7B', submissionCount: 1 },
    ]);

    expect((await api(teacher).delete(lessonPath(lessonId, a))).status).toBe(204);

    expect(await titles(a)).toEqual([]);
    await expect(Submission.findByPk(fromA)).resolves.toBeNull();
    await expect(Submission.findByPk(fromB)).resolves.not.toBeNull();
    expect((await api(teacher).get(`/api/v1/lessons/${lessonId}/impact?classId=${b.id}`)).body.classes).toEqual([
      { id: b.id, name: '7B', submissionCount: 1 },
    ]);

    expect((await api(teacher).delete(`${lessonPath(lessonId, b)}&scope=class`)).status).toBe(204);
    await expect(Lesson.findByPk(lessonId)).resolves.toBeNull();
  });

  it('scope=all deletes it and its work in every class, and the linked order closes up', async () => {
    const first = await addLesson(a, 'First', { linked: true });
    const { lessonId, homeworkId, inA, inB } = await sharedHomework();
    const last = await addLesson(a, 'Last', { linked: true });
    await submit(inA, a, homeworkId);
    await submit(inB, b, homeworkId);

    expect((await api(teacher).delete(`${lessonPath(lessonId, b)}&scope=all`)).status).toBe(204);

    expect(await titles(a)).toEqual(['First', 'Last']);
    expect(await titles(b)).toEqual(['First', 'Last']);
    await expect(Submission.count()).resolves.toBe(0);
    await expect(Lesson.findAll({ where: { id: [first, last] }, order: [['position', 'ASC']], attributes: ['position'], raw: true })).resolves.toEqual([
      { position: 0 },
      { position: 1 },
    ]);
  });
});

describe('units of a group', () => {
  it('creates, renames and moves a unit in every class', async () => {
    const res = await api(teacher).post(`/api/v1/classes/${b.id}/units`, { title: 'Geometry' });
    expect(res.body).toMatchObject({ classId: b.id, title: 'Geometry', order: 2 });
    const unitId = res.body.id as string;

    await api(teacher).patch(`/api/v1/units/${unitId}?classId=${a.id}`, { title: 'Shapes', order: 0 });

    for (const forClass of [a, b]) {
      expect((await outline(forClass)).units.map(({ id, title }) => ({ id, title }))).toEqual([
        { id: unitId, title: 'Shapes' },
        { id: unit1, title: 'Unit 1' },
        { id: unit2, title: 'Unit 1' },
      ]);
    }
    await expect(Unit.findByPk(unitId)).resolves.toMatchObject({ classId: null });
  });

  it('gives UNIT_NOT_EMPTY while any class has a lesson in it, then deletes it from every class', async () => {
    const own = await addLesson(b, 'B own', { unitId: unit2 });

    expectError(await api(teacher).delete(`/api/v1/units/${unit2}?classId=${a.id}`), 409, 'UNIT_NOT_EMPTY');

    await api(teacher).delete(lessonPath(own, b));
    expect((await api(teacher).delete(`/api/v1/units/${unit2}?classId=${a.id}`)).status).toBe(204);
    for (const forClass of [a, b]) {
      expect((await outline(forClass)).units.map((unit) => unit.id)).toEqual([unit1]);
    }
  });

  it('gives LAST_UNIT naming every class of the group', async () => {
    await api(teacher).delete(`/api/v1/units/${unit2}?classId=${a.id}`);

    const res = await api(teacher).delete(`/api/v1/units/${unit1}?classId=${b.id}`);

    expectError(res, 409, 'LAST_UNIT');
    expect(res.body.error.details).toEqual({ classIds: [a.id, b.id].sort() });
  });
});

describe('caps across a group (contract 2.7)', () => {
  it('gives LIMIT_REACHED naming the class that a linked lesson would push over 500', async () => {
    await fillLessons(b, 500);

    const linked = await api(teacher).post(`/api/v1/classes/${a.id}/lessons`, { title: 'Linked', unitId: unit1, linked: true });
    expectError(linked, 409, 'LIMIT_REACHED');
    expect(linked.body.error.details).toEqual({ classIds: [b.id] });

    const own = await addLesson(a, 'Own');
    const linking = await api(teacher).patch(lessonPath(own, a), { linked: true });
    expectError(linking, 409, 'LIMIT_REACHED');
    expect(linking.body.error.details).toEqual({ classIds: [b.id] });
    expect((await outline(a)).lessons).toEqual([expect.objectContaining({ id: own, linked: false })]);
  });

  it('gives LIMIT_REACHED with every class for a 101st unit, and for a class-only lesson names its class', async () => {
    const { groupId } = (await SchoolClass.findByPk(a.id)) as SchoolClass;
    const units = await Unit.bulkCreate(Array.from({ length: 98 }, (_, index) => ({ classId: null, groupId, title: `Filler ${index}` })));
    await ClassUnit.bulkCreate(
      [a, b].flatMap((forClass) => units.map((unit, index) => ({ classId: forClass.id, unitId: unit.id, position: index + 2 }))),
    );

    const unit = await api(teacher).post(`/api/v1/classes/${a.id}/units`, { title: 'One too many' });
    expectError(unit, 409, 'LIMIT_REACHED');
    expect(unit.body.error.details).toEqual({ classIds: [a.id, b.id].sort() });

    await fillLessons(a, 500);
    const lesson = await api(teacher).post(`/api/v1/classes/${a.id}/lessons`, { title: 'Own', unitId: unit1 });
    expectError(lesson, 409, 'LIMIT_REACHED');
    expect(lesson.body.error.details).toEqual({ classIds: [a.id] });
  });
});

describe('student work on a linked lesson stays per class', () => {
  it('locks the homework type once any class has a submission, and deleting the homework clears every class', async () => {
    const { lessonId, homeworkId, inB } = await sharedHomework();
    await submit(inB, b, homeworkId);

    expectError(await api(teacher).put(`/api/v1/lessons/${lessonId}/homework?classId=${a.id}`, { type: 'draw' }), 409, 'HOMEWORK_TYPE_LOCKED');

    expect((await api(teacher).delete(`/api/v1/lessons/${lessonId}/homework?classId=${a.id}`)).status).toBe(200);
    await expect(Submission.count()).resolves.toBe(0);
  });

  it("gives each class its own counts, grading and journal", async () => {
    const { lessonId, homeworkId, inA, inB } = await sharedHomework();
    await submit(inA, a, homeworkId);
    await submit(inB, b, homeworkId);
    await submit(inB, b, homeworkId);

    for (const forClass of [a, b]) {
      expect((await api(teacher).get(`/api/v1/classes/${forClass.id}`)).body.newSubmissionCount).toBe(1);
      expect((await outline(forClass)).lessons[0]).toMatchObject({ newSubmissionCount: 1 });
      const grading = (await api(teacher).get(`/api/v1/lessons/${lessonId}/grading?classId=${forClass.id}`)).body;
      expect(grading.items).toHaveLength(1);
      expect(grading.items[0].submission.classId).toBe(forClass.id);
    }
  });

  it('runs AI jobs for the same lesson in two classes side by side, one per class', async () => {
    env.ANTHROPIC_API_KEY = 'test-key';
    const { lessonId, homeworkId, inA, inB } = await sharedHomework();
    const fromA = await submit(inA, a, homeworkId);
    const fromB = await submit(inB, b, homeworkId);
    const start = (forClass: ClassRef) => api(teacher).post(`/api/v1/lessons/${lessonId}/ai-grade?classId=${forClass.id}`);

    const inClassA = await start(a);
    const inClassB = await start(b);

    expect(inClassA.status).toBe(202);
    expect(inClassB.status).toBe(202);
    expect(inClassA.body).toMatchObject({ classId: a.id, lessonId, total: 1 });
    expect(inClassB.body).toMatchObject({ classId: b.id, lessonId, total: 1 });
    const again = await start(a);
    expectError(again, 409, 'AI_JOB_ACTIVE');
    expect(again.body.error.details).toEqual({ jobId: inClassA.body.id });
    await expect(AiJob.findByPk(inClassA.body.id)).resolves.toMatchObject({ submissionIds: [fromA] });
    await expect(AiJob.findByPk(inClassB.body.id)).resolves.toMatchObject({ submissionIds: [fromB] });
  });
});

describe('files shared by copies', () => {
  it('stay until the last lesson that uses them is gone', async () => {
    const lessonId = await addLesson(a, 'Shared', { linked: true });
    await addHomework(lessonId);
    await api(teacher).upload(`/api/v1/lessons/${lessonId}/lesson-file?classId=${a.id}`, MD, 'notes.md');
    await api(teacher).upload(`/api/v1/lessons/${lessonId}/homework/file?classId=${a.id}`, MD, 'task.md');
    const copy = await patchLesson(lessonId, b, { linked: false });
    const files = await FileRecord.findAll();
    expect(files).toHaveLength(2);

    expect((await api(teacher).delete(`${lessonPath(lessonId, a)}&scope=all`)).status).toBe(204);

    for (const file of files) {
      await expect(isStored(file.storageKey)).resolves.toBe(true);
    }
    const detail = (await api(teacher).get(lessonPath(copy.id, b))).body;
    expect((await getFile(detail.lessonFile.url)).body).toEqual(MD);

    // The copy was the last lesson using them: deleting it removes them.
    expect((await api(teacher).delete(lessonPath(copy.id, b))).status).toBe(204);
    await expect(FileRecord.count()).resolves.toBe(0);
    for (const file of files) {
      await expect(isStored(file.storageKey)).resolves.toBe(false);
    }
  });

  it('keep a file the copy still uses when the original replaces or removes it', async () => {
    const lessonId = await addLesson(a, 'Shared', { linked: true });
    await api(teacher).upload(`/api/v1/lessons/${lessonId}/lesson-file?classId=${a.id}`, MD, 'notes.md');
    const copy = await patchLesson(lessonId, b, { linked: false });
    const [file] = await FileRecord.findAll();

    expect((await api(teacher).delete(`/api/v1/lessons/${lessonId}/lesson-file?classId=${a.id}`)).status).toBe(200);

    await expect(isStored((file as FileRecord).storageKey)).resolves.toBe(true);
    expect((await api(teacher).get(lessonPath(copy.id, b))).body.lessonFile).toMatchObject({ name: 'notes.md' });
  });
});
