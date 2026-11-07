import { Router, type CookieOptions, type Request, type Response } from 'express';

import { env } from '../../config/env.js';
import { REFRESH_TOKEN_TTL_SECONDS } from '../../lib/tokens.js';
import { getAuth, requireAuth } from '../../middleware/auth.js';
import { generalLimiter, loginLimiter, registerLimiter } from '../../middleware/rateLimit.js';
import {
  changePasswordBody,
  loginBody,
  noBody,
  registerBody,
  updateMeBody,
} from './schemas.js';
import * as auth from './service.js';

const REFRESH_COOKIE = 'edunify_rt';

// Contract 2.3. Secure only in production, because development runs on http://localhost.
export function refreshCookieOptions(production = env.NODE_ENV === 'production'): CookieOptions {
  return { httpOnly: true, sameSite: 'strict', path: '/api/v1/auth', secure: production };
}

function setRefreshCookie(res: Response, token: string): void {
  // Express takes maxAge in milliseconds and writes Max-Age in seconds.
  res.cookie(REFRESH_COOKIE, token, {
    ...refreshCookieOptions(),
    maxAge: REFRESH_TOKEN_TTL_SECONDS * 1000,
  });
}

function readRefreshCookie(req: Request): string | undefined {
  const value: unknown = req.cookies?.[REFRESH_COOKIE];

  return typeof value === 'string' ? value : undefined;
}

export const authRouter = Router();

authRouter.use(generalLimiter);

authRouter.post('/register', registerLimiter, async (req, res) => {
  const { refreshToken, ...session } = await auth.register(registerBody.parse(req.body));

  setRefreshCookie(res, refreshToken);
  res.status(201).json(session);
});

authRouter.post('/login', loginLimiter, async (req, res) => {
  const { refreshToken, ...session } = await auth.login(loginBody.parse(req.body));

  setRefreshCookie(res, refreshToken);
  res.json(session);
});

authRouter.post('/refresh', async (req, res) => {
  noBody.parse(req.body);
  const { refreshToken, ...session } = await auth.refresh(readRefreshCookie(req));

  if (refreshToken) {
    setRefreshCookie(res, refreshToken);
  }
  res.json(session);
});

authRouter.post('/logout', async (req, res) => {
  noBody.parse(req.body);
  await auth.logout(readRefreshCookie(req));

  res.clearCookie(REFRESH_COOKIE, refreshCookieOptions());
  res.status(204).end();
});

export const meRouter = Router();

meRouter.use(requireAuth, generalLimiter);

meRouter.get('/', async (req, res) => {
  res.json(await auth.getMe(getAuth(req).id));
});

meRouter.patch('/', async (req, res) => {
  const body = updateMeBody.parse(req.body);

  res.json(await auth.updateMe(getAuth(req).id, body));
});

meRouter.post('/password', async (req, res) => {
  const body = changePasswordBody.parse(req.body);

  setRefreshCookie(res, await auth.changePassword(getAuth(req).id, body));
  res.status(204).end();
});
