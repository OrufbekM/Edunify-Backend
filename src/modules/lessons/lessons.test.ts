import { randomUUID } from 'node:crypto';

import type request from 'supertest';
import { QueryTypes } from 'sequelize';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { sequelize } from '../../db/index.js';
import { ClassLesson, ClassUnit, Homework, Lesson, Submission, Unit } from '../../db/models/index.js';
import { resetRateLimits } from '../../middleware/rateLimit.js';
import { useTestDatabase } from '../../test/database.js';
import { api, createTestUser, type TestUser } from '../../test/users.js';
import { mergeUnit, type Mergeable } from './placements.js';

useTestDatabase();

afterEach(() => {
  vi.restoreAllMocks();
});

const UNIT_KEYS = ['classId', 'id', 'order', 'title'];
const TEACHER_SUMMARY_KEYS = ['homeworkType', 'id', 'linked', 'newSubmissionCount', 'number', 'order', 'title', 'unitId', 'visible'];
const STUDENT_SUMMARY_KEYS = ['homeworkType', 'id', 'number', 'order', 'title', 'unitId'];
const TEACHER_DETAIL_KEYS = ['classId', 'homework', 'id', 'lessonFile', 'linked', 'number', 'order', 'title', 'unitId', 'visible'];

interface ClassRef {
  id: string;
  publicId: string;
  // Its first unit, Unit 1.
  unitId: string;
}

let teacher: TestUser;
let otherTeacher: TestUser;
let student: TestUser;
let schoolClass: ClassRef;

async function createClass(user: TestUser): Promise<ClassRef> {
  const category = await api(user).post('/api/v1/categories', { name: `C ${randomUUID()}` });
  const res = await api(user).post('/api/v1/classes', { categoryId: category.body.id, name: 'Maths' });
  expect(res.status).toBe(201);

  const outlineRes = await api(user).get(`/api/v1/classes/${res.body.id}/outline`);
  return { id: res.body.id, publicId: res.body.publicId, unitId: outlineRes.body.units[0].id };
}

beforeEach(async () => {
  await resetRateLimits();
  teacher = await createTestUser('teacher');
  otherTeacher = await createTestUser('teacher');
  student = await createTestUser('student');
  schoolClass = await createClass(teacher);
});

function expectError(res: request.Response, status: number, code: string): void {
  expect(res.status).toBe(status);
  expect(res.body.error.code).toBe(code);
}

function detailPaths(res: request.Response): string[] {
  return res.body.error.details.map((detail: { path: string }) => detail.path);
}

const inClass = (forClass = schoolClass.id) => `?classId=${forClass}`;

// Teacher adds the student's ID, student enters the class ID (contract 6.2).
async function connect(user: TestUser, forClass = schoolClass, owner = teacher): Promise<string> {
  const row = await api(owner).post(`/api/v1/classes/${forClass.id}/students`, {
    fullName: 'Ali',
    studentPublicId: user.publicId,
  });
  expect(row.status).toBe(201);
  expect((await api(user).post('/api/v1/student/claims', { classPublicId: forClass.publicId })).status).toBe(200);
  return row.body.id;
}

async function addUnit(title: string, forClass = schoolClass.id, user = teacher): Promise<string> {
  const res = await api(user).post(`/api/v1/classes/${forClass}/units`, { title });
  expect(res.status).toBe(201);
  return res.body.id;
}

async function addLesson(title: string, unitId = schoolClass.unitId, forClass = schoolClass.id): Promise<string> {
  const res = await api(teacher).post(`/api/v1/classes/${forClass}/lessons`, { title, unitId });
  expect(res.status).toBe(201);
  return res.body.id;
}

function patchLesson(lessonId: string, body: object, forClass = schoolClass.id, user = teacher) {
  return api(user).patch(`/api/v1/lessons/${lessonId}${inClass(forClass)}`, body);
}

function patchUnit(unitId: string, body: object, forClass = schoolClass.id, user = teacher) {
  return api(user).patch(`/api/v1/units/${unitId}${inClass(forClass)}`, body);
}

function outlinePath(forClass = schoolClass.id): string {
  return `/api/v1/classes/${forClass}/outline`;
}

// Units as "order:title", lessons as "unit/order:number.title", so one comparison checks the
// sorting, every order and every number.
async function outline(user = teacher, forClass = schoolClass.id) {
  const res = await api(user).get(outlinePath(forClass));
  expect(res.status).toBe(200);

  const unitTitles = new Map<string, string>(
    res.body.units.map((unit: { id: string; title: string }) => [unit.id, unit.title]),
  );

  return {
    units: res.body.units.map((unit: { order: number; title: string }) => `${unit.order}:${unit.title}`),
    lessons: res.body.lessons.map(
      (lesson: { unitId: string; order: number; number: number; title: string }) =>
        `${unitTitles.get(lesson.unitId) ?? '?'}/${lesson.order}:${lesson.number}.${lesson.title}`,
    ),
  };
}

