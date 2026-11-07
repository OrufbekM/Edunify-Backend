import { randomUUID } from 'node:crypto';

import type request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';

import { sequelize } from '../../db/index.js';
import {
  ClassStudent,
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

const CLASS_KEYS = ['categoryId', 'createdAt', 'id', 'name', 'publicId', 'studentCount', 'subject'];

async function createCategory(user: TestUser, name: string): Promise<string> {
  const res = await api(user).post('/api/v1/categories', { name });
  expect(res.status).toBe(201);
  return res.body.id;
}

async function createClass(user: TestUser, category: string, body: object = {}) {
  const res = await api(user).post('/api/v1/classes', { categoryId: category, subject: 'Maths', ...body });
  expect(res.status).toBe(201);
  return res.body as { id: string; publicId: string; name: string | null };
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
  it('creates a class with a generated publicId', async () => {
    const res = await api(teacher).post('/api/v1/classes', {
      categoryId,
      subject: '  Mathematics  ',
      name: ' 7A ',
    });

    expect(res.status).toBe(201);
    expect(Object.keys(res.body).sort()).toEqual(CLASS_KEYS);
    expect(res.body).toMatchObject({
      categoryId,
      subject: 'Mathematics',
      name: '7A',
      studentCount: 0,
    });
    expect(res.body.publicId).toMatch(/^[a-z0-9]{8}$/);
  });

  it.each([
    ['omitted', {}],
    ['null', { name: null }],
    ['empty', { name: '' }],
    ['blank', { name: '   ' }],
  ])('stores a name that is %s as null', async (_case, body) => {
    expect((await createClass(teacher, categoryId, body)).name).toBeNull();
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
    const res = await api(teacher).post('/api/v1/classes', {
      categoryId: await makeCategory(),
      subject: 'Maths',
    });

    expectError(res, 400, 'VALIDATION_ERROR');
    expect(res.body.error.details).toEqual([{ path: 'categoryId', message: 'Unknown category' }]);
    await expect(SchoolClass.count()).resolves.toBe(0);
  });

  it.each([
    ['a blank subject', { subject: '  ' }, 'subject'],
    ['a subject over 80 characters', { subject: 'x'.repeat(81) }, 'subject'],
    ['a name over 80 characters', { name: 'x'.repeat(81) }, 'name'],
    ['a malformed categoryId', { categoryId: 'nope' }, 'categoryId'],
    ['an unknown field', { teacherId: randomUUID() }, 'teacherId'],
  ])('gives VALIDATION_ERROR for %s', async (_case, overrides, path) => {
    const res = await api(teacher).post('/api/v1/classes', {
      categoryId,
      subject: 'Maths',
      ...overrides,
    });

    expectError(res, 400, 'VALIDATION_ERROR');
    expect(res.body.error.details.map((detail: { path: string }) => detail.path)).toContain(path);
  });

  it('accepts a subject and a name of exactly 80 characters', async () => {
    const res = await api(teacher).post('/api/v1/classes', {
      categoryId,
      subject: 's'.repeat(80),
      name: 'n'.repeat(80),
    });

    expect(res.status).toBe(201);
  });

  async function fillClasses(count: number): Promise<void> {
    await SchoolClass.bulkCreate(
      Array.from({ length: count }, () => ({
        categoryId,
        teacherId: teacher.id,
        subject: 'Filler',
        name: null,
        publicId: generatePublicId(),
      })),
    );
  }

  it('gives LIMIT_REACHED for a 101st class', async () => {
    await fillClasses(100);

    expectError(
      await api(teacher).post('/api/v1/classes', { categoryId, subject: 'One too many' }),
      409,
      'LIMIT_REACHED',
    );
  });

  it('never lets simultaneous creates pass the cap together', async () => {
    await fillClasses(95);

    const results = await Promise.all(
      Array.from({ length: 10 }, (_, index) =>
        api(teacher).post('/api/v1/classes', { categoryId, subject: `Race ${index}` }),
      ),
    );

    expect(results.filter((res) => res.status === 201)).toHaveLength(5);
    expect(results.filter((res) => res.body.error?.code === 'LIMIT_REACHED')).toHaveLength(5);
    await expect(SchoolClass.count({ where: { teacherId: teacher.id } })).resolves.toBe(100);
  });
});

describe('GET /classes', () => {
  async function setCreatedAt(id: string, minutesAgo: number): Promise<void> {
    await sequelize.query(
      `UPDATE classes SET created_at = now() - make_interval(mins => :minutesAgo) WHERE id = :id`,
      { replacements: { id, minutesAgo } },
    );
  }

  it('lists the newest class first', async () => {
    const oldest = await createClass(teacher, categoryId, { name: 'oldest' });
    const newest = await createClass(teacher, categoryId, { name: 'newest' });
    const middle = await createClass(teacher, categoryId, { name: 'middle' });
    await setCreatedAt(oldest.id, 30);
    await setCreatedAt(middle.id, 20);
    await setCreatedAt(newest.id, 10);

    const res = await api(teacher).get('/api/v1/classes');

    expect(res.status).toBe(200);
    expect(res.body.items.map((item: { name: string }) => item.name)).toEqual([
      'newest',
      'middle',
      'oldest',
    ]);
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
    await createClass(teacher, categoryId, { name: 'algebra class' });
    await createClass(teacher, otherCategory, { name: 'geometry class' });

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
    const created = await createClass(teacher, categoryId, { name: '7A' });

    const res = await api(teacher).get(`/api/v1/classes/${created.id}`);

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ id: created.id, name: '7A', publicId: created.publicId });
  });

  it('gives VALIDATION_ERROR for a malformed id', async () => {
    expectError(await api(teacher).get('/api/v1/classes/nope'), 400, 'VALIDATION_ERROR');
  });
});

