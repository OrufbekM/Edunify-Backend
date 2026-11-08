import { QueryTypes, Transaction } from 'sequelize';

import { sequelize } from '../../db/index.js';
import type { HomeworkType, Role } from '../../db/models/enums.js';
import {
  FileRecord,
  Homework,
  Lesson,
  SchoolClass,
  Submission,
  Unit,
} from '../../db/models/index.js';
import { AppError } from '../../lib/errors.js';
import { toFileRef, type FileRef } from '../../lib/signedUrl.js';
import type { Upload } from '../../middleware/upload.js';
import { getOwnClass, lockOwnClass } from '../classes/service.js';
import {
  createFileRecord,
  deleteFileRows,
  lockLessonFiles,
  pageFileIds,
  removeStoredFiles,
  withStoredFile,
} from '../files/service.js';
import { getActiveClassStudent } from '../students/service.js';
import { latestSubmissionOf, type SubmissionDto } from '../submissions/service.js';

const UNIT_CAP = 100;
const LESSON_CAP = 500;

export interface Viewer {
  id: string;
  role: Role;
}

export interface UnitDto {
  id: string;
  classId: string;
  title: string;
  order: number;
}

export interface LessonSummaryDto {
  id: string;
  unitId: string | null;
  title: string;
  order: number;
  homeworkType: HomeworkType | null;
}

export interface HomeworkDto {
  id: string;
  lessonId: string;
  type: HomeworkType;
  instructionsText: string | null;
  instructionsFile: FileRef | null;
}

export interface LessonDetailDto {
  id: string;
  classId: string;
  unitId: string | null;
  title: string;
  order: number;
  lessonFile: FileRef | null;
  homework: HomeworkDto | null;
  mySubmission?: SubmissionDto | null;
}

export interface OutlineDto {
  units: UnitDto[];
  lessons: LessonSummaryDto[];
}

function toUnitDto(unit: Unit): UnitDto {
  return { id: unit.id, classId: unit.classId, title: unit.title, order: unit.position };
}

// File URLs are signed afresh on every read (contract 7). Without mySubmission, which only
// a student's GET /lessons/:id carries (contract 3).
async function lessonDetail(lesson: Lesson, transaction?: Transaction): Promise<LessonDetailDto> {
  const homework = await Homework.findOne({ where: { lessonId: lesson.id }, transaction });
  const fileIds = [lesson.lessonFileId, homework?.instructionsFileId ?? null].filter(
    (id): id is string => id !== null,
  );
  const files =
    fileIds.length === 0 ? [] : await FileRecord.findAll({ where: { id: fileIds }, transaction });
  const fileRef = (id: string | null): FileRef | null => {
    const file = files.find((candidate) => candidate.id === id);
    return file ? toFileRef(file) : null;
  };

  return {
    id: lesson.id,
    classId: lesson.classId,
    unitId: lesson.unitId,
    title: lesson.title,
    order: lesson.position,
    lessonFile: fileRef(lesson.lessonFileId),
    homework: homework
      ? {
          id: homework.id,
          lessonId: homework.lessonId,
          type: homework.type,
          instructionsText: homework.instructionsText,
          instructionsFile: fileRef(homework.instructionsFileId),
        }
      : null,
  };
}

// One message for "missing" and "not yours", so the body reveals nothing (contract 2.4).
function unitNotFound(): AppError {
  return new AppError('NOT_FOUND', 'Unit not found');
}

function lessonNotFound(): AppError {
  return new AppError('NOT_FOUND', 'Lesson not found');
}

function orderOutOfRange(max: number): AppError {
  return new AppError('VALIDATION_ERROR', 'Order out of range', [
    { path: 'order', message: `Must be between 0 and ${max}` },
  ]);
}

// Teachers see their own classes, students the classes they have an active link to
// (contract 5); both checks answer 404 'Class not found' otherwise.
async function assertCanView(viewer: Viewer, classId: string, transaction?: Transaction) {
  if (viewer.role === 'teacher') {
    await getOwnClass(viewer.id, classId, transaction);
  } else {
    await getActiveClassStudent(viewer.id, classId, transaction);
  }
}

async function findOwnUnit(
  teacherId: string,
  unitId: string,
  transaction?: Transaction,
): Promise<Unit> {
  const unit = await Unit.findOne({
    where: { id: unitId },
    include: [{ model: SchoolClass, attributes: [], where: { teacherId }, required: true }],
    transaction,
  });

  if (!unit) {
    throw unitNotFound();
  }

  return unit;
}

