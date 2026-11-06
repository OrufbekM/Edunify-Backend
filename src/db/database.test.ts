import { randomUUID } from 'node:crypto';
import { readdir } from 'node:fs/promises';
import path from 'node:path';

import { QueryTypes, UniqueConstraintError } from 'sequelize';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { logger } from '../lib/logger.js';
import { insertWithPublicId } from '../lib/publicId.js';
import { useTestDatabase } from '../test/database.js';
import { sequelize } from './index.js';
import { Category, SchoolClass, User } from './models/index.js';

useTestDatabase();

afterEach(() => {
  vi.restoreAllMocks();
});

function selectOne<T extends object>(sql: string): Promise<T | null> {
  return sequelize.query<T>(sql, { type: QueryTypes.SELECT, plain: true });
}

function createStudent(publicId: string, email = `${randomUUID()}@example.com`): Promise<User> {
  return User.create({
    role: 'student',
    fullName: 'Student',
    email,
    passwordHash: 'hash',
    publicId,
  });
}

describe('test database', () => {
  it('is never the development database', async () => {
    const row = await selectOne<{ name: string }>('SELECT current_database() AS name');

    expect(row?.name).toMatch(/_test$/);
  });

  it('has every migration applied', async () => {
    const files = await readdir(path.join(import.meta.dirname, 'migrations'));
    const row = await selectOne<{ count: string }>('SELECT count(*) AS count FROM sequelize_meta');

    expect(Number(row?.count)).toBe(files.filter((file) => /^\d+-.*\.ts$/.test(file)).length);
  });

  it('has the index on refresh_tokens.family_id', async () => {
    const row = await selectOne<{ definition: string }>(
      `SELECT indexdef AS definition FROM pg_indexes WHERE indexname = 'refresh_tokens_family_id_idx'`,
    );

    expect(row?.definition).toContain('(family_id)');
  });

  it('keeps rows within a test', async () => {
    await createStudent('aaaaaaaa');

    await expect(User.count()).resolves.toBe(1);
  });

  it('truncates between tests', async () => {
    await expect(User.count()).resolves.toBe(0);
  });
});

describe('Sequelize logging', () => {
  it('goes through pino', async () => {
    const debug = vi.spyOn(logger, 'debug');

    await sequelize.query('SELECT 1 AS logged_query');

    expect(debug).toHaveBeenCalledWith(
      { sql: expect.stringContaining('logged_query') },
      'SQL query',
    );
  });
});

describe('insertWithPublicId on real tables', () => {
  it('retries a collision on users.public_id', async () => {
    await createStudent('taken000');
    let attempts = 0;

    const student = await insertWithPublicId((publicId) => {
      attempts += 1;
      return createStudent(attempts < 3 ? 'taken000' : publicId);
    });

    expect(attempts).toBe(3);
    expect(student.publicId).not.toBe('taken000');
    await expect(User.count()).resolves.toBe(2);
  });

  it('retries a collision on classes.public_id', async () => {
    const teacher = await User.create({
      role: 'teacher',
      fullName: 'Teacher',
      email: 'teacher@example.com',
      passwordHash: 'hash',
      publicId: null,
    });
    const category = await Category.create({ teacherId: teacher.id, name: 'Algebra' });
    const createClass = (publicId: string) =>
      SchoolClass.create({
        categoryId: category.id,
        teacherId: teacher.id,
        subject: 'Maths',
        name: null,
        publicId,
      });
    await createClass('taken000');
    let attempts = 0;

    await insertWithPublicId((publicId) => {
      attempts += 1;
      return createClass(attempts < 2 ? 'taken000' : publicId);
    });

    expect(attempts).toBe(2);
    await expect(SchoolClass.count()).resolves.toBe(2);
  });

  it('gives up after 5 retries', async () => {
    await createStudent('taken000');
    let attempts = 0;

    const inserting = insertWithPublicId(() => {
      attempts += 1;
      return createStudent('taken000');
    });

    await expect(inserting).rejects.toBeInstanceOf(UniqueConstraintError);
    expect(attempts).toBe(6);
  });

  it('retries a whole transaction', async () => {
    await createStudent('taken000');
    let attempts = 0;

    await insertWithPublicId((publicId) => {
      attempts += 1;
      return sequelize.transaction(async (transaction) => {
        await User.create(
          {
            role: 'student',
            fullName: 'Student',
            email: `${randomUUID()}@example.com`,
            passwordHash: 'hash',
            publicId: attempts === 1 ? 'taken000' : publicId,
          },
          { transaction },
        );
      });
    });

    expect(attempts).toBe(2);
    await expect(User.count()).resolves.toBe(2);
  });

  it('does not retry a collision on another column', async () => {
    await createStudent('first000', 'same@example.com');
    let attempts = 0;

    const inserting = insertWithPublicId((publicId) => {
      attempts += 1;
      return createStudent(publicId, 'same@example.com');
    });

    await expect(inserting).rejects.toBeInstanceOf(UniqueConstraintError);
    expect(attempts).toBe(1);
  });
});
