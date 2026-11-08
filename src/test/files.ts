import { QueryTypes, type Transaction } from 'sequelize';
import request from 'supertest';

import { app } from '../app.js';
import { sequelize } from '../db/index.js';
import type { FileKind } from '../db/models/enums.js';
import { FileRecord, Submission, SubmissionPage } from '../db/models/index.js';
import { storage } from '../storage/index.js';
import { StorageNotFoundError } from '../storage/provider.js';

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00]);

// Stores bytes and writes a files row for them, skipping the upload routes.
export async function storeFile(
  ownerUserId: string,
  kind: FileKind,
  options: { content?: Buffer; name?: string; mime?: string; transaction?: Transaction } = {},
): Promise<FileRecord> {
  const content = options.content ?? Buffer.from(`%PDF-1.7 ${kind}`);

  return FileRecord.create(
    {
      ownerUserId,
      kind,
      originalName: options.name ?? `${kind}.pdf`,
      mime: options.mime ?? 'application/pdf',
      size: content.length,
      storageKey: await storage.put(content),
    },
    { transaction: options.transaction },
  );
}

// Submissions arrive with Phase 8; until then tests write them and their pages directly.
export async function addSubmission(input: {
  homeworkId: string;
  classStudentId: string;
  ownerUserId: string;
  pages?: number;
  version?: number;
  transaction?: Transaction;
}): Promise<{ submission: Submission; pages: FileRecord[] }> {
  const { transaction } = input;
  const submission = await Submission.create(
    {
      homeworkId: input.homeworkId,
      classStudentId: input.classStudentId,
      version: input.version ?? 1,
      status: 'submitted',
      content: null,
      gradeValue: null,
      gradeComment: null,
      gradeSource: null,
      gradedAt: null,
      aiSuggestion: null,
    },
    { transaction },
  );
  const pages: FileRecord[] = [];

  for (let position = 0; position < (input.pages ?? 1); position += 1) {
    const file = await storeFile(input.ownerUserId, 'page', {
      content: PNG,
      name: `page-${position + 1}.png`,
      mime: 'image/png',
      transaction,
    });
    await SubmissionPage.create({ submissionId: submission.id, position, fileId: file.id }, { transaction });
    pages.push(file);
  }

  return { submission, pages };
}

export async function isStored(storageKey: string): Promise<boolean> {
  try {
    await storage.get(storageKey);
    return true;
  } catch (err) {
    if (err instanceof StorageNotFoundError) {
      return false;
    }
    throw err;
  }
}

// GETs a URL and keeps the body as raw bytes, whatever its type.
export function getFile(url: string) {
  return request(app)
    .get(url)
    .buffer(true)
    .parse((res, callback) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('end', () => callback(null, Buffer.concat(chunks)));
    });
}

// Resolves once some query on the test database is waiting for a lock. A test can then
// hold a lock, start a request, and release the lock only after the request is stuck
// behind it.
export async function waitUntilBlocked(): Promise<void> {
  for (let attempt = 0; attempt < 250; attempt += 1) {
    const [row] = await sequelize.query<{ waiting: number }>(
      `SELECT count(*)::int AS waiting FROM pg_stat_activity
        WHERE datname = current_database() AND wait_event_type = 'Lock'`,
      { type: QueryTypes.SELECT },
    );

    if (row && row.waiting > 0) {
      return;
    }

    await new Promise((resolve) => setTimeout(resolve, 20));
  }

  throw new Error('No query ever waited for a lock');
}
