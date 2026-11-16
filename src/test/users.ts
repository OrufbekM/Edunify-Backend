import { randomUUID } from 'node:crypto';

import request from 'supertest';

import { app } from '../app.js';
import type { Role, UserStatus } from '../db/models/enums.js';
import { User } from '../db/models/index.js';
import { generatePublicId } from '../lib/publicId.js';
import { signAccessToken } from '../lib/tokens.js';

export interface TestUser {
  id: string;
  role: Role;
  token: string;
  email: string | null;
  login: string | null;
  publicId: string | null;
}

export interface TestUserOptions {
  status?: UserStatus;
  mustChangePassword?: boolean;
  // An argon2 hash, for tests that sign in with a password.
  passwordHash?: string;
}

export const TEST_PHONE = '+998901234567';

// Writes the account straight to the database, skipping argon2 and the register rate limit.
// The name splits at its first space into first and last name. Accounts are active unless
// `status` says otherwise; there can be only one admin at a time.
export async function createTestUser(
  role: Role,
  name = `Test ${role}`,
  options: TestUserOptions = {},
): Promise<TestUser> {
  const space = name.indexOf(' ');
  const user = await User.create({
    role,
    firstName: space < 0 ? name : name.slice(0, space),
    lastName: space < 0 ? '' : name.slice(space + 1),
    email: role === 'admin' ? null : `${randomUUID()}@example.com`,
    phone: role === 'teacher' ? TEST_PHONE : null,
    login: role === 'admin' ? `admin_${randomUUID().slice(0, 8)}` : null,
    passwordHash: options.passwordHash ?? 'not-a-real-hash',
    publicId: role === 'student' ? generatePublicId() : null,
    status: options.status ?? 'active',
    mustChangePassword: options.mustChangePassword ?? false,
  });

  return {
    id: user.id,
    role,
    token: signAccessToken(user),
    email: user.email,
    login: user.login,
    publicId: user.publicId,
  };
}

// Requests to the real app as `user`; with no user, requests go out unauthenticated.
export function api(user?: TestUser) {
  const sign = (pending: request.Test) =>
    user ? pending.set('Authorization', `Bearer ${user.token}`) : pending;

  return {
    get: (path: string) => sign(request(app).get(path)),
    post: (path: string, body: object = {}) => sign(request(app).post(path)).send(body),
    put: (path: string, body: object = {}) => sign(request(app).put(path)).send(body),
    patch: (path: string, body: object = {}) => sign(request(app).patch(path)).send(body),
    delete: (path: string) => sign(request(app).delete(path)),
    // A multipart PUT with one file in the field `file`.
    upload: (path: string, content: Buffer, filename: string) =>
      sign(request(app).put(path)).attach('file', content, filename),
  };
}
