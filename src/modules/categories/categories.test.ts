import { randomUUID } from 'node:crypto';

import type request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';

import { Category } from '../../db/models/index.js';
import { resetRateLimits } from '../../middleware/rateLimit.js';
import { useTestDatabase } from '../../test/database.js';
import { api, createTestUser, type TestUser } from '../../test/users.js';

useTestDatabase();

let teacher: TestUser;
let otherTeacher: TestUser;

beforeEach(async () => {
  await resetRateLimits();
  teacher = await createTestUser('teacher');
  otherTeacher = await createTestUser('teacher');
});

const ISO_MILLIS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

async function createCategory(user: TestUser, name: string): Promise<string> {
  const res = await api(user).post('/api/v1/categories', { name });
  expect(res.status).toBe(201);
  return res.body.id;
}

async function names(user = teacher): Promise<string[]> {
  return (await api(user).get('/api/v1/categories')).body.items.map((item: { name: string }) => item.name);
}

async function orders(user = teacher): Promise<number[]> {
  return (await api(user).get('/api/v1/categories')).body.items.map((item: { order: number }) => item.order);
}

async function addClass(user: TestUser, categoryId: string): Promise<string> {
  const res = await api(user).post('/api/v1/classes', { categoryId, name: 'Maths' });
  expect(res.status).toBe(201);
  return res.body.id;
}

function expectError(res: request.Response, status: number, code: string): void {
  expect(res.status).toBe(status);
  expect(res.body.error.code).toBe(code);
}

describe('GET /categories', () => {
  it('starts empty', async () => {
    const res = await api(teacher).get('/api/v1/categories');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ items: [] });
  });

  it('sorts by order, which is the order they were made in until the teacher moves them', async () => {
    for (const name of ['beta', 'Gamma', 'alpha 2', 'Alpha']) {
      await createCategory(teacher, name);
    }

    expect(await names()).toEqual(['beta', 'Gamma', 'alpha 2', 'Alpha']);
    expect(await orders()).toEqual([0, 1, 2, 3]);
  });

  it('returns exactly the contract Category with its class count', async () => {
    const busy = await createCategory(teacher, 'Busy');
    await createCategory(teacher, 'Empty');
    await addClass(teacher, busy);
    await addClass(teacher, busy);

    const res = await api(teacher).get('/api/v1/categories');

    expect(res.body.items).toEqual([
      { id: busy, name: 'Busy', order: 0, classCount: 2, createdAt: expect.stringMatching(ISO_MILLIS) },
      { id: expect.any(String), name: 'Empty', order: 1, classCount: 0, createdAt: expect.any(String) },
    ]);
  });

  it("lists only the caller's own categories", async () => {
    await createCategory(otherTeacher, 'Not yours');

    expect((await api(teacher).get('/api/v1/categories')).body).toEqual({ items: [] });
  });

  it('rejects unknown query parameters', async () => {
    expectError(await api(teacher).get('/api/v1/categories?sort=name'), 400, 'VALIDATION_ERROR');
  });
});

