import express from 'express';
import jwt from 'jsonwebtoken';
import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';

import { env } from '../config/env.js';
import { User } from '../db/models/index.js';
import { signAccessToken } from '../lib/tokens.js';
import { useTestDatabase } from '../test/database.js';
import { createTestUser, type TestUser } from '../test/users.js';
import { getAuth, requireAuth, requireSignedIn } from './auth.js';
import { errorHandler } from './error.js';

useTestDatabase();

let user: TestUser;

beforeEach(async () => {
  user = await createTestUser('student');
});

function createApp() {
  const app = express();
  app.get('/private', requireAuth, (req, res) => {
    res.json(req.user);
  });
  app.get('/account', requireSignedIn, (req, res) => {
    res.json(req.user);
  });
  app.get('/unguarded', (req, res) => {
    res.json(getAuth(req));
  });
  app.use(errorHandler);
  return app;
}

function withAuthorization(value: string, path = '/private') {
  return request(createApp()).get(path).set('Authorization', value);
}

function expectUnauthenticated(res: request.Response): void {
  expect(res.status).toBe(401);
  expect(res.body).toEqual({ error: { code: 'UNAUTHENTICATED', message: expect.any(String) } });
}

function expectError(res: request.Response, status: number, code: string): void {
  expect(res.status).toBe(status);
  expect(res.body.error.code).toBe(code);
}

describe('requireAuth', () => {
  it('rejects a request with no header', async () => {
    expectUnauthenticated(await request(createApp()).get('/private'));
  });

  it('rejects the wrong scheme', async () => {
    expectUnauthenticated(await withAuthorization(`Basic ${user.token}`));
  });

  it.each(['Bearer', 'Bearer '])('rejects the header %j with no token', async (value) => {
    expectUnauthenticated(await withAuthorization(value));
  });

  it.each([
    ['two spaces', (token: string) => `Bearer  ${token}`],
    ['no space', (token: string) => `Bearer${token}`],
    ['trailing text', (token: string) => `Bearer ${token} extra`],
  ])('rejects a valid token with %s', async (_name, header) => {
    expectUnauthenticated(await withAuthorization(header(user.token)));
  });

  it('rejects a garbage token', async () => {
    expectUnauthenticated(await withAuthorization('Bearer not-a-token'));
  });

  it('gives TOKEN_EXPIRED for an expired token', async () => {
    const token = jwt.sign({ role: user.role }, env.JWT_ACCESS_SECRET, {
      algorithm: 'HS256',
      subject: user.id,
      expiresIn: -10,
    });

    expectError(await withAuthorization(`Bearer ${token}`), 401, 'TOKEN_EXPIRED');
  });

  it('sets req.user from a valid token', async () => {
    const res = await withAuthorization(`Bearer ${user.token}`);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ id: user.id, role: 'student' });
  });

  it.each(['bearer', 'BEARER', 'BeArEr'])('accepts the scheme spelled %s', async (scheme) => {
    expect((await withAuthorization(`${scheme} ${user.token}`)).status).toBe(200);
  });

  it('gives UNAUTHENTICATED once the account no longer exists', async () => {
    await User.destroy({ where: { id: user.id } });

    expectUnauthenticated(await withAuthorization(`Bearer ${user.token}`));
  });

  it('takes the role from the database, not from the token', async () => {
    const res = await withAuthorization(`Bearer ${signAccessToken({ id: user.id, role: 'teacher' })}`);

    expect(res.body).toEqual({ id: user.id, role: 'student' });
  });
});

describe('account state (contract 2.3)', () => {
  async function account(
    role: 'teacher' | 'student',
    status: 'pending' | 'active' | 'blocked',
    mustChangePassword = false,
  ): Promise<string> {
    return `Bearer ${(await createTestUser(role, `Test ${role}`, { status, mustChangePassword })).token}`;
  }

  it('turns a blocked account away everywhere, /me included', async () => {
    const header = await account('student', 'blocked');

    expectError(await withAuthorization(header), 403, 'ACCOUNT_BLOCKED');
    expectError(await withAuthorization(header, '/account'), 403, 'ACCOUNT_BLOCKED');
  });

  it('sends a reset password to the change screen, which stays reachable', async () => {
    const header = await account('student', 'active', true);

    expectError(await withAuthorization(header), 403, 'PASSWORD_CHANGE_REQUIRED');
    expect((await withAuthorization(header, '/account')).status).toBe(200);
  });

  it('keeps a pending teacher at the gate, which stays reachable', async () => {
    const header = await account('teacher', 'pending');

    expectError(await withAuthorization(header), 403, 'ACCOUNT_PENDING');
    expect((await withAuthorization(header, '/account')).status).toBe(200);
  });

  it('checks blocked first, then the password change, then pending', async () => {
    expectError(await withAuthorization(await account('teacher', 'blocked', true)), 403, 'ACCOUNT_BLOCKED');
    expectError(await withAuthorization(await account('teacher', 'pending', true)), 403, 'PASSWORD_CHANGE_REQUIRED');
  });

  it('reads the state on every request, so a change applies to a token already handed out', async () => {
    const header = await account('teacher', 'pending');
    expectError(await withAuthorization(header), 403, 'ACCOUNT_PENDING');

    await User.update({ status: 'active' }, { where: { role: 'teacher' } });
    expect((await withAuthorization(header)).status).toBe(200);

    await User.update({ status: 'blocked' }, { where: { role: 'teacher' } });
    expectError(await withAuthorization(header), 403, 'ACCOUNT_BLOCKED');
  });
});

describe('getAuth', () => {
  it('gives 401 UNAUTHENTICATED when requireAuth has not run', async () => {
    expectUnauthenticated(await request(createApp()).get('/unguarded'));
  });
});
