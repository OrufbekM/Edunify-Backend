import { execFileSync } from 'node:child_process';

import { describe, expect, it } from 'vitest';

// env.ts reads process.env once and exits on bad values, so each case loads it in its own
// process with only the variables given.
const BASE = {
  NODE_ENV: 'test',
  DATABASE_URL: 'postgres://user:pass@localhost:5432/edunify_test',
  JWT_ACCESS_SECRET: 'j'.repeat(32),
  FILE_URL_SECRET: 'f'.repeat(32),
  STORAGE_DIR: '/tmp/edunify-env-test',
};

const AI_FIELDS = [
  'AI_GRADING_ENABLED',
  'AI_PROVIDER_TEXT',
  'AI_PROVIDER_IMAGE',
  'AI_FALLBACK_PROVIDER',
  'ANTHROPIC_API_KEY',
  'GEMINI_API_KEY',
  'OPENAI_API_KEY',
  'ANTHROPIC_MODEL',
  'GEMINI_MODEL',
  'OPENAI_MODEL',
];

function load(vars: Record<string, string>): { ok: true; env: Record<string, unknown> } | { ok: false; error: string } {
  const script = `const { env } = await import(${JSON.stringify(new URL('./env.ts', import.meta.url).pathname)});
    console.log(JSON.stringify(Object.fromEntries(${JSON.stringify(AI_FIELDS)}.map((k) => [k, env[k] ?? null]))));`;

  try {
    const out = execFileSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script], {
      env: { PATH: process.env.PATH ?? '', ...BASE, ...vars },
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { ok: true, env: JSON.parse(out) };
  } catch (err) {
    return { ok: false, error: String((err as { stderr?: string }).stderr) };
  }
}

describe('AI settings', () => {
  it('keeps AI grading off unless AI_GRADING_ENABLED turns it on', () => {
    for (const vars of [{}, { AI_GRADING_ENABLED: '' }, { AI_GRADING_ENABLED: 'false' }] as Record<string, string>[]) {
      expect(load({ ANTHROPIC_MODEL: 'c', ...vars })).toMatchObject({ ok: true, env: { AI_GRADING_ENABLED: false } });
    }

    expect(load({ ANTHROPIC_MODEL: 'c', AI_GRADING_ENABLED: 'true' })).toMatchObject({
      ok: true,
      env: { AI_GRADING_ENABLED: true },
    });

    const unclear = load({ ANTHROPIC_MODEL: 'c', AI_GRADING_ENABLED: 'maybe' });
    expect(unclear.ok).toBe(false);
    expect(unclear.ok === false && unclear.error).toContain('AI_GRADING_ENABLED');
  });

  it('sends every homework type to Claude by default, which then needs ANTHROPIC_MODEL', () => {
    expect(load({ ANTHROPIC_MODEL: 'claude-opus-5-5' })).toMatchObject({
      ok: true,
      env: { AI_PROVIDER_TEXT: 'anthropic', AI_PROVIDER_IMAGE: 'anthropic', AI_FALLBACK_PROVIDER: null },
    });

    const missing = load({});
    expect(missing.ok).toBe(false);
    expect(missing.ok === false && missing.error).toContain('ANTHROPIC_MODEL');
  });

  it('reads provider names in any case and with spaces around them', () => {
    expect(
      load({ AI_PROVIDER_TEXT: ' OpenAI  ', AI_PROVIDER_IMAGE: 'Gemini', OPENAI_MODEL: 'o', GEMINI_MODEL: 'g' }),
    ).toMatchObject({ ok: true, env: { AI_PROVIDER_TEXT: 'openai', AI_PROVIDER_IMAGE: 'gemini' } });
  });

  it('needs the model of each provider in use, the fallback included, and no other', () => {
    expect(load({ AI_PROVIDER_TEXT: 'openai', AI_PROVIDER_IMAGE: 'gemini', OPENAI_MODEL: 'o', GEMINI_MODEL: 'g' }).ok).toBe(true);

    const noFallbackModel = load({
      AI_PROVIDER_TEXT: 'openai',
      AI_PROVIDER_IMAGE: 'gemini',
      AI_FALLBACK_PROVIDER: 'anthropic',
      OPENAI_MODEL: 'o',
      GEMINI_MODEL: 'g',
    });
    expect(noFallbackModel.ok).toBe(false);
    expect(noFallbackModel.ok === false && noFallbackModel.error).toContain('ANTHROPIC_MODEL');
  });

  it('treats an empty value as unset', () => {
    expect(
      load({ ANTHROPIC_MODEL: 'c', ANTHROPIC_API_KEY: '', GEMINI_API_KEY: '  ', AI_FALLBACK_PROVIDER: '' }),
    ).toMatchObject({ ok: true, env: { ANTHROPIC_API_KEY: null, GEMINI_API_KEY: null, AI_FALLBACK_PROVIDER: null } });
  });

  it('refuses a provider it does not know', () => {
    const result = load({ AI_PROVIDER_IMAGE: 'mistral', ANTHROPIC_MODEL: 'c' });

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error).toContain('AI_PROVIDER_IMAGE');
  });
});