describe('POST /categories', () => {
  it('creates a category with a trimmed name', async () => {
    const res = await api(teacher).post('/api/v1/categories', { name: '  Algebra  ' });

    expect(res.status).toBe(201);
    expect(res.body).toEqual({
      id: expect.any(String),
      name: 'Algebra',
      order: 0,
      classCount: 0,
      createdAt: expect.stringMatching(ISO_MILLIS),
    });
  });

  it('places each new category last', async () => {
    await createCategory(teacher, 'First');
    await createCategory(otherTeacher, 'Not counted');

    expect((await api(teacher).post('/api/v1/categories', { name: 'Second' })).body.order).toBe(1);
  });

  it('gives CATEGORY_NAME_TAKEN for the same name in another letter case', async () => {
    await createCategory(teacher, 'Math');

    expectError(
      await api(teacher).post('/api/v1/categories', { name: 'mATH' }),
      409,
      'CATEGORY_NAME_TAKEN',
    );
  });

  it('lets two teachers use the same name', async () => {
    await createCategory(otherTeacher, 'Math');

    expect((await api(teacher).post('/api/v1/categories', { name: 'Math' })).status).toBe(201);
  });

  it('gives CATEGORY_NAME_TAKEN to the loser of two simultaneous creates', async () => {
    const results = await Promise.all([
      api(teacher).post('/api/v1/categories', { name: 'Race' }),
      api(teacher).post('/api/v1/categories', { name: 'race' }),
    ]);

    expect(results.map((res) => res.status).sort()).toEqual([201, 409]);
    await expect(Category.count()).resolves.toBe(1);
  });

  it('accepts a name of exactly 60 characters', async () => {
    expect((await api(teacher).post('/api/v1/categories', { name: 'x'.repeat(60) })).status).toBe(
      201,
    );
  });

  it.each([
    ['a blank name', { name: '   ' }, 'name'],
    ['a name over 60 characters', { name: 'x'.repeat(61) }, 'name'],
    ['no name', {}, 'name'],
    ['an unknown field', { name: 'Math', color: 'red' }, 'color'],
  ])('gives VALIDATION_ERROR for %s', async (_name, body, path) => {
    const res = await api(teacher).post('/api/v1/categories', body);

    expectError(res, 400, 'VALIDATION_ERROR');
    expect(res.body.error.details.map((detail: { path: string }) => detail.path)).toContain(path);
  });

  it('gives LIMIT_REACHED for a 101st category', async () => {
    await Category.bulkCreate(
      Array.from({ length: 100 }, (_, index) => ({ teacherId: teacher.id, name: `C${index}`, position: index })),
    );

    expectError(
      await api(teacher).post('/api/v1/categories', { name: 'One too many' }),
      409,
      'LIMIT_REACHED',
    );
  });

  it('never lets simultaneous creates pass the cap together', async () => {
    await Category.bulkCreate(
      Array.from({ length: 95 }, (_, index) => ({ teacherId: teacher.id, name: `C${index}`, position: index })),
    );

    const results = await Promise.all(
      Array.from({ length: 10 }, (_, index) =>
        api(teacher).post('/api/v1/categories', { name: `Race ${index}` }),
      ),
    );

    expect(results.filter((res) => res.status === 201)).toHaveLength(5);
    expect(results.filter((res) => res.body.error?.code === 'LIMIT_REACHED')).toHaveLength(5);
    await expect(Category.count({ where: { teacherId: teacher.id } })).resolves.toBe(100);
    expect(await orders()).toEqual(Array.from({ length: 100 }, (_, index) => index));
  });
});

describe('PATCH /categories/:id', () => {
  it('renames and returns the class count', async () => {
    const id = await createCategory(teacher, 'Old');
    await addClass(teacher, id);

    const res = await api(teacher).patch(`/api/v1/categories/${id}`, { name: ' New ' });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ id, name: 'New', classCount: 1 });
  });

  it('lets a category change the letter case of its own name', async () => {
    const id = await createCategory(teacher, 'Math');

    expect((await api(teacher).patch(`/api/v1/categories/${id}`, { name: 'MATH' })).body.name).toBe(
      'MATH',
    );
  });

  it("gives CATEGORY_NAME_TAKEN for another category's name", async () => {
    await createCategory(teacher, 'Taken');
    const id = await createCategory(teacher, 'Free');

    expectError(
      await api(teacher).patch(`/api/v1/categories/${id}`, { name: 'TAKEN' }),
      409,
      'CATEGORY_NAME_TAKEN',
    );
  });

  it('gives VALIDATION_ERROR for a malformed id', async () => {
    expectError(
      await api(teacher).patch('/api/v1/categories/not-a-uuid', { name: 'X' }),
      400,
      'VALIDATION_ERROR',
    );
  });

  describe('order', () => {
    let ids: string[];

    beforeEach(async () => {
      ids = [];
      for (const name of ['A', 'B', 'C', 'D']) {
        ids.push(await createCategory(teacher, name));
      }
    });

    it.each([
      ['to the front', 3, 0, ['D', 'A', 'B', 'C']],
      ['to the end', 0, 3, ['B', 'C', 'D', 'A']],
      ['one step right', 1, 2, ['A', 'C', 'B', 'D']],
      ['one step left', 2, 1, ['A', 'C', 'B', 'D']],
      ['to where it already is', 2, 2, ['A', 'B', 'C', 'D']],
    ])('moves a category %s and renumbers the rest densely', async (_name, from, to, expected) => {
      const res = await api(teacher).patch(`/api/v1/categories/${ids[from]}`, { order: to });

      expect(res.status).toBe(200);
      expect(res.body.order).toBe(to);
      expect(await names()).toEqual(expected);
      expect(await orders()).toEqual([0, 1, 2, 3]);
    });

    it('renames and moves in one request', async () => {
      const res = await api(teacher).patch(`/api/v1/categories/${ids[0]}`, { name: 'Z', order: 3 });

      expect(res.body).toMatchObject({ name: 'Z', order: 3 });
      expect(await names()).toEqual(['B', 'C', 'D', 'Z']);
    });

    it('changes nothing for an empty body', async () => {
      expect((await api(teacher).patch(`/api/v1/categories/${ids[1]}`, {})).body).toMatchObject({ name: 'B', order: 1 });
      expect(await names()).toEqual(['A', 'B', 'C', 'D']);
    });

    it.each([
      ['past the last category', { order: 4 }],
      ['negative', { order: -1 }],
      ['not a whole number', { order: 1.5 }],
      ['a string', { order: '1' }],
    ])('gives VALIDATION_ERROR for an order %s and changes nothing', async (_name, body) => {
      const res = await api(teacher).patch(`/api/v1/categories/${ids[0]}`, body);

      expectError(res, 400, 'VALIDATION_ERROR');
      expect(res.body.error.details).toEqual([{ path: 'order', message: expect.any(String) }]);
      expect(await names()).toEqual(['A', 'B', 'C', 'D']);
    });

    it('applies simultaneous moves one after the other, keeping the order dense', async () => {
      await Promise.all([
        api(teacher).patch(`/api/v1/categories/${ids[0]}`, { order: 3 }),
        api(teacher).patch(`/api/v1/categories/${ids[3]}`, { order: 0 }),
        api(teacher).patch(`/api/v1/categories/${ids[1]}`, { order: 2 }),
      ]);

      expect((await names()).sort()).toEqual(['A', 'B', 'C', 'D']);
      expect(await orders()).toEqual([0, 1, 2, 3]);
    });

    it("never touches another teacher's order", async () => {
      await createCategory(otherTeacher, 'X');
      await createCategory(otherTeacher, 'Y');

      await api(teacher).patch(`/api/v1/categories/${ids[3]}`, { order: 0 });

      expect(await names(otherTeacher)).toEqual(['X', 'Y']);
      expect(await orders(otherTeacher)).toEqual([0, 1]);
    });
  });
});

