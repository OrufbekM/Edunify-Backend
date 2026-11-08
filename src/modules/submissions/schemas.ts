import { z } from 'zod';

import { trimmedString, uuidSchema } from '../../lib/validation.js';

export const homeworkParams = z.strictObject({ homeworkId: uuidSchema });

export const textSubmissionBody = z.strictObject({ text: trimmedString(1, 20_000) });

// Each 0-100 000 after trimming, and at least one with content (contract 2.6).
const code = z.string().trim().max(100_000);

export const codeSubmissionBody = z
  .strictObject({ html: code, css: code, js: code })
  .refine((body) => body.html !== '' || body.css !== '' || body.js !== '', {
    message: 'At least one of html, css and js must have content',
  });

export const studentSubmissionsQuery = z.strictObject({ classId: uuidSchema.optional() });
