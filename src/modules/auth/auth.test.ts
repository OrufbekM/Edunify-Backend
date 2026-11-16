import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';

import { hash } from 'argon2';
import jwt from 'jsonwebtoken';
import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';

import { app } from '../../app.js';
import { env } from '../../config/env.js';
import { sequelize } from '../../db/index.js';
import { RefreshToken, User } from '../../db/models/index.js';
import { hashRefreshToken } from '../../lib/tokens.js';
import { resetRateLimits } from '../../middleware/rateLimit.js';
import { useTestDatabase } from '../../test/database.js';
import { createTestUser } from '../../test/users.js';
import { refreshCookieOptions } from './routes.js';
import { seedAdmin } from './service.js';

useTestDatabase();

beforeEach(async () => {
  await resetRateLimits();
});

const PASSWORD = 'correct horse battery';
const ADMIN_PASSWORD = 'a long admin password';
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
const ISO_MILLIS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

function newEmail(): string {
  return `${randomUUID()}@example.com`;
}

// A student by default. A teacher gets a phone unless the test sends its own, and
// confirmPassword follows password unless the test sends its own.
function register(overrides: Record<string, unknown> = {}) {
  const body: Record<string, unknown> = {
    role: 'student',
    firstName: 'Ann',
    lastName: 'Student',
    email: newEmail(),
    password: PASSWORD,
    ...overrides,
  };
  if (body.role === 'teacher' && !('phone' in overrides)) {
    body.phone = '+998 (90) 123-45-67';
  }
  if (!('confirmPassword' in overrides)) {
    body.confirmPassword = body.password;
  }

  return request(app).post('/api/v1/auth/register').send(body);
}

function login(email: string, password = PASSWORD, role = 'student') {
  return request(app).post('/api/v1/auth/login').send({ role, email, password });
}

function adminLogin(loginName: string, password = ADMIN_PASSWORD) {
  return request(app).post('/api/v1/auth/admin/login').send({ login: loginName, password });
}

function withCookie(path: string, token?: string) {
  const pending = request(app).post(path);

  return token ? pending.set('Cookie', `edunify_rt=${token}`) : pending;
}

function refresh(token?: string) {
  return withCookie('/api/v1/auth/refresh', token);
}

function logout(token?: string) {
  return withCookie('/api/v1/auth/logout', token);
}

function asUser(accessToken: string) {
  const authorized = (pending: request.Test) => pending.set('Authorization', `Bearer ${accessToken}`);

  return {
    get: (path: string) => authorized(request(app).get(path)),
    getMe: () => authorized(request(app).get('/api/v1/me')),
    patchMe: (body: object) => authorized(request(app).patch('/api/v1/me')).send(body),
    changePassword: (body: object) => authorized(request(app).post('/api/v1/me/password')).send(body),
  };
}

function passwordChange(currentPassword: string, newPassword: string) {
  return { currentPassword, newPassword, confirmNewPassword: newPassword };
}

function refreshCookie(res: request.Response): { value: string; attributes: string[] } | undefined {
  const cookies = res.headers['set-cookie'] as unknown as string[] | undefined;
  const header = cookies?.find((cookie) => cookie.startsWith('edunify_rt='));

  if (!header) {
    return undefined;
  }

  const [pair = '', ...attributes] = header.split(';').map((part) => part.trim());
  return { value: pair.slice('edunify_rt='.length), attributes };
}

function tokenOf(res: request.Response): string {
  const value = refreshCookie(res)?.value;

  if (!value) {
    throw new Error(`expected a refresh cookie, got status ${res.status}`);
  }
  return value;
}

function stored(token: string): Promise<RefreshToken | null> {
  return RefreshToken.findOne({ where: { tokenHash: hashRefreshToken(token) } });
}

async function shiftBack(column: 'expires_at' | 'replaced_at', token: string, seconds: number) {
  await sequelize.query(
    `UPDATE refresh_tokens SET ${column} = ${column} - make_interval(secs => :seconds) WHERE token_hash = :hash`,
    { replacements: { seconds, hash: hashRefreshToken(token) } },
  );
}

function expectError(res: request.Response, status: number, code: string): void {
  expect(res.status).toBe(status);
  expect(res.body.error.code).toBe(code);
}

function detailPaths(res: request.Response): string[] {
  return res.body.error.details.map((detail: { path: string }) => detail.path);
}

