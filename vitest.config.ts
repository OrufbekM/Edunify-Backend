import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    env: {
      NODE_ENV: 'test',
      PORT: '3000',
      DATABASE_URL: 'postgres://user:pass@localhost:5432/unused',
      JWT_ACCESS_SECRET: 'test-only-jwt-access-secret-0123456789abcdef',
      FILE_URL_SECRET: 'test-only-file-url-secret-fedcba9876543210',
      STORAGE_DIR: join(tmpdir(), 'edunify-test-storage'),
      AI_MODEL: 'test-model',
    },
  },
});