// Straight from the database: unit positions and class-only slots are 0..n-1 (contract 4).
async function expectDense(forClass = schoolClass.id): Promise<void> {
  const units = await ClassUnit.findAll({ where: { classId: forClass }, raw: true });
  const slots = await sequelize.query<{ unitId: string; position: number }>(
    `SELECT l.unit_id AS "unitId", cl.position
       FROM class_lessons cl JOIN lessons l ON l.id = cl.lesson_id
      WHERE cl.class_id = $classId`,
    { bind: { classId: forClass }, type: QueryTypes.SELECT },
  );
  const groups = new Map<string, number[]>([['units', units.map((unit) => unit.position)]]);

  for (const slot of slots) {
    groups.set(slot.unitId, [...(groups.get(slot.unitId) ?? []), slot.position]);
  }

  for (const [group, positions] of groups) {
    expect([group, positions.sort((a, b) => a - b)]).toEqual([group, positions.map((_, index) => index)]);
  }
}

describe('mergeUnit (contract 4.1)', () => {
  const classOnly = (id: string, slot: number): Mergeable => ({ id, slot, linkedPosition: null });
  const linked = (id: string, linkedPosition: number): Mergeable => ({ id, slot: null, linkedPosition });
  const ids = (lessons: Mergeable[]) => mergeUnit(lessons).map((lesson) => lesson.id);

  it('gives the contract example: lesson2 at slot 1 between linked lesson1 and lesson3', () => {
    expect(ids([linked('lesson1', 0), linked('lesson3', 1), classOnly('lesson2', 1)])).toEqual([
      'lesson1',
      'lesson2',
      'lesson3',
    ]);
    expect(ids([linked('lesson3', 1), linked('lesson1', 0)])).toEqual(['lesson1', 'lesson3']);
  });

  it('orders class-only lessons by slot alone and linked ones by linked order alone', () => {
    expect(ids([classOnly('c', 2), classOnly('a', 0), classOnly('b', 1)])).toEqual(['a', 'b', 'c']);
    expect(ids([linked('z', 2), linked('x', 0), linked('y', 1)])).toEqual(['x', 'y', 'z']);
  });

  it('puts a slot past the end last', () => {
    expect(ids([classOnly('late', 9), linked('l1', 0), linked('l2', 1)])).toEqual(['l1', 'l2', 'late']);
  });

  it('lets linked lessons fill every place no slot takes', () => {
    expect(ids([linked('l1', 0), linked('l2', 1), linked('l3', 2), classOnly('c0', 0), classOnly('c3', 3)])).toEqual([
      'c0',
      'l1',
      'l2',
      'c3',
      'l3',
    ]);
  });

  it('gives an empty unit an empty list', () => {
    expect(mergeUnit([])).toEqual([]);
  });
});

