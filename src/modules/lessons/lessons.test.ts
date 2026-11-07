import { randomUUID } from 'node:crypto';

import type request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';

import { Homework, Lesson, Unit } from '../../db/models/index.js';
import { resetRateLimits } from '../../middleware/rateLimit.js';
import { useTestDatabase } from '../../test/database.js';
import { api, createTestUser, type TestUser } from '../../test/users.js';

useTestDatabase();

const UNIT_KEYS = ['classId', 'id', 'order', 'title'];
const LESSON_SUMMARY_KEYS = ['homeworkType', 'id', 'order', 'title', 'unitId'];

interface ClassRef {
  id: string;
  publicId: string;
}

let teacher: TestUser;
let otherTeacher: TestUser;
let student: TestUser;
let schoolClass: ClassRef;

async function createClass(user: TestUser): Promise<ClassRef> {
  const category = await api(user).post('/api/v1/categories', { name: `C ${randomUUID()}` });
  expect(category.status).toBe(201);

  const res = await api(user).post('/api/v1/classes', {
    categoryId: category.body.id,
    subject: 'Maths',
  });
  expect(res.status).toBe(201);
  return res.body;
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

// Teacher adds the student's ID, student enters the class ID (contract 6.2).
async function linkActive(user: TestUser, forClass = schoolClass, owner = teacher): Promise<string> {
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

async function addLesson(
  title: string,
  unitId: string | null = null,
  forClass = schoolClass.id,
  user = teacher,
): Promise<string> {
  const res = await api(user).post(`/api/v1/classes/${forClass}/lessons`, { title, unitId });
  expect(res.status).toBe(201);
  return res.body.id;
}

function outlinePath(forClass = schoolClass.id): string {
  return `/api/v1/classes/${forClass}/outline`;
}

// The outline as "order:title" for units and "unit/order:title" for lessons ("-" = no unit),
// so one comparison checks the sorting and every order value.
async function outline(user = teacher, forClass = schoolClass.id) {
  const res = await api(user).get(outlinePath(forClass));
  expect(res.status).toBe(200);

  const unitTitles = new Map<string, string>(
    res.body.units.map((unit: { id: string; title: string }) => [unit.id, unit.title]),
  );

  return {
    units: res.body.units.map((unit: { order: number; title: string }) => `${unit.order}:${unit.title}`),
    lessons: res.body.lessons.map(
      (lesson: { unitId: string | null; order: number; title: string }) =>
        `${lesson.unitId === null ? '-' : unitTitles.get(lesson.unitId)}/${lesson.order}:${lesson.title}`,
    ),
  };
}

// Straight from the database: every sibling set is numbered 0..n-1 (contract 4).
async function expectDense(forClass = schoolClass.id): Promise<void> {
  const groups = new Map<string, number[]>();
  const units = await Unit.findAll({ where: { classId: forClass }, raw: true });
  const lessons = await Lesson.findAll({ where: { classId: forClass }, raw: true });

  groups.set('units', units.map((unit) => unit.position));
  for (const lesson of lessons) {
    const key = `lessons of ${lesson.unitId ?? 'no unit'}`;
    groups.set(key, [...(groups.get(key) ?? []), lesson.position]);
  }

  for (const [group, positions] of groups) {
    expect([group, positions.sort((a, b) => a - b)]).toEqual([group, positions.map((_, index) => index)]);
  }
}

describe('GET /classes/:classId/outline', () => {
  it('starts empty', async () => {
    const res = await api(teacher).get(outlinePath());

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ units: [], lessons: [] });
  });

  it('returns exactly the contract Unit and LessonSummary', async () => {
    const unitId = await addUnit('Algebra');
    const lessonId = await addLesson('Equations', unitId);

    const res = await api(teacher).get(outlinePath());

    expect(Object.keys(res.body).sort()).toEqual(['lessons', 'units']);
    expect(Object.keys(res.body.units[0]).sort()).toEqual(UNIT_KEYS);
    expect(Object.keys(res.body.lessons[0]).sort()).toEqual(LESSON_SUMMARY_KEYS);
    expect(res.body).toEqual({
      units: [{ id: unitId, classId: schoolClass.id, title: 'Algebra', order: 0 }],
      lessons: [{ id: lessonId, unitId, title: 'Equations', order: 0, homeworkType: null }],
    });
  });

  it('puts the no-unit group first, then each unit in unit order', async () => {
    const first = await addUnit('First');
    const second = await addUnit('Second');
    await addLesson('s1', second);
    await addLesson('n1');
    await addLesson('f1', first);
    await addLesson('n2');
    await addLesson('f2', first);

    await expect(outline()).resolves.toEqual({
      units: ['0:First', '1:Second'],
      lessons: ['-/0:n1', '-/1:n2', 'First/0:f1', 'First/1:f2', 'Second/0:s1'],
    });

    await api(teacher).patch(`/api/v1/units/${second}`, { order: 0 });

    await expect(outline()).resolves.toEqual({
      units: ['0:Second', '1:First'],
      lessons: ['-/0:n1', '-/1:n2', 'Second/0:s1', 'First/0:f1', 'First/1:f2'],
    });
  });

  it('reads units and lessons from one snapshot', async () => {
    const lessonId = await addLesson('Mover');

    // Commits, from another connection, a new unit with the lesson moved into it, right
    // between the outline's read of units and its read of lessons.
    Unit.addHook('afterFind', 'commitBetweenReads', async () => {
      Unit.removeHook('afterFind', 'commitBetweenReads');
      const unit = await Unit.create({ classId: schoolClass.id, title: 'Late', position: 0 });
      await Lesson.update({ unitId: unit.id, position: 0 }, { where: { id: lessonId } });
    });

    try {
      const res = await api(teacher).get(outlinePath());

      expect(res.status).toBe(200);
      expect(res.body).toEqual({
        units: [],
        lessons: [expect.objectContaining({ id: lessonId, unitId: null })],
      });
    } finally {
      Unit.removeHook('afterFind', 'commitBetweenReads');
    }

    await expect(outline()).resolves.toEqual({ units: ['0:Late'], lessons: ['Late/0:Mover'] });
  });

  it('gives homeworkType when the lesson has homework, null otherwise', async () => {
    const withHomework = await addLesson('With');
    await addLesson('Without');
    await Homework.create({ lessonId: withHomework, type: 'draw', instructionsText: null, instructionsFileId: null });

    const res = await api(teacher).get(outlinePath());

    expect(res.body.lessons.map((lesson: { homeworkType: string | null }) => lesson.homeworkType)).toEqual([
      'draw',
      null,
    ]);
  });

  it('shows a student with an active link the same outline as the teacher', async () => {
    const unitId = await addUnit('Algebra');
    await addLesson('Equations', unitId);
    await addLesson('Intro');
    await linkActive(student);

    const forStudent = await api(student).get(outlinePath());

    expect(forStudent.status).toBe(200);
    expect(forStudent.body).toEqual((await api(teacher).get(outlinePath())).body);
  });

  it('gives a student 404 while the link awaits the claim, then 200 once active', async () => {
    await api(teacher).post(`/api/v1/classes/${schoolClass.id}/students`, {
      fullName: 'Ali',
      studentPublicId: student.publicId,
    });

    expectError(await api(student).get(outlinePath()), 404, 'NOT_FOUND');

    await api(student).post('/api/v1/student/claims', { classPublicId: schoolClass.publicId });

    expect((await api(student).get(outlinePath())).status).toBe(200);
  });

  it('gives a student 404 with a claim but no roster row', async () => {
    await api(student).post('/api/v1/student/claims', { classPublicId: schoolClass.publicId });

    expectError(await api(student).get(outlinePath()), 404, 'NOT_FOUND');
  });

  it('gives a student 404 once the teacher unlinks the row', async () => {
    const rowId = await linkActive(student);

    await api(teacher).patch(`/api/v1/classes/${schoolClass.id}/students/${rowId}`, { studentPublicId: null });

    expectError(await api(student).get(outlinePath()), 404, 'NOT_FOUND');
  });

  it('answers a student without a link the same as a class that does not exist', async () => {
    const forUnlinked = await api(student).get(outlinePath());
    const forMissing = await api(student).get(outlinePath(randomUUID()));

    expect(forUnlinked.status).toBe(404);
    expect(forUnlinked.body).toEqual(forMissing.body);
  });

  it("answers another teacher's class the same as one that does not exist", async () => {
    const forOther = await api(otherTeacher).get(outlinePath());
    const forMissing = await api(otherTeacher).get(outlinePath(randomUUID()));

    expectError(forOther, 404, 'NOT_FOUND');
    expect(forOther.body).toEqual(forMissing.body);
  });

  it('gives VALIDATION_ERROR for a malformed classId or a query parameter', async () => {
    expectError(await api(teacher).get(outlinePath('nope')), 400, 'VALIDATION_ERROR');
    expectError(await api(teacher).get(`${outlinePath()}?unitId=1`), 400, 'VALIDATION_ERROR');
  });
});

