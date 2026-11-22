import { z } from 'zod';

import { trimmedString } from '../../lib/validation.js';

const name = trimmedString(1, 60);

export const createCategoryBody = z.strictObject({ name });

// `order` is the target 0-based index among the teacher's categories (contract 8.2).
export const updateCategoryBody = z.strictObject({
  name: name.optional(),
  order: z.number().int().min(0).optional(),
});