describe('GET /classes/:classId/outline', () => {
  it('starts with Unit 1 and no lessons', async () => {
    await expect(outline()).resolves.toEqual({ units: ['0:Unit 1'], lessons: [] });
  });

  it('returns exactly the contract Unit and the teacher LessonSummary', async () => {
    const lessonId = await addLesson('Equations');

    const res = await api(teacher).get(outlinePath());

    expect(Object.keys(res.body).sort()).toEqual(['lessons', 'units']);
    expect(Object.keys(res.body.units[0]).sort()).toEqual(UNIT_KEYS);
    expect(Object.keys(res.body.lessons[0]).sort()).toEqual(TEACHER_SUMMARY_KEYS);
    expect(res.body).toEqual({
      units: [{ id: schoolClass.unitId, classId: schoolClass.id, title: 'Unit 1', order: 0 }],
      lessons: [
        {
          id: lessonId,
          unitId: schoolClass.unitId,
          number: 1,
          title: 'Equations',
          order: 0,
          homeworkType: null,
          linked: false,
          visible: true,
          newSubmissionCount: 0,
        },
      ],
    });
  });

  it('numbers lessons continuously across units, in unit order', async () => {
    const second = await addUnit('Second');
    await addLesson('s1', second);
    await addLesson('a');
    await addLesson('b');
    await addLesson('s2', second);

    await expect(outline()).resolves.toEqual({
      units: ['0:Unit 1', '1:Second'],
      lessons: ['Unit 1/0:1.a', 'Unit 1/1:2.b', 'Second/0:3.s1', 'Second/1:4.s2'],
    });

    expect((await patchUnit(second, { order: 0 })).status).toBe(200);

    await expect(outline()).resolves.toEqual({
      units: ['0:Second', '1:Unit 1'],
      lessons: ['Second/0:1.s1', 'Second/1:2.s2', 'Unit 1/0:3.a', 'Unit 1/1:4.b'],
    });
  });

  it('reads units and lessons from one snapshot', async () => {
    const lessonId = await addLesson('Mover');
    const realQuery = sequelize.query.bind(sequelize) as (...args: unknown[]) => Promise<unknown>;
    let committed = false;

    // Commits, from another connection right after the units are read, a new unit with the
    // lesson moved into it.
    vi.spyOn(sequelize, 'query').mockImplementation((async (...args: unknown[]) => {
      const result = await realQuery(...args);
      if (!committed && String(args[0]).includes('FROM class_units')) {
        committed = true;
        const late = await Unit.create({ classId: schoolClass.id, groupId: null, title: 'Late' });
        await ClassUnit.create({ classId: schoolClass.id, unitId: late.id, position: 1 });
        await Lesson.update({ unitId: late.id }, { where: { id: lessonId } });
      }
      return result;
    }) as never);

    const res = await api(teacher).get(outlinePath());

    expect(committed).toBe(true);
    expect(res.body.units).toHaveLength(1);
    expect(res.body.lessons).toEqual([expect.objectContaining({ id: lessonId, unitId: schoolClass.unitId })]);
    vi.restoreAllMocks();
    await expect(outline()).resolves.toEqual({ units: ['0:Unit 1', '1:Late'], lessons: ['Late/0:1.Mover'] });
  });

  it('gives homeworkType when the lesson has homework, null otherwise', async () => {
    const withHomework = await addLesson('With');
    await addLesson('Without');
    await Homework.create({ lessonId: withHomework, type: 'draw', instructionsText: null, instructionsFileId: null });

    const res = await api(teacher).get(outlinePath());

    expect(res.body.lessons.map((lesson: { homeworkType: string | null }) => lesson.homeworkType)).toEqual(['draw', null]);
  });

  describe('for a student', () => {
    it('gives the lessons without the teacher-only fields', async () => {
      await addLesson('Intro');
      await connect(student);

      const res = await api(student).get(outlinePath());

      expect(res.status).toBe(200);
      expect(Object.keys(res.body.lessons[0]).sort()).toEqual(STUDENT_SUMMARY_KEYS);
      expect(res.body.units).toEqual([{ id: schoolClass.unitId, classId: schoolClass.id, title: 'Unit 1', order: 0 }]);
    });

    it('leaves out hidden lessons, keeps the numbers with their gaps, and drops units with nothing visible', async () => {
      const second = await addUnit('Second');
      await addLesson('a');
      const hidden = await addLesson('b');
      await addLesson('c');
      const onlyHidden = await addLesson('s1', second);
      await patchLesson(hidden, { visible: false });
      await patchLesson(onlyHidden, { visible: false });
      await connect(student);

      await expect(outline(student)).resolves.toEqual({
        units: ['0:Unit 1'],
        lessons: ['Unit 1/0:1.a', 'Unit 1/2:3.c'],
      });
      expect((await outline()).lessons).toEqual(['Unit 1/0:1.a', 'Unit 1/1:2.b', 'Unit 1/2:3.c', 'Second/0:4.s1']);
    });

    it('gives 404 while the connection awaits the claim, then 200 once connected', async () => {
      await api(teacher).post(`/api/v1/classes/${schoolClass.id}/students`, {
        fullName: 'Ali',
        studentPublicId: student.publicId,
      });

      expectError(await api(student).get(outlinePath()), 404, 'NOT_FOUND');

      await api(student).post('/api/v1/student/claims', { classPublicId: schoolClass.publicId });

      expect((await api(student).get(outlinePath())).status).toBe(200);
    });

    it('gives 404 with a claim but no roster row, and once the teacher disconnects the row', async () => {
      await api(student).post('/api/v1/student/claims', { classPublicId: schoolClass.publicId });
      expectError(await api(student).get(outlinePath()), 404, 'NOT_FOUND');

      const rowId = await connect(student);
      await api(teacher).patch(`/api/v1/classes/${schoolClass.id}/students/${rowId}`, { studentPublicId: null });

      expectError(await api(student).get(outlinePath()), 404, 'NOT_FOUND');
    });

    it('answers an unconnected class the same as one that does not exist', async () => {
      const forUnconnected = await api(student).get(outlinePath());
      const forMissing = await api(student).get(outlinePath(randomUUID()));

      expect(forUnconnected.status).toBe(404);
      expect(forUnconnected.body).toEqual(forMissing.body);
    });
  });

  it("answers another teacher's class the same as one that does not exist", async () => {
    const forOther = await api(otherTeacher).get(outlinePath());
    const forMissing = await api(otherTeacher).get(outlinePath(randomUUID()));

    expect(forOther.status).toBe(404);
    expect(forOther.body).toEqual(forMissing.body);
  });

  it('rejects query parameters', async () => {
    expectError(await api(teacher).get(`${outlinePath()}?all=1`), 400, 'VALIDATION_ERROR');
  });
});

