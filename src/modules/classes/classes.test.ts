import { randomUUID } from 'node:crypto';

import type request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';

import {
  ClassLesson,
  ClassStudent,
  ClassUnit,
  Homework,
  Lesson,
  SchoolClass,
  Unit,
} from '../../db/models/index.js';
import { generatePublicId } from '../../lib/publicId.js';
import { resetRateLimits } from '../../middleware/rateLimit.js';
import { useTestDatabase } from '../../test/database.js';
import { api, createTestUser, type TestUser } from '../../test/users.js';

useTestDatabase();

let teacher: TestUser;
let otherTeacher: TestUser;
let categoryId: string;

const CLASS_KEYS = [
  'categoryId',
  'createdAt',
  'id',
  'linkedClasses',
  'name',
  'newSubmissionCount',
  'order',
  'publicId',
  'studentCount',
];

async function createCategory(user: TestUser, name: string): Promise<string> {
  const res = await api(user).post('/api/v1/categories', { name });
  expect(res.status).toBe(201);
  return res.body.id;
}

async function createClass(user: TestUser, category: string, name = 'Maths') {
  const res = await api(user).post('/api/v1/classes', { categoryId: category, name });
  expect(res.status).toBe(201);
  return res.body as { id: string; publicId: string; name: string; order: number };
}

// The class names of a category, in order, with their order values.
async function layout(category = categoryId): Promise<Array<[string, number]>> {
  const res = await api(teacher).get(`/api/v1/classes?categoryId=${category}`);
  return res.body.items.map((item: { name: string; order: number }) => [item.name, item.order]);
}

function expectError(res: request.Response, status: number, code: string): void {
  expect(res.status).toBe(status);
  expect(res.body.error.code).toBe(code);
}

beforeEach(async () => {
  await resetRateLimits();
  teacher = await createTestUser('teacher');
  otherTeacher = await createTestUser('teacher');
  categoryId = await createCategory(teacher, 'Algebra');
});

