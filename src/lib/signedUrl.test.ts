import { createHmac, randomUUID } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { env } from '../config/env.js';
import {
  FILE_URL_TTL_SECONDS,
  assertValidFileSignature,
  isValidFileSignature,
  signFileUrl,
} from './signedUrl.js';

const fileId = randomUUID();
const now = new Date('2026-11-05T07:08:09.123Z');
const expectedExp = Math.floor(now.getTime() / 1000) + 900;

function signedParams(id = fileId): { exp: string; sig: string } {
  const { searchParams } = new URL(signFileUrl(id, now).url, 'http://localhost');

  return { exp: searchParams.get('exp') ?? '', sig: searchParams.get('sig') ?? '' };
}

function secondsAfter(seconds: number): Date {
  return new Date(now.getTime() + seconds * 1000);
}

describe('signFileUrl', () => {
  it('has a 15 minute TTL', () => {
    expect(FILE_URL_TTL_SECONDS).toBe(15 * 60);
  });

  it('builds the URL from contract section 7', () => {
    const sig = createHmac('sha256', env.FILE_URL_SECRET)
      .update(`${fileId}:${expectedExp}`)
      .digest('hex');

    expect(signFileUrl(fileId, now).url).toBe(`/api/v1/files/${fileId}?exp=${expectedExp}&sig=${sig}`);
  });

  it('mirrors exp in expiresAt as an ISO string with milliseconds', () => {
    expect(signFileUrl(fileId, now).expiresAt).toBe('2026-11-05T07:23:09.000Z');
  });
});

describe('isValidFileSignature', () => {
  it('accepts a fresh signature', () => {
    const { exp, sig } = signedParams();

    expect(isValidFileSignature(fileId, exp, sig, now)).toBe(true);
  });

  it('accepts a signature one second before it expires', () => {
    const { exp, sig } = signedParams();

    expect(isValidFileSignature(fileId, exp, sig, secondsAfter(898))).toBe(true);
  });

  it('rejects a signature at and after its expiry', () => {
    const { exp, sig } = signedParams();
    const expiry = new Date(expectedExp * 1000);

    expect(isValidFileSignature(fileId, exp, sig, expiry)).toBe(false);
    expect(isValidFileSignature(fileId, exp, sig, secondsAfter(3600))).toBe(false);
  });

  it('rejects a tampered id', () => {
    const { exp, sig } = signedParams();

    expect(isValidFileSignature(randomUUID(), exp, sig, now)).toBe(false);
  });

  it('rejects a tampered exp', () => {
    const { exp, sig } = signedParams();

    expect(isValidFileSignature(fileId, String(Number(exp) + 3600), sig, now)).toBe(false);
    expect(isValidFileSignature(fileId, `0${exp}`, sig, now)).toBe(false);
  });

  it('rejects a tampered sig', () => {
    const { exp, sig } = signedParams();
    const flipped = `${sig.slice(0, -1)}${sig.endsWith('0') ? '1' : '0'}`;

    expect(isValidFileSignature(fileId, exp, flipped, now)).toBe(false);
  });

  it('rejects a signature made with another secret', () => {
    const { exp } = signedParams();
    const sig = createHmac('sha256', env.JWT_ACCESS_SECRET).update(`${fileId}:${exp}`).digest('hex');

    expect(isValidFileSignature(fileId, exp, sig, now)).toBe(false);
  });

  it.each([['abc'], ['12e5'], ['-1'], [' 123'], ['1.5'], [''], [undefined], [null], [123], [['1']]])(
    'rejects exp %j without throwing',
    (exp) => {
      expect(isValidFileSignature(fileId, exp, signedParams().sig, now)).toBe(false);
    },
  );

  it('rejects an absurdly large exp without throwing', () => {
    expect(isValidFileSignature(fileId, '9'.repeat(400), signedParams().sig, now)).toBe(false);
  });

  it('rejects a sig of the wrong length', () => {
    const { exp, sig } = signedParams();

    expect(isValidFileSignature(fileId, exp, sig.slice(0, -2), now)).toBe(false);
    expect(isValidFileSignature(fileId, exp, `${sig}00`, now)).toBe(false);
    expect(isValidFileSignature(fileId, exp, '', now)).toBe(false);
  });

  it('rejects a non-hex sig of the right length', () => {
    expect(isValidFileSignature(fileId, signedParams().exp, 'z'.repeat(64), now)).toBe(false);
  });

  it('rejects an uppercase sig', () => {
    const { exp, sig } = signedParams();

    expect(isValidFileSignature(fileId, exp, sig.toUpperCase(), now)).toBe(false);
  });

  it.each([[undefined], [null], [123], [['a']]])('rejects sig %j without throwing', (sig) => {
    expect(isValidFileSignature(fileId, signedParams().exp, sig, now)).toBe(false);
  });
});

describe('assertValidFileSignature', () => {
  it('passes for a valid signature', () => {
    const { exp, sig } = signedParams();

    expect(() => assertValidFileSignature(fileId, exp, sig, now)).not.toThrow();
  });

  it('throws 403 FILE_URL_INVALID otherwise', () => {
    const { exp, sig } = signedParams();

    expect(() => assertValidFileSignature(fileId, exp, sig, secondsAfter(901))).toThrow(
      expect.objectContaining({ code: 'FILE_URL_INVALID', status: 403 }),
    );
  });
});
