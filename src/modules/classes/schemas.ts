import { z } from 'zod';

import { trimmedString, uuidSchema } from '../../lib/validation.js';

const name = trimmedString(1, 80);

export const listClassesQuery = z.strictObject({ categoryId: uuidSchema.optional() });

export const createClassBody = z.strictObject({ categoryId: uuidSchema, name });

// `linkedClassIds` (contract 8.3) comes with class groups in plan Phase 17; until then it is
// an unknown field.
export const updateClassBody = z.strictObject({
  categoryId: uuidSchema.optional(),
  name: name.optional(),
  order: z.number().int().min(0).optional(),
});
