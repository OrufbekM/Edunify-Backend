import { describe, expect, it } from 'vitest';

import { AppError, type ErrorCode } from './errors.js';

const CONTRACT_STATUSES: Record<ErrorCode, number> = {
  VALIDATION_ERROR: 400,
  UNAUTHENTICATED: 401,
  TOKEN_EXPIRED: 401,
  INVALID_CREDENTIALS: 401,
  FORBIDDEN: 403,
  FILE_URL_INVALID: 403,
  NOT_FOUND: 404,
  STUDENT_ID_NOT_FOUND: 404,
  CLASS_ID_NOT_FOUND: 404,
  EMAIL_TAKEN: 409,
  CATEGORY_NAME_TAKEN: 409,
  CATEGORY_NOT_EMPTY: 409,
  STUDENT_ID_IN_USE: 409,
  HOMEWORK_TYPE_LOCKED: 409,
  SUBMISSION_NOT_LATEST: 409,
  AI_JOB_ACTIVE: 409,
  LIMIT_REACHED: 409,
  PAYLOAD_TOO_LARGE: 413,
  UNSUPPORTED_MEDIA_TYPE: 415,
  RATE_LIMITED: 429,
  AI_UNAVAILABLE: 503,
  INTERNAL: 500,
};

const codes = Object.keys(CONTRACT_STATUSES) as ErrorCode[];

describe('AppError', () => {
  it.each(codes)('gives %s its contract status and a default message', (code) => {
    const error = new AppError(code);

    expect(error.status).toBe(CONTRACT_STATUSES[code]);
    expect(error.message).not.toBe('');
  });

  it('prefers the given message', () => {
    expect(new AppError('NOT_FOUND', 'Route not found').message).toBe('Route not found');
  });

  it('carries details, with or without a message', () => {
    const details = { jobId: 'job-1' };

    expect(new AppError('AI_JOB_ACTIVE', 'Job running', details).details).toBe(details);
    expect(new AppError('AI_JOB_ACTIVE', undefined, details).details).toBe(details);
  });

  it('has no details by default', () => {
    expect(new AppError('FORBIDDEN').details).toBeUndefined();
  });

  it('is an Error with its code', () => {
    const error = new AppError('FORBIDDEN');

    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe('AppError');
    expect(error.code).toBe('FORBIDDEN');
  });
});