describe('units', () => {
  it('appends units last with trimmed titles', async () => {
    const res = await api(teacher).post(`/api/v1/classes/${schoolClass.id}/units`, { title: '  Algebra  ' });

    expect(res.status).toBe(201);
    expect(res.body).toEqual({ id: expect.any(String), classId: schoolClass.id, title: 'Algebra', order: 1 });
    await expect(outline()).resolves.toEqual({ units: ['0:Unit 1', '1:Algebra'], lessons: [] });
  });

  it('gives LIMIT_REACHED for a 101st unit, Unit 1 included', async () => {
    const units = await Unit.bulkCreate(
      Array.from({ length: 99 }, (_, index) => ({ classId: schoolClass.id, groupId: null, title: `U${index}` })),
    );
    await ClassUnit.bulkCreate(units.map((unit, index) => ({ classId: schoolClass.id, unitId: unit.id, position: index + 1 })));

    expectError(await api(teacher).post(`/api/v1/classes/${schoolClass.id}/units`, { title: 'One too many' }), 409, 'LIMIT_REACHED');
  });

  it('never lets simultaneous creates pass the cap or share a position', async () => {
    const units = await Unit.bulkCreate(
      Array.from({ length: 94 }, (_, index) => ({ classId: schoolClass.id, groupId: null, title: `U${index}` })),
    );
    await ClassUnit.bulkCreate(units.map((unit, index) => ({ classId: schoolClass.id, unitId: unit.id, position: index + 1 })));

    const results = await Promise.all(
      Array.from({ length: 10 }, (_, index) => api(teacher).post(`/api/v1/classes/${schoolClass.id}/units`, { title: `Race ${index}` })),
    );

    expect(results.filter((res) => res.status === 201)).toHaveLength(5);
    expect(results.filter((res) => res.body.error?.code === 'LIMIT_REACHED')).toHaveLength(5);
    await expectDense();
  });

  it('renames with a trimmed title and moves, alone or together', async () => {
    const algebra = await addUnit('Algebra');
    await addUnit('Geometry');

    expect((await patchUnit(algebra, { title: ' Numbers ' })).body).toEqual({
      id: algebra,
      classId: schoolClass.id,
      title: 'Numbers',
      order: 1,
    });
    expect((await patchUnit(algebra, { title: 'Algebra', order: 0 })).body).toMatchObject({ title: 'Algebra', order: 0 });
    expect((await patchUnit(algebra, {})).body).toMatchObject({ title: 'Algebra', order: 0 });

    await expect(outline()).resolves.toEqual({ units: ['0:Algebra', '1:Unit 1', '2:Geometry'], lessons: [] });
    await expectDense();
  });

  it('gives VALIDATION_ERROR for an order past the last unit, and changes nothing', async () => {
    await addUnit('Second');

    const res = await patchUnit(schoolClass.unitId, { order: 2 });

    expectError(res, 400, 'VALIDATION_ERROR');
    expect(detailPaths(res)).toEqual(['order']);
    await expect(outline()).resolves.toEqual({ units: ['0:Unit 1', '1:Second'], lessons: [] });
  });

  it('applies simultaneous moves one after the other, keeping the order dense', async () => {
    const ids = [schoolClass.unitId, await addUnit('B'), await addUnit('C'), await addUnit('D')];

    await Promise.all([patchUnit(ids[0] ?? '', { order: 3 }), patchUnit(ids[3] ?? '', { order: 0 }), patchUnit(ids[1] ?? '', { order: 2 })]);

    expect((await outline()).units.map((unit: string) => unit.split(':')[0])).toEqual(['0', '1', '2', '3']);
    await expectDense();
  });

  it('deletes a unit with its lessons, their homework and submissions, renumbering units and lessons', async () => {
    const second = await addUnit('Second');
    await addLesson('a');
    const doomed = await addLesson('s1', second);
    await Homework.create({ lessonId: doomed, type: 'text', instructionsText: null, instructionsFileId: null });
    const third = await addUnit('Third');
    await addLesson('t1', third);

    const res = await api(teacher).delete(`/api/v1/units/${second}${inClass()}`);

    expect(res.status).toBe(204);
    await expect(outline()).resolves.toEqual({ units: ['0:Unit 1', '1:Third'], lessons: ['Unit 1/0:1.a', 'Third/0:2.t1'] });
    await expect(Promise.all([Lesson.count({ where: { id: doomed } }), Homework.count()])).resolves.toEqual([0, 0]);
    await expectDense();
  });

  it('keeps the last unit: LAST_UNIT with the class in details', async () => {
    const res = await api(teacher).delete(`/api/v1/units/${schoolClass.unitId}${inClass()}`);

    expectError(res, 409, 'LAST_UNIT');
    expect(res.body.error.details).toEqual({ classIds: [schoolClass.id] });
    await expect(outline()).resolves.toEqual({ units: ['0:Unit 1'], lessons: [] });
  });

  it.each([
    ['PATCH', (unitId: string, classId: string, user: TestUser) => api(user).patch(`/api/v1/units/${unitId}${inClass(classId)}`, { title: 'X' })],
    ['DELETE', (unitId: string, classId: string, user: TestUser) => api(user).delete(`/api/v1/units/${unitId}${inClass(classId)}`)],
  ])('%s gives the same 404 for a missing unit, a unit of another class, and another teacher', async (_method, send) => {
    await addUnit('Spare');
    const otherClass = await createClass(teacher);

    const missing = await send(randomUUID(), schoolClass.id, teacher);
    const wrongClass = await send(schoolClass.unitId, otherClass.id, teacher);
    const stranger = await send(schoolClass.unitId, schoolClass.id, otherTeacher);

    expectError(missing, 404, 'NOT_FOUND');
    expect(wrongClass.body).toEqual(missing.body);
    expect(stranger.body).toEqual(missing.body);
    await expect(outline()).resolves.toEqual({ units: ['0:Unit 1', '1:Spare'], lessons: [] });
  });

  it('needs ?classId= on PATCH and DELETE', async () => {
    expectError(await api(teacher).patch(`/api/v1/units/${schoolClass.unitId}`, { title: 'X' }), 400, 'VALIDATION_ERROR');
    expectError(await api(teacher).delete(`/api/v1/units/${schoolClass.unitId}`), 400, 'VALIDATION_ERROR');
  });
});

