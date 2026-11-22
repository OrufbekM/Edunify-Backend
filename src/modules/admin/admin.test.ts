import { randomUUID } from 'node:crypto';

import { hash, verify } from 'argon2';
import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';

import { app } from '../../app.js';
import { sequelize } from '../../db/index.js';
import type { UserStatus } from '../../db/models/enums.js';
import { RefreshToken, User } from '../../db/models/index.js';
import { generatePublicId } from '../../lib/publicId.js';
import { resetRateLimits } from '../../middleware/rateLimit.js';
import { useTestDatabase } from '../../test/database.js';
import { api, createTestUser, type TestUser } from '../../test/users.js';
import { generateTemporaryPassword } from './service.js';

useTestDatabase();

const PASSWORD = 'correct horse battery';
const USER_KEYS = [
  'createdAt',
  'email',
  'firstName',
  'id',
  'lastName',
  'login',
  'mustChangePassword',
  'phone',
  'publicId',
  'role',
  'status',
];
// 12 characters, none of 0, O, 1, l and I.
const TEMPORARY_PASSWORD = /^[a-km-zA-HJ-NP-Z2-9]{12}$/;

let admin: TestUser;
let passwordHash: string;
let age = 0;

beforeEach(async () => {
  await resetRateLimits();
  admin = await createTestUser('admin');
  passwordHash ??= await hash(PASSWORD);
});

// Every account made here is a minute newer than the one before, so "newest first" is certain.
async function makeUser(
  role: 'teacher' | 'student',
  name: string,
  fields: { email?: string; phone?: string; status?: UserStatus } = {},
): Promise<User> {
  const [firstName = '', lastName = ''] = name.split(' ');
  const user = await User.create({
    role,
    firstName,
    lastName,
    email: fields.email ?? `${randomUUID()}@example.com`,
    phone: role === 'teacher' ? (fields.phone ?? '+998900000000') : null,
    login: null,
    passwordHash,
    publicId: role === 'student' ? generatePublicId() : null,
    status: fields.status ?? 'active',
  });

  age += 1;
  await sequelize.query('UPDATE users SET created_at = now() - make_interval(mins => :minutes) WHERE id = :id', {
    replacements: { minutes: 1_000_000 - age, id: user.id },
  });
  return user;
}

function list(query = '') {
  return api(admin).get(`/api/v1/admin/users${query}`);
}

function setStatus(userId: string, status: string) {
  return api(admin).patch(`/api/v1/admin/users/${userId}/status`, { status });
}

function resetPassword(userId: string) {
  return api(admin).post(`/api/v1/admin/users/${userId}/reset-password`);
}

function login(user: User, password = PASSWORD) {
  return request(app).post('/api/v1/auth/login').send({ role: user.role, email: user.email, password });
}

function refresh(token: string) {
  return request(app).post('/api/v1/auth/refresh').set('Cookie', `edunify_rt=${token}`);
}

function bearer(accessToken: string) {
  return {
    get: (path: string) => request(app).get(path).set('Authorization', `Bearer ${accessToken}`),
    post: (path: string, body: object) =>
      request(app).post(path).set('Authorization', `Bearer ${accessToken}`).send(body),
  };
}

function tokenOf(res: request.Response): string {
  const cookies = res.headers['set-cookie'] as unknown as string[] | undefined;
  const value = cookies?.find((cookie) => cookie.startsWith('edunify_rt='))?.split(';')[0]?.slice('edunify_rt='.length);

  if (!value) {
    throw new Error(`expected a refresh cookie, got status ${res.status}`);
  }
  return value;
}

function ids(res: request.Response): string[] {
  return res.body.items.map((item: { id: string }) => item.id);
}

function expectError(res: request.Response, status: number, code: string): void {
  expect(res.status).toBe(status);
  expect(res.body.error.code).toBe(code);
}

