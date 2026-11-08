import { extname } from 'node:path';

import type { Request, RequestHandler } from 'express';
import multer from 'multer';

import { AppError } from '../lib/errors.js';

const MB = 1024 * 1024;
const MAX_NAME_LENGTH = 255;
// C0 controls and DEL have no place in a file name, and PostgreSQL text can't hold U+0000.
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;

// Contract section 7. A type is chosen by the file's extension and must then match the
// content; the MIME type the client sends is never used.
export interface FileType {
  mime: string;
  maxSize: number;
  matches(data: Buffer): boolean;
}

// Keyed by lowercase extension, dot included.
export type FileTypes = Readonly<Record<string, FileType>>;

// A file that passed every check, with its detected MIME type.
export interface Upload {
  originalName: string;
  mime: string;
  size: number;
  data: Buffer;
}

declare module 'express-serve-static-core' {
  interface Request {
    upload?: Upload;
    uploads?: Upload[];
  }
}

function startsWith(signature: Buffer): (data: Buffer) => boolean {
  return (data) => data.subarray(0, signature.length).equals(signature);
}

const utf8 = new TextDecoder('utf-8', { fatal: true });

function isUtf8(data: Buffer): boolean {
  try {
    utf8.decode(data);
    return true;
  } catch {
    return false;
  }
}

const RIFF = Buffer.from('RIFF');
const WEBP_TAG = Buffer.from('WEBP');

// RIFF, then the 4-byte chunk size, then WEBP.
function isWebp(data: Buffer): boolean {
  return data.subarray(0, 4).equals(RIFF) && data.subarray(8, 12).equals(WEBP_TAG);
}

