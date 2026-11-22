import { execFileSync } from 'node:child_process';

import type { TestProject } from 'vitest/node';

import { assertTestDatabase } from './assertTestDatabase.js';

export default function setup(project: TestProject): void {
  const env = { ...process.env, ...project.config.env };

  assertTestDatabase(env.DATABASE_URL);

  execFileSync(process.execPath, ['--import', 'tsx', 'src/db/migrate.ts', 'up'], {
    env,
    stdio: 'pipe',
  });
}