describe('POST /classes', () => {
  it('creates a class with a trimmed name and a generated publicId', async () => {
    const res = await api(teacher).post('/api/v1/classes', { categoryId, name: '  Maths 7A  ' });

    expect(res.status).toBe(201);
    expect(Object.keys(res.body).sort()).toEqual(CLASS_KEYS);
    expect(res.body).toMatchObject({
      categoryId,
      name: 'Maths 7A',
      order: 0,
      studentCount: 0,
      newSubmissionCount: 0,
      linkedClasses: [],
    });
    expect(res.body.publicId).toMatch(/^[a-z0-9]{8}$/);
  });

  it('gives every new class its first unit, Unit 1', async () => {
    const { id } = await createClass(teacher, categoryId);

    const outline = await api(teacher).get(`/api/v1/classes/${id}/outline`);

    expect(outline.body.units).toEqual([{ id: expect.any(String), classId: id, title: 'Unit 1', order: 0 }]);
    await expect(Unit.count({ where: { classId: id } })).resolves.toBe(1);
  });

  it('places each new class last in its category', async () => {
    const geometry = await createCategory(teacher, 'Geometry');
    await createClass(teacher, categoryId, 'A');
    await createClass(teacher, geometry, 'G');
    await createClass(teacher, categoryId, 'B');

    expect(await layout()).toEqual([
      ['A', 0],
      ['B', 1],
    ]);
    expect(await layout(geometry)).toEqual([['G', 0]]);
  });

  it('gives every class its own publicId', async () => {
    const ids = new Set<string>();
    for (let i = 0; i < 5; i += 1) {
      ids.add((await createClass(teacher, categoryId)).publicId);
    }

    expect(ids.size).toBe(5);
  });

  it.each([
    ["another teacher's category", async () => createCategory(otherTeacher, 'Theirs')],
    ['a category that does not exist', async () => randomUUID()],
  ])('gives VALIDATION_ERROR on categoryId for %s', async (_case, makeCategory) => {
    const res = await api(teacher).post('/api/v1/classes', { categoryId: await makeCategory(), name: 'Maths' });

    expectError(res, 400, 'VALIDATION_ERROR');
    expect(res.body.error.details).toEqual([{ path: 'categoryId', message: 'Unknown category' }]);
    await expect(Promise.all([SchoolClass.count(), Unit.count()])).resolves.toEqual([0, 0]);
  });

  it.each([
    ['no name', { name: undefined }, 'name'],
    ['a blank name', { name: '  ' }, 'name'],
    ['a null name', { name: null }, 'name'],
    ['a name over 80 characters', { name: 'x'.repeat(81) }, 'name'],
    ['the old subject', { subject: 'Maths' }, 'subject'],
    ['a malformed categoryId', { categoryId: 'nope' }, 'categoryId'],
    ['an unknown field', { teacherId: randomUUID() }, 'teacherId'],
  ])('gives VALIDATION_ERROR for %s', async (_case, overrides, path) => {
    const res = await api(teacher).post('/api/v1/classes', { categoryId, name: 'Maths', ...overrides });

    expectError(res, 400, 'VALIDATION_ERROR');
    expect(res.body.error.details.map((detail: { path: string }) => detail.path)).toContain(path);
  });

  it('accepts a name of exactly 80 characters', async () => {
    expect((await api(teacher).post('/api/v1/classes', { categoryId, name: 'n'.repeat(80) })).status).toBe(201);
  });

  async function fillClasses(count: number): Promise<void> {
    await SchoolClass.bulkCreate(
      Array.from({ length: count }, (_, index) => ({
        categoryId,
        teacherId: teacher.id,
        name: `Filler ${index}`,
        position: index,
        publicId: generatePublicId(),
      })),
    );
  }

  it('gives LIMIT_REACHED for a 101st class', async () => {
    await fillClasses(100);

    expectError(
      await api(teacher).post('/api/v1/classes', { categoryId, name: 'One too many' }),
      409,
      'LIMIT_REACHED',
    );
  });

  it('never lets simultaneous creates pass the cap together, or share an order', async () => {
    await fillClasses(95);

    const results = await Promise.all(
      Array.from({ length: 10 }, (_, index) =>
        api(teacher).post('/api/v1/classes', { categoryId, name: `Race ${index}` }),
      ),
    );

    expect(results.filter((res) => res.status === 201)).toHaveLength(5);
    expect(results.filter((res) => res.body.error?.code === 'LIMIT_REACHED')).toHaveLength(5);
    await expect(SchoolClass.count({ where: { teacherId: teacher.id } })).resolves.toBe(100);
    expect((await layout()).map(([, order]) => order)).toEqual(Array.from({ length: 100 }, (_, index) => index));
  });
});

describe('GET /classes', () => {
  it('lists by category order, then class order', async () => {
    const geometry = await createCategory(teacher, 'Geometry');
    await createClass(teacher, geometry, 'G1');
    await createClass(teacher, categoryId, 'A1');
    await createClass(teacher, categoryId, 'A2');
    await createClass(teacher, geometry, 'G2');
    await api(teacher).patch(`/api/v1/categories/${geometry}`, { order: 0 });

    const res = await api(teacher).get('/api/v1/classes');

    expect(res.status).toBe(200);
    expect(res.body.items.map((item: { name: string }) => item.name)).toEqual(['G1', 'G2', 'A1', 'A2']);
  });

  it('counts every roster row as a student', async () => {
    const { id } = await createClass(teacher, categoryId);
    await ClassStudent.bulkCreate([
      { classId: id, fullName: 'Ann', studentUserId: null },
      { classId: id, fullName: 'Ben', studentUserId: null },
    ]);

    const res = await api(teacher).get('/api/v1/classes');

    expect(res.body.items[0].studentCount).toBe(2);
    expect(Object.keys(res.body.items[0]).sort()).toEqual(CLASS_KEYS);
  });

  it('filters by categoryId', async () => {
    const otherCategory = await createCategory(teacher, 'Geometry');
    await createClass(teacher, categoryId, 'algebra class');
    await createClass(teacher, otherCategory, 'geometry class');

    const res = await api(teacher).get(`/api/v1/classes?categoryId=${otherCategory}`);

    expect(res.body.items.map((item: { name: string }) => item.name)).toEqual(['geometry class']);
  });

  it("returns nothing for another teacher's categoryId", async () => {
    const theirCategory = await createCategory(otherTeacher, 'Theirs');
    await createClass(otherTeacher, theirCategory);

    const res = await api(teacher).get(`/api/v1/classes?categoryId=${theirCategory}`);

    expect(res.body).toEqual({ items: [] });
  });

  it("lists only the caller's own classes", async () => {
    await createClass(otherTeacher, await createCategory(otherTeacher, 'Theirs'));

    expect((await api(teacher).get('/api/v1/classes')).body).toEqual({ items: [] });
  });

  it.each([
    ['a malformed categoryId', '?categoryId=nope'],
    ['an unknown parameter', '?sort=name'],
    ['a repeated categoryId', `?categoryId=${randomUUID()}&categoryId=${randomUUID()}`],
  ])('gives VALIDATION_ERROR for %s', async (_case, query) => {
    expectError(await api(teacher).get(`/api/v1/classes${query}`), 400, 'VALIDATION_ERROR');
  });
});

