import Anthropic from '@anthropic-ai/sdk';

import { env, type AiProvider } from '../../config/env.js';
import type { HomeworkType } from '../../db/models/enums.js';
import { model } from './model.js';
import {
  buildRequest,
  GRADE_SCHEMA,
  parseGrade,
  promptParts,
  readGrade,
  SYSTEM_PROMPT,
  type GradeOutcome,
  type GradingInput,
} from './prompt.js';

// Page images (draw, math, photo) and typed answers (text, code) can go to different AIs.
const PAGE_TYPES: ReadonlySet<HomeworkType> = new Set(['draw', 'math', 'photo']);

type HttpReply = { status: number; body: unknown };

// Gemini and OpenAI are called over plain HTTPS, so neither needs an SDK (a new dependency
// would need approval, plan: working rules). Kept on an object so tests can replace `send`.
export const http = {
  // Waits before each retry of a 5xx or a connection that failed or hung.
  retryDelaysMs: [2_000, 6_000],
  timeoutMs: 120_000,

  async send(url: string, headers: Record<string, string>, body: unknown): Promise<HttpReply> {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(http.timeoutMs),
    });
    let json: unknown = null;

    try {
      json = await res.json();
    } catch {
      // A body that isn't JSON leaves `json` null; the status still says what happened.
    }

    return { status: res.status, body: json };
  },
};

// A 4xx, quota and rate limits included, isn't retried: the fallback provider is tried
// instead, and a quota doesn't recover in seconds.
async function postJson(url: string, headers: Record<string, string>, body: unknown): Promise<HttpReply> {
  for (let attempt = 0; ; attempt += 1) {
    const last = attempt >= http.retryDelaysMs.length;

    try {
      const reply = await http.send(url, headers, body);

      if (reply.status < 500 || last) {
        return reply;
      }
    } catch (err) {
      if (last) {
        throw err;
      }
    }

    await new Promise((resolve) => setTimeout(resolve, http.retryDelaysMs[attempt]));
  }
}

function errorText(body: unknown): string {
  const error = (body as { error?: { status?: string; code?: string; type?: string; message?: string } } | null)?.error;

  return [error?.status ?? error?.code ?? error?.type, error?.message?.slice(0, 200)].filter(Boolean).join(': ');
}

async function gradeWithClaude(input: GradingInput): Promise<GradeOutcome> {
  return readGrade(await model.send(buildRequest(input, env.ANTHROPIC_MODEL as string)));
}

// Gemini's response schema is its own OpenAPI-style dialect: types in capitals, and enum
// only for strings, so the 2-5 range is in the description and checked by parseGrade.
const GEMINI_SCHEMA = {
  type: 'OBJECT',
  properties: {
    value: { type: 'INTEGER', description: 'The grade: 2, 3, 4 or 5' },
    comment: { type: 'STRING' },
  },
  required: ['value', 'comment'],
  propertyOrdering: ['value', 'comment'],
};

type GeminiReply = {
  candidates?: Array<{ finishReason?: string; content?: { parts?: Array<{ text?: string; thought?: boolean }> } }>;
  promptFeedback?: { blockReason?: string };
};

async function gradeWithGemini(input: GradingInput): Promise<GradeOutcome> {
  const reply = await postJson(
    `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(env.GEMINI_MODEL as string)}:generateContent`,
    { 'x-goog-api-key': env.GEMINI_API_KEY as string },
    {
      systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
      contents: [
        {
          role: 'user',
          parts: promptParts(input).map((part) =>
            part.kind === 'text'
              ? { text: part.text }
              : { inlineData: { mimeType: part.mime, data: part.data.toString('base64') } },
          ),
        },
      ],
      generationConfig: { responseMimeType: 'application/json', responseSchema: GEMINI_SCHEMA },
    },
  );

  if (reply.status !== 200) {
    return { ok: false, reason: `HTTP ${reply.status} ${errorText(reply.body)}` };
  }

  const body = reply.body as GeminiReply;
  const candidate = body.candidates?.[0];

  if (candidate?.finishReason !== 'STOP') {
    return { ok: false, reason: `finishReason ${candidate?.finishReason ?? body.promptFeedback?.blockReason ?? 'none'}` };
  }

  // Thought summaries, if a model sends them, are not the answer.
  return parseGrade(
    (candidate.content?.parts ?? [])
      .filter((part) => !part.thought && typeof part.text === 'string')
      .map((part) => part.text)
      .join(''),
  );
}

