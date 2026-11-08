import { z } from 'zod';

import { HOMEWORK_TYPES } from '../../db/models/enums.js';
import { optionalText, trimmedString, uuidSchema } from '../../lib/validation.js';

const title = trimmedString(1, 120);

// The target 0-based index (contract 8.6). The upper bound depends on the group, so the
// service checks it.
const order = z.int().min(0);

// null means the no-unit group, as it does in PATCH (contract 8.6).
const unitId = uuidSchema.nullable();

export const classParams = z.strictObject({ classId: uuidSchema });

export const createUnitBody = z.strictObject({ title });

export const updateUnitBody = z.strictObject({
  title: title.optional(),
  order: order.optional(),
});

export const createLessonBody = z.strictObject({ title, unitId: unitId.optional() });

export const updateLessonBody = z.strictObject({
  title: title.optional(),
  unitId: unitId.optional(),
  order: order.optional(),
});

// Empty after trimming, or absent, means no instructions text (contract 2.6, plan open item 6).
export const putHomeworkBody = z.strictObject({
  type: z.enum(HOMEWORK_TYPES),
  instructionsText: optionalText(10_000),
});
