import { z } from 'zod';

import { ROLES } from '../../db/models/enums.js';
import { trimmedString } from '../../lib/validation.js';

const email = z.string().trim().toLowerCase().max(254).pipe(z.email());

// Not trimmed (plan open item 4): spaces are part of the password the user typed.
const password = z.string().min(8).max(128);

const fullName = trimmedString(1, 100);

export const registerBody = z.strictObject({ role: z.enum(ROLES), fullName, email, password });

export const loginBody = z.strictObject({ email, password });

export const updateMeBody = z.strictObject({ fullName });

export const changePasswordBody = z.strictObject({
  currentPassword: password,
  newPassword: password,
});

// Refresh and logout read only the cookie; a body, if one is sent, must be empty.
export const noBody = z.strictObject({}).optional();
