import { randomUUID } from 'node:crypto';

import express from 'express';
import jwt from 'jsonwebtoken';
import request from 'supertest';
import { describe, expect, it } from 'vitest';

import { env } from '../config/env.js';
import { signAccessToken } from '../lib/tokens.js';
import { getAuth, requireAuth } from './auth.js';
import { errorHandler } from './error.js';

const user = { id: randomUUID(), role: 'student' } as const;

function createApp() {
  const app = express();
  app.get('/private', requireAuth, (req, res) => {
    res.json(req.auth);
  });
  app.get('/unguarded', (req, res) => {
    res.json(getAuth(req));
  });
  app.use(errorHandler);
  return app;
}

function withAuthorization(value: string) {
  return request(createApp()).get('/private').set('Authorization', value);
}

function expectUnauthenticated(res: request.Response): void {
  expect(res.status).toBe(401);
  expect(res.body).toEqual({ error: { code: 'UNAUTHENTICATED', message: expect.any(String) } });
}

describe('requireAuth', () => {
  it('rejects a request with no header', async () => {
    expectUnauthenticated(await request(createApp()).get('/private'));
  });

  it('rejects the wrong scheme', async () => {
    expectUnauthenticated(await withAuthorization(`Basic ${signAccessToken(user)}`));
  });

  it.each(['Bearer', 'Bearer '])('rejects the header %j with no token', async (value) => {
    expectUnauthenticated(await withAuthorization(value));
  });

  it.each([
    ['two spaces', (token: string) => `Bearer  ${token}`],
    ['no space', (token: string) => `Bearer${token}`],
    ['trailing text', (token: string) => `Bearer ${token} extra`],
  ])('rejects a valid token with %s', async (_name, header) => {
    expectUnauthenticated(await withAuthorization(header(signAccessToken(user))));
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

    const res = await withAuthorization(`Bearer ${token}`);

    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('TOKEN_EXPIRED');
  });

  it('sets req.auth from a valid token', async () => {
    const res = await withAuthorization(`Bearer ${signAccessToken(user)}`);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ userId: user.id, role: user.role });
  });

  it.each(['bearer', 'BEARER', 'BeArEr'])('accepts the scheme spelled %s', async (scheme) => {
    const res = await withAuthorization(`${scheme} ${signAccessToken(user)}`);

    expect(res.status).toBe(200);
  });
});

describe('getAuth', () => {
  it('gives 401 UNAUTHENTICATED when requireAuth has not run', async () => {
    expectUnauthenticated(await request(createApp()).get('/unguarded'));
  });
});