async function setAccount(userId: string, values: { status?: 'pending' | 'active' | 'blocked'; mustChangePassword?: boolean }) {
  await User.update(values, { where: { id: userId } });
}

async function createAdmin(password = ADMIN_PASSWORD) {
  return createTestUser('admin', 'Edunify Admin', { passwordHash: await hash(password) });
}

describe('POST /auth/register', () => {
  it('creates a pending teacher with the phone normalized and no publicId', async () => {
    const res = await register({ role: 'teacher' });

    expect(res.status).toBe(201);
    expect(res.body.user).toMatchObject({
      role: 'teacher',
      status: 'pending',
      phone: '+998901234567',
      publicId: null,
      login: null,
      mustChangePassword: false,
    });
  });

  it('creates an active student with an 8-character publicId and no phone', async () => {
    const res = await register({ role: 'student' });

    expect(res.status).toBe(201);
    expect(res.body.user).toMatchObject({ role: 'student', status: 'active', phone: null, login: null });
    expect(res.body.user.publicId).toMatch(/^[a-z0-9]{8}$/);
  });

  it('returns exactly the contract User and a working access token', async () => {
    const res = await register();

    expect(Object.keys(res.body).sort()).toEqual(['accessToken', 'user']);
    expect(Object.keys(res.body.user).sort()).toEqual(USER_KEYS);
    expect(res.body.user.createdAt).toMatch(ISO_MILLIS);

    const claims = jwt.verify(res.body.accessToken, env.JWT_ACCESS_SECRET) as jwt.JwtPayload;
    expect(claims.sub).toBe(res.body.user.id);
    expect(claims.role).toBe('student');

    expect((await asUser(res.body.accessToken).getMe()).body).toEqual(res.body.user);
  });

  it('gives a new teacher the gate and nothing else until approved', async () => {
    const { accessToken } = (await register({ role: 'teacher' })).body;
    const teacher = asUser(accessToken);

    expect((await teacher.getMe()).status).toBe(200);
    expectError(await teacher.get('/api/v1/categories'), 403, 'ACCOUNT_PENDING');
  });

  it('trims the names and stores the email trimmed and lowercased', async () => {
    const res = await register({ firstName: '  Ann ', lastName: ' Lee  ', email: '  Ann.Mixed@Example.COM ' });

    expect(res.body.user).toMatchObject({ firstName: 'Ann', lastName: 'Lee', email: 'ann.mixed@example.com' });
    await expect(User.findOne({ where: { id: res.body.user.id } })).resolves.toMatchObject({
      email: 'ann.mixed@example.com',
    });
  });

  it('gives EMAIL_TAKEN for an email in another letter case, whatever the role', async () => {
    await register({ email: 'taken@example.com' });

    expectError(await register({ email: 'TAKEN@Example.com' }), 409, 'EMAIL_TAKEN');
    expectError(await register({ role: 'teacher', email: 'taken@example.com' }), 409, 'EMAIL_TAKEN');
  });

  it('gives EMAIL_TAKEN to the loser of two simultaneous registrations', async () => {
    const results = await Promise.all([
      register({ email: 'race@example.com' }),
      register({ email: 'race@example.com' }),
    ]);

    expect(results.map((res) => res.status).sort()).toEqual([201, 409]);
    expect(results.find((res) => res.status === 409)?.body.error.code).toBe('EMAIL_TAKEN');
    await expect(User.count()).resolves.toBe(1);
  });

  it.each([
    ['a short password', { password: '1234567' }, 'password'],
    ['a long password', { password: 'x'.repeat(129) }, 'password'],
    ['a confirmPassword that differs', { confirmPassword: 'another password' }, 'confirmPassword'],
    ['no confirmPassword', { confirmPassword: undefined }, 'confirmPassword'],
    ['the admin role', { role: 'admin' }, 'role'],
    ['a malformed email', { email: 'not-an-email' }, 'email'],
    ['an email over 254 characters', { email: `${'a'.repeat(250)}@x.io` }, 'email'],
    ['a blank first name', { firstName: '   ' }, 'firstName'],
    ['a last name over 50 characters', { lastName: 'x'.repeat(51) }, 'lastName'],
    ['a teacher without a phone', { role: 'teacher', phone: undefined }, 'phone'],
    ['a teacher phone without +', { role: 'teacher', phone: '998901234567' }, 'phone'],
    ['a teacher phone with too few digits', { role: 'teacher', phone: '+9989012' }, 'phone'],
    ['a teacher phone with letters', { role: 'teacher', phone: '+99890123456a' }, 'phone'],
    ['a student with a phone', { phone: '+998901234567' }, 'phone'],
  ])('gives VALIDATION_ERROR for %s', async (_name, overrides, path) => {
    const res = await register(overrides);

    expectError(res, 400, 'VALIDATION_ERROR');
    expect(detailPaths(res)).toEqual([path]);
  });

  it('gives VALIDATION_ERROR for an unknown field', async () => {
    const res = await register({ isAdmin: true });

    expectError(res, 400, 'VALIDATION_ERROR');
    expect(res.body.error.details).toEqual([{ path: 'isAdmin', message: 'Unknown field' }]);
  });

  it('accepts a password of exactly 8 and 128 characters', async () => {
    expect((await register({ password: 'x'.repeat(8) })).status).toBe(201);
    expect((await register({ password: 'x'.repeat(128) })).status).toBe(201);
  });

  it('sets the refresh cookie exactly as contract 2.3 says', async () => {
    const cookie = refreshCookie(await register());

    expect(cookie?.value).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(cookie?.attributes).toEqual(
      expect.arrayContaining(['Max-Age=2592000', 'Path=/api/v1/auth', 'HttpOnly', 'SameSite=Strict']),
    );
    expect(cookie?.attributes).not.toContain('Secure');
  });

  it('stores only the SHA-256 hash of the refresh token', async () => {
    const res = await register();
    const token = tokenOf(res);
    const [row] = await RefreshToken.findAll();

    expect(row?.tokenHash).toMatch(/^[0-9a-f]{64}$/);
    expect(row?.tokenHash).not.toBe(token);
    expect(row?.tokenHash).toBe(hashRefreshToken(token));
  });

  it('never returns the password hash, the token hash, or the refresh token in the body', async () => {
    const res = await register();
    const body = JSON.stringify(res.body);
    const user = await User.findByPk(res.body.user.id);
    const [row] = await RefreshToken.findAll();

    expect(body).not.toContain('passwordHash');
    expect(body).not.toContain(user?.passwordHash ?? 'missing');
    expect(body).not.toContain(row?.tokenHash ?? 'missing');
    expect(body).not.toContain(tokenOf(res));
  });

  it('keeps spaces in a password exactly as typed', async () => {
    const email = newEmail();
    await register({ email, password: '  spaced password  ' });

    expectError(await login(email, 'spaced password'), 401, 'INVALID_CREDENTIALS');
    expect((await login(email, '  spaced password  ')).status).toBe(200);
  });
});

