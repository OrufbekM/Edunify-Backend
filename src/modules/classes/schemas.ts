import { z } from 'zod';

import { trimmedString, uuidSchema } from '../../lib/validation.js';

const name = trimmedString(1, 80);

export const listClassesQuery = z.strictObject({ categoryId: uuidSchema.optional() });

export const createClassBody = z.strictObject({ categoryId: uuidSchema, name });

// The other classes of the group after the save (contract 2.6 and 8.3): 0-9 distinct ids.
// That they are the teacher's own and not the class itself is the service's to check.
const linkedClassIds = z
  .array(uuidSchema)
  .max(9)
  .refine((ids) => new Set(ids).size === ids.length, { message: 'Ids must be distinct' });

export const updateClassBody = z.strictObject({
  categoryId: uuidSchema.optional(),
  name: name.optional(),
  order: z.number().int().min(0).optional(),
  linkedClassIds: linkedClassIds.optional(),
});

export const previewLinkedClassesBody = z.strictObject({ linkedClassIds });