describe('POST /classes/:classId/units', () => {
  it('appends units last with trimmed titles', async () => {
    const res = await api(teacher).post(`/api/v1/classes/${schoolClass.id}/units`, { title: '  Algebra ' });

    expect(res.status).toBe(201);
    expect(res.body).toEqual({ id: expect.any(String), classId: schoolClass.id, title: 'Algebra', order: 0 });

    await addUnit('Geometry');
    await expect(outline()).resolves.toMatchObject({ units: ['0:Algebra', '1:Geometry'] });
  });

  it('accepts a title of exactly 120 characters', async () => {
    await addUnit('x'.repeat(120));
  });

  it.each([
    ['a blank title', { title: '  ' }, 'title'],
    ['a title over 120 characters', { title: 'x'.repeat(121) }, 'title'],
    ['no title', {}, 'title'],
    ['an order, which create does not take', { title: 'X', order: 0 }, 'order'],
  ])('gives VALIDATION_ERROR for %s', async (_name, body, path) => {
    const res = await api(teacher).post(`/api/v1/classes/${schoolClass.id}/units`, body);

    expectError(res, 400, 'VALIDATION_ERROR');
    expect(detailPaths(res)).toContain(path);
  });

  it('gives LIMIT_REACHED for a 101st unit', async () => {
    await Unit.bulkCreate(
      Array.from({ length: 100 }, (_, index) => ({ classId: schoolClass.id, title: `U${index}`, position: index })),
    );

    expectError(
      await api(teacher).post(`/api/v1/classes/${schoolClass.id}/units`, { title: 'One too many' }),
      409,
      'LIMIT_REACHED',
    );
  });

  it('never lets simultaneous creates pass the cap or share a position', async () => {
    await Unit.bulkCreate(
      Array.from({ length: 95 }, (_, index) => ({ classId: schoolClass.id, title: `U${index}`, position: index })),
    );

    const results = await Promise.all(
      Array.from({ length: 10 }, (_, index) =>
        api(teacher).post(`/api/v1/classes/${schoolClass.id}/units`, { title: `Race ${index}` }),
      ),
    );

    expect(results.filter((res) => res.status === 201)).toHaveLength(5);
    expect(results.filter((res) => res.body.error?.code === 'LIMIT_REACHED')).toHaveLength(5);
    await expect(Unit.count({ where: { classId: schoolClass.id } })).resolves.toBe(100);
    await expectDense();
  });

  it("gives 404 NOT_FOUND for another teacher's class", async () => {
    expectError(
      await api(otherTeacher).post(`/api/v1/classes/${schoolClass.id}/units`, { title: 'Mine?' }),
      404,
      'NOT_FOUND',
    );
    await expect(Unit.count()).resolves.toBe(0);
  });
});