describe('POST /auth/login', () => {
  it('signs in with the user, an access token, and a refresh cookie', async () => {
    const email = newEmail();
    await register({ email });

    const res = await login(email);

    expect(res.status).toBe(200);
    expect(Object.keys(res.body).sort()).toEqual(['accessToken', 'user']);
    expect(res.body.user.email).toBe(email);
    expect(refreshCookie(res)?.attributes).toContain('Max-Age=2592000');
  });

  it('answers a wrong password, an unknown email, and the wrong role identically', async () => {
    const email = newEmail();
    await register({ email });

    const wrongPassword = await login(email, 'wrong password!');
    const unknownEmail = await login(newEmail());
    const wrongRole = await login(email, PASSWORD, 'teacher');

    expectError(wrongPassword, 401, 'INVALID_CREDENTIALS');
    for (const res of [unknownEmail, wrongRole]) {
      expect(res.status).toBe(401);
      expect(res.body).toEqual(wrongPassword.body);
      expect(refreshCookie(res)).toBeUndefined();
    }
  });

  it('lets a pending teacher sign in, to be shown the gate', async () => {
    const email = newEmail();
    await register({ role: 'teacher', email });

    const res = await login(email, PASSWORD, 'teacher');

    expect(res.status).toBe(200);
    expect(res.body.user.status).toBe('pending');
  });

  it('gives ACCOUNT_BLOCKED only after the right password, and no cookie', async () => {
    const email = newEmail();
    const { user } = (await register({ email })).body;
    await setAccount(user.id, { status: 'blocked' });

    expectError(await login(email, 'wrong password!'), 401, 'INVALID_CREDENTIALS');

    const res = await login(email);
    expectError(res, 403, 'ACCOUNT_BLOCKED');
    expect(refreshCookie(res)).toBeUndefined();
  });

  it('ignores the letter case of the email', async () => {
    await register({ email: 'casey@example.com' });

    expect((await login(' CASEY@Example.com ')).status).toBe(200);
  });

  it('starts a new token family on every login', async () => {
    const email = newEmail();
    await register({ email });

    const first = await stored(tokenOf(await login(email)));
    const second = await stored(tokenOf(await login(email)));

    expect(first?.familyId).toBeDefined();
    expect(first?.familyId).not.toBe(second?.familyId);
  });

  it('checks the password length on login too', async () => {
    expectError(await login(newEmail(), 'short'), 400, 'VALIDATION_ERROR');
  });

  it.each([
    ['no role', undefined],
    ['the admin role', 'admin'],
  ])('gives VALIDATION_ERROR for %s', async (_name, role) => {
    const res = await request(app).post('/api/v1/auth/login').send({ role, email: newEmail(), password: PASSWORD });

    expectError(res, 400, 'VALIDATION_ERROR');
    expect(detailPaths(res)).toEqual(['role']);
  });
});