describe('GET /classes/:id', () => {
  it('returns the class', async () => {
    const created = await createClass(teacher, categoryId, '7A');

    const res = await api(teacher).get(`/api/v1/classes/${created.id}`);

    expect(res.status).toBe(200);
    expect(Object.keys(res.body).sort()).toEqual(CLASS_KEYS);
    expect(res.body).toMatchObject({ id: created.id, name: '7A', order: 0, publicId: created.publicId });
  });

  it('gives VALIDATION_ERROR for a malformed id', async () => {
    expectError(await api(teacher).get('/api/v1/classes/nope'), 400, 'VALIDATION_ERROR');
  });
});

describe('PATCH /classes/:id', () => {
  it('renames the class, trimmed', async () => {
    const { id } = await createClass(teacher, categoryId, 'Old');

    const res = await api(teacher).patch(`/api/v1/classes/${id}`, { name: ' New ' });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ name: 'New', order: 0 });
  });

  it('accepts an empty body and changes nothing', async () => {
    const created = await createClass(teacher, categoryId, 'Same');

    const res = await api(teacher).patch(`/api/v1/classes/${created.id}`, {});

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ name: 'Same', order: 0, categoryId });
  });

  describe('order inside its category', () => {
    let ids: string[];

    beforeEach(async () => {
      ids = [];
      for (const name of ['A', 'B', 'C', 'D']) {
        ids.push((await createClass(teacher, categoryId, name)).id);
      }
    });

    it.each([
      ['to the top', 3, 0, ['D', 'A', 'B', 'C']],
      ['to the bottom', 0, 3, ['B', 'C', 'D', 'A']],
      ['one step down', 1, 2, ['A', 'C', 'B', 'D']],
      ['one step up', 2, 1, ['A', 'C', 'B', 'D']],
      ['to where it already is', 1, 1, ['A', 'B', 'C', 'D']],
    ])('moves a class %s and renumbers the rest densely', async (_name, from, to, expected) => {
      const res = await api(teacher).patch(`/api/v1/classes/${ids[from]}`, { order: to });

      expect(res.status).toBe(200);
      expect(res.body.order).toBe(to);
      expect(await layout()).toEqual(expected.map((name, index) => [name, index]));
    });

    it('takes the same category with an order as a move inside it', async () => {
      await api(teacher).patch(`/api/v1/classes/${ids[0]}`, { categoryId, order: 2 });

      expect((await layout()).map(([name]) => name)).toEqual(['B', 'C', 'A', 'D']);
    });

    it.each([
      ['past the last class', { order: 4 }],
      ['negative', { order: -1 }],
      ['not a whole number', { order: 0.5 }],
    ])('gives VALIDATION_ERROR for an order %s and changes nothing', async (_name, body) => {
      const res = await api(teacher).patch(`/api/v1/classes/${ids[0]}`, body);

      expectError(res, 400, 'VALIDATION_ERROR');
      expect(res.body.error.details.map((detail: { path: string }) => detail.path)).toEqual(['order']);
      expect((await layout()).map(([name]) => name)).toEqual(['A', 'B', 'C', 'D']);
    });

    it('applies simultaneous moves one after the other, keeping the order dense', async () => {
      await Promise.all([
        api(teacher).patch(`/api/v1/classes/${ids[0]}`, { order: 3 }),
        api(teacher).patch(`/api/v1/classes/${ids[3]}`, { order: 0 }),
        api(teacher).patch(`/api/v1/classes/${ids[2]}`, { order: 1 }),
      ]);

      const result = await layout();
      expect(result.map(([name]) => name).sort()).toEqual(['A', 'B', 'C', 'D']);
      expect(result.map(([, order]) => order)).toEqual([0, 1, 2, 3]);
    });
  });

  describe('moving to another category', () => {
    let geometry: string;
    let a: string;

    beforeEach(async () => {
      geometry = await createCategory(teacher, 'Geometry');
      a = (await createClass(teacher, categoryId, 'A')).id;
      await createClass(teacher, categoryId, 'B');
      await createClass(teacher, categoryId, 'C');
      await createClass(teacher, geometry, 'G1');
      await createClass(teacher, geometry, 'G2');
    });

    it('puts it last there without an order, and closes the gap it left', async () => {
      const res = await api(teacher).patch(`/api/v1/classes/${a}`, { categoryId: geometry });

      expect(res.body).toMatchObject({ categoryId: geometry, order: 2 });
      expect(await layout(geometry)).toEqual([
        ['G1', 0],
        ['G2', 1],
        ['A', 2],
      ]);
      expect(await layout()).toEqual([
        ['B', 0],
        ['C', 1],
      ]);
    });

    it('puts it at the order given', async () => {
      const res = await api(teacher).patch(`/api/v1/classes/${a}`, { categoryId: geometry, order: 1 });

      expect(res.body).toMatchObject({ categoryId: geometry, order: 1 });
      expect(await layout(geometry)).toEqual([
        ['G1', 0],
        ['A', 1],
        ['G2', 2],
      ]);
    });

    it('counts the order in the new category, where the end is one past its last class', async () => {
      expect((await api(teacher).patch(`/api/v1/classes/${a}`, { categoryId: geometry, order: 2 })).status).toBe(200);

      const tooFar = await api(teacher).patch(`/api/v1/classes/${a}`, { categoryId, order: 3 });
      expectError(tooFar, 400, 'VALIDATION_ERROR');
      await expect(SchoolClass.findByPk(a)).resolves.toMatchObject({ categoryId: geometry, position: 2 });
    });

    it('updates both class counts', async () => {
      await api(teacher).patch(`/api/v1/classes/${a}`, { categoryId: geometry });
      const categories = (await api(teacher).get('/api/v1/categories')).body.items;

      expect(categories.map((item: { name: string; classCount: number }) => [item.name, item.classCount])).toEqual([
        ['Algebra', 2],
        ['Geometry', 3],
      ]);
    });

    it("gives VALIDATION_ERROR for another teacher's category and changes nothing", async () => {
      const theirs = await createCategory(otherTeacher, 'Theirs');

      const res = await api(teacher).patch(`/api/v1/classes/${a}`, { categoryId: theirs });

      expectError(res, 400, 'VALIDATION_ERROR');
      expect(res.body.error.details).toEqual([{ path: 'categoryId', message: 'Unknown category' }]);
      await expect(SchoolClass.findByPk(a)).resolves.toMatchObject({ categoryId, position: 0 });
    });
  });

  it.each([
    ['a null name', { name: null }],
    ['a blank name', { name: ' ' }],
    ['a null categoryId', { categoryId: null }],
    ['the old subject', { subject: 'Physics' }],
    ['linkedClassIds that is not a list', { linkedClassIds: 'all' }],
    ['a malformed id in linkedClassIds', { linkedClassIds: ['nope'] }],
    ['an unknown field', { publicId: 'aaaaaaaa' }],
  ])('gives VALIDATION_ERROR for %s', async (_case, body) => {
    const { id } = await createClass(teacher, categoryId);

    expectError(await api(teacher).patch(`/api/v1/classes/${id}`, body), 400, 'VALIDATION_ERROR');
  });
});

