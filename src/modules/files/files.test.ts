import { randomUUID } from 'node:crypto';

import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { app } from '../../app.js';
import type { FileRecord } from '../../db/models/index.js';
import { logger } from '../../lib/logger.js';
import { FILE_URL_TTL_SECONDS, FILE_URL_WINDOW_SECONDS, signFileUrl } from '../../lib/signedUrl.js';
import { resetRateLimits } from '../../middleware/rateLimit.js';
import { storage } from '../../storage/index.js';
import { useTestDatabase } from '../../test/database.js';
import { getFile, storeFile } from '../../test/files.js';
import { createTestUser, type TestUser } from '../../test/users.js';

useTestDatabase();

afterEach(() => {
  vi.restoreAllMocks();
});

let teacher: TestUser;

beforeEach(async () => {
  await resetRateLimits();
  teacher = await createTestUser('teacher');
});

const PDF = Buffer.from('%PDF-1.7\nslides');

function storePdf(name = 'Slides.pdf'): Promise<FileRecord> {
  return storeFile(teacher.id, 'lesson', { content: PDF, name, mime: 'application/pdf' });
}

function urlParts(url: string): { path: string; exp: string; sig: string } {
  const parsed = new URL(url, 'http://localhost');
  return {
    path: parsed.pathname,
    exp: parsed.searchParams.get('exp') ?? '',
    sig: parsed.searchParams.get('sig') ?? '',
  };
}

// getFile keeps every body as bytes, error responses included.
function jsonOf(res: request.Response): unknown {
  return JSON.parse((res.body as Buffer).toString());
}

function expectInvalidUrl(res: request.Response): void {
  expect(res.status).toBe(403);
  expect(jsonOf(res)).toEqual({ error: { code: 'FILE_URL_INVALID', message: expect.any(String) } });
}

describe('GET /files/:id', () => {
  it('serves the bytes with the contract headers, and needs no Authorization', async () => {
    const file = await storePdf();

    const res = await getFile(signFileUrl(file.id).url);

    expect(res.status).toBe(200);
    expect(res.body).toEqual(PDF);
    expect(res.headers['content-type']).toBe('application/pdf');
    expect(res.headers['content-length']).toBe(String(PDF.length));
    expect(res.headers['content-disposition']).toBe("inline; filename*=UTF-8''Slides.pdf");
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['cache-control']).toBe('private, max-age=300');
    expect(res.headers.etag).toBeUndefined();
  });

  it('serves markdown as UTF-8 plain text', async () => {
    const content = Buffer.from('# Kasrlar\n\nЯрим ва чорак.\n');
    const file = await storeFile(teacher.id, 'lesson', { content, name: 'notes.md', mime: 'text/markdown' });

    const res = await getFile(signFileUrl(file.id).url);

    expect(res.headers['content-type']).toBe('text/plain; charset=utf-8');
    expect(res.body).toEqual(content);
  });

  it('percent-encodes the file name, including characters outside ASCII and the RFC 8187 extras', async () => {
    const file = await storePdf("Урок 1 (draft)*'s.pdf");

    const res = await getFile(signFileUrl(file.id).url);

    expect(res.status).toBe(200);
    expect(res.headers['content-disposition']).toBe(
      "inline; filename*=UTF-8''%D0%A3%D1%80%D0%BE%D0%BA%201%20%28draft%29%2A%27s.pdf",
    );
  });

  it('answers HEAD with the headers alone', async () => {
    const file = await storePdf();

    const res = await request(app).head(signFileUrl(file.id).url);

    expect(res.status).toBe(200);
    expect(res.headers['content-length']).toBe(String(PDF.length));
    expect(res.text).toBeUndefined();
  });

  it('accepts a URL until it expires and rejects it after', async () => {
    const file = await storePdf();
    // Signed almost a TTL ago: at least 5 seconds left. Signed a TTL plus a window ago: past
    // its expiry whichever way it was rounded.
    const almostExpired = new Date(Date.now() - (FILE_URL_TTL_SECONDS - 5) * 1000);
    const expired = new Date(Date.now() - (FILE_URL_TTL_SECONDS + FILE_URL_WINDOW_SECONDS) * 1000);

    expect((await getFile(signFileUrl(file.id, almostExpired).url)).status).toBe(200);
    expectInvalidUrl(await getFile(signFileUrl(file.id, expired).url));
  });

  it.each([
    ['a forged signature', (path: string, exp: string, sig: string) => `${path}?exp=${exp}&sig=${sig.slice(0, -1)}${sig.endsWith('0') ? '1' : '0'}`],
    ['an exp moved later', (path: string, exp: string, sig: string) => `${path}?exp=${Number(exp) + 3600}&sig=${sig}`],
    ['no signature', (path: string, exp: string) => `${path}?exp=${exp}`],
    ['no exp', (path: string, _exp: string, sig: string) => `${path}?sig=${sig}`],
    ['no query at all', (path: string) => path],
    ['a signature that is not hex', (path: string, exp: string) => `${path}?exp=${exp}&sig=${'z'.repeat(64)}`],
    ['a repeated exp', (path: string, exp: string, sig: string) => `${path}?exp=${exp}&exp=${exp}&sig=${sig}`],
  ])('gives 403 FILE_URL_INVALID for %s', async (_case, build) => {
    const file = await storePdf();
    const { path, exp, sig } = urlParts(signFileUrl(file.id).url);

    expectInvalidUrl(await getFile(build(path, exp, sig)));
  });

  it("gives 403 for another file's valid signature", async () => {
    const [mine, other] = [await storePdf(), await storePdf()];
    const { exp, sig } = urlParts(signFileUrl(other.id).url);

    expectInvalidUrl(await getFile(`/api/v1/files/${mine.id}?exp=${exp}&sig=${sig}`));
  });

  it('gives 403, not 404, for an unsigned id that does not exist, malformed or not', async () => {
    expectInvalidUrl(await getFile(`/api/v1/files/${randomUUID()}?exp=9999999999&sig=${'0'.repeat(64)}`));
    expectInvalidUrl(await getFile('/api/v1/files/not-a-uuid'));
  });

  it('gives 404 NOT_FOUND for a validly signed id with no file, malformed or not', async () => {
    for (const id of [randomUUID(), 'not-a-uuid']) {
      const res = await getFile(signFileUrl(id).url);

      expect(res.status).toBe(404);
      expect(jsonOf(res)).toEqual({ error: { code: 'NOT_FOUND', message: 'File not found' } });
    }
  });

  it('gives VALIDATION_ERROR for an unknown query parameter', async () => {
    const file = await storePdf();

    const res = await getFile(`${signFileUrl(file.id).url}&download=1`);

    expect(res.status).toBe(400);
    expect(jsonOf(res)).toMatchObject({ error: { code: 'VALIDATION_ERROR' } });
  });

  it('gives 404 and logs an error when the stored bytes are missing', async () => {
    const file = await storePdf();
    await storage.delete(file.storageKey);
    const error = vi.spyOn(logger, 'error').mockImplementation(() => undefined);

    const res = await getFile(signFileUrl(file.id).url);

    expect(res.status).toBe(404);
    expect(error).toHaveBeenCalledWith(
      { fileId: file.id, storageKey: file.storageKey },
      'A file row has no stored bytes',
    );
  });
});