describe('POST /auth/admin/login', () => {
  it('signs the admin in by login, ignoring case and spaces', async () => {
    const admin = await createAdmin();

    const res = await adminLogin(`  ${admin.login?.toUpperCase()} `);

    expect(res.status).toBe(200);
    expect(res.body.user).toMatchObject({ role: 'admin', login: admin.login, email: null, phone: null, publicId: null });
    expect(refreshCookie(res)?.attributes).toContain('Path=/api/v1/auth');
    expect((await refresh(tokenOf(res))).status).toBe(200);
  });

  it('answers a wrong password and an unknown login identically', async () => {
    const admin = await createAdmin();

    const wrongPassword = await adminLogin(admin.login ?? '', 'wrong password!');
    const unknownLogin = await adminLogin('nobody_here');

    expectError(wrongPassword, 401, 'INVALID_CREDENTIALS');
    expect(unknownLogin.body).toEqual(wrongPassword.body);
  });

  it('has no way in for teachers and students, who sign in with an email instead', async () => {
    const email = newEmail();
    await register({ role: 'teacher', email });

    expectError(await adminLogin(email), 400, 'VALIDATION_ERROR');
    expectError(await adminLogin('ann'), 401, 'INVALID_CREDENTIALS');
  });

  it('keeps the admin out of teacher and student routes', async () => {
    const admin = await createAdmin();
    const { accessToken } = (await adminLogin(admin.login ?? '')).body;
    const caller = asUser(accessToken);

    expect((await caller.getMe()).status).toBe(200);
    expectError(await caller.get('/api/v1/categories'), 403, 'FORBIDDEN');
    expectError(await caller.get('/api/v1/student/classes'), 403, 'FORBIDDEN');
  });

  it.each([
    ['a login under 3 characters', 'ab'],
    ['a login over 40 characters', 'a'.repeat(41)],
    ['a login with other characters', 'bad-login!'],
  ])('gives VALIDATION_ERROR for %s', async (_name, loginName) => {
    const res = await adminLogin(loginName);

    expectError(res, 400, 'VALIDATION_ERROR');
    expect(detailPaths(res)).toEqual(['login']);
  });

  it('gives the 6th attempt from one IP 429 RATE_LIMITED, whatever the login', async () => {
    for (let i = 0; i < 5; i += 1) {
      expect((await adminLogin(`nobody_${i}`)).status).toBe(401);
    }

    const res = await adminLogin('someone_else');
    expectError(res, 429, 'RATE_LIMITED');
    expect(Number(res.headers['retry-after'])).toBeGreaterThanOrEqual(1);
  });
});

