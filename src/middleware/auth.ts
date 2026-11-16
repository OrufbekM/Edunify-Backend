import type { Request, RequestHandler } from 'express';

import type { Role } from '../db/models/enums.js';
import { User } from '../db/models/index.js';
import { AppError } from '../lib/errors.js';
import { verifyAccessToken } from '../lib/tokens.js';

export interface AuthContext {
  id: string;
  role: Role;
}

declare module 'express-serve-static-core' {
  interface Request {
    user?: AuthContext;
  }
}

const BEARER_PATTERN = /^bearer (\S+)$/i;

// Contract 2.3: the account is read from the database on every request, never trusted from
// the token, so blocking, approval and a password reset take effect at once. The checks run
// in the contract's order, and before any role check (plan, open item 2).
function authenticate({ gate }: { gate: boolean }): RequestHandler {
  return async (req, _res, next) => {
    const token = BEARER_PATTERN.exec(req.headers.authorization ?? '')?.[1];

    if (!token) {
      throw new AppError('UNAUTHENTICATED', 'Missing or malformed Authorization header');
    }

    const { userId } = verifyAccessToken(token);
    const user = await User.findByPk(userId, { attributes: ['id', 'role', 'status', 'mustChangePassword'] });

    // An access token stays valid for up to 15 minutes, so it can outlive its account.
    if (!user) {
      throw new AppError('UNAUTHENTICATED', 'Account no longer exists');
    }

    if (user.status === 'blocked') {
      throw new AppError('ACCOUNT_BLOCKED');
    }

    if (gate && user.mustChangePassword) {
      throw new AppError('PASSWORD_CHANGE_REQUIRED');
    }

    if (gate && user.status === 'pending') {
      throw new AppError('ACCOUNT_PENDING');
    }

    req.user = { id: user.id, role: user.role };
    next();
  };
}

// Every route except /me and /me/password: the account must be fully usable.
export const requireAuth = authenticate({ gate: true });

// /me and /me/password only: signed in and not blocked is enough, so a teacher waiting for
// approval can see the gate and a user with a reset password can change it (contract 2.3).
export const requireSignedIn = authenticate({ gate: false });

export function getAuth(req: Request): AuthContext {
  if (!req.user) {
    throw new AppError('UNAUTHENTICATED', 'Authentication required');
  }

  return req.user;
}