type OpenAiReply = {
  choices?: Array<{ finish_reason?: string; message?: { content?: string | null; refusal?: string | null } }>;
};

async function gradeWithOpenAi(input: GradingInput): Promise<GradeOutcome> {
  const reply = await postJson(
    'https://api.openai.com/v1/chat/completions',
    { Authorization: `Bearer ${env.OPENAI_API_KEY as string}` },
    {
      model: env.OPENAI_MODEL,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        {
          role: 'user',
          content: promptParts(input).map((part) =>
            part.kind === 'text'
              ? { type: 'text', text: part.text }
              : { type: 'image_url', image_url: { url: `data:${part.mime};base64,${part.data.toString('base64')}` } },
          ),
        },
      ],
      response_format: { type: 'json_schema', json_schema: { name: 'grade', strict: true, schema: GRADE_SCHEMA } },
    },
  );

  if (reply.status !== 200) {
    return { ok: false, reason: `HTTP ${reply.status} ${errorText(reply.body)}` };
  }

  const choice = (reply.body as OpenAiReply).choices?.[0];

  if (choice?.message?.refusal) {
    return { ok: false, reason: 'refusal' };
  }

  if (choice?.finish_reason !== 'stop') {
    return { ok: false, reason: `finish_reason ${choice?.finish_reason ?? 'none'}` };
  }

  return parseGrade(choice.message?.content ?? '');
}

const GRADERS: Record<AiProvider, { key: () => string | undefined; grade: (input: GradingInput) => Promise<GradeOutcome> }> = {
  anthropic: { key: () => env.ANTHROPIC_API_KEY, grade: gradeWithClaude },
  gemini: { key: () => env.GEMINI_API_KEY, grade: gradeWithGemini },
  openai: { key: () => env.OPENAI_API_KEY, grade: gradeWithOpenAi },
};

function hasKey(provider: AiProvider): boolean {
  return Boolean(GRADERS[provider].key());
}

// The providers to try for a homework type, in order: its own, then the fallback, leaving
// out any without a key. Empty means AI grading is unavailable for that type.
export function providersFor(type: HomeworkType): AiProvider[] {
  const own = PAGE_TYPES.has(type) ? env.AI_PROVIDER_IMAGE : env.AI_PROVIDER_TEXT;
  const fallback = env.AI_FALLBACK_PROVIDER;

  return [...new Set(fallback ? [own, fallback] : [own])].filter(hasKey);
}

// Whether any homework type can be graded at all. Never while AI grading is switched off
// (AI_GRADING_ENABLED), whatever keys are set.
export function aiConfigured(): boolean {
  if (!env.AI_GRADING_ENABLED) {
    return false;
  }

  return providersFor('text').length > 0 || providersFor('photo').length > 0;
}

function describe(err: unknown): string {
  if (err instanceof Anthropic.APIError) {
    return `HTTP ${err.status ?? '-'} ${err.message.slice(0, 200)}`;
  }

  return err instanceof Error ? `${err.name}: ${err.message.slice(0, 200)}` : String(err);
}

// Never throws: an API error, a hung request or a bad answer is a failed outcome, so the
// next provider can be tried.
export async function gradeWith(provider: AiProvider, input: GradingInput): Promise<GradeOutcome> {
  try {
    return await GRADERS[provider].grade(input);
  } catch (err) {
    return { ok: false, reason: describe(err) };
  }
}
