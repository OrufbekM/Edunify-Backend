import { randomInt } from 'node:crypto';

import type { UniqueConstraintError } from 'sequelize';

const ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789';
const LENGTH = 8;
const PATTERN = /^[a-z0-9]{8}$/;

export function generatePublicId(): string {
  let id = '';
  for (let i = 0; i < LENGTH; i += 1) {
    id += ALPHABET[randomInt(ALPHABET.length)];
  }
  return id;
}

export function normalizePublicId(input: string): string {
  return input.trim().toLowerCase().replace(/[#-]/g, '');
}

export function isValidPublicId(value: string): boolean {
  return PATTERN.test(value);
}

function isPublicIdCollision(err: unknown): boolean {
  return (
    err instanceof Error &&
    err.name === 'SequelizeUniqueConstraintError' &&
    'public_id' in (err as UniqueConstraintError).fields
  );
}

// A failed insert aborts its transaction, so `insert` must open its own on every call.
export async function insertWithPublicId<T>(
  insert: (publicId: string) => Promise<T>,
  maxRetries = 5,
): Promise<T> {
  for (let retries = 0; ; retries += 1) {
    try {
      return await insert(generatePublicId());
    } catch (err) {
      if (retries === maxRetries || !isPublicIdCollision(err)) {
        throw err;
      }
    }
  }
}
