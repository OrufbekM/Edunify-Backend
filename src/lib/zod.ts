import { z } from 'zod';

import { isValidPublicId, normalizePublicId } from './publicId.js';

// Every request body, query and params schema must use z.strictObject:
// contract 2.1 rejects unknown fields with VALIDATION_ERROR.

export function trimmedString(min: number, max: number): z.ZodString {
  return z.string().trim().min(min).max(max);
}

export const uuidSchema = z.uuid();

export const idParamsSchema = z.strictObject({ id: uuidSchema });

export const publicIdSchema = z
  .string()
  .overwrite(normalizePublicId)
  .refine(isValidPublicId, 'Must be 8 letters or digits');
