import { afterAll, beforeEach } from 'vitest';

import { env } from '../config/env.js';
import { sequelize } from '../db/index.js';
import { assertTestDatabase } from './assertTestDatabase.js';

export function useTestDatabase(): void {
  assertTestDatabase(env.DATABASE_URL);

  beforeEach(async () => {
    await sequelize.query('TRUNCATE TABLE users CASCADE');
  });

  afterAll(async () => {
    await sequelize.close();
  });
}