describe('POST /auth/refresh', () => {
  it('rotates the token within its family', async () => {
    const old = tokenOf(await register());

    const res = await refresh(old);
    const next = tokenOf(res);
    const [oldRow, nextRow] = [await stored(old), await stored(next)];

    expect(res.status).toBe(200);
    expect(Object.keys(res.body).sort()).toEqual(['accessToken', 'user']);
    expect(next).not.toBe(old);
    expect(oldRow?.replacedAt).toBeInstanceOf(Date);
    expect(oldRow?.revokedAt).toBeNull();
    expect(nextRow?.familyId).toBe(oldRow?.familyId);
    expect(nextRow?.replacedAt).toBeNull();
  });

  it('slides the expiry 30 days forward from each rotation', async () => {
    const next = tokenOf(await refresh(tokenOf(await register())));
    const row = await stored(next);
    const days = ((row?.expiresAt.getTime() ?? 0) - Date.now()) / 86_400_000;

    expect(days).toBeGreaterThan(29.99);
    expect(days).toBeLessThanOrEqual(30);
  });

  it.each([
    ['no cookie', undefined],
    ['a garbage cookie', 'garbage'],
    ['a well-formed token that was never issued', 'A'.repeat(43)],
  ])('gives UNAUTHENTICATED for %s', async (_name, token) => {
    expectError(await refresh(token), 401, 'UNAUTHENTICATED');
  });

  it('gives UNAUTHENTICATED for an expired token', async () => {
    const token = tokenOf(await register());
    await shiftBack('expires_at', token, 31 * 86_400);

    expectError(await refresh(token), 401, 'UNAUTHENTICATED');
  });

  it('accepts every reuse inside the 10-second grace, without a new cookie', async () => {
    const old = tokenOf(await register());
    const next = tokenOf(await refresh(old));

    for (let i = 0; i < 3; i += 1) {
      const res = await refresh(old);

      expect(res.status).toBe(200);
      expect(Object.keys(res.body).sort()).toEqual(['accessToken', 'user']);
      expect(refreshCookie(res)).toBeUndefined();
    }

    expect((await refresh(next)).status).toBe(200);
  });

  it('treats reuse after the grace window as theft and revokes the whole family', async () => {
    const old = tokenOf(await register());
    const next = tokenOf(await refresh(old));
    await shiftBack('replaced_at', old, 11);

    expectError(await refresh(old), 401, 'UNAUTHENTICATED');
    expectError(await refresh(next), 401, 'UNAUTHENTICATED');

    const rows = await RefreshToken.findAll();
    expect(rows.every((row) => row.revokedAt !== null)).toBe(true);
  });

  it('closes the grace window once the session is logged out', async () => {
    const old = tokenOf(await register());
    const next = tokenOf(await refresh(old));

    await logout(next);

    expectError(await refresh(old), 401, 'UNAUTHENTICATED');
  });

  it('never lets two simultaneous refreshes of one token both rotate it', async () => {
    const token = tokenOf(await register());

    const results = await Promise.all([refresh(token), refresh(token), refresh(token)]);
    const family = (await stored(token))?.familyId;

    expect(results.map((res) => res.status)).toEqual([200, 200, 200]);
    expect(results.filter((res) => refreshCookie(res))).toHaveLength(1);
    await expect(RefreshToken.count({ where: { familyId: family ?? '' } })).resolves.toBe(2);
  });

  it('gives ACCOUNT_BLOCKED to a blocked account, revoked token or not, and rotates nothing', async () => {
    const registered = await register();
    const live = tokenOf(registered);
    const revoked = tokenOf(await login(registered.body.user.email));
    await RefreshToken.update({ revokedAt: new Date() }, { where: { tokenHash: hashRefreshToken(revoked) } });
    await setAccount(registered.body.user.id, { status: 'blocked' });

    expectError(await refresh(live), 403, 'ACCOUNT_BLOCKED');
    expectError(await refresh(revoked), 403, 'ACCOUNT_BLOCKED');
    expect((await stored(live))?.replacedAt).toBeNull();
  });

  it('keeps refreshing a pending teacher and a user who must change the password', async () => {
    const teacher = await register({ role: 'teacher' });
    const student = await register();
    await setAccount(student.body.user.id, { mustChangePassword: true });

    expect((await refresh(tokenOf(teacher))).body.user.status).toBe('pending');
    expect((await refresh(tokenOf(student))).body.user.mustChangePassword).toBe(true);
  });

  it('rejects a body with unknown fields', async () => {
    const token = tokenOf(await register());

    expectError(await refresh(token).send({ extra: 1 }), 400, 'VALIDATION_ERROR');
  });
});

