import express, { type Express, type RequestHandler } from 'express';
import request from 'supertest';
import { describe, expect, it } from 'vitest';

import { errorHandler } from './error.js';
import { createFileUpload, createPagesUpload, uploadFile, uploadPages } from './upload.js';

const MB = 1024 * 1024;

function createApp(upload: RequestHandler): Express {
  const app = express();
  app.post('/', upload, (req, res) => {
    const pages = Array.isArray(req.files) ? req.files : [];
    const files = req.file ? [req.file] : pages;

    res.json({
      files: files.map(({ fieldname, originalname, buffer }) => ({
        fieldname,
        originalname,
        size: buffer.length,
        start: buffer.subarray(0, 8).toString(),
      })),
    });
  });
  app.use(errorHandler);
  return app;
}

function attachPages(app: Express, count: number, field = 'pages') {
  let pending = request(app).post('/');

  for (let i = 1; i <= count; i += 1) {
    pending = pending.attach(field, Buffer.from(`page ${i}`), `page-${i}.png`);
  }

  return pending;
}

function expectValidationError(res: request.Response, path: string): void {
  expect(res.status).toBe(400);
  expect(res.body).toEqual({
    error: {
      code: 'VALIDATION_ERROR',
      message: expect.any(String),
      details: [{ path, message: expect.any(String) }],
    },
  });
}

describe('uploadFile', () => {
  const app = createApp(uploadFile);

  it('puts the buffer on req.file', async () => {
    const res = await request(app).post('/').attach('file', Buffer.from('hello'), 'notes.md');

    expect(res.status).toBe(200);
    expect(res.body.files).toEqual([
      { fieldname: 'file', originalname: 'notes.md', size: 5, start: 'hello' },
    ]);
  });

  it('accepts a file of exactly 20 MB', async () => {
    const res = await request(app).post('/').attach('file', Buffer.alloc(20 * MB), 'big.pdf');

    expect(res.status).toBe(200);
    expect(res.body.files[0].size).toBe(20 * MB);
  });

  it('gives 413 PAYLOAD_TOO_LARGE one byte over 20 MB', async () => {
    const res = await request(app).post('/').attach('file', Buffer.alloc(20 * MB + 1), 'big.pdf');

    expect(res.status).toBe(413);
    expect(res.body).toEqual({ error: { code: 'PAYLOAD_TOO_LARGE', message: expect.any(String) } });
  });

  it('gives 400 with the field name for a wrong field', async () => {
    const res = await request(app).post('/').attach('upload', Buffer.from('x'), 'notes.md');

    expectValidationError(res, 'upload');
  });

  it('gives 400 for a second file', async () => {
    const res = await request(app)
      .post('/')
      .attach('file', Buffer.from('one'), 'one.md')
      .attach('file', Buffer.from('two'), 'two.md');

    expectValidationError(res, '');
  });

  it('gives 400 for a text field', async () => {
    const res = await request(app)
      .post('/')
      .field('title', 'Lesson')
      .attach('file', Buffer.from('x'), 'notes.md');

    expectValidationError(res, '');
  });

  it('gives 400 when the multipart boundary is missing', async () => {
    const res = await request(app)
      .post('/')
      .set('Content-Type', 'multipart/form-data')
      .send('not multipart');

    expectValidationError(res, '');
  });

  it('gives 400 for a truncated multipart body', async () => {
    const res = await request(app)
      .post('/')
      .set('Content-Type', 'multipart/form-data; boundary=x')
      .send('--x\r\nContent-Disposition: form-data; name="file"; filename="a.md"\r\n\r\nabc');

    expectValidationError(res, '');
  });

  it('leaves a request that is not multipart alone', async () => {
    const res = await request(app).post('/').send({ not: 'multipart' });

    expect(res.status).toBe(200);
    expect(res.body.files).toEqual([]);
  });
});

describe('uploadPages', () => {
  const app = createApp(uploadPages);

  it('puts the buffers on req.files in upload order', async () => {
    const res = await attachPages(app, 9);

    expect(res.status).toBe(200);
    expect(res.body.files).toHaveLength(9);
    expect(res.body.files.map((file: { start: string }) => file.start)).toEqual(
      Array.from({ length: 9 }, (_, index) => `page ${index + 1}`),
    );
  });

  it('gives 409 LIMIT_REACHED for a 10th page', async () => {
    const res = await attachPages(app, 10);

    expect(res.status).toBe(409);
    expect(res.body).toEqual({ error: { code: 'LIMIT_REACHED', message: expect.any(String) } });
  });

  it('accepts a page of exactly 10 MB', async () => {
    const res = await request(app).post('/').attach('pages', Buffer.alloc(10 * MB), 'page.png');

    expect(res.status).toBe(200);
  });

  it('gives 413 PAYLOAD_TOO_LARGE one byte over 10 MB', async () => {
    const res = await request(app).post('/').attach('pages', Buffer.alloc(10 * MB + 1), 'page.png');

    expect(res.status).toBe(413);
    expect(res.body.error.code).toBe('PAYLOAD_TOO_LARGE');
  });

  it('gives 400 with the field name for a wrong field', async () => {
    expectValidationError(await attachPages(app, 1, 'photos'), 'photos');
  });

  it('gives 400 for a text field', async () => {
    const res = await request(app)
      .post('/')
      .field('note', 'hello')
      .attach('pages', Buffer.from('x'), 'page.png');

    expectValidationError(res, '');
  });
});

describe('factories', () => {
  it('createFileUpload applies its size limit', async () => {
    const app = createApp(createFileUpload({ maxFileSize: 4 }));

    const allowed = await request(app).post('/').attach('file', Buffer.from('1234'), 'a.md');
    const blocked = await request(app).post('/').attach('file', Buffer.from('12345'), 'a.md');

    expect(allowed.status).toBe(200);
    expect(blocked.status).toBe(413);
  });

  it('createPagesUpload applies its page and size limits', async () => {
    const app = createApp(createPagesUpload({ maxFileSize: 4, maxPages: 2 }));

    const allowed = await request(app)
      .post('/')
      .attach('pages', Buffer.from('1'), 'a.png')
      .attach('pages', Buffer.from('2'), 'b.png');
    const tooMany = await request(app)
      .post('/')
      .attach('pages', Buffer.from('1'), 'a.png')
      .attach('pages', Buffer.from('2'), 'b.png')
      .attach('pages', Buffer.from('3'), 'c.png');
    const tooLarge = await request(app).post('/').attach('pages', Buffer.from('12345'), 'a.png');

    expect(allowed.status).toBe(200);
    expect(tooMany.status).toBe(409);
    expect(tooLarge.status).toBe(413);
  });
});
