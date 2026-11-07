import { z } from 'zod';

import { publicIdSchema, trimmedString, uuidSchema } from '../../lib/validation.js';

const fullName = trimmedString(1, 100);

export const classParams = z.strictObject({ classId: uuidSchema });

export const classStudentParams = z.strictObject({ classId: uuidSchema, id: uuidSchema });

// null means "no ID", as it does in ClassStudent and in PATCH (contract 8.4).
export const addStudentBody = z.strictObject({
  fullName,
  studentPublicId: publicIdSchema.nullable().optional(),
});

// An absent studentPublicId leaves the link alone; null unlinks (contract 6.3).
export const updateStudentBody = z.strictObject({
  fullName: fullName.optional(),
  studentPublicId: publicIdSchema.nullable().optional(),
});

export const claimBody = z.strictObject({ classPublicId: publicIdSchema });