describe('POST /auth/logout', () => {
  it('revokes the family, clears the cookie, and answers 204', async () => {
    const token = tokenOf(await register());

    const res = await logout(token);
    const cleared = refreshCookie(res);

    expect(res.status).toBe(204);
    expect(res.text).toBe('');
    expect(cleared?.value).toBe('');
    expect(cleared?.attributes).toEqual(
      expect.arrayContaining(['Path=/api/v1/auth', 'Expires=Thu, 01 Jan 1970 00:00:00 GMT']),
    );
    expect((await stored(token))?.revokedAt).toBeInstanceOf(Date);
    expectError(await refresh(token), 401, 'UNAUTHENTICATED');
  });

  it('leaves the user’s other sessions alone', async () => {
    const email = newEmail();
    const first = tokenOf(await register({ email }));
    const second = tokenOf(await login(email));

    await logout(first);

    expect((await refresh(second)).status).toBe(200);
  });

  it.each([
    ['no cookie', undefined],
    ['an unknown token', 'A'.repeat(43)],
    ['a garbage cookie', 'garbage'],
  ])('answers 204 with %s', async (_name, token) => {
    expect((await logout(token)).status).toBe(204);
  });
});

describe('GET and PATCH /me', () => {
  it('gives UNAUTHENTICATED without a token', async () => {
    expectError(await request(app).get('/api/v1/me'), 401, 'UNAUTHENTICATED');
  });

  it('gives TOKEN_EXPIRED for an expired access token', async () => {
    const { user } = (await register()).body;
    const expired = jwt.sign({ role: user.role }, env.JWT_ACCESS_SECRET, {
      algorithm: 'HS256',
      subject: user.id,
      expiresIn: -10,
    });

    expectError(await asUser(expired).getMe(), 401, 'TOKEN_EXPIRED');
  });

  it('returns the caller', async () => {
    const { user, accessToken } = (await register()).body;

    const res = await asUser(accessToken).getMe();

    expect(res.status).toBe(200);
    expect(res.body).toEqual(user);
  });

  it('gives UNAUTHENTICATED when the account no longer exists', async () => {
    const { user, accessToken } = (await register()).body;
    await User.destroy({ where: { id: user.id } });

    expectError(await asUser(accessToken).getMe(), 401, 'UNAUTHENTICATED');
  });

  it('gives ACCOUNT_BLOCKED to a blocked account', async () => {
    const { user, accessToken } = (await register()).body;
    await setAccount(user.id, { status: 'blocked' });

    expectError(await asUser(accessToken).getMe(), 403, 'ACCOUNT_BLOCKED');
  });

  it('updates the names, trimmed, and only what is sent', async () => {
    const { accessToken } = (await register()).body;
    const caller = asUser(accessToken);

    const res = await caller.patchMe({ firstName: '  New  ', lastName: ' Name ' });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ firstName: 'New', lastName: 'Name' });

    expect((await caller.patchMe({ lastName: 'Only' })).body).toMatchObject({ firstName: 'New', lastName: 'Only' });
    expect((await caller.patchMe({})).body).toMatchObject({ firstName: 'New', lastName: 'Only' });
    expect((await caller.getMe()).body).toMatchObject({ firstName: 'New', lastName: 'Only' });
  });

  it('lets a teacher, pending or not, change the phone, normalized', async () => {
    const { accessToken } = (await register({ role: 'teacher' })).body;

    const res = await asUser(accessToken).patchMe({ phone: '+998 (91) 765-43-21' });

    expect(res.status).toBe(200);
    expect(res.body.phone).toBe('+998917654321');
  });

  it('refuses a phone from a student or the admin', async () => {
    const student = (await register()).body.accessToken as string;
    const admin = (await createAdmin()).token;

    for (const token of [student, admin]) {
      const res = await asUser(token).patchMe({ phone: '+998901234567' });
      expectError(res, 400, 'VALIDATION_ERROR');
      expect(res.body.error.details).toEqual([{ path: 'phone', message: expect.any(String) }]);
    }
  });

  it.each([
    ['a blank firstName', { firstName: '   ' }, 'firstName'],
    ['a lastName over 50 characters', { lastName: 'x'.repeat(51) }, 'lastName'],
    ['a malformed phone', { phone: '12345' }, 'phone'],
    ['a null phone', { phone: null }, 'phone'],
    ['the old fullName', { fullName: 'Ann Lee' }, 'fullName'],
    ['an unknown field', { firstName: 'Ann', email: 'other@example.com' }, 'email'],
  ])('rejects %s', async (_name, body, path) => {
    const { accessToken } = (await register({ role: 'teacher' })).body;

    const res = await asUser(accessToken).patchMe(body);

    expectError(res, 400, 'VALIDATION_ERROR');
    expect(detailPaths(res)).toContain(path);
  });
});

