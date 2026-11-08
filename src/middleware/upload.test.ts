import express, { type Express, type RequestHandler } from 'express';
import request from 'supertest';
import { describe, expect, it } from 'vitest';

import { AppError } from '../lib/errors.js';
import { errorHandler } from './error.js';
import {
  DRAW_PAGE_TYPES,
  LESSON_FILE_TYPES,
  PHOTO_PAGE_TYPES,
  checkFile,
  createFileUpload,
  createPagesUpload,
  getUpload,
  uploadLessonFile,
  uploadPages,
  type FileTypes,
} from './upload.js';

const MB = 1024 * 1024;

const PDF = Buffer.from('%PDF-1.7\n');
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00]);
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);
const WEBP = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBPVP8 ')]);
const GIF = Buffer.from('GIF89a');
const INVALID_UTF8 = Buffer.from([0x23, 0x20, 0xc0, 0x80]);

// `head` followed by spaces up to exactly `size` bytes.
function sized(head: Buffer, size: number): Buffer {
  const data = Buffer.alloc(size, 0x20);
  head.copy(data);
  return data;
}

function fileApp(upload: RequestHandler): Express {
  const app = express();
  app.post('/', upload, (req, res) => {
    const { originalName, mime, size, data } = getUpload(req);
    res.json({ originalName, mime, size, start: data.subarray(0, 5).toString() });
  });
  app.use(errorHandler);
  return app;
}

