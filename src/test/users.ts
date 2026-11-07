import { randomUUID } from 'node:crypto';

import request from 'supertest';

import { app } from '../app.js';
import type { Role } from '../db/models/enums.js';
import { User } from '../db/models/index.js';
import { generatePublicId } from '../lib/publicId.js';
import { signAccessToken } from '../lib/tokens.js';

export interface TestUser {
  id: string;
  role: Role;
  token: string;
}

// Writes the account straight to the database, skipping argon2 and the register rate limit.
export async function createTestUser(role: Role): Promise<TestUser> {
  const user = await User.create({
    role,
    fullName: `Test ${role}`,
    email: `${randomUUID()}@example.com`,
    passwordHash: 'not-a-real-hash',
    publicId: role === 'student' ? generatePublicId() : null,
  });

  return { id: user.id, role, token: signAccessToken(user) };
}

// Requests to the real app as `user`; with no user, requests go out unauthenticated.
export function api(user?: TestUser) {
  const sign = (pending: request.Test) =>
    user ? pending.set('Authorization', `Bearer ${user.token}`) : pending;

  return {
    get: (path: string) => sign(request(app).get(path)),
    post: (path: string, body: object = {}) => sign(request(app).post(path)).send(body),
    patch: (path: string, body: object = {}) => sign(request(app).patch(path)).send(body),
    delete: (path: string) => sign(request(app).delete(path)),
  };
}
