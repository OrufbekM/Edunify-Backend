import { randomInt } from 'node:crypto';

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

export async function generateUniquePublicId(
  isTaken: (candidate: string) => boolean | Promise<boolean>,
  maxAttempts = 5,
): Promise<string> {
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const candidate = generatePublicId();
    if (!(await isTaken(candidate))) {
      return candidate;
    }
  }

  throw new Error(`No free public ID after ${maxAttempts} attempts`);
}
