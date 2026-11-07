import { z } from 'zod';

import { isValidPublicId, normalizePublicId } from './publicId.js';

// Every request body, query and params schema must use z.strictObject:
// contract 2.1 rejects unknown fields with VALIDATION_ERROR.

export function trimmedString(min: number, max: number): z.ZodString {
  return z.string().trim().min(min).max(max);
}

// Accepts a string, null or nothing. Text that is empty after trimming becomes null,
// and an absent key stays absent, so a PATCH can tell "clear it" from "leave it".
export function optionalText(max: number) {
  return z
    .string()
    .trim()
    .max(max)
    .nullable()
    .transform((value) => value || null)
    .optional();
}

export const uuidSchema = z.uuid();

export const idParamsSchema = z.strictObject({ id: uuidSchema });

// For GET routes that take no query parameters: unknown ones are rejected too.
export const emptyQuerySchema = z.strictObject({});

export const publicIdSchema = z
  .string()
  .overwrite(normalizePublicId)
  .refine(isValidPublicId, 'Must be 8 letters or digits');