describe('POST /classes/:classId/lessons', () => {
  it('appends the lesson last in its unit, visible, as a LessonDetail', async () => {
    await addLesson('First');

    const res = await api(teacher).post(`/api/v1/classes/${schoolClass.id}/lessons`, {
      title: '  Second  ',
      unitId: schoolClass.unitId,
      linked: false,
    });

    expect(res.status).toBe(201);
    expect(Object.keys(res.body).sort()).toEqual(TEACHER_DETAIL_KEYS);
    expect(res.body).toMatchObject({
      classId: schoolClass.id,
      unitId: schoolClass.unitId,
      number: 2,
      title: 'Second',
      order: 1,
      lessonFile: null,
      homework: null,
      linked: false,
      visible: true,
    });
  });

  it('renumbers every later lesson', async () => {
    const second = await addUnit('Second');
    await addLesson('s1', second);
    await addLesson('a');

    await expect(outline()).resolves.toEqual({
      units: ['0:Unit 1', '1:Second'],
      lessons: ['Unit 1/0:1.a', 'Second/0:2.s1'],
    });
  });

  it.each([
    ['no unitId', { title: 'X' }, 'unitId'],
    ['a malformed unitId', { title: 'X', unitId: 'nope' }, 'unitId'],
    ['a blank title', { title: '  ', unitId: 'UNIT' }, 'title'],
    ['linked: true in a class without a group', { title: 'X', unitId: 'UNIT', linked: true }, 'linked'],
    ['an unknown field', { title: 'X', unitId: 'UNIT', order: 0 }, 'order'],
  ])('gives VALIDATION_ERROR for %s', async (_name, body, path) => {
    const sent = Object.fromEntries(Object.entries(body).map(([key, value]) => [key, value === 'UNIT' ? schoolClass.unitId : value]));

    const res = await api(teacher).post(`/api/v1/classes/${schoolClass.id}/lessons`, sent);

    expectError(res, 400, 'VALIDATION_ERROR');
    expect(detailPaths(res)).toEqual([path]);
    await expect(Lesson.count()).resolves.toBe(0);
  });

  it("gives VALIDATION_ERROR for a unit of another class, another teacher's included", async () => {
    const mine = await createClass(teacher);
    const theirs = await createClass(otherTeacher);

    for (const unitId of [mine.unitId, theirs.unitId, randomUUID()]) {
      const res = await api(teacher).post(`/api/v1/classes/${schoolClass.id}/lessons`, { title: 'X', unitId });
      expectError(res, 400, 'VALIDATION_ERROR');
      expect(res.body.error.details).toEqual([{ path: 'unitId', message: 'Unknown unit' }]);
    }
  });

  it('gives LIMIT_REACHED for a 501st lesson in the class', async () => {
    const lessons = await Lesson.bulkCreate(
      Array.from({ length: 500 }, (_, index) => ({
        classId: schoolClass.id,
        groupId: null,
        unitId: schoolClass.unitId,
        title: `L${index}`,
        position: null,
        lessonFileId: null,
      })),
    );
    await ClassLesson.bulkCreate(lessons.map((lesson, index) => ({ classId: schoolClass.id, lessonId: lesson.id, position: index })));

    expectError(
      await api(teacher).post(`/api/v1/classes/${schoolClass.id}/lessons`, { title: 'X', unitId: schoolClass.unitId }),
      409,
      'LIMIT_REACHED',
    );
  });
});

