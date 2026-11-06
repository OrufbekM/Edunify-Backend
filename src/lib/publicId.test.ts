import { UniqueConstraintError } from 'sequelize';
import { describe, expect, it, vi } from 'vitest';

import {
  generatePublicId,
  insertWithPublicId,
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

describe('insertWithPublicId', () => {
  const collision = () => new UniqueConstraintError({ fields: { public_id: 'ab12cd34' } });

  it('hands the insert a generated ID and returns its result', async () => {
    const insert = vi.fn(async (publicId: string) => ({ publicId }));

    const row = await insertWithPublicId(insert);

    expect(row.publicId).toMatch(/^[a-z0-9]{8}$/);
    expect(insert).toHaveBeenCalledTimes(1);
  });

  it('retries with a new ID after a collision', async () => {
    const insert = vi
      .fn<(publicId: string) => Promise<string>>()
      .mockRejectedValueOnce(collision())
      .mockResolvedValue('inserted');

    await expect(insertWithPublicId(insert)).resolves.toBe('inserted');

    expect(insert).toHaveBeenCalledTimes(2);
    expect(insert.mock.calls[0]?.[0]).not.toBe(insert.mock.calls[1]?.[0]);
  });

  it('succeeds on the fifth retry', async () => {
    const insert = vi.fn<(publicId: string) => Promise<string>>();
    for (let i = 0; i < 5; i += 1) {
      insert.mockRejectedValueOnce(collision());
    }
    insert.mockResolvedValue('inserted');

    await expect(insertWithPublicId(insert)).resolves.toBe('inserted');
    expect(insert).toHaveBeenCalledTimes(6);
  });

  it('gives up after 5 retries with the collision itself', async () => {
    const insert = vi.fn().mockRejectedValue(collision());

    await expect(insertWithPublicId(insert)).rejects.toBeInstanceOf(UniqueConstraintError);
    expect(insert).toHaveBeenCalledTimes(6);
  });

  it('honours a custom retry limit', async () => {
    const insert = vi.fn().mockRejectedValue(collision());

    await expect(insertWithPublicId(insert, 2)).rejects.toBeInstanceOf(UniqueConstraintError);
    expect(insert).toHaveBeenCalledTimes(3);
  });

  it('does not retry a collision on another column', async () => {
    const taken = new UniqueConstraintError({ fields: { email: 'a@b.co' } });
    const insert = vi.fn().mockRejectedValue(taken);

    await expect(insertWithPublicId(insert)).rejects.toBe(taken);
    expect(insert).toHaveBeenCalledTimes(1);
  });

  it('does not retry any other error', async () => {
    const insert = vi.fn().mockRejectedValue(new Error('database down'));

    await expect(insertWithPublicId(insert)).rejects.toThrow('database down');
    expect(insert).toHaveBeenCalledTimes(1);
  });
});
