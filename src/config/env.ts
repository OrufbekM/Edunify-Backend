import { isAbsolute } from 'node:path';

import { z } from 'zod';

// Contract section 11: the process exits on any missing or invalid value.
const envSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'production', 'test']),
    PORT: z.coerce.number().int().min(1).max(65535).default(3000),
    DATABASE_URL: z.url({ protocol: /^postgres(ql)?$/ }),
    JWT_ACCESS_SECRET: z.string().min(32),
    FILE_URL_SECRET: z.string().min(32),
    STORAGE_DIR: z.string().refine(isAbsolute, 'Must be an absolute path'),
    // An empty value counts as unset, so `ANTHROPIC_API_KEY=` in .env turns AI grading off.
    ANTHROPIC_API_KEY: z
      .string()
      .optional()
      .transform((key) => key || undefined),
    AI_MODEL: z.string().min(1),
  })
  .refine((env) => env.FILE_URL_SECRET !== env.JWT_ACCESS_SECRET, {
    path: ['FILE_URL_SECRET'],
    message: 'Must be different from JWT_ACCESS_SECRET',
  });

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  // Not the pino logger: it reads its settings from this module.
  console.error(`Invalid environment:\n${z.prettifyError(parsed.error)}`);
  process.exit(1);
}

export const env = parsed.data;
