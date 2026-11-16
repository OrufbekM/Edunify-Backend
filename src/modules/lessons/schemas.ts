import { z } from 'zod';

import { HOMEWORK_TYPES } from '../../db/models/enums.js';
import { optionalText, trimmedString, uuidSchema } from '../../lib/validation.js';

const title = trimmedString(1, 120);

// The target 0-based index (contract 8.6). The upper bound depends on the list, so the
// service checks it.
const order = z.int().min(0);

export const classParams = z.strictObject({ classId: uuidSchema });

// scope=class (the default) removes the lesson from this class; scope=all deletes a linked
// lesson everywhere (contract 8.6).
export const deleteLessonQuery = z.strictObject({
  classId: uuidSchema,
  scope: z.enum(['class', 'all']).default('class'),
});

export const createUnitBody = z.strictObject({ title });

export const updateUnitBody = z.strictObject({
  title: title.optional(),
  order: order.optional(),
});

// Every lesson sits in a unit of its class (contract 8.6).
export const createLessonBody = z.strictObject({
  title,
  unitId: uuidSchema,
  linked: z.boolean().optional(),
});

export const updateLessonBody = z.strictObject({
  title: title.optional(),
  unitId: uuidSchema.optional(),
  order: order.optional(),
  linked: z.boolean().optional(),
  visible: z.boolean().optional(),
});

// Empty after trimming, or absent, means no instructions text (contract 2.6, plan open item 6).
export const putHomeworkBody = z.strictObject({
  type: z.enum(HOMEWORK_TYPES),
  instructionsText: optionalText(10_000),
});
