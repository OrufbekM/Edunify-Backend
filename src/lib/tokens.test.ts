import { createHash, randomUUID } from 'node:crypto';

import jwt from 'jsonwebtoken';
import { describe, expect, it } from 'vitest';

import { env } from '../config/env.js';
import {
  ACCESS_TOKEN_TTL_SECONDS,
  REFRESH_TOKEN_TTL_SECONDS,
  generateRefreshToken,
  hashRefreshToken,
  signAccessToken,
  verifyAccessToken,
} from './tokens.js';

const user = { id: randomUUID(), role: 'teacher' } as const;
const secret = env.JWT_ACCESS_SECRET;

function base64url(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}

function expectRejected(token: string, code: 'TOKEN_EXPIRED' | 'UNAUTHENTICATED'): void {
  const expected = code === 'TOKEN_EXPIRED' ? 'Access token expired' : 'Invalid access token';

  expect(() => verifyAccessToken(token)).toThrow(
    expect.objectContaining({ code, status: 401, message: expected }),
  );
}

describe('TTL constants', () => {
  it('match contract 2.3', () => {
    expect(ACCESS_TOKEN_TTL_SECONDS).toBe(15 * 60);
    expect(REFRESH_TOKEN_TTL_SECONDS).toBe(30 * 24 * 60 * 60);
  });
});

describe('signAccessToken', () => {
  it('produces an HS256 token with sub, role, iat and exp 900 seconds apart', () => {
    const decoded = jwt.decode(signAccessToken(user), { complete: true });

    expect(decoded?.header.alg).toBe('HS256');
    expect(decoded?.payload).toEqual({
      sub: user.id,
      role: user.role,
      iat: expect.any(Number),
      exp: expect.any(Number),
    });

    const { iat, exp } = decoded?.payload as { iat: number; exp: number };
    expect(exp - iat).toBe(900);
  });
});

describe('verifyAccessToken', () => {
  it('round-trips a signed token', () => {
    expect(verifyAccessToken(signAccessToken(user))).toEqual({
      userId: user.id,
      role: user.role,
    });
  });

  it('gives TOKEN_EXPIRED for an expired token with a valid signature', () => {
    const token = jwt.sign({ role: user.role }, secret, {
      algorithm: 'HS256',
      subject: user.id,
      expiresIn: -10,
    });

    expectRejected(token, 'TOKEN_EXPIRED');
  });

  it('gives UNAUTHENTICATED for an expired token with a bad signature', () => {
    const token = jwt.sign({ role: user.role }, 'x'.repeat(40), {
      algorithm: 'HS256',
      subject: user.id,
      expiresIn: -10,
    });

    expectRejected(token, 'UNAUTHENTICATED');
  });

  it('gives UNAUTHENTICATED for the wrong secret', () => {
    const token = jwt.sign({ role: user.role }, 'x'.repeat(40), {
      algorithm: 'HS256',
      subject: user.id,
      expiresIn: 900,
    });

    expectRejected(token, 'UNAUTHENTICATED');
  });

  it('gives UNAUTHENTICATED for a tampered payload', () => {
    const [header, , signature] = signAccessToken({ id: user.id, role: 'student' }).split('.');
    const now = Math.floor(Date.now() / 1000);
    const forged = base64url({ sub: user.id, role: 'teacher', iat: now, exp: now + 900 });

    expectRejected(`${header}.${forged}.${signature}`, 'UNAUTHENTICATED');
  });

  it('gives UNAUTHENTICATED for alg none', () => {
    const now = Math.floor(Date.now() / 1000);
    const header = base64url({ alg: 'none', typ: 'JWT' });
    const payload = base64url({ sub: user.id, role: user.role, iat: now, exp: now + 900 });

    expectRejected(`${header}.${payload}.`, 'UNAUTHENTICATED');
  });

  it('gives UNAUTHENTICATED for a different HMAC algorithm', () => {
    const token = jwt.sign({ role: user.role }, secret, {
      algorithm: 'HS512',
      subject: user.id,
      expiresIn: 900,
    });

    expectRejected(token, 'UNAUTHENTICATED');
  });

  it.each([
    ['no role', {}, { subject: user.id, expiresIn: 900 }],
    ['an unknown role', { role: 'admin' }, { subject: user.id, expiresIn: 900 }],
    ['no subject', { role: user.role }, { expiresIn: 900 }],
    ['a subject that is not a uuid', { role: user.role }, { subject: 'user-1', expiresIn: 900 }],
    ['no expiry', { role: user.role }, { subject: user.id }],
  ])('gives UNAUTHENTICATED for a signed payload with %s', (_name, payload, options) => {
    expectRejected(jwt.sign(payload, secret, { algorithm: 'HS256', ...options }), 'UNAUTHENTICATED');
  });

  it('gives UNAUTHENTICATED for a signed string payload', () => {
    expectRejected(jwt.sign('plain text', secret, { algorithm: 'HS256' }), 'UNAUTHENTICATED');
  });

  it.each(['', 'garbage', 'a.b.c'])('gives UNAUTHENTICATED for %j', (token) => {
    expectRejected(token, 'UNAUTHENTICATED');
  });
});

describe('generateRefreshToken', () => {
  it('returns 43 base64url characters', () => {
    expect(generateRefreshToken()).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it('never repeats', () => {
    const tokens = new Set(Array.from({ length: 1000 }, () => generateRefreshToken()));
    expect(tokens.size).toBe(1000);
  });
});

describe('hashRefreshToken', () => {
  it('returns 64 hex characters', () => {
    expect(hashRefreshToken('token')).toMatch(/^[0-9a-f]{64}$/);
  });

  it('is deterministic and equals SHA-256', () => {
    expect(hashRefreshToken('token')).toBe(hashRefreshToken('token'));
    expect(hashRefreshToken('token')).toBe(createHash('sha256').update('token').digest('hex'));
  });

  it('differs between tokens', () => {
    expect(hashRefreshToken('a')).not.toBe(hashRefreshToken('b'));
  });
});
