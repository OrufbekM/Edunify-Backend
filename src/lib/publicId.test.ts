import { describe, expect, it, vi } from 'vitest';

import {
  generatePublicId,
  generateUniquePublicId,
  isValidPublicId,
  normalizePublicId,
} from './publicId.js';

describe('generatePublicId', () => {
  it('returns 8 characters from a-z0-9', () => {
    for (let i = 0; i < 1000; i += 1) {
      expect(generatePublicId()).toMatch(/^[a-z0-9]{8}$/);
    }
  });

  it('draws from the whole alphabet', () => {
    const characters = new Set(Array.from({ length: 2000 }, () => generatePublicId()).join(''));
    expect(characters.size).toBe(36);
  });
});

describe('normalizePublicId', () => {
  it.each([
    ['#AB12-cd34', 'ab12cd34'],
    ['  #ab12-CD34\n', 'ab12cd34'],
    ['ab12cd34', 'ab12cd34'],
    ['#-AB#12--CD-34#', 'ab12cd34'],
    ['', ''],
  ])('turns %j into %j', (input, expected) => {
    expect(normalizePublicId(input)).toBe(expected);
  });
});

describe('isValidPublicId', () => {
  it('accepts 8 lowercase letters or digits', () => {
    expect(isValidPublicId('ab12cd34')).toBe(true);
  });

  it.each(['ab12cd3', 'ab12cd345', 'AB12CD34', '#b12cd34', 'ab12-d34', 'ab12cd34\n', ''])(
    'rejects %j',
    (value) => {
      expect(isValidPublicId(value)).toBe(false);
    },
  );
});

describe('generateUniquePublicId', () => {
  it('returns the first free candidate', async () => {
    const isTaken = vi.fn().mockResolvedValue(false);

    await expect(generateUniquePublicId(isTaken)).resolves.toMatch(/^[a-z0-9]{8}$/);
    expect(isTaken).toHaveBeenCalledTimes(1);
  });

  it('retries with a new candidate until one is free', async () => {
    const isTaken = vi
      .fn<(candidate: string) => Promise<boolean>>()
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(true)
      .mockResolvedValue(false);

    const id = await generateUniquePublicId(isTaken);

    expect(isTaken).toHaveBeenCalledTimes(5);
    expect(isTaken).toHaveBeenLastCalledWith(id);
  });

  it('throws after 5 taken candidates', async () => {
    const isTaken = vi.fn().mockResolvedValue(true);

    await expect(generateUniquePublicId(isTaken)).rejects.toThrow('No free public ID');
    expect(isTaken).toHaveBeenCalledTimes(5);
  });

  it('honours a custom attempt limit and a synchronous check', async () => {
    const isTaken = vi.fn().mockReturnValue(true);

    await expect(generateUniquePublicId(isTaken, 2)).rejects.toThrow('after 2 attempts');
    expect(isTaken).toHaveBeenCalledTimes(2);
  });

  it('lets a failing check propagate', async () => {
    const isTaken = vi.fn().mockRejectedValue(new Error('database down'));

    await expect(generateUniquePublicId(isTaken)).rejects.toThrow('database down');
  });
});