async function findOwnLesson(
  teacherId: string,
  lessonId: string,
  transaction?: Transaction,
): Promise<Lesson> {
  const lesson = await Lesson.findOne({
    where: { id: lessonId },
    include: [{ model: SchoolClass, attributes: [], where: { teacherId }, required: true }],
    transaction,
  });

  if (!lesson) {
    throw lessonNotFound();
  }

  return lesson;
}

// Every write that changes positions holds the class lock, so moves that race still leave
// positions dense. The row is read again under the lock, because whoever held it before
// may have moved or deleted it.
async function lockOwnUnit(
  teacherId: string,
  unitId: string,
  transaction: Transaction,
): Promise<Unit> {
  const { classId } = await findOwnUnit(teacherId, unitId, transaction);
  await lockOwnClass(teacherId, classId, transaction);

  const unit = await Unit.findByPk(unitId, { transaction });

  if (!unit) {
    throw unitNotFound();
  }

  return unit;
}

async function lockOwnLesson(
  teacherId: string,
  lessonId: string,
  transaction: Transaction,
): Promise<Lesson> {
  const { classId } = await findOwnLesson(teacherId, lessonId, transaction);
  await lockOwnClass(teacherId, classId, transaction);

  const lesson = await Lesson.findByPk(lessonId, { transaction });

  if (!lesson) {
    throw lessonNotFound();
  }

  return lesson;
}

async function unitIds(classId: string, transaction: Transaction): Promise<string[]> {
  const units = await Unit.findAll({
    attributes: ['id'],
    where: { classId },
    order: [
      ['position', 'ASC'],
      ['id', 'ASC'],
    ],
    transaction,
  });

  return units.map((unit) => unit.id);
}

// The lessons of one unit, or of the no-unit group when unitId is null.
async function lessonIds(
  classId: string,
  unitId: string | null,
  transaction: Transaction,
): Promise<string[]> {
  const lessons = await Lesson.findAll({
    attributes: ['id'],
    where: { classId, unitId },
    order: [
      ['position', 'ASC'],
      ['id', 'ASC'],
    ],
    transaction,
  });

  return lessons.map((lesson) => lesson.id);
}

// Returns ids with `id` taken out (if it is there) and put back at index `order`.
function placeAt(ids: string[], id: string, order: number): string[] {
  const rest = ids.filter((other) => other !== id);

  return [...rest.slice(0, order), id, ...rest.slice(order)];
}

// Gives the rows positions 0..n-1 in the order listed, so the group stays dense
// (contract 4). Rows already in place are left alone.
async function writePositions(
  table: 'units' | 'lessons',
  ids: string[],
  transaction: Transaction,
): Promise<void> {
  if (ids.length === 0) {
    return;
  }

  await sequelize.query(
    `UPDATE ${table} AS t
        SET position = v.n - 1, updated_at = now()
       FROM unnest($ids::uuid[]) WITH ORDINALITY AS v(id, n)
      WHERE t.id = v.id AND t.position <> v.n - 1`,
    { bind: { ids }, transaction },
  );
}

// A lesson may only join a unit of its own class. Anything else, another teacher's unit
// included, is a VALIDATION_ERROR, as an unknown category is for a class.
async function assertUnitOfClass(
  unitId: string,
  classId: string,
  transaction: Transaction,
): Promise<void> {
  const unit = await Unit.findOne({ attributes: ['id'], where: { id: unitId, classId }, transaction });

  if (!unit) {
    throw new AppError('VALIDATION_ERROR', 'Unknown unit', [
      { path: 'unitId', message: 'Unknown unit' },
    ]);
  }
}

// Units by order, then lessons: the no-unit group first, then each unit's lessons in unit
// order (contract 8.6). One REPEATABLE READ snapshot, so a move made between the two
// reads can't produce a lesson whose unit is missing from the list.
export async function getOutline(viewer: Viewer, classId: string): Promise<OutlineDto> {
  return sequelize.transaction(
    { isolationLevel: Transaction.ISOLATION_LEVELS.REPEATABLE_READ },
    async (transaction) => {
      await assertCanView(viewer, classId, transaction);

      const units = await Unit.findAll({
        where: { classId },
        order: [
          ['position', 'ASC'],
          ['id', 'ASC'],
        ],
        transaction,
      });
      const lessons = await sequelize.query<LessonSummaryDto>(
        `SELECT l.id,
                l.unit_id AS "unitId",
                l.title,
                l.position AS "order",
                h.type AS "homeworkType"
           FROM lessons l
           LEFT JOIN units u ON u.id = l.unit_id
           LEFT JOIN homeworks h ON h.lesson_id = l.id
          WHERE l.class_id = $classId
          ORDER BY u.position NULLS FIRST, u.id NULLS FIRST, l.position, l.id`,
        { bind: { classId }, type: QueryTypes.SELECT, transaction },
      );

      return { units: units.map(toUnitDto), lessons };
    },
  );
}