describe('DELETE /categories/:id', () => {
  it('deletes an empty category with an empty 204', async () => {
    const id = await createCategory(teacher, 'Doomed');

    const res = await api(teacher).delete(`/api/v1/categories/${id}`);

    expect(res.status).toBe(204);
    expect(res.text).toBe('');
    await expect(Category.findByPk(id)).resolves.toBeNull();
  });

  it('moves the categories after it up one', async () => {
    await createCategory(teacher, 'A');
    const doomed = await createCategory(teacher, 'B');
    await createCategory(teacher, 'C');
    await createCategory(teacher, 'D');

    await api(teacher).delete(`/api/v1/categories/${doomed}`);

    expect(await names()).toEqual(['A', 'C', 'D']);
    expect(await orders()).toEqual([0, 1, 2]);
  });

  it('gives CATEGORY_NOT_EMPTY while the category has classes', async () => {
    const id = await createCategory(teacher, 'Busy');
    const classId = await addClass(teacher, id);

    expectError(await api(teacher).delete(`/api/v1/categories/${id}`), 409, 'CATEGORY_NOT_EMPTY');
    expect(await orders()).toEqual([0]);

    await api(teacher).delete(`/api/v1/classes/${classId}`);
    expect((await api(teacher).delete(`/api/v1/categories/${id}`)).status).toBe(204);
  });
});

describe("another teacher's category", () => {
  it.each([
    ['PATCH', (user: TestUser, id: string) => api(user).patch(`/api/v1/categories/${id}`, { name: 'Mine now' })],
    ['DELETE', (user: TestUser, id: string) => api(user).delete(`/api/v1/categories/${id}`)],
  ])('gives 404 NOT_FOUND on %s and changes nothing', async (_method, send) => {
    const id = await createCategory(otherTeacher, 'Theirs');

    expectError(await send(teacher, id), 404, 'NOT_FOUND');
    await expect(Category.findByPk(id)).resolves.toMatchObject({ name: 'Theirs' });
  });

  it('answers the same as a category that does not exist', async () => {
    const theirs = await createCategory(otherTeacher, 'Theirs');

    const forOther = await api(teacher).delete(`/api/v1/categories/${theirs}`);
    const forMissing = await api(teacher).delete(`/api/v1/categories/${randomUUID()}`);

    expect(forOther.body).toEqual(forMissing.body);
  });
});

describe('access', () => {
  const routes = [
    ['GET /categories', (user?: TestUser) => api(user).get('/api/v1/categories')],
    ['POST /categories', (user?: TestUser) => api(user).post('/api/v1/categories', { name: 'X' })],
    ['PATCH /categories/:id', (user?: TestUser) => api(user).patch(`/api/v1/categories/${randomUUID()}`, { name: 'X' })],
    ['DELETE /categories/:id', (user?: TestUser) => api(user).delete(`/api/v1/categories/${randomUUID()}`)],
  ] as const;

  it.each(routes)('gives a student 403 FORBIDDEN on %s', async (_route, send) => {
    expectError(await send(await createTestUser('student')), 403, 'FORBIDDEN');
  });

  it.each(routes)('gives no token 401 UNAUTHENTICATED on %s', async (_route, send) => {
    expectError(await send(), 401, 'UNAUTHENTICATED');
  });
});
