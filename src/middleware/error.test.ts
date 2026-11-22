import express from 'express';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { AppError } from '../lib/errors.js';
import { errorHandler, notFoundHandler } from './error.js';

const bodySchema = z.strictObject({
  fullName: z.string(),
  profile: z.strictObject({ age: z.number() }).optional(),
});

function createApp() {
  const app = express();
  app.use(express.json());
  app.post('/people', (req, res) => {
    res.json(bodySchema.parse(req.body));
  });
  app.get('/taken', () => {
    throw new AppError('EMAIL_TAKEN', 'Email already registered');
  });
  app.get('/job', () => {
    throw new AppError('AI_JOB_ACTIVE', 'Job running', { jobId: 'job-1' });
  });
  app.get('/boom', () => {
    throw new Error('secret detail');
  });
  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}

describe('errorHandler with a strict zod schema', () => {
  it('lets a valid body through', async () => {
    const res = await request(createApp()).post('/people').send({ fullName: 'Ann' });

    expect(res.status).toBe(200);
  });

  it('returns one detail per unknown field', async () => {
    const res = await request(createApp())
      .post('/people')
      .send({ fullName: 'Ann', role: 'admin', extra: 1 });

    expect(res.status).toBe(400);
    expect(res.body).toEqual({
      error: {
        code: 'VALIDATION_ERROR',
        message: 'Invalid request',
        details: [
          { path: 'role', message: 'Unknown field' },
          { path: 'extra', message: 'Unknown field' },
        ],
      },
    });
  });

  it('includes the parent path of a nested unknown field', async () => {
    const res = await request(createApp())
      .post('/people')
      .send({ fullName: 'Ann', profile: { age: 30, nickname: 'A' } });

    expect(res.status).toBe(400);
    expect(res.body.error.details).toEqual([{ path: 'profile.nickname', message: 'Unknown field' }]);
  });

  it('keeps ordinary issues as { path, message }', async () => {
    const res = await request(createApp())
      .post('/people')
      .send({ profile: { age: 'old' } });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
    expect(res.body.error.details).toEqual([
      { path: 'fullName', message: expect.any(String) },
      { path: 'profile.age', message: expect.any(String) },
    ]);
  });

  it('reports unknown and invalid fields together', async () => {
    const res = await request(createApp()).post('/people').send({ fullName: 1, extra: true });

    expect(res.status).toBe(400);
    expect(res.body.error.details).toEqual(
      expect.arrayContaining([
        { path: 'fullName', message: expect.any(String) },
        { path: 'extra', message: 'Unknown field' },
      ]),
    );
  });
});

describe('errorHandler with other errors', () => {
  it('omits details when an AppError has none', async () => {
    const res = await request(createApp()).get('/taken');

    expect(res.status).toBe(409);
    expect(res.body).toEqual({
      error: { code: 'EMAIL_TAKEN', message: 'Email already registered' },
    });
  });

  it('passes object details through', async () => {
    const res = await request(createApp()).get('/job');

    expect(res.status).toBe(409);
    expect(res.body.error.details).toEqual({ jobId: 'job-1' });
  });

  it('hides the cause of an unexpected error', async () => {
    const res = await request(createApp()).get('/boom');

    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: { code: 'INTERNAL', message: 'Internal server error' } });
  });

  it('answers unknown paths with NOT_FOUND', async () => {
    const res = await request(createApp()).get('/nope');

    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('NOT_FOUND');
  });
});
