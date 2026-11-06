import { createHash, randomBytes } from 'node:crypto';

// A default import on purpose: jsonwebtoken is CommonJS and Node's ESM loader
// cannot see `sign` or `verify` as named exports.
import jwt from 'jsonwebtoken';
import { z } from 'zod';

import { env } from '../config/env.js';
import { ROLES, type Role } from '../db/models/enums.js';
import { AppError } from './errors.js';
import { uuidSchema } from './zod.js';

export const ACCESS_TOKEN_TTL_SECONDS = 900;
export const REFRESH_TOKEN_TTL_SECONDS = 2_592_000;

const accessTokenPayloadSchema = z.object({
  sub: uuidSchema,
  role: z.enum(ROLES),
  iat: z.number(),
  exp: z.number(),
});

export function signAccessToken({ id, role }: { id: string; role: Role }): string {
  return jwt.sign({ role }, env.JWT_ACCESS_SECRET, {
    algorithm: 'HS256',
    subject: id,
    expiresIn: ACCESS_TOKEN_TTL_SECONDS,
  });
}

export function verifyAccessToken(token: string): { userId: string; role: Role } {
  let payload: unknown;

  try {
    payload = jwt.verify(token, env.JWT_ACCESS_SECRET, { algorithms: ['HS256'] });
  } catch (err) {
    if (err instanceof jwt.TokenExpiredError) {
      throw new AppError('TOKEN_EXPIRED', 'Access token expired');
    }
    throw new AppError('UNAUTHENTICATED', 'Invalid access token');
  }

  const claims = accessTokenPayloadSchema.safeParse(payload);
  if (!claims.success) {
    throw new AppError('UNAUTHENTICATED', 'Invalid access token');
  }

  return { userId: claims.data.sub, role: claims.data.role };
}

export function generateRefreshToken(): string {
  return randomBytes(32).toString('base64url');
}

export function hashRefreshToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}
