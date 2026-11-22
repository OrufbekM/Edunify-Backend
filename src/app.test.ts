import request from 'supertest';
import { describe, expect, it } from 'vitest';

import { app } from './app.js';

const ONE_MB = 1024 * 1024;

// A JSON document of exactly `bytes` bytes.
function jsonOfSize(bytes: number): string {
  const wrapper = '{"a":""}';

  return `{"a":"${'x'.repeat(bytes - wrapper.length)}"}`;
}

function postJson(body: string) {
  return request(app).post('/api/v1/health').set('Content-Type', 'application/json').send(body);
}

describe('app', () => {
  it('answers the health check', async () => {
    const res = await request(app).get('/api/v1/health');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'ok' });
  });

  it('answers an unknown path with NOT_FOUND in the contract shape', async () => {
    const res = await request(app).get('/api/v1/nope');

    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: { code: 'NOT_FOUND', message: expect.any(String) } });
  });

  it('answers malformed JSON with VALIDATION_ERROR', async () => {
    const res = await postJson('{"a":');

    expect(res.status).toBe(400);
    expect(res.body).toEqual({
      error: {
        code: 'VALIDATION_ERROR',
        message: expect.any(String),
        details: [{ path: '', message: expect.any(String) }],
      },
    });
  });

  it('accepts a JSON body of exactly 1 MB', async () => {
    const res = await postJson(jsonOfSize(ONE_MB));

    // The body parsed; there is simply no POST route on this path.
    expect(res.status).toBe(404);
  });

  it('answers a JSON body over 1 MB with PAYLOAD_TOO_LARGE', async () => {
    const res = await postJson(jsonOfSize(ONE_MB + 1));

    expect(res.status).toBe(413);
    expect(res.body).toEqual({ error: { code: 'PAYLOAD_TOO_LARGE', message: expect.any(String) } });
  });

  it('sends no ETag', async () => {
    const res = await request(app).get('/api/v1/health');

    expect(res.headers.etag).toBeUndefined();
  });

  it('runs helmet', async () => {
    const res = await request(app).get('/api/v1/health');

    expect(res.headers['x-powered-by']).toBeUndefined();
    expect(res.headers['x-content-type-options']).toBe('nosniff');
  });

  it('trusts exactly one reverse proxy', () => {
    expect(app.get('trust proxy')).toBe(1);
  });
});
