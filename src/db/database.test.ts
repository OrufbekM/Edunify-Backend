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
    firstName: 'Test',
    lastName: 'Student',
    email,
    phone: null,
    login: null,
    passwordHash: 'hash',
    publicId,
    status: 'active',
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

describe('users table checks (contract 4)', () => {
  type Row = Record<string, string | null>;

  const valid: Record<'teacher' | 'student' | 'admin', Row> = {
    teacher: { role: 'teacher', email: 't@example.com', phone: '+998901234567', login: null, public_id: null, status: 'pending' },
    student: { role: 'student', email: 's@example.com', phone: null, login: null, public_id: 'abcd1234', status: 'active' },
    admin: { role: 'admin', email: null, phone: null, login: 'edunify_admin', public_id: null, status: 'active' },
  };

  function insert(row: Row) {
    return sequelize.query(
      `INSERT INTO users (role, first_name, last_name, email, phone, login, password_hash, public_id, status)
       VALUES (:role, 'First', 'Last', :email, :phone, :login, 'hash', :public_id, :status)`,
      { replacements: row },
    );
  }

  it('accepts each role in its own shape', async () => {
    for (const row of Object.values(valid)) {
      await insert(row);
    }

    await expect(User.count()).resolves.toBe(3);
  });

  it.each([
    ['a teacher without a phone', { ...valid.teacher, phone: null }],
    ['a teacher with a publicId', { ...valid.teacher, public_id: 'abcd1234' }],
    ['a teacher with a login', { ...valid.teacher, login: 'teacher_login' }],
    ['a student without a publicId', { ...valid.student, public_id: null }],
    ['a student with a phone', { ...valid.student, phone: '+998901234567' }],
    ['a student without an email', { ...valid.student, email: null }],
    ['a pending student', { ...valid.student, status: 'pending' }],
    ['an admin without a login', { ...valid.admin, login: null }],
    ['an admin with an email', { ...valid.admin, email: 'a@example.com' }],
    ['a pending admin', { ...valid.admin, status: 'pending' }],
  ])('rejects %s', async (_name, row) => {
    await expect(insert(row)).rejects.toThrow(/violates check constraint/);
  });

  it('allows only one admin', async () => {
    await insert(valid.admin);

    // Sequelize words a unique violation as 'Validation error'; the constraint name is on it.
    await expect(insert({ ...valid.admin, login: 'second_admin' })).rejects.toMatchObject({
      parent: { constraint: 'users_one_admin_uq' },
    });
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
      firstName: 'Test',
      lastName: 'Teacher',
      email: 'teacher@example.com',
      phone: '+998901234567',
      login: null,
      passwordHash: 'hash',
      publicId: null,
      status: 'active',
    });
    const category = await Category.create({ teacherId: teacher.id, name: 'Algebra', position: 0 });
    const createClass = (publicId: string) =>
      SchoolClass.create({
        categoryId: category.id,
        teacherId: teacher.id,
        name: 'Maths',
        position: 0,
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
            firstName: 'Test',
            lastName: 'Student',
            email: `${randomUUID()}@example.com`,
            phone: null,
            login: null,
            passwordHash: 'hash',
            publicId: attempts === 1 ? 'taken000' : publicId,
            status: 'active',
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