export async function createUnit(
  teacherId: string,
  classId: string,
  input: { title: string },
): Promise<UnitDto> {
  return sequelize.transaction(async (transaction) => {
    await lockOwnClass(teacherId, classId, transaction);

    const count = await Unit.count({ where: { classId }, transaction });

    if (count >= UNIT_CAP) {
      throw new AppError('LIMIT_REACHED', `A class has at most ${UNIT_CAP} units`);
    }

    // Appended last; positions are dense, so the count is the next free one.
    return toUnitDto(await Unit.create({ classId, title: input.title, position: count }, { transaction }));
  });
}

export async function updateUnit(
  teacherId: string,
  unitId: string,
  input: { title?: string; order?: number },
): Promise<UnitDto> {
  return sequelize.transaction(async (transaction) => {
    const unit = await lockOwnUnit(teacherId, unitId, transaction);
    let siblings: string[] | undefined;

    if (input.order !== undefined) {
      siblings = await unitIds(unit.classId, transaction);

      if (input.order > siblings.length - 1) {
        throw orderOutOfRange(siblings.length - 1);
      }
    }

    if (input.title !== undefined) {
      unit.title = input.title;
      await unit.save({ transaction });
    }

    if (siblings && input.order !== undefined && input.order !== unit.position) {
      await writePositions('units', placeAt(siblings, unit.id, input.order), transaction);
      await unit.reload({ transaction });
    }

    return toUnitDto(unit);
  });
}

// Cascades the unit's lessons with their homework and submissions; their files go once the
// transaction has committed.
export async function deleteUnit(teacherId: string, unitId: string): Promise<void> {
  const storageKeys = await sequelize.transaction(async (transaction) => {
    const unit = await lockOwnUnit(teacherId, unitId, transaction);
    const fileIds = await lockLessonFiles({ unitId }, transaction);

    await unit.destroy({ transaction });
    await writePositions('units', await unitIds(unit.classId, transaction), transaction);

    return deleteFileRows(fileIds, transaction);
  });

  await removeStoredFiles(storageKeys);
}

export async function createLesson(
  teacherId: string,
  classId: string,
  input: { title: string; unitId?: string | null },
): Promise<LessonDetailDto> {
  return sequelize.transaction(async (transaction) => {
    await lockOwnClass(teacherId, classId, transaction);

    if ((await Lesson.count({ where: { classId }, transaction })) >= LESSON_CAP) {
      throw new AppError('LIMIT_REACHED', `A class has at most ${LESSON_CAP} lessons`);
    }

    const unitId = input.unitId ?? null;

    if (unitId !== null) {
      await assertUnitOfClass(unitId, classId, transaction);
    }

    // Appended last in its group.
    const position = await Lesson.count({ where: { classId, unitId }, transaction });
    const lesson = await Lesson.create(
      { classId, unitId, title: input.title, position },
      { transaction },
    );

    return lessonDetail(lesson, transaction);
  });
}

// `unitId` moves the lesson to that unit, or to the no-unit group with null. A move without
// `order` appends it last; `order` alone reorders it within its group. Both groups are
// renumbered (contract 4).
export async function updateLesson(
  teacherId: string,
  lessonId: string,
  input: { title?: string; unitId?: string | null; order?: number },
): Promise<LessonDetailDto> {
  return sequelize.transaction(async (transaction) => {
    const lesson = await lockOwnLesson(teacherId, lessonId, transaction);
    const fromUnitId = lesson.unitId;
    const toUnitId = input.unitId === undefined ? fromUnitId : input.unitId;
    const moving = toUnitId !== fromUnitId;
    let target: string[] | undefined;

    if (moving && toUnitId !== null) {
      await assertUnitOfClass(toUnitId, lesson.classId, transaction);
    }

    if (moving || input.order !== undefined) {
      const ids = await lessonIds(lesson.classId, toUnitId, transaction);
      // Joining a group, the lesson may also go after its last lesson.
      const maxOrder = moving ? ids.length : ids.length - 1;
      const order = input.order ?? ids.length;

      if (order > maxOrder) {
        throw orderOutOfRange(maxOrder);
      }

      target = placeAt(ids, lesson.id, order);
    }

    if (input.title !== undefined) {
      lesson.title = input.title;
    }
    lesson.unitId = toUnitId;
    await lesson.save({ transaction });

    if (target) {
      await writePositions('lessons', target, transaction);

      if (moving) {
        await writePositions(
          'lessons',
          await lessonIds(lesson.classId, fromUnitId, transaction),
          transaction,
        );
      }

      await lesson.reload({ transaction });
    }

    return lessonDetail(lesson, transaction);
  });
}

