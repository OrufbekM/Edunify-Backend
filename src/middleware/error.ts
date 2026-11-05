import type { ErrorRequestHandler, RequestHandler } from 'express';
import { ZodError } from 'zod';

import { AppError } from '../lib/errors.js';

export const notFoundHandler: RequestHandler = (_req, _res, next) => {
  next(new AppError('NOT_FOUND', 'Route not found'));
};

function toAppError(err: unknown): AppError {
  if (err instanceof AppError) {
    return err;
  }

  if (err instanceof ZodError) {
    const details = err.issues.map((issue) => ({
      path: issue.path.join('.'),
      message: issue.message,
    }));
    return new AppError('VALIDATION_ERROR', 'Invalid request', details);
  }

  // Express and body-parser reject bad requests with a plain `status`, before any route runs.
  switch ((err as { status?: unknown }).status) {
    case 400:
      return new AppError('VALIDATION_ERROR', 'Invalid request', [
        { path: '', message: 'Malformed request' },
      ]);
    case 413:
      return new AppError('PAYLOAD_TOO_LARGE', 'Request body too large');
    case 415:
      return new AppError('UNSUPPORTED_MEDIA_TYPE', 'Unsupported request encoding');
    default:
      return new AppError('INTERNAL', 'Internal server error');
  }
}

export const errorHandler: ErrorRequestHandler = (err, _req, res, next) => {
  if (res.headersSent) {
    next(err);
    return;
  }

  const { status, code, message, details } = toAppError(err);

  if (status >= 500) {
    // pino-http logs this with the request, so the cause stays in the logs and out of the response.
    res.err = err;
  }

  res.status(status).json({ error: { code, message, details } });
};