function pagesApp(upload: RequestHandler): Express {
  const app = express();
  app.post('/', upload, (req, res) => {
    const pages = Array.isArray(req.files) ? req.files : [];
    res.json({
      files: pages.map(({ fieldname, originalname, buffer }) => ({
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

function expectError(res: request.Response, status: number, code: string): void {
  expect(res.status).toBe(status);
  expect(res.body).toEqual({ error: { code, message: expect.any(String) } });
}

// Raw multipart, for what supertest won't send: no file part at all, or an RFC 5987 name.
function rawMultipart(app: Express, parts: string) {
  return request(app)
    .post('/')
    .set('Content-Type', 'multipart/form-data; boundary=x')
    .send(`${parts}--x--\r\n`);
}

describe('uploadLessonFile', () => {
  const app = fileApp(uploadLessonFile);

  it('accepts markdown and stores the detected type', async () => {
    const res = await request(app).post('/').attach('file', Buffer.from('# Title\n'), 'notes.md');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ originalName: 'notes.md', mime: 'text/markdown', size: 8, start: '# Tit' });
  });

  it('accepts a PDF', async () => {
    const res = await request(app).post('/').attach('file', PDF, 'slides.pdf');

    expect(res.body).toMatchObject({ originalName: 'slides.pdf', mime: 'application/pdf' });
  });

  it('ignores the MIME type the client sends', async () => {
    const res = await request(app)
      .post('/')
      .attach('file', Buffer.from('# Title'), { filename: 'notes.md', contentType: 'image/png' });

    expect(res.body.mime).toBe('text/markdown');
  });

  it('matches the extension in any letter case', async () => {
    expect((await request(app).post('/').attach('file', PDF, 'SLIDES.PDF')).status).toBe(200);
    expect((await request(app).post('/').attach('file', Buffer.from('x'), 'Notes.Md')).status).toBe(200);
  });

  it('keeps a file name outside ASCII as sent', async () => {
    const res = await request(app).post('/').attach('file', PDF, 'Урок 1 — kasrlar.pdf');

    expect(res.body.originalName).toBe('Урок 1 — kasrlar.pdf');
  });

  it('decodes an RFC 5987 file name', async () => {
    const res = await rawMultipart(
      app,
      `--x\r\nContent-Disposition: form-data; name="file"; filename*=UTF-8''%D0%A3%D1%80%D0%BE%D0%BA.md\r\n\r\nhello\r\n`,
    );

    expect(res.body.originalName).toBe('Урок.md');
  });

  it('drops the directories of a name sent with a path', async () => {
    const res = await rawMultipart(
      app,
      `--x\r\nContent-Disposition: form-data; name="file"; filename="../../etc/notes.md"\r\n\r\nhello\r\n`,
    );

    expect(res.body.originalName).toBe('notes.md');
  });

  it('accepts markdown of exactly 1 MB and a PDF of exactly 20 MB', async () => {
    const md = await request(app).post('/').attach('file', Buffer.alloc(1 * MB, 'a'), 'notes.md');
    const pdf = await request(app).post('/').attach('file', sized(PDF, 20 * MB), 'slides.pdf');

    expect(md.body.size).toBe(1 * MB);
    expect(pdf.body.size).toBe(20 * MB);
  });

  it('gives 413 PAYLOAD_TOO_LARGE for markdown one byte over 1 MB', async () => {
    expectError(
      await request(app).post('/').attach('file', Buffer.alloc(1 * MB + 1, 'a'), 'notes.md'),
      413,
      'PAYLOAD_TOO_LARGE',
    );
  });

  it('gives 413 PAYLOAD_TOO_LARGE for a PDF one byte over 20 MB', async () => {
    expectError(
      await request(app).post('/').attach('file', sized(PDF, 20 * MB + 1), 'slides.pdf'),
      413,
      'PAYLOAD_TOO_LARGE',
    );
  });

  it.each([
    ['a .txt file', Buffer.from('text'), 'notes.txt'],
    ['a .docx file', Buffer.from('PK'), 'notes.docx'],
    ['a name without an extension', Buffer.from('# x'), 'README'],
    ['a name that is only an extension', Buffer.from('# x'), '.md'],
    ['a second extension after an allowed one', Buffer.from('# x'), 'notes.md.exe'],
    ['markdown that is not UTF-8', INVALID_UTF8, 'notes.md'],
    ['a PDF without the %PDF- header', Buffer.from('hello'), 'slides.pdf'],
    ['a PNG named .pdf', PNG, 'slides.pdf'],
  ])('gives 415 UNSUPPORTED_MEDIA_TYPE for %s', async (_name, content, filename) => {
    expectError(
      await request(app).post('/').attach('file', content, filename),
      415,
      'UNSUPPORTED_MEDIA_TYPE',
    );
  });

  it('rejects a wrong extension before reading the bytes, even past the size limit', async () => {
    expectError(
      await request(app).post('/').attach('file', Buffer.alloc(25 * MB), 'video.mp4'),
      415,
      'UNSUPPORTED_MEDIA_TYPE',
    );
  });

  it('gives 400 for an empty file', async () => {
    expectValidationError(await request(app).post('/').attach('file', Buffer.alloc(0), 'notes.md'), 'file');
  });

  it('accepts a 255-character name and rejects a 256-character one', async () => {
    const name = (length: number) => `${'n'.repeat(length - 3)}.md`;

    expect((await request(app).post('/').attach('file', Buffer.from('x'), name(255))).status).toBe(200);
    expectValidationError(await request(app).post('/').attach('file', Buffer.from('x'), name(256)), 'file');
  });

  it('gives 400 for a name with a control character', async () => {
    const res = await rawMultipart(
      app,
      `--x\r\nContent-Disposition: form-data; name="file"; filename*=UTF-8''a%00b.md\r\n\r\nhello\r\n`,
    );

    expectValidationError(res, 'file');
  });

  it('gives 400 when no file was sent', async () => {
    expectValidationError(await request(app).post('/').send({ not: 'multipart' }), 'file');
    expectValidationError(await rawMultipart(app, ''), 'file');
  });

  it('gives 400 with the field name for a wrong field', async () => {
    expectValidationError(await request(app).post('/').attach('upload', Buffer.from('x'), 'notes.md'), 'upload');
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
});

function codeOf(run: () => unknown): string {
  try {
    run();
  } catch (err) {
    return err instanceof AppError ? err.code : 'not an AppError';
  }
  return 'accepted';
}

describe('checkFile', () => {
  const check = (types: FileTypes, name: string, data: Buffer) =>
    codeOf(() => checkFile({ originalname: name, buffer: data }, types));

  describe('lesson files and homework instructions', () => {
    it.each([
      ['notes.md', Buffer.from('# Title'), 'text/markdown'],
      ['notes.md', Buffer.from('﻿# With a byte order mark'), 'text/markdown'],
      ['slides.pdf', PDF, 'application/pdf'],
    ])('accepts %s as %s', (name, data, mime) => {
      expect(checkFile({ originalname: name, buffer: data }, LESSON_FILE_TYPES).mime).toBe(mime);
    });

    it.each([
      ['an image', 'photo.png', PNG, 'UNSUPPORTED_MEDIA_TYPE'],
      ['markdown that is not UTF-8', 'notes.md', INVALID_UTF8, 'UNSUPPORTED_MEDIA_TYPE'],
      ['a PDF without its header', 'slides.pdf', Buffer.from('%PDF'), 'UNSUPPORTED_MEDIA_TYPE'],
      ['markdown over 1 MB', 'notes.md', Buffer.alloc(1 * MB + 1, 'a'), 'PAYLOAD_TOO_LARGE'],
      ['a PDF over 20 MB', 'slides.pdf', sized(PDF, 20 * MB + 1), 'PAYLOAD_TOO_LARGE'],
      ['an empty file', 'notes.md', Buffer.alloc(0), 'VALIDATION_ERROR'],
    ])('rejects %s', (_case, name, data, code) => {
      expect(check(LESSON_FILE_TYPES, name, data)).toBe(code);
    });
  });

  describe('draw and math pages', () => {
    it('accepts a PNG of exactly 10 MB', () => {
      expect(checkFile({ originalname: 'page-1.png', buffer: sized(PNG, 10 * MB) }, DRAW_PAGE_TYPES)).toMatchObject({
        mime: 'image/png',
        size: 10 * MB,
      });
    });

    it.each([
      ['a JPEG', 'page-1.jpg', JPEG, 'UNSUPPORTED_MEDIA_TYPE'],
      ['JPEG bytes named .png', 'page-1.png', JPEG, 'UNSUPPORTED_MEDIA_TYPE'],
      ['a PNG over 10 MB', 'page-1.png', sized(PNG, 10 * MB + 1), 'PAYLOAD_TOO_LARGE'],
      ['a canvas blob with no name', 'blob', PNG, 'UNSUPPORTED_MEDIA_TYPE'],
    ])('rejects %s', (_case, name, data, code) => {
      expect(check(DRAW_PAGE_TYPES, name, data)).toBe(code);
    });
  });

  describe('photo pages', () => {
    it.each([
      ['photo.jpg', JPEG, 'image/jpeg'],
      ['photo.JPEG', JPEG, 'image/jpeg'],
      ['photo.png', PNG, 'image/png'],
      ['photo.webp', WEBP, 'image/webp'],
    ])('accepts %s as %s', (name, data, mime) => {
      expect(checkFile({ originalname: name, buffer: data }, PHOTO_PAGE_TYPES).mime).toBe(mime);
    });

    it.each([
      ['PNG bytes named .jpg', 'photo.jpg', PNG, 'UNSUPPORTED_MEDIA_TYPE'],
      ['a RIFF file that is not WebP', 'photo.webp', Buffer.from('RIFF\0\0\0\0AVI '), 'UNSUPPORTED_MEDIA_TYPE'],
      ['a GIF', 'photo.gif', GIF, 'UNSUPPORTED_MEDIA_TYPE'],
      ['a HEIC photo', 'photo.heic', Buffer.from('....ftypheic'), 'UNSUPPORTED_MEDIA_TYPE'],
      ['a JPEG over 10 MB', 'photo.jpg', sized(JPEG, 10 * MB + 1), 'PAYLOAD_TOO_LARGE'],
    ])('rejects %s', (_case, name, data, code) => {
      expect(check(PHOTO_PAGE_TYPES, name, data)).toBe(code);
    });
  });

  it('gives VALIDATION_ERROR when there is no file', () => {
    expect(codeOf(() => checkFile(undefined, LESSON_FILE_TYPES))).toBe('VALIDATION_ERROR');
  });
});

describe('uploadPages', () => {
  const app = pagesApp(uploadPages);

  it('puts the buffers on req.files in upload order', async () => {
    const res = await attachPages(app, 9);

    expect(res.status).toBe(200);
    expect(res.body.files).toHaveLength(9);
    expect(res.body.files.map((file: { start: string }) => file.start)).toEqual(
      Array.from({ length: 9 }, (_, index) => `page ${index + 1}`),
    );
  });

  it('keeps page names outside ASCII as sent', async () => {
    const res = await request(app).post('/').attach('pages', PNG, 'sahifa-1 (тест).png');

    expect(res.body.files[0].originalname).toBe('sahifa-1 (тест).png');
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
  const anyContent = { matches: () => true };

  it('createFileUpload lets each type keep its own size limit', async () => {
    const app = fileApp(
      createFileUpload({
        types: {
          '.md': { mime: 'text/markdown', maxSize: 4, ...anyContent },
          '.pdf': { mime: 'application/pdf', maxSize: 8, ...anyContent },
        },
      }),
    );
    const send = (size: number, name: string) =>
      request(app).post('/').attach('file', Buffer.alloc(size, 'a'), name);

    expect((await send(4, 'a.md')).status).toBe(200);
    expect((await send(5, 'a.md')).status).toBe(413);
    expect((await send(8, 'a.pdf')).status).toBe(200);
    expect((await send(9, 'a.pdf')).status).toBe(413);
  });

  it('createPagesUpload applies its page and size limits', async () => {
    const app = pagesApp(createPagesUpload({ maxFileSize: 4, maxPages: 2 }));

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