// Cascades homework and submissions; the files go once the transaction has committed.
export async function deleteLesson(teacherId: string, lessonId: string): Promise<void> {
  const storageKeys = await sequelize.transaction(async (transaction) => {
    const lesson = await lockOwnLesson(teacherId, lessonId, transaction);
    const fileIds = await lockLessonFiles({ lessonId }, transaction);

    await lesson.destroy({ transaction });
    await writePositions(
      'lessons',
      await lessonIds(lesson.classId, lesson.unitId, transaction),
      transaction,
    );

    return deleteFileRows(fileIds, transaction);
  });

  await removeStoredFiles(storageKeys);
}

export async function getLesson(viewer: Viewer, lessonId: string): Promise<LessonDetailDto> {
  if (viewer.role === 'teacher') {
    return lessonDetail(await findOwnLesson(viewer.id, lessonId));
  }

  const lesson = await Lesson.findByPk(lessonId);

  if (!lesson) {
    throw lessonNotFound();
  }

  let row: Awaited<ReturnType<typeof getActiveClassStudent>>;

  try {
    row = await getActiveClassStudent(viewer.id, lesson.classId);
  } catch (err) {
    throw err instanceof AppError && err.code === 'NOT_FOUND' ? lessonNotFound() : err;
  }

  const detail = await lessonDetail(lesson);

  // Their latest version, built for a student, so without aiSuggestion (contract 3).
  return {
    ...detail,
    mySubmission: detail.homework ? await latestSubmissionOf(row.id, detail.homework.id) : null,
  };
}

function homeworkNotFound(): AppError {
  return new AppError('NOT_FOUND', 'Homework not found');
}

// For the routes to call before multer reads a body (see lessons/routes.ts).
export async function assertOwnLesson(teacherId: string, lessonId: string): Promise<void> {
  await findOwnLesson(teacherId, lessonId);
}

export async function assertOwnHomework(teacherId: string, lessonId: string): Promise<void> {
  await findOwnLesson(teacherId, lessonId);

  if ((await Homework.count({ where: { lessonId } })) === 0) {
    throw homeworkNotFound();
  }
}

// Every change to a lesson's file or homework holds this lock, so two at once can't both
// replace the same old file (orphaning one new one) or both create the homework. Deletes
// that collect the lesson's files lock it FOR UPDATE, which waits for this one.
async function lockLessonRow(
  teacherId: string,
  lessonId: string,
  transaction: Transaction,
): Promise<Lesson> {
  await findOwnLesson(teacherId, lessonId, transaction);

  const lesson = await Lesson.findByPk(lessonId, {
    lock: Transaction.LOCK.NO_KEY_UPDATE,
    transaction,
  });

  if (!lesson) {
    throw lessonNotFound();
  }

  return lesson;
}

// FOR UPDATE, because a new submission's foreign key needs KEY SHARE on the homework row:
// while this is held, no submission can appear, so the count behind HOMEWORK_TYPE_LOCKED
// and the files collected for a delete stay true until commit.
async function lockHomework(
  lessonId: string,
  transaction: Transaction,
): Promise<Homework | null> {
  return Homework.findOne({ where: { lessonId }, lock: Transaction.LOCK.UPDATE, transaction });
}

async function requireHomework(lessonId: string, transaction: Transaction): Promise<Homework> {
  const homework = await lockHomework(lessonId, transaction);

  if (!homework) {
    throw homeworkNotFound();
  }

  return homework;
}

// Replaces any earlier file, whose stored bytes go once the transaction has committed.
export async function setLessonFile(
  teacherId: string,
  lessonId: string,
  upload: Upload,
): Promise<LessonDetailDto> {
  const { detail, replacedKeys } = await withStoredFile(upload.data, (storageKey) =>
    sequelize.transaction(async (transaction) => {
      const lesson = await lockLessonRow(teacherId, lessonId, transaction);
      const file = await createFileRecord(teacherId, 'lesson', upload, storageKey, transaction);
      const replacedId = lesson.lessonFileId;

      lesson.lessonFileId = file.id;
      await lesson.save({ transaction });

      return {
        replacedKeys: replacedId ? await deleteFileRows([replacedId], transaction) : [],
        detail: await lessonDetail(lesson, transaction),
      };
    }),
  );

  await removeStoredFiles(replacedKeys);
  return detail;
}