describe('GET /lessons/:id', () => {
  it('gives the teacher the lesson as it sits in the class', async () => {
    await addLesson('First');
    const lessonId = await addLesson('Second');

    const res = await api(teacher).get(`/api/v1/lessons/${lessonId}${inClass()}`);

    expect(res.status).toBe(200);
    expect(Object.keys(res.body).sort()).toEqual(TEACHER_DETAIL_KEYS);
    expect(res.body).toMatchObject({ id: lessonId, number: 2, order: 1, linked: false, visible: true });
  });

  it('gives a connected student the visible lesson without the teacher-only fields, with mySubmission', async () => {
    const lessonId = await addLesson('Intro');
    await connect(student);

    const res = await api(student).get(`/api/v1/lessons/${lessonId}${inClass()}`);

    expect(res.status).toBe(200);
    expect(res.body).not.toHaveProperty('linked');
    expect(res.body).not.toHaveProperty('visible');
    expect(res.body).toMatchObject({ id: lessonId, number: 1, mySubmission: null });
  });

  it('answers a student asking for a hidden lesson as for a missing one, while the teacher still sees it', async () => {
    const lessonId = await addLesson('Hidden');
    await patchLesson(lessonId, { visible: false });
    await connect(student);

    const hidden = await api(student).get(`/api/v1/lessons/${lessonId}${inClass()}`);
    const missing = await api(student).get(`/api/v1/lessons/${randomUUID()}${inClass()}`);

    expectError(hidden, 404, 'NOT_FOUND');
    expect(hidden.body).toEqual(missing.body);
    expect((await api(teacher).get(`/api/v1/lessons/${lessonId}${inClass()}`)).body.visible).toBe(false);
  });

  it('gives the same 404 for a lesson of another class, an unconnected student and another teacher', async () => {
    const lessonId = await addLesson('Intro');
    const otherClass = await createClass(teacher);
    const missing = await api(teacher).get(`/api/v1/lessons/${randomUUID()}${inClass()}`);

    expectError(missing, 404, 'NOT_FOUND');
    for (const res of [
      await api(teacher).get(`/api/v1/lessons/${lessonId}${inClass(otherClass.id)}`),
      await api(student).get(`/api/v1/lessons/${lessonId}${inClass()}`),
      await api(otherTeacher).get(`/api/v1/lessons/${lessonId}${inClass()}`),
    ]) {
      expect(res.status).toBe(404);
      expect(res.body).toEqual(missing.body);
    }
  });

  it.each([
    ['no classId', ''],
    ['a malformed classId', '?classId=nope'],
    ['an extra parameter', `?classId=${randomUUID()}&scope=all`],
  ])('gives VALIDATION_ERROR for %s', async (_name, query) => {
    const lessonId = await addLesson('Intro');

    expectError(await api(teacher).get(`/api/v1/lessons/${lessonId}${query}`), 400, 'VALIDATION_ERROR');
  });
});