describe('GET /admin/users', () => {
  it('lists teachers and students, newest first, never the admin, with the total', async () => {
    const oldest = await makeUser('teacher', 'Tom Old', { status: 'pending' });
    const middle = await makeUser('student', 'Sue Mid');
    const newest = await makeUser('teacher', 'Tia New');

    const res = await list();

    expect(res.status).toBe(200);
    expect(Object.keys(res.body).sort()).toEqual(['items', 'total']);
    expect(ids(res)).toEqual([newest.id, middle.id, oldest.id]);
    expect(res.body.total).toBe(3);
    expect(Object.keys(res.body.items[0]).sort()).toEqual(USER_KEYS);
  });

  it('shows a teacher’s phone but never a student’s publicId (contract 6.1)', async () => {
    const teacher = await makeUser('teacher', 'Tom Teach', { phone: '+998901112233' });
    const student = await makeUser('student', 'Sue Study');

    const items = (await list()).body.items as Array<{ id: string; phone: string | null; publicId: string | null }>;

    expect(items.find((item) => item.id === teacher.id)).toMatchObject({ phone: '+998901112233', publicId: null });
    expect(items.find((item) => item.id === student.id)).toMatchObject({ phone: null, publicId: null });
    expect(student.publicId).toMatch(/^[a-z0-9]{8}$/);
  });

  it('filters by role and status, alone or together', async () => {
    const pendingTeacher = await makeUser('teacher', 'Pat Pending', { status: 'pending' });
    const student = await makeUser('student', 'Sam Student');
    const activeTeacher = await makeUser('teacher', 'Ada Active');
    const blockedStudent = await makeUser('student', 'Ben Blocked', { status: 'blocked' });

    expect(ids(await list('?role=teacher'))).toEqual([activeTeacher.id, pendingTeacher.id]);
    expect(ids(await list('?role=student'))).toEqual([blockedStudent.id, student.id]);
    expect(ids(await list('?status=pending'))).toEqual([pendingTeacher.id]);
    expect(ids(await list('?role=student&status=active'))).toEqual([student.id]);

    const none = await list('?role=teacher&status=blocked');
    expect(none.body).toEqual({ items: [], total: 0 });
  });

  describe('search', () => {
    let ann: User;
    let bob: User;
    let cara: User;

    beforeEach(async () => {
      ann = await makeUser('student', 'Ann Lee', { email: 'ann.lee@school.uz' });
      bob = await makeUser('teacher', 'Bob Stone', { email: 'bob@example.com', phone: '+998901112233' });
      cara = await makeUser('student', 'Cara Annson', { email: 'cara@example.com' });
    });

    it.each([
      ['a first or last name, in any case', 'ANN', () => [cara, ann]],
      ['a whole name', 'ann lee', () => [ann]],
      ['part of an email', 'school.uz', () => [ann]],
      ['a phone typed with spaces and brackets', '+998 (90) 111', () => [bob]],
      ['digits from the middle of a phone', '90111', () => [bob]],
      ['a term with spaces around it', '  bob  ', () => [bob]],
      ['% taken literally', '%', () => []],
      ['_ taken literally', '_', () => []],
    ])('finds %s', async (_name, q, expected) => {
      const res = await list(`?q=${encodeURIComponent(q)}`);

      expect(ids(res)).toEqual(expected().map((user) => user.id));
      expect(res.body.total).toBe(expected().length);
    });

    it('combines with the filters, and ignores an empty term', async () => {
      expect(ids(await list('?q=ann&role=teacher'))).toEqual([]);
      expect(ids(await list('?q=ann&role=student'))).toEqual([cara.id, ann.id]);
      expect((await list('?q=%20%20')).body.total).toBe(3);
    });
  });

  it('pages with limit and offset, and counts every match whatever the page', async () => {
    const users: User[] = [];
    for (let i = 0; i < 5; i += 1) {
      users.push(await makeUser('student', `Student ${i}`));
    }
    const newestFirst = users.map((user) => user.id).reverse();

    expect((await list('?limit=2')).body).toMatchObject({ total: 5 });
    expect(ids(await list('?limit=2'))).toEqual(newestFirst.slice(0, 2));
    expect(ids(await list('?limit=2&offset=2'))).toEqual(newestFirst.slice(2, 4));
    expect(ids(await list('?limit=2&offset=4'))).toEqual(newestFirst.slice(4));
    expect((await list('?offset=10')).body).toEqual({ items: [], total: 5 });
  });

  it('sends 50 by default', async () => {
    for (let i = 0; i < 52; i += 1) {
      await makeUser('student', `Student ${i}`);
    }

    const res = await list();

    expect(res.body.items).toHaveLength(50);
    expect(res.body.total).toBe(52);
  });

  it.each([
    ['the admin role', '?role=admin', 'role'],
    ['an unknown status', '?status=gone', 'status'],
    ['a limit of 0', '?limit=0', 'limit'],
    ['a limit over 100', '?limit=101', 'limit'],
    ['a limit that is not a number', '?limit=ten', 'limit'],
    ['a negative offset', '?offset=-1', 'offset'],
    ['a fractional offset', '?offset=1.5', 'offset'],
    ['a search over 100 characters', `?q=${'x'.repeat(101)}`, 'q'],
    ['a repeated parameter', '?role=teacher&role=student', 'role'],
    ['an unknown parameter', '?sort=name', 'sort'],
  ])('gives VALIDATION_ERROR for %s', async (_name, query, path) => {
    const res = await list(query);

    expectError(res, 400, 'VALIDATION_ERROR');
    expect(res.body.error.details.map((detail: { path: string }) => detail.path)).toEqual([path]);
  });
});