export async function removeLessonFile(
  teacherId: string,
  lessonId: string,
): Promise<LessonDetailDto> {
  const { detail, removedKeys } = await sequelize.transaction(async (transaction) => {
    const lesson = await lockLessonRow(teacherId, lessonId, transaction);
    const fileId = lesson.lessonFileId;

    if (!fileId) {
      throw new AppError('NOT_FOUND', 'Lesson file not found');
    }

    lesson.lessonFileId = null;
    await lesson.save({ transaction });

    return {
      removedKeys: await deleteFileRows([fileId], transaction),
      detail: await lessonDetail(lesson, transaction),
    };
  });

  await removeStoredFiles(removedKeys);
  return detail;
}

// Creates or replaces (contract 2.1: PUT replaces), so an absent instructionsText clears
// it. Only the instructions file carries over (contract 8.7).
export async function putHomework(
  teacherId: string,
  lessonId: string,
  input: { type: HomeworkType; instructionsText?: string | null },
): Promise<LessonDetailDto> {
  return sequelize.transaction(async (transaction) => {
    const lesson = await lockLessonRow(teacherId, lessonId, transaction);
    const homework = await lockHomework(lessonId, transaction);
    const instructionsText = input.instructionsText ?? null;

    if (!homework) {
      await Homework.create(
        { lessonId, type: input.type, instructionsText, instructionsFileId: null },
        { transaction },
      );
    } else {
      // Any version of any submission counts: its content was made for the old type.
      if (
        input.type !== homework.type &&
        (await Submission.count({ where: { homeworkId: homework.id }, transaction })) > 0
      ) {
        throw new AppError('HOMEWORK_TYPE_LOCKED');
      }

      homework.type = input.type;
      homework.instructionsText = instructionsText;
      await homework.save({ transaction });
    }

    return lessonDetail(lesson, transaction);
  });
}

// Deletes the homework with its submissions, grades and notifications (the database
// cascades them), then its instructions file and every submitted page once committed.
export async function deleteHomework(
  teacherId: string,
  lessonId: string,
): Promise<LessonDetailDto> {
  const { detail, removedKeys } = await sequelize.transaction(async (transaction) => {
    const lesson = await lockLessonRow(teacherId, lessonId, transaction);
    const homework = await requireHomework(lessonId, transaction);
    const fileIds = [
      ...(homework.instructionsFileId ? [homework.instructionsFileId] : []),
      ...(await pageFileIds({ homeworkIds: [homework.id] }, transaction)),
    ];

    await homework.destroy({ transaction });

    return {
      removedKeys: await deleteFileRows(fileIds, transaction),
      detail: await lessonDetail(lesson, transaction),
    };
  });

  await removeStoredFiles(removedKeys);
  return detail;
}

export async function setHomeworkFile(
  teacherId: string,
  lessonId: string,
  upload: Upload,
): Promise<LessonDetailDto> {
  const { detail, replacedKeys } = await withStoredFile(upload.data, (storageKey) =>
    sequelize.transaction(async (transaction) => {
      const lesson = await lockLessonRow(teacherId, lessonId, transaction);
      const homework = await requireHomework(lessonId, transaction);
      const file = await createFileRecord(
        teacherId,
        'instructions',
        upload,
        storageKey,
        transaction,
      );
      const replacedId = homework.instructionsFileId;

      homework.instructionsFileId = file.id;
      await homework.save({ transaction });

      return {
        replacedKeys: replacedId ? await deleteFileRows([replacedId], transaction) : [],
        detail: await lessonDetail(lesson, transaction),
      };
    }),
  );

  await removeStoredFiles(replacedKeys);
  return detail;
}

export async function removeHomeworkFile(
  teacherId: string,
  lessonId: string,
): Promise<LessonDetailDto> {
  const { detail, removedKeys } = await sequelize.transaction(async (transaction) => {
    const lesson = await lockLessonRow(teacherId, lessonId, transaction);
    const homework = await requireHomework(lessonId, transaction);
    const fileId = homework.instructionsFileId;

    if (!fileId) {
      throw new AppError('NOT_FOUND', 'Homework file not found');
    }

    homework.instructionsFileId = null;
    await homework.save({ transaction });

    return {
      removedKeys: await deleteFileRows([fileId], transaction),
      detail: await lessonDetail(lesson, transaction),
    };
  });

  await removeStoredFiles(removedKeys);
  return detail;
}
