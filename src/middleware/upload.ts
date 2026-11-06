import type { RequestHandler } from 'express';
import multer from 'multer';

import { AppError } from '../lib/errors.js';

const MB = 1024 * 1024;

type IsCapError = (err: multer.MulterError) => boolean;

function toAppError(err: unknown, isCapError: IsCapError): AppError {
  // With memory storage, anything else comes from parsing the client's body
  // (no boundary, truncated form), which must not surface as a 500.
  if (!(err instanceof multer.MulterError)) {
    return new AppError('VALIDATION_ERROR', 'Invalid upload', [
      { path: '', message: 'Malformed multipart request' },
    ]);
  }

  if (err.code === 'LIMIT_FILE_SIZE') {
    return new AppError('PAYLOAD_TOO_LARGE', 'File too large');
  }

  if (isCapError(err)) {
    return new AppError('LIMIT_REACHED', 'Too many pages');
  }

  return new AppError('VALIDATION_ERROR', 'Invalid upload', [
    { path: err.field ?? '', message: err.message },
  ]);
}

function withAppErrors(upload: RequestHandler, isCapError: IsCapError): RequestHandler {
  return (req, res, next) => {
    upload(req, res, (err?: unknown) => {
      next(err ? toAppError(err, isCapError) : undefined);
    });
  };
}

export function createFileUpload({ maxFileSize }: { maxFileSize: number }): RequestHandler {
  const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: maxFileSize, files: 1, fields: 0 },
  });

  return withAppErrors(upload.single('file'), () => false);
}

export function createPagesUpload({
  maxFileSize,
  maxPages,
}: {
  maxFileSize: number;
  maxPages: number;
}): RequestHandler {
  const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: maxFileSize, files: maxPages, fields: 0 },
  });

  return withAppErrors(
    upload.array('pages', maxPages),
    ({ code, field }) =>
      code === 'LIMIT_FILE_COUNT' || (code === 'LIMIT_UNEXPECTED_FILE' && field === 'pages'),
  );
}

export const uploadFile = createFileUpload({ maxFileSize: 20 * MB });

export const uploadPages = createPagesUpload({ maxFileSize: 10 * MB, maxPages: 9 });
