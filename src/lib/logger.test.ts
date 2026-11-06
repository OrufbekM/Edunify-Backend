import { pino } from 'pino';
import { describe, expect, it } from 'vitest';

import { redactPaths } from './logger.js';

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