describe('PATCH /units/:id', () => {
  let ids: Record<'a' | 'b' | 'c' | 'd', string>;

  beforeEach(async () => {
    ids = { a: await addUnit('A'), b: await addUnit('B'), c: await addUnit('C'), d: await addUnit('D') };
  });

  it('renames with a trimmed title', async () => {
    const res = await api(teacher).patch(`/api/v1/units/${ids.b}`, { title: ' Bee ' });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ id: ids.b, classId: schoolClass.id, title: 'Bee', order: 1 });
  });

  it('moves a unit up or down and renumbers the rest', async () => {
    expect((await api(teacher).patch(`/api/v1/units/${ids.d}`, { order: 1 })).body.order).toBe(1);
    await expect(outline()).resolves.toMatchObject({ units: ['0:A', '1:D', '2:B', '3:C'] });

    expect((await api(teacher).patch(`/api/v1/units/${ids.a}`, { order: 3 })).body.order).toBe(3);
    await expect(outline()).resolves.toMatchObject({ units: ['0:D', '1:B', '2:C', '3:A'] });
    await expectDense();
  });

  it('renames and moves in one request', async () => {
    await api(teacher).patch(`/api/v1/units/${ids.c}`, { title: 'See', order: 0 });

    await expect(outline()).resolves.toMatchObject({ units: ['0:See', '1:A', '2:B', '3:D'] });
  });

  it('changes nothing for the order it already has, or an empty body', async () => {
    await api(teacher).patch(`/api/v1/units/${ids.b}`, { order: 1 });
    const res = await api(teacher).patch(`/api/v1/units/${ids.b}`, {});

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ title: 'B', order: 1 });
    await expect(outline()).resolves.toMatchObject({ units: ['0:A', '1:B', '2:C', '3:D'] });
  });

  it('gives VALIDATION_ERROR for an order past the last unit, and changes nothing', async () => {
    const res = await api(teacher).patch(`/api/v1/units/${ids.a}`, { title: 'Renamed', order: 4 });

    expectError(res, 400, 'VALIDATION_ERROR');
    expect(res.body.error.details).toEqual([{ path: 'order', message: 'Must be between 0 and 3' }]);
    await expect(outline()).resolves.toMatchObject({ units: ['0:A', '1:B', '2:C', '3:D'] });
  });

  it.each([
    ['a negative order', { order: -1 }, 'order'],
    ['a fractional order', { order: 1.5 }, 'order'],
    ['an order given as a string', { order: '1' }, 'order'],
    ['a blank title', { title: ' ' }, 'title'],
    ['an unknown field', { classId: randomUUID() }, 'classId'],
  ])('gives VALIDATION_ERROR for %s', async (_name, body, path) => {
    const res = await api(teacher).patch(`/api/v1/units/${ids.a}`, body);

    expectError(res, 400, 'VALIDATION_ERROR');
    expect(detailPaths(res)).toContain(path);
  });

  // Moving the last unit first and the first unit last gives the same result in either
  // order, so anything else means one move overwrote the other.
  it('applies simultaneous moves one after the other, losing neither', async () => {
    let [first, , , last] = [ids.a, ids.b, ids.c, ids.d];
    const expected = [
      ['0:D', '1:B', '2:C', '3:A'],
      ['0:A', '1:B', '2:C', '3:D'],
    ];

    for (let round = 0; round < 6; round += 1) {
      await Promise.all([
        api(teacher).patch(`/api/v1/units/${last}`, { order: 0 }),
        api(teacher).patch(`/api/v1/units/${first}`, { order: 3 }),
      ]);

      await expect(outline()).resolves.toMatchObject({ units: expected[round % 2] });
      [first, last] = [last, first];
    }
  });

  it('keeps positions dense under simultaneous moves', async () => {
    const all = [ids.a, ids.b, ids.c, ids.d];

    const results = await Promise.all(
      Array.from({ length: 12 }, (_, index) =>
        api(teacher).patch(`/api/v1/units/${all[index % 4]}`, { order: (index * 3) % 4 }),
      ),
    );

    expect(results.every((res) => res.status === 200)).toBe(true);
    await expectDense();
  });
});