describe('POST /me/password', () => {
  it('gives INVALID_CREDENTIALS for a wrong current password and changes nothing', async () => {
    const res = await register();
    const caller = asUser(res.body.accessToken);

    const attempt = await caller.changePassword(passwordChange('not my password', 'brand new password'));

    expectError(attempt, 401, 'INVALID_CREDENTIALS');
    expect(refreshCookie(attempt)).toBeUndefined();
    expect((await refresh(tokenOf(res))).status).toBe(200);
    expect((await login(res.body.user.email)).status).toBe(200);
  });

  it('ends every session and keeps the caller signed in with a fresh cookie', async () => {
    const email = newEmail();
    const registered = await register({ email });
    const otherDevice = tokenOf(await login(email));

    const res = await asUser(registered.body.accessToken).changePassword(
      passwordChange(PASSWORD, 'brand new password'),
    );
    const fresh = refreshCookie(res);

    expect(res.status).toBe(204);
    expect(res.text).toBe('');
    expect(fresh?.attributes).toEqual(
      expect.arrayContaining(['Max-Age=2592000', 'Path=/api/v1/auth', 'HttpOnly', 'SameSite=Strict']),
    );

    expectError(await refresh(tokenOf(registered)), 401, 'UNAUTHENTICATED');
    expectError(await refresh(otherDevice), 401, 'UNAUTHENTICATED');
    expect((await refresh(fresh?.value)).status).toBe(200);

    expectError(await login(email), 401, 'INVALID_CREDENTIALS');
    expect((await login(email, 'brand new password')).status).toBe(200);
  });

  it('puts each fresh token in a family of its own', async () => {
    const registered = await register();
    const caller = asUser(registered.body.accessToken);

    const first = await caller.changePassword(passwordChange(PASSWORD, 'brand new password'));
    const second = await caller.changePassword(passwordChange('brand new password', 'another new password'));
    const families = await Promise.all(
      [registered, first, second].map(async (res) => (await stored(tokenOf(res)))?.familyId),
    );

    expect(new Set(families).size).toBe(3);
  });

  it('is the way out of an admin reset: every other route waits for it', async () => {
    const { user, accessToken } = (await register()).body;
    await setAccount(user.id, { mustChangePassword: true });
    const caller = asUser(accessToken);

    expectError(await caller.get('/api/v1/student/classes'), 403, 'PASSWORD_CHANGE_REQUIRED');
    expect((await caller.getMe()).body.mustChangePassword).toBe(true);

    expect((await caller.changePassword(passwordChange(PASSWORD, 'brand new password'))).status).toBe(204);

    expect((await caller.getMe()).body.mustChangePassword).toBe(false);
    expect((await caller.get('/api/v1/student/classes')).status).toBe(200);
  });

  it('checks the length of both passwords', async () => {
    const { accessToken } = (await register()).body;

    const res = await asUser(accessToken).changePassword(passwordChange(PASSWORD, 'short'));

    expectError(res, 400, 'VALIDATION_ERROR');
    expect(res.body.error.details).toEqual([{ path: 'newPassword', message: expect.any(String) }]);
  });

  it('gives VALIDATION_ERROR when confirmNewPassword differs', async () => {
    const { accessToken } = (await register()).body;

    const res = await asUser(accessToken).changePassword({
      currentPassword: PASSWORD,
      newPassword: 'brand new password',
      confirmNewPassword: 'brand new passw0rd',
    });

    expectError(res, 400, 'VALIDATION_ERROR');
    expect(res.body.error.details).toEqual([{ path: 'confirmNewPassword', message: expect.any(String) }]);
  });
});

describe('rate limits', () => {
  it('gives the 11th login for one IP and email 429 RATE_LIMITED with Retry-After', async () => {
    const email = newEmail();

    for (let i = 0; i < 10; i += 1) {
      expect((await login(email, 'wrong password!')).status).toBe(401);
    }
    const res = await login(email, 'wrong password!');

    expectError(res, 429, 'RATE_LIMITED');
    expect(Number(res.headers['retry-after'])).toBeGreaterThanOrEqual(1);
    expect((await login(newEmail(), 'wrong password!')).status).toBe(401);
  });

  it('turns an IP away after 100 failed logins, whatever the emails, even with the right password', async () => {
    const email = newEmail();
    expect((await register({ email })).status).toBe(201);

    // Every failure counts. A too-short password fails before the slow password check,
    // which keeps 100 attempts fast.
    for (let i = 0; i < 100; i += 1) {
      expect((await login(newEmail(), 'short')).status).toBe(400);
    }

    expectError(await login(email), 429, 'RATE_LIMITED');
  });

  it('gives the 11th registration from one IP 429 RATE_LIMITED', async () => {
    for (let i = 0; i < 10; i += 1) {
      expect((await register()).status).toBe(201);
    }

    expectError(await register(), 429, 'RATE_LIMITED');
  });
});

