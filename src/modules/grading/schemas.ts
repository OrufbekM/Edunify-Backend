import { z } from 'zod';

import { uuidSchema } from '../../lib/validation.js';
import type { Grade } from '../submissions/service.js';
import type { GradeInput } from './service.js';

const COMMENT_MAX = 2000;

export const lessonParams = z.strictObject({ lessonId: uuidSchema });

// Exactly one of two bodies (contract 8.9): { value, comment?, fromAi? } or
// { denied: true, comment }. One object with optional keys and a check, not a union, so
// each mistake gets its own path in details. The comment is trimmed (contract 2.6); on a
// grade an empty one becomes null (plan, open item 6), and a denial needs one.
export const gradeBody = z
  .strictObject({
    value: z.int().min(2).max(5).optional(),
    denied: z.literal(true).optional(),
    comment: z.string().trim().max(COMMENT_MAX).optional(),
    fromAi: z.boolean().optional(),
  })
  .superRefine((body, ctx) => {
    if ((body.value === undefined) === (body.denied === undefined)) {
      ctx.addIssue({ code: 'custom', path: [], message: 'Send either value or denied: true' });
      return;
    }

    if (body.denied && !body.comment) {
      ctx.addIssue({ code: 'custom', path: ['comment'], message: 'Required when denying' });
    }

    if (body.denied && body.fromAi !== undefined) {
      ctx.addIssue({ code: 'custom', path: ['fromAi'], message: 'Only allowed with value' });
    }
  })
  .transform(
    (body): GradeInput =>
      body.value === undefined
        ? { status: 'denied', comment: body.comment as string }
        : {
            status: 'graded',
            value: body.value as Grade,
            comment: body.comment || null,
            fromAi: body.fromAi ?? false,
          },
  );