describe('PATCH /admin/users/:id/status', () => {
  it.each([
    ['approves', 'pending', 'active'],
    ['rejects', 'pending', 'blocked'],
    ['blocks', 'active', 'blocked'],
    ['unblocks', 'blocked', 'active'],
  ] as const)('%s: %s -> %s', async (_name, from, to) => {
    const teacher = await makeUser('teacher', 'Tom Teach', { status: from });

    const res = await setStatus(teacher.id, to);

    expect(res.status).toBe(200);
    expect(Object.keys(res.body).sort()).toEqual(USER_KEYS);
    expect(res.body).toMatchObject({ id: teacher.id, status: to });
    await expect(User.findByPk(teacher.id)).resolves.toMatchObject({ status: to });
  });

  it.each([
    ['active', 'active'],
    ['blocked', 'blocked'],
  ] as const)('gives INVALID_STATUS_TRANSITION for %s -> %s and changes nothing', async (from, to) => {
    const teacher = await makeUser('teacher', 'Tom Teach', { status: from });

    expectError(await setStatus(teacher.id, to), 409, 'INVALID_STATUS_TRANSITION');
    await expect(User.findByPk(teacher.id)).resolves.toMatchObject({ status: from });
  });

  it('never puts anyone back to pending', async () => {
    const teacher = await makeUser('teacher', 'Tom Teach');

    const res = await setStatus(teacher.id, 'pending');

    expectError(res, 400, 'VALIDATION_ERROR');
    expect(res.body.error.details).toEqual([{ path: 'status', message: expect.any(String) }]);
  });

  it('lets an approved teacher in at once, with the token they already have', async () => {
    const teacher = await createTestUser('teacher', 'Tom Teach', { status: 'pending' });

    expectError(await api(teacher).get('/api/v1/categories'), 403, 'ACCOUNT_PENDING');
    expect((await setStatus(teacher.id, 'active')).status).toBe(200);
    expect((await api(teacher).get('/api/v1/categories')).status).toBe(200);
  });

  it('blocking ends every session at once, and unblocking does not bring them back', async () => {
    const student = await makeUser('student', 'Sue Study');
    const phone = await login(student);
    const laptop = await login(student);

    expect((await setStatus(student.id, 'blocked')).status).toBe(200);

    await expect(RefreshToken.count({ where: { userId: student.id, revokedAt: null } })).resolves.toBe(0);
    expectError(await bearer(phone.body.accessToken).get('/api/v1/me'), 403, 'ACCOUNT_BLOCKED');
    expectError(await refresh(tokenOf(laptop)), 403, 'ACCOUNT_BLOCKED');
    expectError(await login(student), 403, 'ACCOUNT_BLOCKED');

    expect((await setStatus(student.id, 'active')).status).toBe(200);

    expectError(await refresh(tokenOf(laptop)), 401, 'UNAUTHENTICATED');
    expect((await login(student)).status).toBe(200);
  });

  it.each([
    ['the admin itself', () => admin.id],
    ['an id that doesn’t exist', () => randomUUID()],
  ])('gives NOT_FOUND for %s', async (_name, target) => {
    expectError(await setStatus(target(), 'blocked'), 404, 'NOT_FOUND');
  });

  it('gives VALIDATION_ERROR for a malformed id', async () => {
    expectError(await setStatus('not-a-uuid', 'blocked'), 400, 'VALIDATION_ERROR');
  });
});

