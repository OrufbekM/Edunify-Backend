import { afterAll, beforeEach } from 'vitest';

import { env } from '../config/env.js';
import { sequelize } from '../db/index.js';
import { assertTestDatabase } from './assertTestDatabase.js';

export function useTestDatabase(): void {
  assertTestDatabase(env.DATABASE_URL);

  beforeEach(async () => {
    // Everything hangs off users except class groups, which classes point at.
    await sequelize.query('TRUNCATE TABLE users, class_groups CASCADE');
  });

  afterAll(async () => {
    await sequelize.close();
  });
}