describe('DELETE /units/:id', () => {
  it('deletes the unit with its lessons and their homework, and renumbers the units', async () => {
    const a = await addUnit('A');
    const b = await addUnit('B');
    await addUnit('C');
    const doomed = await addLesson('In B', b);
    await addLesson('In A', a);
    await addLesson('No unit');
    await Homework.create({ lessonId: doomed, type: 'text', instructionsText: null, instructionsFileId: null });

    const res = await api(teacher).delete(`/api/v1/units/${b}`);

    expect(res.status).toBe(204);
    expect(res.text).toBe('');
    await expect(outline()).resolves.toEqual({
      units: ['0:A', '1:C'],
      lessons: ['-/0:No unit', 'A/0:In A'],
    });
    await expect(Lesson.findByPk(doomed)).resolves.toBeNull();
    await expect(Homework.count()).resolves.toBe(0);
  });

  it('gives 404 NOT_FOUND the second time', async () => {
    const id = await addUnit('A');
    await api(teacher).delete(`/api/v1/units/${id}`);

    expectError(await api(teacher).delete(`/api/v1/units/${id}`), 404, 'NOT_FOUND');
  });
});

describe("another teacher's unit", () => {
  it.each([
    ['PATCH', (id: string) => api(otherTeacher).patch(`/api/v1/units/${id}`, { title: 'Mine now', order: 0 })],
    ['DELETE', (id: string) => api(otherTeacher).delete(`/api/v1/units/${id}`)],
  ])('gives 404 NOT_FOUND on %s, the same as a missing unit, and changes nothing', async (_method, send) => {
    await addUnit('First');
    const id = await addUnit('Theirs');

    const forOther = await send(id);
    const forMissing = await send(randomUUID());

    expectError(forOther, 404, 'NOT_FOUND');
    expect(forOther.body).toEqual(forMissing.body);
    await expect(outline()).resolves.toMatchObject({ units: ['0:First', '1:Theirs'] });
  });
});