describe('PATCH /lessons/:id', () => {
  it('renames with a trimmed title', async () => {
    const lessonId = await addLesson('Old');

    expect((await patchLesson(lessonId, { title: '  New  ' })).body).toMatchObject({ title: 'New', number: 1 });
  });

  it('reorders within the unit and renumbers', async () => {
    const a = await addLesson('a');
    await addLesson('b');
    const c = await addLesson('c');

    expect((await patchLesson(c, { order: 0 })).body).toMatchObject({ number: 1, order: 0 });
    await expect(outline()).resolves.toMatchObject({ lessons: ['Unit 1/0:1.c', 'Unit 1/1:2.a', 'Unit 1/2:3.b'] });

    await patchLesson(a, { order: 2 });
    await expect(outline()).resolves.toMatchObject({ lessons: ['Unit 1/0:1.c', 'Unit 1/1:2.b', 'Unit 1/2:3.a'] });
    await expectDense();
  });

  it('moves to another unit, last without an order, or at the order given, renumbering both', async () => {
    const second = await addUnit('Second');
    const [a, b] = [await addLesson('a'), await addLesson('b')];
    await addLesson('s1', second);

    await patchLesson(a, { unitId: second });
    await expect(outline()).resolves.toMatchObject({ lessons: ['Unit 1/0:1.b', 'Second/0:2.s1', 'Second/1:3.a'] });

    await patchLesson(b, { unitId: second, order: 0 });
    await expect(outline()).resolves.toMatchObject({ lessons: ['Second/0:1.b', 'Second/1:2.s1', 'Second/2:3.a'] });
    await expectDense();
  });

  it('counts the order in the unit it ends up in, where the end is one past its last lesson', async () => {
    const second = await addUnit('Second');
    const a = await addLesson('a');
    await addLesson('s1', second);

    expectError(await patchLesson(a, { unitId: second, order: 2 }), 400, 'VALIDATION_ERROR');
    expect((await patchLesson(a, { unitId: second, order: 1 })).body).toMatchObject({ unitId: second, order: 1 });

    const stay = await patchLesson(a, { order: 2 });
    expectError(stay, 400, 'VALIDATION_ERROR');
    expect(detailPaths(stay)).toEqual(['order']);
  });

  it('hides and shows the lesson in this class, keeping its number', async () => {
    const lessonId = await addLesson('a');
    await addLesson('b');

    expect((await patchLesson(lessonId, { visible: false })).body).toMatchObject({ visible: false, number: 1 });
    await expect(ClassLesson.findOne({ where: { lessonId } })).resolves.toMatchObject({ visible: false });
    expect((await patchLesson(lessonId, { visible: true })).body.visible).toBe(true);
  });

  it('gives VALIDATION_ERROR for linked: true without a group, and takes linked: false as it is', async () => {
    const lessonId = await addLesson('a');

    const res = await patchLesson(lessonId, { linked: true });
    expectError(res, 400, 'VALIDATION_ERROR');
    expect(detailPaths(res)).toEqual(['linked']);
    expect((await patchLesson(lessonId, { linked: false })).body.linked).toBe(false);
  });

  it("gives VALIDATION_ERROR for another class's unit and changes nothing", async () => {
    const lessonId = await addLesson('a');
    const otherClass = await createClass(teacher);

    const res = await patchLesson(lessonId, { unitId: otherClass.unitId });

    expectError(res, 400, 'VALIDATION_ERROR');
    expect(res.body.error.details).toEqual([{ path: 'unitId', message: 'Unknown unit' }]);
    await expect(Lesson.findByPk(lessonId)).resolves.toMatchObject({ unitId: schoolClass.unitId });
  });

  it('gives another teacher the same 404 as a missing lesson and changes nothing', async () => {
    const lessonId = await addLesson('Mine');

    const stranger = await patchLesson(lessonId, { title: 'Theirs' }, schoolClass.id, otherTeacher);
    const missing = await patchLesson(randomUUID(), { title: 'Theirs' });

    expectError(stranger, 404, 'NOT_FOUND');
    expect(stranger.body).toEqual(missing.body);
    await expect(Lesson.findByPk(lessonId)).resolves.toMatchObject({ title: 'Mine' });
  });
});

