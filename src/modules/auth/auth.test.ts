import { randomUUID } from 'node:crypto';

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
import { refreshCookieOptions } from './routes.js';

useTestDatabase();

beforeEach(async () => {
  await resetRateLimits();
});

const PASSWORD = 'correct horse battery';
const USER_KEYS = ['createdAt', 'email', 'fullName', 'id', 'publicId', 'role'];
const ISO_MILLIS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

function newEmail(): string {
  return `${randomUUID()}@example.com`;
}

function register(overrides: Record<string, unknown> = {}) {
  return request(app)
    .post('/api/v1/auth/register')
    .send({ role: 'student', fullName: 'Ann Student', email: newEmail(), password: PASSWORD, ...overrides });
}

function login(email: string, password = PASSWORD) {
  return request(app).post('/api/v1/auth/login').send({ email, password });
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
  return {
    getMe: () => request(app).get('/api/v1/me').set('Authorization', `Bearer ${accessToken}`),
    patchMe: (body: object) =>
      request(app).patch('/api/v1/me').set('Authorization', `Bearer ${accessToken}`).send(body),
    changePassword: (body: object) =>
      request(app)
        .post('/api/v1/me/password')
        .set('Authorization', `Bearer ${accessToken}`)
        .send(body),
  };
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

describe('POST /auth/register', () => {
  it('creates a teacher without a publicId', async () => {
    const res = await register({ role: 'teacher' });

    expect(res.status).toBe(201);
    expect(res.body.user.role).toBe('teacher');
    expect(res.body.user.publicId).toBeNull();
  });

  it('gives a student an 8-character publicId', async () => {
    const res = await register({ role: 'student' });

    expect(res.status).toBe(201);
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

  it('stores the email trimmed and lowercased', async () => {
    const res = await register({ email: '  Ann.Mixed@Example.COM ' });

    expect(res.body.user.email).toBe('ann.mixed@example.com');
    await expect(User.findOne({ where: { id: res.body.user.id } })).resolves.toMatchObject({
      email: 'ann.mixed@example.com',
    });
  });

  it('gives EMAIL_TAKEN for an email in another letter case', async () => {
    await register({ email: 'taken@example.com' });

    expectError(await register({ email: 'TAKEN@Example.com' }), 409, 'EMAIL_TAKEN');
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
    ['an unknown role', { role: 'admin' }, 'role'],
    ['a malformed email', { email: 'not-an-email' }, 'email'],
    ['an email over 254 characters', { email: `${'a'.repeat(250)}@x.io` }, 'email'],
    ['a blank full name', { fullName: '   ' }, 'fullName'],
    ['a full name over 100 characters', { fullName: 'x'.repeat(101) }, 'fullName'],
  ])('gives VALIDATION_ERROR for %s', async (_name, overrides, path) => {
    const res = await register(overrides);

    expectError(res, 400, 'VALIDATION_ERROR');
    expect(res.body.error.details).toEqual([{ path, message: expect.any(String) }]);
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

  it('answers a wrong password and an unknown email identically', async () => {
    const email = newEmail();
    await register({ email });

    const wrongPassword = await login(email, 'wrong password!');
    const unknownEmail = await login(newEmail());

    expectError(wrongPassword, 401, 'INVALID_CREDENTIALS');
    expect(unknownEmail.status).toBe(401);
    expect(unknownEmail.body).toEqual(wrongPassword.body);
    expect(refreshCookie(wrongPassword)).toBeUndefined();
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

  it('updates the full name, trimmed', async () => {
    const { accessToken } = (await register()).body;
    const caller = asUser(accessToken);

    const res = await caller.patchMe({ fullName: '  New Name  ' });

    expect(res.status).toBe(200);
    expect(res.body.fullName).toBe('New Name');
    expect((await caller.getMe()).body.fullName).toBe('New Name');
  });

  it.each([
    ['no fullName', {}, 'fullName'],
    ['a blank fullName', { fullName: '   ' }, 'fullName'],
    ['a fullName over 100 characters', { fullName: 'x'.repeat(101) }, 'fullName'],
    ['an unknown field', { fullName: 'Ann', email: 'other@example.com' }, 'email'],
  ])('rejects %s', async (_name, body, path) => {
    const { accessToken } = (await register()).body;

    const res = await asUser(accessToken).patchMe(body);

    expectError(res, 400, 'VALIDATION_ERROR');
    expect(res.body.error.details.map((detail: { path: string }) => detail.path)).toContain(path);
  });
});

describe('POST /me/password', () => {
  it('gives INVALID_CREDENTIALS for a wrong current password and changes nothing', async () => {
    const res = await register();
    const caller = asUser(res.body.accessToken);

    const attempt = await caller.changePassword({
      currentPassword: 'not my password',
      newPassword: 'brand new password',
    });

    expectError(attempt, 401, 'INVALID_CREDENTIALS');
    expect(refreshCookie(attempt)).toBeUndefined();
    expect((await refresh(tokenOf(res))).status).toBe(200);
    expect((await login(res.body.user.email)).status).toBe(200);
  });

  it('ends every session and keeps the caller signed in with a fresh cookie', async () => {
    const email = newEmail();
    const registered = await register({ email });
    const otherDevice = tokenOf(await login(email));

    const res = await asUser(registered.body.accessToken).changePassword({
      currentPassword: PASSWORD,
      newPassword: 'brand new password',
    });
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

    const first = await caller.changePassword({
      currentPassword: PASSWORD,
      newPassword: 'brand new password',
    });
    const second = await caller.changePassword({
      currentPassword: 'brand new password',
      newPassword: 'another new password',
    });
    const families = await Promise.all(
      [registered, first, second].map(async (res) => (await stored(tokenOf(res)))?.familyId),
    );

    expect(new Set(families).size).toBe(3);
  });

  it('checks the length of both passwords', async () => {
    const { accessToken } = (await register()).body;

    const res = await asUser(accessToken).changePassword({
      currentPassword: PASSWORD,
      newPassword: 'short',
    });

    expectError(res, 400, 'VALIDATION_ERROR');
    expect(res.body.error.details).toEqual([{ path: 'newPassword', message: expect.any(String) }]);
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

describe('refreshCookieOptions', () => {
  it('marks the cookie Secure only in production', () => {
    expect(refreshCookieOptions(true).secure).toBe(true);
    expect(refreshCookieOptions(false).secure).toBe(false);
  });
});
