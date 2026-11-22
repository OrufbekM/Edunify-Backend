import type { RequestHandler } from 'express';

import type { Role } from '../db/models/enums.js';
import { AppError } from '../lib/errors.js';
import { getAuth } from './auth.js';

export function requireRole(...roles: Role[]): RequestHandler {
  return (req, _res, next) => {
    if (!roles.includes(getAuth(req).role)) {
      throw new AppError('FORBIDDEN', 'This role may not use this endpoint');
    }

    next();
  };
}
