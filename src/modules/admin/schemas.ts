import { z } from 'zod';

import { USER_STATUSES } from '../../db/models/enums.js';

// Contract 8.14. Query values arrive as strings, so the numbers are coerced.
export const listUsersQuery = z.strictObject({
  role: z.enum(['teacher', 'student']).optional(),
  status: z.enum(USER_STATUSES).optional(),
  // Empty after trimming counts as no search.
  q: z
    .string()
    .trim()
    .max(100)
    .optional()
    .transform((value) => value || undefined),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

// Contract 8.14: the admin can approve or unblock (active) and reject or block (blocked);
// nobody is ever put back to pending.
export const setStatusBody = z.strictObject({ status: z.enum(['active', 'blocked']) });

// The reset takes no input; a body, if one is sent, must be empty.
export const noBody = z.strictObject({}).optional();
