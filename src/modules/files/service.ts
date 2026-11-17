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

// Call inside the transaction, after deleting or changing the rows that pointed at these
// files, then pass the returned keys to removeStoredFiles once it has committed. Not a
// transaction.afterCommit hook: Sequelize also runs those when COMMIT fails, which would
// delete the stored bytes of rows that still exist.
//
// A file that some row still references stays: copies of a lesson share its lesson file
// and its homework's instructions file (contract 4.1). The rows are locked first, in id
// order, so two deletes of the last two references can't both see the other one still there,
// and nothing can take a new reference while the check runs.
export async function deleteFileRows(
  fileIds: string[],
  transaction: Transaction,
): Promise<string[]> {
  const ids = [...new Set(fileIds)];

  if (ids.length === 0) {
    return [];
  }

  await sequelize.query('SELECT id FROM files WHERE id = ANY($ids::uuid[]) ORDER BY id FOR UPDATE', {
    bind: { ids },
    transaction,
  });

  const removed = await sequelize.query<{ storageKey: string }>(
    `DELETE FROM files f
      WHERE f.id = ANY($ids::uuid[])
        AND NOT EXISTS (SELECT 1 FROM lessons l WHERE l.lesson_file_id = f.id)
        AND NOT EXISTS (SELECT 1 FROM homeworks h WHERE h.instructions_file_id = f.id)
        AND NOT EXISTS (SELECT 1 FROM submission_pages sp WHERE sp.file_id = f.id)
      RETURNING f.storage_key AS "storageKey"`,
    { bind: { ids }, type: QueryTypes.SELECT, transaction },
  );

  return removed.map((file) => file.storageKey);
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

// Pages of submissions to these homeworks (from one class's roster when `classId` is given),
// by this roster row, or by every roster row of a class. The caller holds a lock that keeps
// new submissions out: FOR UPDATE on the homework or class_students rows, which a new
// submission's foreign keys need KEY SHARE on.
export async function pageFileIds(
  scope:
    | { homeworkIds: string[]; classId?: string }
    | { classStudentId: string }
    | { rosterOf: string },
  transaction: Transaction,
): Promise<string[]> {
  if ('homeworkIds' in scope && scope.homeworkIds.length === 0) {
    return [];
  }

  const inClass = 's.class_student_id IN (SELECT cs.id FROM class_students cs WHERE cs.class_id = $classId)';
  const [condition, bind] =
    'homeworkIds' in scope
      ? scope.classId
        ? [`s.homework_id = ANY($ids::uuid[]) AND ${inClass}`, { ids: scope.homeworkIds, classId: scope.classId }]
        : ['s.homework_id = ANY($ids::uuid[])', { ids: scope.homeworkIds }]
      : 'classStudentId' in scope
        ? ['s.class_student_id = $id', { id: scope.classStudentId }]
        : [inClass, { classId: scope.rosterOf }];
  const rows = await sequelize.query<{ fileId: string }>(
    `SELECT sp.file_id AS "fileId"
       FROM submission_pages sp
       JOIN submissions s ON s.id = sp.submission_id
      WHERE ${condition}`,
    { bind, type: QueryTypes.SELECT, transaction },
  );

  return rows.map((row) => row.fileId);
}

export type LessonScope =
  | { classId: string }
  | { unitId: string }
  | { lessonId: string }
  | { lessonIds: string[] };

// Every file under the lessons in scope: lesson files, homework instructions and submitted
// pages. Locks those lessons and their homework FOR UPDATE first, so nothing can attach a
// new file to them before the caller's delete commits. Rows are locked in id order, so two
// deletes over the same lessons can't deadlock.
export async function lockLessonFiles(
  scope: LessonScope,
  transaction: Transaction,
): Promise<string[]> {
  const [condition, value] =
    'classId' in scope
      ? ['class_id = $value', scope.classId]
      : 'unitId' in scope
        ? ['unit_id = $value', scope.unitId]
        : 'lessonId' in scope
          ? ['id = $value', scope.lessonId]
          : ['id = ANY($value::uuid[])', scope.lessonIds];
  const lessons = await sequelize.query<{ id: string; fileId: string | null }>(
    `SELECT id, lesson_file_id AS "fileId" FROM lessons
      WHERE ${condition}
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

// For deleting a class (contract 4 and 4.1): locks every lesson the class holds, linked ones
// included, and their homework, FOR UPDATE in id order, so no new submission or file can
// attach to them. Returns the files that go with the class: those of its own (class-only)
// lessons and the pages its roster handed in. Files of linked lessons stay with the group.
export async function lockClassFiles(classId: string, transaction: Transaction): Promise<string[]> {
  const lessons = await sequelize.query<{ id: string; fileId: string | null; own: boolean }>(
    `SELECT l.id, l.lesson_file_id AS "fileId", l.class_id IS NOT NULL AS own
       FROM lessons l
      WHERE l.class_id = $classId
         OR l.id IN (SELECT cl.lesson_id FROM class_lessons cl WHERE cl.class_id = $classId)
      ORDER BY l.id
        FOR UPDATE OF l`,
    { bind: { classId }, type: QueryTypes.SELECT, transaction },
  );
  const homeworks = await sequelize.query<{ fileId: string | null; lessonId: string }>(
    `SELECT instructions_file_id AS "fileId", lesson_id AS "lessonId" FROM homeworks
      WHERE lesson_id = ANY($lessonIds::uuid[])
      ORDER BY id
        FOR UPDATE`,
    { bind: { lessonIds: lessons.map((lesson) => lesson.id) }, type: QueryTypes.SELECT, transaction },
  );
  const own = new Set(lessons.filter((lesson) => lesson.own).map((lesson) => lesson.id));

  return [
    ...lessons.filter((lesson) => lesson.own).map((lesson) => lesson.fileId).filter(present),
    ...homeworks.filter((homework) => own.has(homework.lessonId)).map((homework) => homework.fileId).filter(present),
    ...(await pageFileIds({ rosterOf: classId }, transaction)),
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
