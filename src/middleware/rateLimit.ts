import type { Request } from 'express';
import {
  HOUR,
  MINUTE,
  MemoryStore,
  ipKeyGenerator,
  rateLimit,
  type AugmentedRequest,
  type RateLimitRequestHandler,
} from 'express-rate-limit';

import { AppError } from '../lib/errors.js';

const MAX_EMAIL_LENGTH = 254;

const stores: MemoryStore[] = [];

// For tests only: clears the counters of every limiter created here.
export async function resetRateLimits(): Promise<void> {
  await Promise.all(stores.map((store) => store.resetAll()));
}

interface RateLimiterOptions {
  windowMs: number;
  limit: number;
  keyGenerator?: (req: Request) => string;
}

export function createRateLimiter({
  windowMs,
  limit,
  keyGenerator,
}: RateLimiterOptions): RateLimitRequestHandler {
  const store = new MemoryStore();
  stores.push(store);

  return rateLimit({
    windowMs,
    limit,
    keyGenerator,
    store,
    standardHeaders: false,
    legacyHeaders: false,
    handler: (req, res, next) => {
      const { resetTime } = (req as AugmentedRequest).rateLimit;
      const remainingMs = resetTime ? resetTime.getTime() - Date.now() : windowMs;

      res.setHeader('Retry-After', Math.max(1, Math.ceil(remainingMs / 1000)));
      next(new AppError('RATE_LIMITED', 'Too many requests'));
    },
  });
}

function ipKey(req: Request): string {
  return ipKeyGenerator(req.ip ?? 'unknown');
}

function userOrIpKey(req: Request): string {
  return req.user?.id ?? ipKey(req);
}

function loginKey(req: Request): string {
  const email: unknown = req.body?.email;
  const normalized = typeof email === 'string' ? email.trim().toLowerCase() : '';

  // A longer value cannot be an address, and a body can carry 1 MB of it: as a key
  // it would let one client fill the in-memory store.
  if (!normalized || normalized.length > MAX_EMAIL_LENGTH) {
    return ipKey(req);
  }

  return `${ipKey(req)}|${normalized}`;
}

export const loginLimiter = createRateLimiter({
  windowMs: 15 * MINUTE,
  limit: 10,
  keyGenerator: loginKey,
});

export const registerLimiter = createRateLimiter({ windowMs: HOUR, limit: 10 });

export const publicIdLookupLimiter = createRateLimiter({
  windowMs: 10 * MINUTE,
  limit: 30,
  keyGenerator: userOrIpKey,
});

export const aiGradeLimiter = createRateLimiter({
  windowMs: MINUTE,
  limit: 5,
  keyGenerator: userOrIpKey,
});

export const generalLimiter = createRateLimiter({
  windowMs: MINUTE,
  limit: 300,
  keyGenerator: userOrIpKey,
});