describe('POST /classes/:classId/lessons', () => {
  it('returns the contract LessonDetail, without mySubmission for a teacher', async () => {
    const res = await api(teacher).post(`/api/v1/classes/${schoolClass.id}/lessons`, { title: ' Intro ' });

    expect(res.status).toBe(201);
    expect(res.body).toEqual({
      id: expect.any(String),
      classId: schoolClass.id,
      unitId: null,
      title: 'Intro',
      order: 0,
      lessonFile: null,
      homework: null,
    });
    expect(res.body).not.toHaveProperty('mySubmission');
  });

  it('appends last within its own group', async () => {
    const unitId = await addUnit('U');
    await addLesson('n0');
    await addLesson('u0', unitId);
    await addLesson('n1', null);
    const res = await api(teacher).post(`/api/v1/classes/${schoolClass.id}/lessons`, { title: 'u1', unitId });

    expect(res.body).toMatchObject({ unitId, order: 1 });
    await expect(outline()).resolves.toMatchObject({ lessons: ['-/0:n0', '-/1:n1', 'U/0:u0', 'U/1:u1'] });
  });

  it.each([
    ['a unit of another own class', async () => addUnit('Elsewhere', (await createClass(teacher)).id)],
    ["another teacher's unit", async () => addUnit('Theirs', (await createClass(otherTeacher)).id, otherTeacher)],
    ['a unit that does not exist', async () => randomUUID()],
  ])('gives VALIDATION_ERROR for %s, and adds nothing', async (_name, makeUnit) => {
    const unitId = await makeUnit();

    const res = await api(teacher).post(`/api/v1/classes/${schoolClass.id}/lessons`, { title: 'X', unitId });

    expectError(res, 400, 'VALIDATION_ERROR');
    expect(res.body.error.details).toEqual([{ path: 'unitId', message: 'Unknown unit' }]);
    await expect(Lesson.count({ where: { classId: schoolClass.id } })).resolves.toBe(0);
  });

  it.each([
    ['a blank title', { title: '' }, 'title'],
    ['a title over 120 characters', { title: 'x'.repeat(121) }, 'title'],
    ['a malformed unitId', { title: 'X', unitId: 'unit-1' }, 'unitId'],
    ['an order, which create does not take', { title: 'X', order: 0 }, 'order'],
  ])('gives VALIDATION_ERROR for %s', async (_name, body, path) => {
    const res = await api(teacher).post(`/api/v1/classes/${schoolClass.id}/lessons`, body);

    expectError(res, 400, 'VALIDATION_ERROR');
    expect(detailPaths(res)).toContain(path);
  });

  it('gives LIMIT_REACHED for a 501st lesson, counting every group', async () => {
    const unitId = await addUnit('U');
    await Lesson.bulkCreate([
      ...Array.from({ length: 250 }, (_, index) => ({ classId: schoolClass.id, unitId: null, title: `N${index}`, position: index })),
      ...Array.from({ length: 250 }, (_, index) => ({ classId: schoolClass.id, unitId, title: `U${index}`, position: index })),
    ]);

    expectError(
      await api(teacher).post(`/api/v1/classes/${schoolClass.id}/lessons`, { title: 'One too many', unitId }),
      409,
      'LIMIT_REACHED',
    );
  });

  it('never lets simultaneous creates pass the cap or share a position', async () => {
    await Lesson.bulkCreate(
      Array.from({ length: 495 }, (_, index) => ({ classId: schoolClass.id, unitId: null, title: `L${index}`, position: index })),
    );

    const results = await Promise.all(
      Array.from({ length: 10 }, (_, index) =>
        api(teacher).post(`/api/v1/classes/${schoolClass.id}/lessons`, { title: `Race ${index}` }),
      ),
    );

    expect(results.filter((res) => res.status === 201)).toHaveLength(5);
    expect(results.filter((res) => res.body.error?.code === 'LIMIT_REACHED')).toHaveLength(5);
    await expect(Lesson.count({ where: { classId: schoolClass.id } })).resolves.toBe(500);
    await expectDense();
  });

  it("gives 404 NOT_FOUND for another teacher's class", async () => {
    expectError(
      await api(otherTeacher).post(`/api/v1/classes/${schoolClass.id}/lessons`, { title: 'Mine?' }),
      404,
      'NOT_FOUND',
    );
  });
});

