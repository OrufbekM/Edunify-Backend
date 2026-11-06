import { randomUUID } from 'node:crypto';

import express, { type Express, type RequestHandler } from 'express';
import request from 'supertest';
import { describe, expect, it } from 'vitest';

import { errorHandler } from './error.js';
import {
  aiGradeLimiter,
  createRateLimiter,
  generalLimiter,
  loginLimiter,
  publicIdLookupLimiter,
  registerLimiter,
} from './rateLimit.js';

// Stands in for requireAuth so a test can choose the user behind a request.
const fakeAuth: RequestHandler = (req, _res, next) => {
  const userId = req.get('x-test-user');
  if (userId) {
    req.user = { id: userId, role: 'teacher' };
  }
  next();
};

function createApp(limiter: RequestHandler): Express {
  const app = express();
  app.use(express.json());
  app.use(fakeAuth);
  app.post('/', limiter, (_req, res) => {
    res.json({ ok: true });
  });
  app.use(errorHandler);
  return app;
}

function post(app: Express, { body = {}, user }: { body?: object; user?: string } = {}) {
  const pending = request(app).post('/');

  return (user ? pending.set('x-test-user', user) : pending).send(body);
}

async function postTimes(app: Express, times: number, options?: Parameters<typeof post>[1]) {
  for (let i = 0; i < times; i += 1) {
    const res = await post(app, options);
    expect(res.status).toBe(200);
  }
}

function expectRetryAfterNear(res: request.Response, windowSeconds: number): void {
  const retryAfter = Number(res.headers['retry-after']);

  expect(retryAfter).toBeGreaterThan(windowSeconds - 10);
  expect(retryAfter).toBeLessThanOrEqual(windowSeconds);
}

describe('createRateLimiter', () => {
  it('gives 429 RATE_LIMITED on request N+1', async () => {
    const app = createApp(createRateLimiter({ windowMs: 60_000, limit: 2 }));

    await postTimes(app, 2);
    const res = await post(app);

    expect(res.status).toBe(429);
    expect(res.body).toEqual({ error: { code: 'RATE_LIMITED', message: expect.any(String) } });
  });

  it('sends Retry-After in whole seconds', async () => {
    const app = createApp(createRateLimiter({ windowMs: 60_000, limit: 1 }));

    await postTimes(app, 1);
    const retryAfter = (await post(app)).headers['retry-after'];

    expect(retryAfter).toMatch(/^\d+$/);
    expect(Number(retryAfter)).toBeGreaterThanOrEqual(1);
    expect(Number(retryAfter)).toBeLessThanOrEqual(60);
  });

  it('never sends a Retry-After below 1', async () => {
    const app = createApp(createRateLimiter({ windowMs: 900, limit: 1 }));

    await postTimes(app, 1);
    const res = await post(app);

    expect(res.status).toBe(429);
    expect(res.headers['retry-after']).toBe('1');
  });

  it('sends no standard or legacy rate-limit headers', async () => {
    const app = createApp(createRateLimiter({ windowMs: 60_000, limit: 1 }));

    const allowed = await post(app);
    const blocked = await post(app);

    for (const res of [allowed, blocked]) {
      expect(Object.keys(res.headers).filter((name) => name.includes('ratelimit'))).toEqual([]);
    }
  });

  it('counts each key separately', async () => {
    const app = createApp(
      createRateLimiter({
        windowMs: 60_000,
        limit: 1,
        keyGenerator: (req) => req.get('x-test-user') ?? 'anonymous',
      }),
    );

    await postTimes(app, 1, { user: 'a' });

    expect((await post(app, { user: 'a' })).status).toBe(429);
    expect((await post(app, { user: 'b' })).status).toBe(200);
  });
});

describe('loginLimiter', () => {
  const app = createApp(loginLimiter);

  it('allows 10 attempts per IP and email', async () => {
    const body = { email: 'limit@example.com' };

    await postTimes(app, 10, { body });
    const res = await post(app, { body });

    expect(res.status).toBe(429);
    expectRetryAfterNear(res, 15 * 60);
  });

  it('counts two emails from one IP separately', async () => {
    await postTimes(app, 10, { body: { email: 'first@example.com' } });

    expect((await post(app, { body: { email: 'first@example.com' } })).status).toBe(429);
    expect((await post(app, { body: { email: 'second@example.com' } })).status).toBe(200);
  });

  it('treats case and surrounding spaces as the same email', async () => {
    await postTimes(app, 5, { body: { email: 'same@example.com' } });
    await postTimes(app, 5, { body: { email: '  SAME@Example.COM ' } });

    expect((await post(app, { body: { email: 'same@example.com' } })).status).toBe(429);
  });

  it('falls back to the IP alone when there is no usable email', async () => {
    const unusable = [{}, { email: 42 }, { email: '   ' }, { email: 'x'.repeat(255) }];

    for (let i = 0; i < 10; i += 1) {
      expect((await post(app, { body: unusable[i % unusable.length] })).status).toBe(200);
    }

    expect((await post(app, { body: { email: 'y'.repeat(255) } })).status).toBe(429);
  });
});

describe('registerLimiter', () => {
  it('allows 10 requests per hour per IP', async () => {
    const app = createApp(registerLimiter);

    await postTimes(app, 10);
    const res = await post(app);

    expect(res.status).toBe(429);
    expectRetryAfterNear(res, 60 * 60);
  });
});

describe.each([
  ['publicIdLookupLimiter', publicIdLookupLimiter, 30, 10 * 60],
  ['aiGradeLimiter', aiGradeLimiter, 5, 60],
  ['generalLimiter', generalLimiter, 300, 60],
])('%s', (_name, limiter, limit, windowSeconds) => {
  it(`allows ${limit} requests per user`, async () => {
    const app = createApp(limiter);
    const user = randomUUID();

    await postTimes(app, limit, { user });
    const res = await post(app, { user });

    expect(res.status).toBe(429);
    expectRetryAfterNear(res, windowSeconds);
    expect((await post(app, { user: randomUUID() })).status).toBe(200);
  });

  it('falls back to the IP for anonymous requests', async () => {
    const app = createApp(limiter);

    await postTimes(app, limit);

    expect((await post(app)).status).toBe(429);
    expect((await post(app, { user: randomUUID() })).status).toBe(200);
  });
});
