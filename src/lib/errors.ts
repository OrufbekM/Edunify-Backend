// Contract section 10.
const ERRORS = {
  VALIDATION_ERROR: { status: 400, message: 'Invalid body, query, params, or upload content' },
  UNAUTHENTICATED: { status: 401, message: 'Missing, invalid, or revoked credentials' },
  TOKEN_EXPIRED: { status: 401, message: 'Access token expired' },
  INVALID_CREDENTIALS: { status: 401, message: 'Wrong email, password, or current password' },
  FORBIDDEN: { status: 403, message: 'The role may not use this endpoint' },
  FILE_URL_INVALID: { status: 403, message: 'Signed file URL is invalid or expired' },
  NOT_FOUND: { status: 404, message: 'Does not exist or the caller cannot see it' },
  STUDENT_ID_NOT_FOUND: { status: 404, message: 'No student with that public ID' },
  CLASS_ID_NOT_FOUND: { status: 404, message: 'No class with that public ID' },
  EMAIL_TAKEN: { status: 409, message: 'Email already registered' },
  CATEGORY_NAME_TAKEN: { status: 409, message: 'Teacher already has a category with this name' },
  CATEGORY_NOT_EMPTY: { status: 409, message: 'Category still contains classes' },
  STUDENT_ID_IN_USE: { status: 409, message: 'That account already has a row in this class' },
  HOMEWORK_TYPE_LOCKED: { status: 409, message: 'Type cannot change once submissions exist' },
  SUBMISSION_NOT_LATEST: { status: 409, message: 'Only the latest version can be graded' },
  AI_JOB_ACTIVE: { status: 409, message: 'A job for this lesson is already running' },
  LIMIT_REACHED: { status: 409, message: 'A cap from contract section 2.7 was hit' },
  PAYLOAD_TOO_LARGE: { status: 413, message: 'Body or file exceeds its limit' },
  UNSUPPORTED_MEDIA_TYPE: { status: 415, message: 'File type not allowed' },
  RATE_LIMITED: { status: 429, message: 'Too many requests' },
  INTERNAL: { status: 500, message: 'Unexpected error' },
  AI_UNAVAILABLE: { status: 503, message: 'AI grading is not configured' },
} as const;

export type ErrorCode = keyof typeof ERRORS;

export class AppError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  readonly details: unknown;

  constructor(code: ErrorCode, message?: string, details?: unknown) {
    super(message ?? ERRORS[code].message);
    this.name = 'AppError';
    this.code = code;
    this.status = ERRORS[code].status;
    this.details = details;
  }
}
