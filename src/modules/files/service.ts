import { QueryTypes, type Transaction } from 'sequelize';

import { sequelize } from '../../db/index.js';
import type { FileKind } from '../../db/models/enums.js';
import { FileRecord } from '../../db/models/index.js';
import { AppError } from '../../lib/errors.js';
import { logger } from '../../lib/logger.js';
import { assertValidFileSignature } from '../../lib/signedUrl.js';
import { uuidSchema } from '../../lib/validation.js';
import type { Upload } from '../../middleware/upload.js';
import { storage } from '../../storage/index.js';
import { StorageNotFoundError } from '../../storage/provider.js';

// Call inside the transaction, then pass the returned keys to removeStoredFiles once it has
// committed. Not a transaction.afterCommit hook: Sequelize also runs those when COMMIT fails,
// which would delete the stored bytes of rows that still exist.
export async function deleteFileRows(
  fileIds: string[],
  transaction: Transaction,
): Promise<string[]> {
  const files = await FileRecord.findAll({
    attributes: ['storageKey'],
    where: { id: fileIds },
    transaction,
  });

  await FileRecord.destroy({ where: { id: fileIds }, transaction });

  return files.map((file) => file.storageKey);
}

export async function removeStoredFiles(storageKeys: string[]): Promise<void> {
  const results = await Promise.allSettled(storageKeys.map((key) => storage.delete(key)));

  results.forEach((result, index) => {
    if (result.status === 'rejected') {
      logger.error(
        { err: result.reason, storageKey: storageKeys[index] },
        'Could not delete a stored file',
      );
    }
  });
}

export async function withStoredFiles<T>(
  contents: Buffer[],
  work: (storageKeys: string[]) => Promise<T>,
): Promise<T> {
  const storageKeys: string[] = [];

  try {
    for (const content of contents) {
      storageKeys.push(await storage.put(content));
    }

    return await work(storageKeys);
  } catch (err) {
    await removeStoredFiles(storageKeys);
    throw err;
  }
}

export async function withStoredFile<T>(
  content: Buffer,
  work: (storageKey: string) => Promise<T>,
): Promise<T> {
  return withStoredFiles([content], ([storageKey]) => work(storageKey as string));
}

// A file row is only ever committed together with the row that points at it, so the
// lock* and *FileIds helpers below can find every file a delete leaves behind.
export async function createFileRecord(
  ownerUserId: string,
  kind: FileKind,
  upload: Upload,
  storageKey: string,
  transaction: Transaction,
): Promise<FileRecord> {
  return FileRecord.create(
    {
      ownerUserId,
      kind,
      originalName: upload.originalName,
      mime: upload.mime,
      size: upload.size,
      storageKey,
    },
    { transaction },
  );
}

function present(id: string | null): id is string {
  return id !== null;
}

// Pages of submissions to these homeworks, or by this roster row. The caller holds a lock
// that keeps new submissions out: FOR UPDATE on the homework or class_students rows, which
// a new submission's foreign keys need KEY SHARE on.
export async function pageFileIds(
  scope: { homeworkIds: string[] } | { classStudentId: string },
  transaction: Transaction,
): Promise<string[]> {
  if ('homeworkIds' in scope && scope.homeworkIds.length === 0) {
    return [];
  }

  const [condition, bind] =
    'homeworkIds' in scope
      ? ['s.homework_id = ANY($ids::uuid[])', { ids: scope.homeworkIds }]
      : ['s.class_student_id = $id', { id: scope.classStudentId }];
  const rows = await sequelize.query<{ fileId: string }>(
    `SELECT sp.file_id AS "fileId"
       FROM submission_pages sp
       JOIN submissions s ON s.id = sp.submission_id
      WHERE ${condition}`,
    { bind, type: QueryTypes.SELECT, transaction },
  );

  return rows.map((row) => row.fileId);
}

export type LessonScope = { classId: string } | { unitId: string } | { lessonId: string };

// Every file under the lessons in scope: lesson files, homework instructions and submitted
// pages. Locks those lessons and their homework FOR UPDATE first, so nothing can attach a
// new file to them before the caller's delete commits. Rows are locked in id order, so two
// deletes over the same lessons can't deadlock.
export async function lockLessonFiles(
  scope: LessonScope,
  transaction: Transaction,
): Promise<string[]> {
  const [column, value] =
    'classId' in scope
      ? ['class_id', scope.classId]
      : 'unitId' in scope
        ? ['unit_id', scope.unitId]
        : ['id', scope.lessonId];
  const lessons = await sequelize.query<{ id: string; fileId: string | null }>(
    `SELECT id, lesson_file_id AS "fileId" FROM lessons
      WHERE ${column} = $value
      ORDER BY id
        FOR UPDATE`,
    { bind: { value }, type: QueryTypes.SELECT, transaction },
  );

  if (lessons.length === 0) {
    return [];
  }

  const homeworks = await sequelize.query<{ id: string; fileId: string | null }>(
    `SELECT id, instructions_file_id AS "fileId" FROM homeworks
      WHERE lesson_id = ANY($lessonIds::uuid[])
      ORDER BY id
        FOR UPDATE`,
    { bind: { lessonIds: lessons.map((lesson) => lesson.id) }, type: QueryTypes.SELECT, transaction },
  );
  const pages = await pageFileIds(
    { homeworkIds: homeworks.map((homework) => homework.id) },
    transaction,
  );

  return [
    ...lessons.map((lesson) => lesson.fileId).filter(present),
    ...homeworks.map((homework) => homework.fileId).filter(present),
    ...pages,
  ];
}

function fileNotFound(): AppError {
  return new AppError('NOT_FOUND', 'File not found');
}

// The signature is the only credential (contract 7). It is checked before anything else,
// so a URL that isn't validly signed gets 403 and learns nothing about the file.
export async function readSignedFile(
  fileId: string,
  exp: unknown,
  sig: unknown,
): Promise<{ file: FileRecord; data: Buffer }> {
  assertValidFileSignature(fileId, exp, sig);

  // Only real file ids get signed, but a validly signed non-uuid must still be a 404, not a
  // database error.
  if (!uuidSchema.safeParse(fileId).success) {
    throw fileNotFound();
  }

  const file = await FileRecord.findByPk(fileId);

  if (!file) {
    throw fileNotFound();
  }

  try {
    return { file, data: await storage.get(file.storageKey) };
  } catch (err) {
    if (err instanceof StorageNotFoundError) {
      logger.error({ fileId, storageKey: file.storageKey }, 'A file row has no stored bytes');
      throw fileNotFound();
    }

    throw err;
  }
}
