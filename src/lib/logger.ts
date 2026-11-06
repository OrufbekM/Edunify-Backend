import { pino } from 'pino';

import { env } from '../config/env.js';

const PASSWORD_FIELDS = ['password', 'currentPassword', 'newPassword', 'passwordHash'];

export const redactPaths = [
  // pino-http logs request and response headers, which carry the access and refresh tokens.
  'req.headers.authorization',
  'req.headers.cookie',
  'res.headers["set-cookie"]',
  ...PASSWORD_FIELDS.flatMap((field) => [field, `*.${field}`, `req.body.${field}`]),
];

export const logger = pino({
  level: env.NODE_ENV === 'test' ? 'silent' : 'info',
  redact: redactPaths,
});
