import express from 'express';
import { pino } from 'pino';
import request from 'supertest';
import { describe, expect, it } from 'vitest';

import { httpLogger, redactPaths, withoutSignature } from './logger.js';

function logged(entry: object): string {
  const lines: string[] = [];

  pino({ redact: redactPaths }, { write: (line) => lines.push(line) }).info(entry);

  return lines.join('');
}

describe('redactPaths', () => {
  it.each([
    ['the Authorization header', { req: { headers: { authorization: 'Bearer SECRET' } } }],
    ['the Cookie header', { req: { headers: { cookie: 'edunify_rt=SECRET' } } }],
    ['the Set-Cookie header', { res: { headers: { 'set-cookie': 'edunify_rt=SECRET' } } }],
    ['a password', { password: 'SECRET' }],
    ['a current password', { currentPassword: 'SECRET' }],
    ['a new password', { newPassword: 'SECRET' }],
    ['a password inside an object', { body: { password: 'SECRET' } }],
    ['a password in a request body', { req: { body: { password: 'SECRET' } } }],
    ['a stored password hash', { user: { passwordHash: 'SECRET' } }],
    ['the signature of a signed file URL', { req: { query: { exp: '1', sig: 'SECRET' } } }],
  ])('hides %s', (_name, entry) => {
    const line = logged(entry);

    expect(line).not.toContain('SECRET');
    expect(line).toContain('[Redacted]');
  });

  it('leaves other fields alone', () => {
    const line = logged({ user: { fullName: 'Ann' }, req: { url: '/api/v1/health' } });

    expect(line).toContain('Ann');
    expect(line).toContain('/api/v1/health');
    expect(line).not.toContain('[Redacted]');
  });
});

describe('withoutSignature', () => {
  it.each([
    ['/api/v1/files/abc?exp=123&sig=SECRET', '/api/v1/files/abc?exp=123&sig=[Redacted]'],
    ['/api/v1/files/abc?sig=SECRET&exp=123', '/api/v1/files/abc?sig=[Redacted]&exp=123'],
    ['/api/v1/health', '/api/v1/health'],
    ['/api/v1/x?design=1&designs=2', '/api/v1/x?design=1&designs=2'],
  ])('turns %s into %s', (url, expected) => {
    expect(withoutSignature(url)).toBe(expected);
  });
});

interface LogEntry {
  level: number;
  req: { url: string; query: Record<string, string> };
}

describe('httpLogger', () => {
  async function logLine(path: string, status = 200): Promise<LogEntry> {
    const lines: string[] = [];
    const base = pino({ redact: redactPaths }, { write: (line) => lines.push(line) });
    const app = express();
    app.use(httpLogger(base));
    app.get('/api/v1/files/:id', (_req, res) => {
      res.status(status).send('x');
    });

    await request(app).get(path);

    expect(lines).toHaveLength(1);
    return JSON.parse(lines[0] as string) as LogEntry;
  }

  it('logs a signed file request with its path and expiry but not its signature', async () => {
    const entry = await logLine('/api/v1/files/abc?exp=123&sig=SECRET');

    expect(JSON.stringify(entry)).not.toContain('SECRET');
    expect(entry.req.url).toBe('/api/v1/files/abc?exp=123&sig=[Redacted]');
    expect(entry.req.query).toEqual({ exp: '123', sig: '[Redacted]' });
    expect(entry.level).toBe(30);
  });

  it('logs a 5xx at error level', async () => {
    expect((await logLine('/api/v1/files/abc', 503)).level).toBe(50);
  });
});
