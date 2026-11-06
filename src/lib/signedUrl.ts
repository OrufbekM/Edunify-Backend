import { createHmac, timingSafeEqual } from 'node:crypto';

import { env } from '../config/env.js';
import { AppError } from './errors.js';

export const FILE_URL_TTL_SECONDS = 900;

function computeSignature(fileId: string, exp: string): Buffer {
  return createHmac('sha256', env.FILE_URL_SECRET).update(`${fileId}:${exp}`).digest();
}

export function signFileUrl(fileId: string, now = new Date()): { url: string; expiresAt: string } {
  const exp = Math.floor(now.getTime() / 1000) + FILE_URL_TTL_SECONDS;
  const sig = computeSignature(fileId, String(exp)).toString('hex');

  return {
    url: `/api/v1/files/${fileId}?exp=${exp}&sig=${sig}`,
    expiresAt: new Date(exp * 1000).toISOString(),
  };
}

// exp and sig come straight from the query string, so either can be missing or an array.
export function isValidFileSignature(
  fileId: string,
  exp: unknown,
  sig: unknown,
  now = new Date(),
): boolean {
  if (typeof exp !== 'string' || !/^\d+$/.test(exp)) {
    return false;
  }
  if (typeof sig !== 'string' || !/^[0-9a-f]{64}$/.test(sig)) {
    return false;
  }
  if (Number(exp) * 1000 <= now.getTime()) {
    return false;
  }

  return timingSafeEqual(Buffer.from(sig, 'hex'), computeSignature(fileId, exp));
}

export function assertValidFileSignature(
  fileId: string,
  exp: unknown,
  sig: unknown,
  now = new Date(),
): void {
  if (!isValidFileSignature(fileId, exp, sig, now)) {
    throw new AppError('FILE_URL_INVALID', 'Signed file URL is invalid or expired');
  }
}