describe('DELETE /classes/:id', () => {
  it('deletes the class and everything in it, keeping the category', async () => {
    const { id } = await createClass(teacher, categoryId);
    const [unit] = await Unit.findAll({ where: { classId: id } });
    const lesson = await api(teacher).post(`/api/v1/classes/${id}/lessons`, { title: 'Lesson 1', unitId: unit?.id });
    await api(teacher).put(`/api/v1/lessons/${lesson.body.id}/homework?classId=${id}`, { type: 'text' });
    await ClassStudent.create({ classId: id, fullName: 'Ann', studentUserId: null });

    const res = await api(teacher).delete(`/api/v1/classes/${id}`);

    expect(res.status).toBe(204);
    expect(res.text).toBe('');
    await expect(
      Promise.all([
        SchoolClass.count(),
        Unit.count(),
        ClassUnit.count(),
        Lesson.count(),
        ClassLesson.count(),
        Homework.count(),
        ClassStudent.count(),
      ]),
    ).resolves.toEqual([0, 0, 0, 0, 0, 0, 0]);
    expect((await api(teacher).get('/api/v1/categories')).body.items).toHaveLength(1);
  });

  it('moves the classes after it up one', async () => {
    await createClass(teacher, categoryId, 'A');
    const doomed = await createClass(teacher, categoryId, 'B');
    await createClass(teacher, categoryId, 'C');

    await api(teacher).delete(`/api/v1/classes/${doomed.id}`);

    expect(await layout()).toEqual([
      ['A', 0],
      ['C', 1],
    ]);
  });
});

