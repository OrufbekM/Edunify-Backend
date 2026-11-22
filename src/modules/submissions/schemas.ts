import { z } from 'zod';

import { trimmedString, uuidSchema } from '../../lib/validation.js';

export const homeworkParams = z.strictObject({ homeworkId: uuidSchema });

export const textSubmissionBody = z.strictObject({ text: trimmedString(1, 20_000) });

// Code is validated and stored exactly as sent (contract 2.6): each 0-100 000 characters as
// sent, and at least one that isn't empty after trimming.
const code = z.string().max(100_000);

export const codeSubmissionBody = z
  .strictObject({ html: code, css: code, js: code })
  .refine((body) => [body.html, body.css, body.js].some((part) => part.trim() !== ''), {
    message: 'At least one of html, css and js must have content',
  });

export const studentSubmissionsQuery = z.strictObject({ classId: uuidSchema.optional() });