describe('DELETE /lessons/:id', () => {
  it('deletes a class-only lesson with its homework and submissions, and renumbers the rest', async () => {
    const second = await addUnit('Second');
    await addLesson('a');
    const doomed = await addLesson('b');
    await addLesson('c');
    await addLesson('s1', second);
    const homework = await Homework.create({ lessonId: doomed, type: 'text', instructionsText: null, instructionsFileId: null });
    const rowId = await connect(student);
    await Submission.create({
      homeworkId: homework.id,
      classStudentId: rowId,
      version: 1,
      status: 'submitted',
      content: { text: 'x' },
      gradeValue: null,
      gradeDenied: false,
      gradeComment: null,
      gradeSource: null,
      gradedAt: null,
      aiSuggestion: null,
    });

    const res = await api(teacher).delete(`/api/v1/lessons/${doomed}${inClass()}`);

    expect(res.status).toBe(204);
    await expect(outline()).resolves.toMatchObject({ lessons: ['Unit 1/0:1.a', 'Unit 1/1:2.c', 'Second/0:3.s1'] });
    await expect(Promise.all([Homework.count(), Submission.count(), ClassLesson.count({ where: { lessonId: doomed } })])).resolves.toEqual([0, 0, 0]);
    await expectDense();
  });

  it('takes scope=class as the default, and gives VALIDATION_ERROR for scope=all on a class-only lesson', async () => {
    const kept = await addLesson('kept');
    const gone = await addLesson('gone');

    const all = await api(teacher).delete(`/api/v1/lessons/${kept}${inClass()}&scope=all`);
    expectError(all, 400, 'VALIDATION_ERROR');
    expect(detailPaths(all)).toEqual(['scope']);

    expect((await api(teacher).delete(`/api/v1/lessons/${gone}${inClass()}&scope=class`)).status).toBe(204);
    await expect(outline()).resolves.toMatchObject({ lessons: ['Unit 1/0:1.kept'] });
  });

  it('gives VALIDATION_ERROR for an unknown scope', async () => {
    const lessonId = await addLesson('a');

    expectError(await api(teacher).delete(`/api/v1/lessons/${lessonId}${inClass()}&scope=some`), 400, 'VALIDATION_ERROR');
  });

  it('gives another teacher the same 404 as a missing lesson and deletes nothing', async () => {
    const lessonId = await addLesson('Mine');

    const stranger = await api(otherTeacher).delete(`/api/v1/lessons/${lessonId}${inClass()}`);
    const missing = await api(teacher).delete(`/api/v1/lessons/${randomUUID()}${inClass()}`);

    expectError(stranger, 404, 'NOT_FOUND');
    expect(stranger.body).toEqual(missing.body);
    await expect(Lesson.count()).resolves.toBe(1);
  });
});

describe('GET /lessons/:id/impact', () => {
  it('lists the class holding the lesson with how many of its students handed it in', async () => {
    const lessonId = await addLesson('a');
    const homework = await Homework.create({ lessonId, type: 'text', instructionsText: null, instructionsFileId: null });
    const rowId = await connect(student);
    const another = await connect(await createTestUser('student'));
    for (const [classStudentId, version] of [
      [rowId, 1],
      [rowId, 2],
      [another, 1],
    ] as const) {
      await Submission.create({
        homeworkId: homework.id,
        classStudentId,
        version,
        status: 'submitted',
        content: { text: 'x' },
        gradeValue: null,
        gradeDenied: false,
        gradeComment: null,
        gradeSource: null,
        gradedAt: null,
        aiSuggestion: null,
      });
    }

    const res = await api(teacher).get(`/api/v1/lessons/${lessonId}/impact${inClass()}`);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ classes: [{ id: schoolClass.id, name: 'Maths', submissionCount: 2 }] });
  });

  it('gives 0 for a lesson nobody handed in, and 404 to another teacher', async () => {
    const lessonId = await addLesson('a');

    expect((await api(teacher).get(`/api/v1/lessons/${lessonId}/impact${inClass()}`)).body).toEqual({
      classes: [{ id: schoolClass.id, name: 'Maths', submissionCount: 0 }],
    });
    expectError(await api(otherTeacher).get(`/api/v1/lessons/${lessonId}/impact${inClass()}`), 404, 'NOT_FOUND');
  });
});

describe('access', () => {
  it('keeps students out of every write', async () => {
    const lessonId = await addLesson('a');
    await connect(student);

    for (const res of [
      await api(student).post(`/api/v1/classes/${schoolClass.id}/units`, { title: 'X' }),
      await api(student).patch(`/api/v1/units/${schoolClass.unitId}${inClass()}`, { title: 'X' }),
      await api(student).delete(`/api/v1/units/${schoolClass.unitId}${inClass()}`),
      await api(student).post(`/api/v1/classes/${schoolClass.id}/lessons`, { title: 'X', unitId: schoolClass.unitId }),
      await api(student).patch(`/api/v1/lessons/${lessonId}${inClass()}`, { title: 'X' }),
      await api(student).delete(`/api/v1/lessons/${lessonId}${inClass()}`),
      await api(student).get(`/api/v1/lessons/${lessonId}/impact${inClass()}`),
    ]) {
      expectError(res, 403, 'FORBIDDEN');
    }
  });
});
