import { z } from 'zod';

import { optionalText, trimmedString, uuidSchema } from '../../lib/validation.js';

const subject = trimmedString(1, 80);
const name = optionalText(80);

export const listClassesQuery = z.strictObject({ categoryId: uuidSchema.optional() });

export const createClassBody = z.strictObject({ categoryId: uuidSchema, subject, name });

export const updateClassBody = z.strictObject({
  categoryId: uuidSchema.optional(),
  subject: subject.optional(),
  name,
});