describe('PATCH /classes/:id', () => {
  it('updates subject and name', async () => {
    const { id } = await createClass(teacher, categoryId, { name: 'Old' });

    const res = await api(teacher).patch(`/api/v1/classes/${id}`, { subject: ' Physics ', name: ' New ' });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ subject: 'Physics', name: 'New' });
  });

  it('clears the name with null and leaves it alone when absent', async () => {
    const { id } = await createClass(teacher, categoryId, { name: 'Keep me' });

    expect((await api(teacher).patch(`/api/v1/classes/${id}`, { subject: 'Physics' })).body.name).toBe(
      'Keep me',
    );
    expect((await api(teacher).patch(`/api/v1/classes/${id}`, { name: null })).body.name).toBeNull();
  });

  it('moves the class to another own category', async () => {
    const { id } = await createClass(teacher, categoryId);
    const target = await createCategory(teacher, 'Geometry');

    const res = await api(teacher).patch(`/api/v1/classes/${id}`, { categoryId: target });
    const categories = (await api(teacher).get('/api/v1/categories')).body.items;

    expect(res.body.categoryId).toBe(target);
    expect(categories.map((item: { name: string; classCount: number }) => [item.name, item.classCount])).toEqual([
      ['Algebra', 0],
      ['Geometry', 1],
    ]);
  });

  it("gives VALIDATION_ERROR for another teacher's category", async () => {
    const { id } = await createClass(teacher, categoryId);
    const theirs = await createCategory(otherTeacher, 'Theirs');

    const res = await api(teacher).patch(`/api/v1/classes/${id}`, { categoryId: theirs });

    expectError(res, 400, 'VALIDATION_ERROR');
    await expect(SchoolClass.findByPk(id)).resolves.toMatchObject({ categoryId });
  });

  it('accepts an empty body and changes nothing', async () => {
    const created = await createClass(teacher, categoryId, { name: 'Same' });

    const res = await api(teacher).patch(`/api/v1/classes/${created.id}`, {});

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ name: 'Same', subject: 'Maths' });
  });

  it.each([
    ['a null subject', { subject: null }],
    ['a null categoryId', { categoryId: null }],
    ['an unknown field', { publicId: 'aaaaaaaa' }],
  ])('gives VALIDATION_ERROR for %s', async (_case, body) => {
    const { id } = await createClass(teacher, categoryId);

    expectError(await api(teacher).patch(`/api/v1/classes/${id}`, body), 400, 'VALIDATION_ERROR');
  });
});

describe('DELETE /classes/:id', () => {
  it('deletes the class and everything in it, keeping the category', async () => {
    const { id } = await createClass(teacher, categoryId);
    const unit = await Unit.create({ classId: id, title: 'Unit 1', position: 0 });
    const lesson = await Lesson.create({
      classId: id,
      unitId: unit.id,
      title: 'Lesson 1',
      position: 0,
      lessonFileId: null,
    });
    await Homework.create({
      lessonId: lesson.id,
      type: 'text',
      instructionsText: null,
      instructionsFileId: null,
    });
    await ClassStudent.create({ classId: id, fullName: 'Ann', studentUserId: null });

    const res = await api(teacher).delete(`/api/v1/classes/${id}`);

    expect(res.status).toBe(204);
    expect(res.text).toBe('');
    await expect(
      Promise.all([
        SchoolClass.count(),
        Unit.count(),
        Lesson.count(),
        Homework.count(),
        ClassStudent.count(),
      ]),
    ).resolves.toEqual([0, 0, 0, 0, 0]);
    expect((await api(teacher).get('/api/v1/categories')).body.items).toHaveLength(1);
  });
});

describe("another teacher's class", () => {
  it.each([
    ['GET', (user: TestUser, id: string) => api(user).get(`/api/v1/classes/${id}`)],
    ['PATCH', (user: TestUser, id: string) => api(user).patch(`/api/v1/classes/${id}`, { subject: 'Mine now' })],
    ['DELETE', (user: TestUser, id: string) => api(user).delete(`/api/v1/classes/${id}`)],
  ])('gives 404 NOT_FOUND on %s and changes nothing', async (_method, send) => {
    const { id } = await createClass(otherTeacher, await createCategory(otherTeacher, 'Theirs'));

    expectError(await send(teacher, id), 404, 'NOT_FOUND');
    await expect(SchoolClass.findByPk(id)).resolves.toMatchObject({ subject: 'Maths' });
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
    ['POST /classes', (user?: TestUser) => api(user).post('/api/v1/classes', { categoryId: randomUUID(), subject: 'X' })],
    ['GET /classes/:id', (user?: TestUser) => api(user).get(`/api/v1/classes/${randomUUID()}`)],
    ['PATCH /classes/:id', (user?: TestUser) => api(user).patch(`/api/v1/classes/${randomUUID()}`, { subject: 'X' })],
    ['DELETE /classes/:id', (user?: TestUser) => api(user).delete(`/api/v1/classes/${randomUUID()}`)],
  ] as const;

  it.each(routes)('gives a student 403 FORBIDDEN on %s', async (_route, send) => {
    expectError(await send(await createTestUser('student')), 403, 'FORBIDDEN');
  });

  it.each(routes)('gives no token 401 UNAUTHENTICATED on %s', async (_route, send) => {
    expectError(await send(), 401, 'UNAUTHENTICATED');
  });
});
