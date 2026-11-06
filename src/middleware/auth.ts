import type { Request, RequestHandler } from 'express';

import type { Role } from '../db/models/enums.js';
import { AppError } from '../lib/errors.js';
import { verifyAccessToken } from '../lib/tokens.js';

export interface AuthContext {
  userId: string;
  role: Role;
}

declare module 'express-serve-static-core' {
  interface Request {
    auth?: AuthContext;
  }
}

const BEARER_PATTERN = /^bearer (\S+)$/i;

export const requireAuth: RequestHandler = (req, _res, next) => {
  const token = BEARER_PATTERN.exec(req.headers.authorization ?? '')?.[1];

  if (!token) {
    throw new AppError('UNAUTHENTICATED', 'Missing or malformed Authorization header');
  }

  req.auth = verifyAccessToken(token);
  next();
};

export function getAuth(req: Request): AuthContext {
  if (!req.auth) {
    throw new AppError('UNAUTHENTICATED', 'Authentication required');
  }

  return req.auth;
}
