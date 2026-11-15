import { isAbsolute } from 'node:path';

import { z } from 'zod';

// The AI services that can grade homework (contract 9).
export const AI_PROVIDERS = ['anthropic', 'gemini', 'openai'] as const;
export type AiProvider = (typeof AI_PROVIDERS)[number];

// An empty value counts as unset, so `GEMINI_API_KEY=` in .env turns that provider off.
const optionalText = z
  .string()
  .optional()
  .transform((value) => value?.trim() || undefined);

const optionalProvider = z
  .string()
  .optional()
  .transform((value) => value?.trim().toLowerCase() || undefined)
  .pipe(z.enum(AI_PROVIDERS).optional());

// Contract section 11: the process exits on any missing or invalid value.
const envSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'production', 'test']),
    PORT: z.coerce.number().int().min(1).max(65535).default(3000),
    DATABASE_URL: z.url({ protocol: /^postgres(ql)?$/ }),
    JWT_ACCESS_SECRET: z.string().min(32),
    FILE_URL_SECRET: z.string().min(32),
    STORAGE_DIR: z.string().refine(isAbsolute, 'Must be an absolute path'),
    // Which AI grades which homework: text and code answers, and page images (draw, math,
    // photo). Both default to anthropic. The fallback is tried when the first one fails.
    AI_PROVIDER_TEXT: optionalProvider,
    AI_PROVIDER_IMAGE: optionalProvider,
    AI_FALLBACK_PROVIDER: optionalProvider,
    // Without its key a provider is off; with no provider left for a homework type, AI grading
    // answers AI_UNAVAILABLE.
    ANTHROPIC_API_KEY: optionalText,
    GEMINI_API_KEY: optionalText,
    OPENAI_API_KEY: optionalText,
    ANTHROPIC_MODEL: optionalText,
    GEMINI_MODEL: optionalText,
    OPENAI_MODEL: optionalText,
  })
  .superRefine((env, ctx) => {
    if (env.FILE_URL_SECRET === env.JWT_ACCESS_SECRET) {
      ctx.addIssue({
        code: 'custom',
        path: ['FILE_URL_SECRET'],
        message: 'Must be different from JWT_ACCESS_SECRET',
      });
    }

    // Every provider in use needs its model, whether or not its key is set yet.
    const used = new Set([
      env.AI_PROVIDER_TEXT ?? 'anthropic',
      env.AI_PROVIDER_IMAGE ?? 'anthropic',
      ...(env.AI_FALLBACK_PROVIDER ? [env.AI_FALLBACK_PROVIDER] : []),
    ]);
    const models = { anthropic: 'ANTHROPIC_MODEL', gemini: 'GEMINI_MODEL', openai: 'OPENAI_MODEL' } as const;

    for (const provider of used) {
      if (!env[models[provider]]) {
        ctx.addIssue({ code: 'custom', path: [models[provider]], message: `Required while ${provider} grades homework` });
      }
    }
  })
  .transform((env) => ({
    ...env,
    AI_PROVIDER_TEXT: env.AI_PROVIDER_TEXT ?? ('anthropic' as AiProvider),
    AI_PROVIDER_IMAGE: env.AI_PROVIDER_IMAGE ?? ('anthropic' as AiProvider),
  }));

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  // Not the pino logger: it reads its settings from this module.
  console.error(`Invalid environment:\n${z.prettifyError(parsed.error)}`);
  process.exit(1);
}

export const env = parsed.data;