describe('POST /admin/users/:id/reset-password', () => {
  it('returns a 12-character temporary password once, kept out of caches, and stores only its hash', async () => {
    const teacher = await makeUser('teacher', 'Tom Teach');

    const res = await resetPassword(teacher.id);

    expect(res.status).toBe(200);
    expect(Object.keys(res.body)).toEqual(['temporaryPassword']);
    expect(res.body.temporaryPassword).toMatch(TEMPORARY_PASSWORD);
    expect(res.headers['cache-control']).toBe('no-store');

    const stored = await User.findByPk(teacher.id);
    expect(stored?.passwordHash).not.toContain(res.body.temporaryPassword);
    await expect(verify(stored?.passwordHash ?? '', res.body.temporaryPassword)).resolves.toBe(true);
    expect(stored?.mustChangePassword).toBe(true);
  });

  it('signs the user out, and forces a new password before anything else works', async () => {
    const student = await makeUser('student', 'Sue Study');
    const session = tokenOf(await login(student));

    const { temporaryPassword } = (await resetPassword(student.id)).body;

    expectError(await refresh(session), 401, 'UNAUTHENTICATED');
    expectError(await login(student), 401, 'INVALID_CREDENTIALS');

    const signedIn = await login(student, temporaryPassword);
    expect(signedIn.status).toBe(200);
    expect(signedIn.body.user.mustChangePassword).toBe(true);
    const caller = bearer(signedIn.body.accessToken);

    expectError(await caller.get('/api/v1/student/classes'), 403, 'PASSWORD_CHANGE_REQUIRED');
    const changed = await caller.post('/api/v1/me/password', {
      currentPassword: temporaryPassword,
      newPassword: 'my own new password',
      confirmNewPassword: 'my own new password',
    });
    expect(changed.status).toBe(204);

    expect((await caller.get('/api/v1/student/classes')).status).toBe(200);
    expect((await caller.get('/api/v1/me')).body.mustChangePassword).toBe(false);
    expect((await login(student, 'my own new password')).status).toBe(200);
  });

  it('leaves the status alone: a blocked user stays blocked', async () => {
    const student = await makeUser('student', 'Sue Study', { status: 'blocked' });

    const { temporaryPassword } = (await resetPassword(student.id)).body;

    await expect(User.findByPk(student.id)).resolves.toMatchObject({ status: 'blocked' });
    expectError(await login(student, temporaryPassword), 403, 'ACCOUNT_BLOCKED');
  });

  it('gives a new password every time', async () => {
    const teacher = await makeUser('teacher', 'Tom Teach');

    const first = (await resetPassword(teacher.id)).body.temporaryPassword;
    const second = (await resetPassword(teacher.id)).body.temporaryPassword;

    expect(first).not.toBe(second);
  });

  it.each([
    ['the admin itself', () => admin.id],
    ['an id that doesn’t exist', () => randomUUID()],
  ])('gives NOT_FOUND for %s', async (_name, target) => {
    expectError(await resetPassword(target()), 404, 'NOT_FOUND');
  });

  it('takes no body', async () => {
    const teacher = await makeUser('teacher', 'Tom Teach');

    const res = await api(admin).post(`/api/v1/admin/users/${teacher.id}/reset-password`, { password: 'mine' });

    expectError(res, 400, 'VALIDATION_ERROR');
    await expect(User.findByPk(teacher.id)).resolves.toMatchObject({ mustChangePassword: false });
  });
});

describe('generateTemporaryPassword', () => {
  it('uses only the unambiguous alphabet, every character of it', () => {
    const samples = Array.from({ length: 300 }, generateTemporaryPassword);
    const seen = new Set(samples.join(''));

    for (const sample of samples) {
      expect(sample).toMatch(TEMPORARY_PASSWORD);
    }
    expect(seen.size).toBe(57);
  });
});
