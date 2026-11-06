import { randomUUID } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { idParamsSchema, publicIdSchema, trimmedString, uuidSchema } from './zod.js';

describe('trimmedString', () => {
  it('trims before checking the length', () => {
    expect(trimmedString(1, 3).parse('  abc  ')).toBe('abc');
  });

  it('treats a whitespace-only value as empty', () => {
    expect(trimmedString(1, 3).safeParse('   ').success).toBe(false);
  });

  it('allows an empty value when min is 0', () => {
    expect(trimmedString(0, 3).parse('   ')).toBe('');
  });

  it('rejects a value over the maximum', () => {
    expect(trimmedString(1, 3).safeParse('abcd').success).toBe(false);
  });
});

describe('uuidSchema', () => {
  it('accepts a generated id', () => {
    const id = randomUUID();
    expect(uuidSchema.parse(id)).toBe(id);
  });

  it.each(['not-a-uuid', '', '123'])('rejects %j', (value) => {
    expect(uuidSchema.safeParse(value).success).toBe(false);
  });
});

describe('idParamsSchema', () => {
  it('accepts an id', () => {
    const id = randomUUID();
    expect(idParamsSchema.parse({ id })).toEqual({ id });
  });

  it('reports unknown keys', () => {
    const result = idParamsSchema.safeParse({ id: randomUUID(), extra: 1 });

    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.code).toBe('unrecognized_keys');
  });
});

describe('publicIdSchema', () => {
  it.each([
    ['#AB12-cd34', 'ab12cd34'],
    ['  ab12cd34  ', 'ab12cd34'],
  ])('normalizes %j', (input, expected) => {
    expect(publicIdSchema.parse(input)).toBe(expected);
  });

  it.each(['ab12cd3', 'ab12cd345', 'ab12 cd34', 'ab12cd3!', ''])(
    'gives a normal zod issue for %j',
    (input) => {
      const result = publicIdSchema.safeParse(input);

      expect(result.success).toBe(false);
      expect(result.error?.issues).toHaveLength(1);
      expect(result.error?.issues[0]?.message).toBe('Must be 8 letters or digits');
    },
  );

  it('rejects a value that is not a string', () => {
    expect(publicIdSchema.safeParse(12345678).success).toBe(false);
  });
});
