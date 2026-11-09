import { pino, stdSerializers, type Logger } from 'pino';
import { pinoHttp, type HttpLogger } from 'pino-http';

import { env } from '../config/env.js';

const PASSWORD_FIELDS = ['password', 'currentPassword', 'newPassword', 'passwordHash'];

export const redactPaths = [
  // pino-http logs request and response headers, which carry the access and refresh tokens.
  'req.headers.authorization',
  'req.headers.cookie',
  'res.headers["set-cookie"]',
  // A signed file URL is the credential for its file (contract 7); see withoutSignature.
  'req.query.sig',
  ...PASSWORD_FIELDS.flatMap((field) => [field, `*.${field}`, `req.body.${field}`]),
];

export const logger = pino({
  level: env.NODE_ENV === 'test' ? 'silent' : 'info',
  redact: redactPaths,
});

// Keeps the path and the expiry of a signed file URL in the request log, and drops the
// signature, so the log can't be used to open the file.
export function withoutSignature(url: string): string {
  return url.replace(/([?&]sig=)[^&#]*/g, '$1[Redacted]');
}

// One request log line per response, at error level for a 5xx.
export function httpLogger(base: Logger = logger): HttpLogger {
  return pinoHttp({
    logger: base,
    customLogLevel: (_req, res) => (res.statusCode >= 500 ? 'error' : 'info'),
    serializers: {
      req: stdSerializers.wrapRequestSerializer((req) => {
        req.url = withoutSignature(req.url);
        return req;
      }),
    },
  });
}
