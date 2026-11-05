// Values must match contract section 3 exactly; the migrations repeat them as literals
// so that a historical migration never changes when this file does.

export const ROLES = ['teacher', 'student'] as const;
export type Role = (typeof ROLES)[number];

// math is rendered and stored exactly like draw.
export const HOMEWORK_TYPES = ['text', 'draw', 'math', 'code', 'photo'] as const;
export type HomeworkType = (typeof HOMEWORK_TYPES)[number];

export const SUBMISSION_STATUSES = ['submitted', 'denied', 'graded'] as const;
export type SubmissionStatus = (typeof SUBMISSION_STATUSES)[number];

export const NOTIFICATION_KINDS = ['graded', 'denied', 'submitted'] as const;
export type NotificationKind = (typeof NOTIFICATION_KINDS)[number];

export const JOB_STATUSES = ['queued', 'running', 'done', 'failed'] as const;
export type JobStatus = (typeof JOB_STATUSES)[number];

export const FILE_KINDS = ['lesson', 'instructions', 'page'] as const;
export type FileKind = (typeof FILE_KINDS)[number];

export const GRADE_SOURCES = ['teacher', 'ai_confirmed'] as const;
export type GradeSource = (typeof GRADE_SOURCES)[number];
