// Contract section 10.
const ERROR_STATUS = {
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
  INTERNAL: 500,
  AI_UNAVAILABLE: 503,
} as const;

export type ErrorCode = keyof typeof ERROR_STATUS;

export class AppError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  readonly details: unknown;

  constructor(code: ErrorCode, message: string, details?: unknown) {
    super(message);
    this.name = 'AppError';
    this.code = code;
    this.status = ERROR_STATUS[code];
    this.details = details;
  }
}