describe('PATCH /lessons/:id', () => {
  let unitA: string;
  let unitB: string;
  let n: string[];
  let a: string[];

  // No unit: n0 n1 n2. Unit A: a0 a1. Unit B: empty.
  beforeEach(async () => {
    unitA = await addUnit('A');
    unitB = await addUnit('B');
    n = [await addLesson('n0'), await addLesson('n1'), await addLesson('n2')];
    a = [await addLesson('a0', unitA), await addLesson('a1', unitA)];
  });

  function patch(id: string, body: object) {
    return api(teacher).patch(`/api/v1/lessons/${id}`, body);
  }

  it('renames with a trimmed title and returns the LessonDetail', async () => {
    const res = await patch(a[1], { title: ' Fractions ' });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      id: a[1],
      classId: schoolClass.id,
      unitId: unitA,
      title: 'Fractions',
      order: 1,
      lessonFile: null,
      homework: null,
    });
  });

  it('reorders within its group and leaves other groups alone', async () => {
    expect((await patch(n[2], { order: 0 })).body).toMatchObject({ unitId: null, order: 0 });

    await expect(outline()).resolves.toMatchObject({
      lessons: ['-/0:n2', '-/1:n0', '-/2:n1', 'A/0:a0', 'A/1:a1'],
    });
  });

  it('appends a lesson moved without order, and closes the gap it leaves', async () => {
    expect((await patch(n[0], { unitId: unitA })).body).toMatchObject({ unitId: unitA, order: 2 });

    await expect(outline()).resolves.toMatchObject({
      lessons: ['-/0:n1', '-/1:n2', 'A/0:a0', 'A/1:a1', 'A/2:n0'],
    });
    await expectDense();
  });

  it('inserts a lesson moved with order at that index', async () => {
    await patch(n[1], { unitId: unitA, order: 1 });

    await expect(outline()).resolves.toMatchObject({
      lessons: ['-/0:n0', '-/1:n2', 'A/0:a0', 'A/1:n1', 'A/2:a1'],
    });
  });

  it('moves to the no-unit group with unitId null, and into an empty unit', async () => {
    await patch(a[0], { unitId: null, order: 0 });
    await patch(a[1], { unitId: unitB });

    await expect(outline()).resolves.toMatchObject({
      lessons: ['-/0:a0', '-/1:n0', '-/2:n1', '-/3:n2', 'B/0:a1'],
    });
    await expectDense();
  });

  it('treats the unitId it already has as no move', async () => {
    const res = await patch(a[0], { unitId: unitA });

    expect(res.body).toMatchObject({ unitId: unitA, order: 0 });
    await expect(outline()).resolves.toMatchObject({ lessons: ['-/0:n0', '-/1:n1', '-/2:n2', 'A/0:a0', 'A/1:a1'] });
  });

  it('accepts an order up to the last place of its own group, and one past the end of a new group', async () => {
    expectError(await patch(n[0], { order: 3 }), 400, 'VALIDATION_ERROR');
    expect((await patch(n[0], { order: 2 })).status).toBe(200);

    const tooFar = await patch(n[1], { unitId: unitA, order: 3 });
    expectError(tooFar, 400, 'VALIDATION_ERROR');
    expect(tooFar.body.error.details).toEqual([{ path: 'order', message: 'Must be between 0 and 2' }]);
    expect((await patch(n[1], { unitId: unitA, order: 2 })).status).toBe(200);
  });

  it('changes nothing when the order is out of range', async () => {
    expectError(await patch(n[0], { title: 'Renamed', unitId: unitA, order: 9 }), 400, 'VALIDATION_ERROR');

    await expect(outline()).resolves.toMatchObject({ lessons: ['-/0:n0', '-/1:n1', '-/2:n2', 'A/0:a0', 'A/1:a1'] });
  });

  it.each([
    ['a unit of another own class', async () => addUnit('Elsewhere', (await createClass(teacher)).id)],
    ["another teacher's unit", async () => addUnit('Theirs', (await createClass(otherTeacher)).id, otherTeacher)],
    ['a unit that does not exist', async () => randomUUID()],
  ])('gives VALIDATION_ERROR for %s, and changes nothing', async (_name, makeUnit) => {
    const res = await patch(n[0], { title: 'Moved?', unitId: await makeUnit() });

    expectError(res, 400, 'VALIDATION_ERROR');
    expect(res.body.error.details).toEqual([{ path: 'unitId', message: 'Unknown unit' }]);
    await expect(Lesson.findByPk(n[0])).resolves.toMatchObject({ title: 'n0', unitId: null, position: 0 });
  });

  it.each([
    ['a negative order', { order: -1 }, 'order'],
    ['a malformed unitId', { unitId: 'A' }, 'unitId'],
    ['a blank title', { title: '' }, 'title'],
    ['an unknown field', { classId: randomUUID() }, 'classId'],
  ])('gives VALIDATION_ERROR for %s', async (_name, body, path) => {
    const res = await patch(n[0], body);

    expectError(res, 400, 'VALIDATION_ERROR');
    expect(detailPaths(res)).toContain(path);
  });

  it('keeps every group dense under simultaneous moves', async () => {
    const lessons = [...n, ...a];
    const targets = [null, unitA, unitB];

    const results = await Promise.all(
      Array.from({ length: 15 }, (_, index) =>
        patch(lessons[index % lessons.length], { unitId: targets[index % 3], order: 0 }),
      ),
    );

    expect(results.every((res) => res.status === 200)).toBe(true);
    await expect(Lesson.count()).resolves.toBe(5);
    await expectDense();
  });

  it("gives 404 NOT_FOUND for another teacher's lesson, the same as a missing one", async () => {
    const forOther = await api(otherTeacher).patch(`/api/v1/lessons/${n[0]}`, { title: 'Mine now' });
    const forMissing = await api(otherTeacher).patch(`/api/v1/lessons/${randomUUID()}`, { title: 'Mine now' });

    expectError(forOther, 404, 'NOT_FOUND');
    expect(forOther.body).toEqual(forMissing.body);
    await expect(Lesson.findByPk(n[0])).resolves.toMatchObject({ title: 'n0' });
  });
});

