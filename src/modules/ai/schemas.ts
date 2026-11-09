import { z } from 'zod';

import { uuidSchema } from '../../lib/validation.js';

// One latest version per student, and a class has at most 200 students (contract 2.7).
const MAX_SUBMISSION_IDS = 200;

export const lessonParams = z.strictObject({ lessonId: uuidSchema });

// Omitted means every latest submission still waiting for a grade (contract 8.11); a body
// may be left out altogether. Ids are compared lowercased, so one id can't appear twice.
export const aiGradeBody = z
  .strictObject({
    submissionIds: z
      .array(uuidSchema.transform((id) => id.toLowerCase()))
      .min(1)
      .max(MAX_SUBMISSION_IDS)
      .optional(),
  })
  .superRefine(({ submissionIds = [] }, ctx) => {
    submissionIds.forEach((id, index) => {
      if (submissionIds.indexOf(id) !== index) {
        ctx.addIssue({ code: 'custom', path: ['submissionIds', index], message: 'Duplicate id' });
      }
    });
  })
  .optional()
  .transform((body) => body ?? {});
