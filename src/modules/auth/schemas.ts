import { z } from 'zod';

import { trimmedString } from '../../lib/validation.js';

const email = z.string().trim().toLowerCase().max(254).pipe(z.email());

// Not trimmed (contract 2.6): spaces are part of the password the user typed.
const password = z.string().min(8).max(128);

// Contract 2.6: first and last name, 1-50 each.
const name = trimmedString(1, 50);

// Contract 2.6: spaces, dashes and parentheses are removed, then it must be the full
// international number with +. It is stored in that form.
const phone = z
  .string()
  .overwrite((value) => value.replace(/[\s()-]/g, ''))
  .regex(/^\+[1-9]\d{7,14}$/, 'Must be the full international number with +, like +998901234567');

// Contract 2.6: the admin's login, lowercased, 3-40 of a-z, 0-9 and _.
export const adminLoginName = z
  .string()
  .trim()
  .toLowerCase()
  .min(3)
  .max(40)
  .regex(/^[a-z0-9_]+$/, 'Only a-z, 0-9 and _');

const registerFields = { firstName: name, lastName: name, email, password, confirmPassword: z.string() };

// Contract 8.1: teachers give a phone, students don't, and nobody registers as the admin.
export const registerBody = z
  .discriminatedUnion('role', [
    z.strictObject({ role: z.literal('teacher'), ...registerFields, phone }),
    z.strictObject({ role: z.literal('student'), ...registerFields }),
  ])
  .refine((body) => body.confirmPassword === body.password, {
    path: ['confirmPassword'],
    message: 'Must match password',
  });

export const loginBody = z.strictObject({ role: z.enum(['teacher', 'student']), email, password });

export const adminLoginBody = z.strictObject({ login: adminLoginName, password });

// Whether the caller may have a phone is the service's call: only teachers do.
export const updateMeBody = z.strictObject({
  firstName: name.optional(),
  lastName: name.optional(),
  phone: phone.optional(),
});

export const changePasswordBody = z
  .strictObject({ currentPassword: password, newPassword: password, confirmNewPassword: z.string() })
  .refine((body) => body.confirmNewPassword === body.newPassword, {
    path: ['confirmNewPassword'],
    message: 'Must match newPassword',
  });

// Refresh and logout read only the cookie; a body, if one is sent, must be empty.
export const noBody = z.strictObject({}).optional();