describe('DELETE /lessons/:id', () => {
  it('deletes the lesson with its homework and renumbers its group only', async () => {
    const unitId = await addUnit('U');
    const doomed = await addLesson('u0', unitId);
    await addLesson('u1', unitId);
    await addLesson('u2', unitId);
    await addLesson('n0');
    await Homework.create({ lessonId: doomed, type: 'code', instructionsText: null, instructionsFileId: null });

    const res = await api(teacher).delete(`/api/v1/lessons/${doomed}`);

    expect(res.status).toBe(204);
    expect(res.text).toBe('');
    await expect(outline()).resolves.toMatchObject({ lessons: ['-/0:n0', 'U/0:u1', 'U/1:u2'] });
    await expect(Homework.count()).resolves.toBe(0);
  });

  it('gives 404 NOT_FOUND the second time', async () => {
    const id = await addLesson('L');
    await api(teacher).delete(`/api/v1/lessons/${id}`);

    expectError(await api(teacher).delete(`/api/v1/lessons/${id}`), 404, 'NOT_FOUND');
  });

  it("gives 404 NOT_FOUND for another teacher's lesson, and keeps it", async () => {
    const id = await addLesson('L');

    expectError(await api(otherTeacher).delete(`/api/v1/lessons/${id}`), 404, 'NOT_FOUND');
    await expect(Lesson.findByPk(id)).resolves.not.toBeNull();
  });
});