const MARKDOWN: FileType = { mime: 'text/markdown', maxSize: 1 * MB, matches: isUtf8 };
const PDF: FileType = {
  mime: 'application/pdf',
  maxSize: 20 * MB,
  matches: startsWith(Buffer.from('%PDF-')),
};
const PNG: FileType = {
  mime: 'image/png',
  maxSize: 10 * MB,
  matches: startsWith(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
};
const JPEG: FileType = {
  mime: 'image/jpeg',
  maxSize: 10 * MB,
  matches: startsWith(Buffer.from([0xff, 0xd8, 0xff])),
};
const WEBP: FileType = { mime: 'image/webp', maxSize: 10 * MB, matches: isWebp };

// Lesson file and homework instructions.
export const LESSON_FILE_TYPES: FileTypes = { '.md': MARKDOWN, '.pdf': PDF };

// Draw and math pages.
export const DRAW_PAGE_TYPES: FileTypes = { '.png': PNG };

// Photo pages.
export const PHOTO_PAGE_TYPES: FileTypes = {
  '.jpg': JPEG,
  '.jpeg': JPEG,
  '.png': PNG,
  '.webp': WEBP,
};

function invalidFile(path: string, message: string): AppError {
  return new AppError('VALIDATION_ERROR', 'Invalid upload', [{ path, message }]);
}

// Everything that can be judged from the name alone, so it runs before any bytes arrive.
function typeForName(name: string, types: FileTypes, path: string): FileType {
  if (CONTROL_CHARACTERS.test(name)) {
    throw invalidFile(path, 'File name contains control characters');
  }
  if (name.length > MAX_NAME_LENGTH) {
    throw invalidFile(path, `File name is longer than ${MAX_NAME_LENGTH} characters`);
  }

  const extension = extname(name).toLowerCase();

  if (!Object.hasOwn(types, extension)) {
    throw new AppError(
      'UNSUPPORTED_MEDIA_TYPE',
      `Allowed file types: ${Object.keys(types).join(', ')}`,
    );
  }

  return types[extension] as FileType;
}

// Name, size, then content. `path` names the file in VALIDATION_ERROR details.
export function checkFile(
  file: { originalname: string; buffer: Buffer } | undefined,
  types: FileTypes,
  path = 'file',
): Upload {
  if (!file) {
    throw invalidFile(path, 'Required');
  }

  const type = typeForName(file.originalname, types, path);
  const size = file.buffer.length;

  if (size === 0) {
    throw invalidFile(path, 'Empty file');
  }
  if (size > type.maxSize) {
    throw new AppError('PAYLOAD_TOO_LARGE', `A ${type.mime} file may be at most ${type.maxSize} bytes`);
  }
  if (!type.matches(file.buffer)) {
    throw new AppError('UNSUPPORTED_MEDIA_TYPE', `The content is not ${type.mime}`);
  }

  return { originalName: file.originalname, mime: type.mime, size, data: file.buffer };
}

type IsCapError = (err: multer.MulterError) => boolean;

function toAppError(err: unknown, isCapError: IsCapError): AppError {
  if (err instanceof AppError) {
    return err;
  }

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

// Browsers send file names as raw UTF-8; multer would read them as latin1 and garble
// anything outside ASCII.
const FILE_NAME_CHARSET = 'utf8';

function largestSize(types: FileTypes): number {
  return Math.max(...Object.values(types).map((type) => type.maxSize));
}

// Rejects a bad name or extension as soon as the part header arrives; multer then drains
// the rest of the body without keeping it.
function fileFilterFor(types: FileTypes, path: string): multer.Options['fileFilter'] {
  return (_req, file, accept) => {
    try {
      typeForName(file.originalname, types, path);
      accept(null, true);
    } catch (err) {
      accept(err as Error);
    }
  };
}

// One file in the field `file`, checked against `types`, and put on req.upload.
export function createFileUpload({ types }: { types: FileTypes }): RequestHandler {
  const upload = withAppErrors(
    multer({
      storage: multer.memoryStorage(),
      limits: { fileSize: largestSize(types), files: 1, fields: 0 },
      defParamCharset: FILE_NAME_CHARSET,
      fileFilter: fileFilterFor(types, 'file'),
    }).single('file'),
    () => false,
  );

  return (req, res, next) => {
    upload(req, res, (err?: unknown) => {
      if (err) {
        next(err);
        return;
      }

      try {
        req.upload = checkFile(req.file, types);
        next();
      } catch (checkErr) {
        next(checkErr);
      }
    });
  };
}

export function getUpload(req: Request): Upload {
  if (!req.upload) {
    throw new Error('getUpload called on a route without a file upload');
  }

  return req.upload;
}

export function getUploads(req: Request): Upload[] {
  if (!req.uploads) {
    throw new Error('getUploads called on a route without a pages upload');
  }

  return req.uploads;
}

// 1 to `maxPages` files in the repeated field `pages`, in upload order, each checked against
// `types`, and put on req.uploads. A page too many is LIMIT_REACHED (contract 2.7).
export function createPagesUpload({
  types,
  maxPages,
}: {
  types: FileTypes;
  maxPages: number;
}): RequestHandler {
  const upload = withAppErrors(
    multer({
      storage: multer.memoryStorage(),
      limits: { fileSize: largestSize(types), files: maxPages, fields: 0 },
      defParamCharset: FILE_NAME_CHARSET,
      fileFilter: fileFilterFor(types, 'pages'),
    }).array('pages', maxPages),
    ({ code, field }) =>
      code === 'LIMIT_FILE_COUNT' || (code === 'LIMIT_UNEXPECTED_FILE' && field === 'pages'),
  );

  return (req, res, next) => {
    upload(req, res, (err?: unknown) => {
      if (err) {
        next(err);
        return;
      }

      try {
        const files = Array.isArray(req.files) ? req.files : [];

        if (files.length === 0) {
          throw invalidFile('pages', 'Required');
        }

        req.uploads = files.map((file, index) => checkFile(file, types, `pages.${index}`));
        next();
      } catch (checkErr) {
        next(checkErr);
      }
    });
  };
}

const MAX_PAGES = 9;

export const uploadLessonFile = createFileUpload({ types: LESSON_FILE_TYPES });

// Draw and math pages share their rules (math is stored exactly like draw, contract 3).
export const uploadDrawPages = createPagesUpload({ types: DRAW_PAGE_TYPES, maxPages: MAX_PAGES });

export const uploadPhotoPages = createPagesUpload({ types: PHOTO_PAGE_TYPES, maxPages: MAX_PAGES });