describe('seedAdmin', () => {
  it('creates the admin, who can then sign in', async () => {
    await expect(seedAdmin({ login: 'edunify_admin', password: ADMIN_PASSWORD, resetPassword: false })).resolves.toEqual({
      outcome: 'created',
      login: 'edunify_admin',
    });

    const res = await adminLogin('edunify_admin');
    expect(res.status).toBe(200);
    expect(res.body.user).toMatchObject({
      role: 'admin',
      firstName: 'Edunify',
      lastName: 'Admin',
      status: 'active',
      mustChangePassword: false,
    });
  });

  it('never changes an existing admin without resetPassword', async () => {
    await seedAdmin({ login: 'edunify_admin', password: ADMIN_PASSWORD, resetPassword: false });

    await expect(
      seedAdmin({ login: 'other_admin', password: 'another admin password', resetPassword: false }),
    ).resolves.toEqual({ outcome: 'exists', login: 'edunify_admin' });

    await expect(User.count({ where: { role: 'admin' } })).resolves.toBe(1);
    expect((await adminLogin('edunify_admin')).status).toBe(200);
    expectError(await adminLogin('edunify_admin', 'another admin password'), 401, 'INVALID_CREDENTIALS');
  });

  it('replaces only the password with resetPassword, and ends the admin’s sessions', async () => {
    await seedAdmin({ login: 'edunify_admin', password: ADMIN_PASSWORD, resetPassword: false });
    const session = tokenOf(await adminLogin('edunify_admin'));

    await expect(
      seedAdmin({ login: 'other_admin', password: 'another admin password', resetPassword: true }),
    ).resolves.toEqual({ outcome: 'password-reset', login: 'edunify_admin' });

    expectError(await refresh(session), 401, 'UNAUTHENTICATED');
    expectError(await adminLogin('edunify_admin'), 401, 'INVALID_CREDENTIALS');
    expect((await adminLogin('edunify_admin', 'another admin password')).status).toBe(200);
  });
});

describe('npm run seed:admin', () => {
  function seed(vars: Record<string, string>, args: string[] = []) {
    try {
      const out = execFileSync(process.execPath, ['--import', 'tsx', 'src/db/seedAdmin.ts', ...args], {
        env: { ...process.env, ADMIN_LOGIN: '', ADMIN_PASSWORD: '', ...vars },
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      return { ok: true, out };
    } catch (err) {
      return { ok: false, out: String((err as { stderr?: string }).stderr) };
    }
  }

  it('creates the admin under the default login, then leaves it alone', async () => {
    const first = seed({ ADMIN_PASSWORD });
    expect(first.ok).toBe(true);
    expect(first.out).toContain('Created the admin "edunify_admin".');

    const second = seed({ ADMIN_PASSWORD });
    expect(second.ok).toBe(true);
    expect(second.out).toContain('already exists');
    expect((await adminLogin('edunify_admin')).status).toBe(200);
  });

  it.each([
    ['a password under 12 characters', { ADMIN_PASSWORD: 'short pass' }, [], 'ADMIN_PASSWORD'],
    ['no password', {}, [], 'ADMIN_PASSWORD'],
    ['a malformed login', { ADMIN_LOGIN: 'bad login', ADMIN_PASSWORD }, [], 'login'],
    ['an unknown argument', { ADMIN_PASSWORD }, ['--force'], 'Unknown argument'],
  ])('refuses %s and creates nothing', async (_name, vars, args, message) => {
    const result = seed(vars, args);

    expect(result.ok).toBe(false);
    expect(result.out).toContain(message);
    await expect(User.count()).resolves.toBe(0);
  });
});

describe('refreshCookieOptions', () => {
  it('marks the cookie Secure only in production', () => {
    expect(refreshCookieOptions(true).secure).toBe(true);
    expect(refreshCookieOptions(false).secure).toBe(false);
  });
});