describe('GET /lessons/:id', () => {
  let unitId: string;
  let lessonId: string;

  beforeEach(async () => {
    unitId = await addUnit('U');
    await addLesson('First', unitId);
    lessonId = await addLesson('Second', unitId);
  });

  it('gives the teacher the LessonDetail without mySubmission', async () => {
    const res = await api(teacher).get(`/api/v1/lessons/${lessonId}`);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      id: lessonId,
      classId: schoolClass.id,
      unitId,
      title: 'Second',
      order: 1,
      lessonFile: null,
      homework: null,
    });
  });

  it('gives a student with an active link the LessonDetail with mySubmission null', async () => {
    await linkActive(student);

    const res = await api(student).get(`/api/v1/lessons/${lessonId}`);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      id: lessonId,
      classId: schoolClass.id,
      unitId,
      title: 'Second',
      order: 1,
      lessonFile: null,
      homework: null,
      mySubmission: null,
    });
  });

  it('gives a student 404 until the link is active, the same as a missing lesson', async () => {
    await api(teacher).post(`/api/v1/classes/${schoolClass.id}/students`, {
      fullName: 'Ali',
      studentPublicId: student.publicId,
    });

    const awaiting = await api(student).get(`/api/v1/lessons/${lessonId}`);
    const missing = await api(student).get(`/api/v1/lessons/${randomUUID()}`);

    expectError(awaiting, 404, 'NOT_FOUND');
    expect(awaiting.body).toEqual(missing.body);

    await api(student).post('/api/v1/student/claims', { classPublicId: schoolClass.publicId });
    expect((await api(student).get(`/api/v1/lessons/${lessonId}`)).status).toBe(200);
  });

  it('gives a student 404 for a lesson of another class they are not linked to', async () => {
    await linkActive(student);
    const other = await createClass(teacher);
    const elsewhere = await addLesson('Elsewhere', null, other.id);

    expectError(await api(student).get(`/api/v1/lessons/${elsewhere}`), 404, 'NOT_FOUND');
  });

  it("answers another teacher's lesson the same as a missing one", async () => {
    const forOther = await api(otherTeacher).get(`/api/v1/lessons/${lessonId}`);
    const forMissing = await api(otherTeacher).get(`/api/v1/lessons/${randomUUID()}`);

    expectError(forOther, 404, 'NOT_FOUND');
    expect(forOther.body).toEqual(forMissing.body);
  });

  it('gives VALIDATION_ERROR for a malformed id or a query parameter', async () => {
    expectError(await api(teacher).get('/api/v1/lessons/nope'), 400, 'VALIDATION_ERROR');
    expectError(await api(teacher).get(`/api/v1/lessons/${lessonId}?full=1`), 400, 'VALIDATION_ERROR');
  });
});

describe('access', () => {
  const teacherRoutes = [
    ['POST /classes/:classId/units', (user?: TestUser) => api(user).post(`/api/v1/classes/${randomUUID()}/units`, { title: 'X' })],
    ['PATCH /units/:id', (user?: TestUser) => api(user).patch(`/api/v1/units/${randomUUID()}`, { title: 'X' })],
    ['DELETE /units/:id', (user?: TestUser) => api(user).delete(`/api/v1/units/${randomUUID()}`)],
    ['POST /classes/:classId/lessons', (user?: TestUser) => api(user).post(`/api/v1/classes/${randomUUID()}/lessons`, { title: 'X' })],
    ['PATCH /lessons/:id', (user?: TestUser) => api(user).patch(`/api/v1/lessons/${randomUUID()}`, { title: 'X' })],
    ['DELETE /lessons/:id', (user?: TestUser) => api(user).delete(`/api/v1/lessons/${randomUUID()}`)],
  ] as const;

  const sharedRoutes = [
    ['GET /classes/:classId/outline', (user?: TestUser) => api(user).get(`/api/v1/classes/${randomUUID()}/outline`)],
    ['GET /lessons/:id', (user?: TestUser) => api(user).get(`/api/v1/lessons/${randomUUID()}`)],
  ] as const;

  it.each(teacherRoutes)('gives a student 403 FORBIDDEN on %s', async (_route, send) => {
    expectError(await send(student), 403, 'FORBIDDEN');
  });

  it('gives a student with an active link 403 on writes to that class', async () => {
    await linkActive(student);
    const lessonId = await addLesson('L');

    expectError(await api(student).patch(`/api/v1/lessons/${lessonId}`, { title: 'Mine' }), 403, 'FORBIDDEN');
    expectError(
      await api(student).post(`/api/v1/classes/${schoolClass.id}/units`, { title: 'Mine' }),
      403,
      'FORBIDDEN',
    );
  });

  it.each([...teacherRoutes, ...sharedRoutes])('gives no token 401 UNAUTHENTICATED on %s', async (_route, send) => {
    expectError(await send(), 401, 'UNAUTHENTICATED');
  });

  it('still serves the class routes after this router', async () => {
    expect((await api(teacher).get(`/api/v1/classes/${schoolClass.id}`)).status).toBe(200);
    expect((await api(teacher).get(`/api/v1/classes/${schoolClass.id}/students`)).status).toBe(200);
  });
});