describe("another teacher's class", () => {
  it.each([
    ['GET', (user: TestUser, id: string) => api(user).get(`/api/v1/classes/${id}`)],
    ['PATCH', (user: TestUser, id: string) => api(user).patch(`/api/v1/classes/${id}`, { name: 'Mine now' })],
    ['DELETE', (user: TestUser, id: string) => api(user).delete(`/api/v1/classes/${id}`)],
  ])('gives 404 NOT_FOUND on %s and changes nothing', async (_method, send) => {
    const { id } = await createClass(otherTeacher, await createCategory(otherTeacher, 'Theirs'));

    expectError(await send(teacher, id), 404, 'NOT_FOUND');
    await expect(SchoolClass.findByPk(id)).resolves.toMatchObject({ name: 'Maths' });
  });

  it('answers the same as a class that does not exist', async () => {
    const { id } = await createClass(otherTeacher, await createCategory(otherTeacher, 'Theirs'));

    const forOther = await api(teacher).get(`/api/v1/classes/${id}`);
    const forMissing = await api(teacher).get(`/api/v1/classes/${randomUUID()}`);

    expect(forOther.status).toBe(404);
    expect(forOther.body).toEqual(forMissing.body);
  });
});

describe('access', () => {
  const routes = [
    ['GET /classes', (user?: TestUser) => api(user).get('/api/v1/classes')],
    ['POST /classes', (user?: TestUser) => api(user).post('/api/v1/classes', { categoryId: randomUUID(), name: 'X' })],
    ['GET /classes/:id', (user?: TestUser) => api(user).get(`/api/v1/classes/${randomUUID()}`)],
    ['PATCH /classes/:id', (user?: TestUser) => api(user).patch(`/api/v1/classes/${randomUUID()}`, { name: 'X' })],
    ['DELETE /classes/:id', (user?: TestUser) => api(user).delete(`/api/v1/classes/${randomUUID()}`)],
  ] as const;

  it.each(routes)('gives a student 403 FORBIDDEN on %s', async (_route, send) => {
    expectError(await send(await createTestUser('student')), 403, 'FORBIDDEN');
  });

  it.each(routes)('gives no token 401 UNAUTHENTICATED on %s', async (_route, send) => {
    expectError(await send(), 401, 'UNAUTHENTICATED');
  });
});
