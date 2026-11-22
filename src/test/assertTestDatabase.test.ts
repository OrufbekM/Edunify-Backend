import { describe, expect, it } from 'vitest';

import { assertTestDatabase } from './assertTestDatabase.js';

describe('assertTestDatabase', () => {
  it.each([
    'postgres://user:pass@localhost:5432/edunify_test',
    'postgresql://user:pass@db.internal/other_test',
    'postgres://user:pass@localhost:5432/edunify_test?sslmode=disable',
  ])('accepts %s', (url) => {
    expect(() => assertTestDatabase(url)).not.toThrow();
  });

  it.each([
    'postgres://user:pass@localhost:5432/edunify',
    'postgres://user:pass@localhost:5432/edunify_test_copy',
    'postgres://user:pass@localhost:5432/test',
    'postgres://user:pass@localhost:5432/edunifytest',
    'postgres://user:pass@localhost:5432/',
    'postgres://edunify_test@localhost:5432/edunify',
    'postgres://user:pass@localhost:5432/edunify?db=edunify_test',
    'not a url',
    '',
    undefined,
  ])('refuses %s', (url) => {
    expect(() => assertTestDatabase(url)).toThrow('must name a database ending in _test');
  });
});
