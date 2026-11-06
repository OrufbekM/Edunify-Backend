import { randomUUID } from 'node:crypto';

import express from 'express';
import request from 'supertest';
import { describe, expect, it } from 'vitest';

import type { Role } from '../db/models/enums.js';
import { signAccessToken } from '../lib/tokens.js';
import { requireAuth } from './auth.js';
import { errorHandler } from './error.js';
import { requireRole } from './role.js';

function createApp() {
  const app = express();
  app.get('/teachers', requireAuth, requireRole('teacher'), (_req, res) => {
    res.json({ ok: true });
  });
  app.get('/everyone', requireAuth, requireRole('teacher', 'student'), (_req, res) => {
    res.json({ ok: true });
  });
  app.get('/no-auth-first', requireRole('teacher'), (_req, res) => {
    res.json({ ok: true });
  });
  app.use(errorHandler);
  return app;
}

function get(path: string, role: Role) {
  const token = signAccessToken({ id: randomUUID(), role });

  return request(createApp()).get(path).set('Authorization', `Bearer ${token}`);
}

describe('requireRole', () => {
  it('gives 401 UNAUTHENTICATED without req.auth', async () => {
    const res = await request(createApp()).get('/no-auth-first');

    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('UNAUTHENTICATED');
  });

  it('gives 403 FORBIDDEN for the wrong role', async () => {
    const res = await get('/teachers', 'student');

    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: { code: 'FORBIDDEN', message: expect.any(String) } });
  });

  it('passes for the right role', async () => {
    const res = await get('/teachers', 'teacher');

    expect(res.status).toBe(200);
  });

  it('passes for any listed role', async () => {
    const res = await get('/everyone', 'student');

    expect(res.status).toBe(200);
  });
});
