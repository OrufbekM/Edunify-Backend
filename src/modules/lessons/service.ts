import { QueryTypes, Transaction } from 'sequelize';

import { sequelize } from '../../db/index.js';
import type { HomeworkType, Role } from '../../db/models/enums.js';
import {
  ClassLesson,
  ClassUnit,
  FileRecord,
  Homework,
  Lesson,
  Submission,
  Unit,
} from '../../db/models/index.js';
import { AppError, notFoundAs } from '../../lib/errors.js';
import { orderOutOfRange, placeAt } from '../../lib/positions.js';
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
import { getConnectedClassStudent } from '../students/service.js';
import { latestSubmissionOf, type SubmissionDto } from '../submissions/service.js';
import {
  assertVisibleToStudent,
  buildOutline,
  findPlacement,
  lessonsOfUnit,
  writeSlots,
  writeUnitOrder,
  type ClassOutline,
  type OutlineLesson,
} from './placements.js';

// Contract 2.7: a group's units and linked lessons count in every class that holds them,
// which counting placements does.
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
  unitId: string;
  number: number;
  title: string;
  order: number;
  homeworkType: HomeworkType | null;
  linked?: boolean;
  visible?: boolean;
  newSubmissionCount?: number;
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
  unitId: string;
  number: number;
  title: string;
  order: number;
  lessonFile: FileRef | null;
  homework: HomeworkDto | null;
  linked?: boolean;
  visible?: boolean;
  mySubmission?: SubmissionDto | null;
}

export interface OutlineDto {
  units: UnitDto[];
  lessons: LessonSummaryDto[];
}

export interface ContentImpactDto {
  classes: { id: string; name: string; submissionCount: number }[];
}

// One message for "missing" and "not yours", so the body reveals nothing (contract 2.4).
function unitNotFound(): AppError {
  return new AppError('NOT_FOUND', 'Unit not found');
}

function lessonNotFound(): AppError {
  return new AppError('NOT_FOUND', 'Lesson not found');
}

function homeworkNotFound(): AppError {
  return new AppError('NOT_FOUND', 'Homework not found');
}

function unknownUnit(): AppError {
  return new AppError('VALIDATION_ERROR', 'Unknown unit', [{ path: 'unitId', message: 'Unknown unit' }]);
}

// Linked lessons need a class group (contract 8.6); groups arrive in plan Phase 17.
function needsGroup(): AppError {
  return new AppError('VALIDATION_ERROR', 'The class is not linked with other classes', [
    { path: 'linked', message: 'Only a class in a group can have linked lessons' },
  ]);
}

// The homework of a lesson, with its instructions file signed afresh (contract 7).
export async function homeworkOf(lesson: Lesson, transaction?: Transaction): Promise<HomeworkDto | null> {
  const homework = await Homework.findOne({ where: { lessonId: lesson.id }, transaction });

  if (!homework) {
    return null;
  }

  const file = homework.instructionsFileId
    ? await FileRecord.findByPk(homework.instructionsFileId, { transaction })
    : null;

  return {
    id: homework.id,
    lessonId: homework.lessonId,
    type: homework.type,
    instructionsText: homework.instructionsText,
    instructionsFile: file ? toFileRef(file) : null,
  };
}

function placed(outline: ClassOutline, lessonId: string): OutlineLesson {
  const entry = outline.lessons.find((lesson) => lesson.id === lessonId);

  if (!entry) {
    throw lessonNotFound();
  }

  return entry;
}

// The lesson as it sits in this class: its number and order there, and for the teacher
// whether it is linked and visible (contract 3). Without mySubmission, which only a student's
// GET /lessons/:id carries.
async function lessonDetail(
  classId: string,
  lesson: Lesson,
  role: Role,
  transaction?: Transaction,
): Promise<LessonDetailDto> {
  const outline = await buildOutline(classId, transaction);
  const entry = placed(outline, lesson.id);
  const lessonFile = lesson.lessonFileId ? await FileRecord.findByPk(lesson.lessonFileId, { transaction }) : null;

  return {
    id: lesson.id,
    classId,
    unitId: lesson.unitId,
    number: entry.number,
    title: lesson.title,
    order: entry.order,
    lessonFile: lessonFile ? toFileRef(lessonFile) : null,
    homework: await homeworkOf(lesson, transaction),
    ...(role === 'teacher' ? { linked: entry.linked, visible: entry.visible } : {}),
  };
}

// Teachers see their own classes, students the classes they are connected to (contract 5);
// both checks answer 404 'Class not found' otherwise.
async function assertCanView(viewer: Viewer, classId: string, transaction?: Transaction): Promise<void> {
  if (viewer.role === 'teacher') {
    await getOwnClass(viewer.id, classId, transaction);
  } else {
    await getConnectedClassStudent(viewer.id, classId, transaction);
  }
}

// Every write to a class's content holds its class lock, so moves that race still leave
// positions dense. A class that isn't the teacher's answers like a missing unit or lesson.
async function lockClassFor(
  teacherId: string,
  classId: string,
  notFound: () => AppError,
  transaction: Transaction,
): Promise<void> {
  await notFoundAs(lockOwnClass(teacherId, classId, transaction), notFound);
}

// The unit, placed in the teacher's own class (contract 8.6).
async function ownPlacedUnit(
  teacherId: string,
  classId: string,
  unitId: string,
  transaction: Transaction,
): Promise<{ unit: Unit; placement: ClassUnit }> {
  await lockClassFor(teacherId, classId, unitNotFound, transaction);

  const placement = await ClassUnit.findOne({ where: { classId, unitId }, transaction });
  const unit = placement && (await Unit.findByPk(unitId, { transaction }));

  if (!placement || !unit) {
    throw unitNotFound();
  }

  return { unit, placement };
}

// The lesson, placed in the teacher's own class (contract 8.6). With `lock`, the class lock
// is taken first, for writes that change the class's content.
async function ownPlacedLesson(
  teacherId: string,
  classId: string,
  lessonId: string,
  transaction?: Transaction,
  { lock = false }: { lock?: boolean } = {},
): Promise<{ lesson: Lesson; placement: ClassLesson }> {
  if (lock && transaction) {
    await lockClassFor(teacherId, classId, lessonNotFound, transaction);
  } else {
    await notFoundAs(getOwnClass(teacherId, classId, transaction), lessonNotFound);
  }

  const placement = await findPlacement(classId, lessonId, transaction);
  const lesson = placement && (await Lesson.findByPk(lessonId, { transaction }));

  if (!placement || !lesson) {
    throw lessonNotFound();
  }

  return { lesson, placement };
}

function unitIdsOf(outline: ClassOutline): string[] {
  return outline.units.map((unit) => unit.id);
}

// Units in order, then lessons in outline order, each with its number (contract 8.6).
// Students get visible lessons only, and only units that hold one; numbers keep their gaps.
// One REPEATABLE READ snapshot, so a move made between the reads can't split the picture.
export async function getOutline(viewer: Viewer, classId: string): Promise<OutlineDto> {
  return sequelize.transaction(
    { isolationLevel: Transaction.ISOLATION_LEVELS.REPEATABLE_READ },
    async (transaction) => {
      await assertCanView(viewer, classId, transaction);

      const outline = await buildOutline(classId, transaction);
      const teacher = viewer.role === 'teacher';
      const lessons = teacher ? outline.lessons : outline.lessons.filter((lesson) => lesson.visible);
      const unitsWithLessons = new Set(lessons.map((lesson) => lesson.unitId));

      return {
        units: outline.units
          .filter((unit) => teacher || unitsWithLessons.has(unit.id))
          .map((unit) => ({ id: unit.id, classId, title: unit.title, order: unit.order })),
        lessons: lessons.map((lesson) => ({
          id: lesson.id,
          unitId: lesson.unitId,
          number: lesson.number,
          title: lesson.title,
          order: lesson.order,
          homeworkType: lesson.homeworkType,
          // Counted from plan Phase 16.
          ...(teacher ? { linked: lesson.linked, visible: lesson.visible, newSubmissionCount: 0 } : {}),
        })),
      };
    },
  );
}

// Appended last (contract 8.6).
export async function createUnit(teacherId: string, classId: string, input: { title: string }): Promise<UnitDto> {
  return sequelize.transaction(async (transaction) => {
    await lockOwnClass(teacherId, classId, transaction);

    const count = await ClassUnit.count({ where: { classId }, transaction });

    if (count >= UNIT_CAP) {
      throw new AppError('LIMIT_REACHED', `A class has at most ${UNIT_CAP} units`);
    }

    const unit = await Unit.create({ classId, groupId: null, title: input.title }, { transaction });
    await ClassUnit.create({ classId, unitId: unit.id, position: count }, { transaction });

    return { id: unit.id, classId, title: unit.title, order: count };
  });
}

export async function updateUnit(
  teacherId: string,
  classId: string,
  unitId: string,
  input: { title?: string; order?: number },
): Promise<UnitDto> {
  return sequelize.transaction(async (transaction) => {
    const { unit, placement } = await ownPlacedUnit(teacherId, classId, unitId, transaction);

    if (input.order !== undefined) {
      const ids = unitIdsOf(await buildOutline(classId, transaction));

      if (input.order > ids.length - 1) {
        throw orderOutOfRange(ids.length - 1);
      }

      await writeUnitOrder(classId, placeAt(ids, unitId, input.order), transaction);
      await placement.reload({ transaction });
    }

    if (input.title !== undefined) {
      unit.title = input.title;
      await unit.save({ transaction });
    }

    return { id: unit.id, classId, title: unit.title, order: placement.position };
  });
}

// A class keeps at least one unit (contract 8.6). The unit goes with its lessons, their
// homework and submissions; their files go once the transaction has committed.
export async function deleteUnit(teacherId: string, classId: string, unitId: string): Promise<void> {
  const storageKeys = await sequelize.transaction(async (transaction) => {
    const { unit } = await ownPlacedUnit(teacherId, classId, unitId, transaction);
    const ids = unitIdsOf(await buildOutline(classId, transaction));

    if (ids.length <= 1) {
      throw new AppError('LAST_UNIT', 'A class must keep at least one unit', { classIds: [classId] });
    }

    const fileIds = await lockLessonFiles({ unitId }, transaction);

    await unit.destroy({ transaction });
    await writeUnitOrder(
      classId,
      ids.filter((id) => id !== unitId),
      transaction,
    );

    return deleteFileRows(fileIds, transaction);
  });

  await removeStoredFiles(storageKeys);
}

// Appended last in its unit, visible (contract 8.6).
export async function createLesson(
  teacherId: string,
  classId: string,
  input: { title: string; unitId: string; linked?: boolean },
): Promise<LessonDetailDto> {
  return sequelize.transaction(async (transaction) => {
    const schoolClass = await lockOwnClass(teacherId, classId, transaction);

    if (input.linked && schoolClass.groupId === null) {
      throw needsGroup();
    }

    if ((await ClassLesson.count({ where: { classId }, transaction })) >= LESSON_CAP) {
      throw new AppError('LIMIT_REACHED', `A class has at most ${LESSON_CAP} lessons`);
    }

    const outline = await buildOutline(classId, transaction);

    if (!outline.units.some((unit) => unit.id === input.unitId)) {
      throw unknownUnit();
    }

    const lesson = await Lesson.create(
      { classId, groupId: null, unitId: input.unitId, title: input.title, position: null, lessonFileId: null },
      { transaction },
    );
    await ClassLesson.create(
      { classId, lessonId: lesson.id, position: lessonsOfUnit(outline, input.unitId).length },
      { transaction },
    );

    return lessonDetail(classId, lesson, 'teacher', transaction);
  });
}

// `unitId` moves the lesson to another unit of the class; a move without `order` appends it
// last. `order` is the target index in this class's list of the unit it ends up in (contract
// 8.6). Every lesson is class-only until class groups arrive (plan Phase 17), so a move
// changes this class only. `visible` is this class only.
export async function updateLesson(
  teacherId: string,
  classId: string,
  lessonId: string,
  input: { title?: string; unitId?: string; order?: number; linked?: boolean; visible?: boolean },
): Promise<LessonDetailDto> {
  return sequelize.transaction(async (transaction) => {
    const { lesson, placement } = await ownPlacedLesson(teacherId, classId, lessonId, transaction, { lock: true });

    if (input.linked === true && lesson.groupId === null) {
      throw needsGroup();
    }

    const fromUnitId = lesson.unitId;
    const toUnitId = input.unitId ?? fromUnitId;

    if (toUnitId !== fromUnitId || input.order !== undefined) {
      const outline = await buildOutline(classId, transaction);

      if (!outline.units.some((unit) => unit.id === toUnitId)) {
        throw unknownUnit();
      }

      const target = lessonsOfUnit(outline, toUnitId)
        .map((entry) => entry.id)
        .filter((id) => id !== lessonId);
      const order = input.order ?? target.length;

      if (order > target.length) {
        throw orderOutOfRange(target.length);
      }

      lesson.unitId = toUnitId;
      await lesson.save({ transaction });
      await writeSlots(classId, placeAt(target, lessonId, order), transaction);

      if (toUnitId !== fromUnitId) {
        const source = lessonsOfUnit(outline, fromUnitId)
          .map((entry) => entry.id)
          .filter((id) => id !== lessonId);
        await writeSlots(classId, source, transaction);
      }
    }

    if (input.title !== undefined) {
      lesson.title = input.title;
      await lesson.save({ transaction });
    }

    if (input.visible !== undefined) {
      placement.visible = input.visible;
      await placement.save({ transaction });
    }

    return lessonDetail(classId, lesson, 'teacher', transaction);
  });
}

// scope=class removes the lesson from this class: a class-only lesson is deleted, with its
// homework and submissions. scope=all is for a linked lesson only (contract 8.6). The files
// go once the transaction has committed.
export async function deleteLesson(
  teacherId: string,
  classId: string,
  lessonId: string,
  scope: 'class' | 'all',
): Promise<void> {
  const storageKeys = await sequelize.transaction(async (transaction) => {
    const { lesson } = await ownPlacedLesson(teacherId, classId, lessonId, transaction, { lock: true });

    if (scope === 'all' && lesson.groupId === null) {
      throw new AppError('VALIDATION_ERROR', 'Only a linked lesson can be deleted from every class', [
        { path: 'scope', message: 'Only a linked lesson can be deleted from every class' },
      ]);
    }

    const outline = await buildOutline(classId, transaction);
    const fileIds = await lockLessonFiles({ lessonId }, transaction);

    await lesson.destroy({ transaction });
    await writeSlots(
      classId,
      lessonsOfUnit(outline, lesson.unitId)
        .map((entry) => entry.id)
        .filter((id) => id !== lessonId),
      transaction,
    );

    return deleteFileRows(fileIds, transaction);
  });

  await removeStoredFiles(storageKeys);
}

// Every class that holds the lesson, this one included, with how many of its students have
// handed the homework in (plan, open item 2): what deleting it from all of them would remove.
export async function getLessonImpact(teacherId: string, classId: string, lessonId: string): Promise<ContentImpactDto> {
  await ownPlacedLesson(teacherId, classId, lessonId);

  const classes = await sequelize.query<{ id: string; name: string; submissionCount: number }>(
    `SELECT c.id,
            c.name,
            (SELECT count(DISTINCT s.class_student_id)::int
               FROM submissions s
               JOIN homeworks h ON h.id = s.homework_id
               JOIN class_students cs ON cs.id = s.class_student_id
              WHERE h.lesson_id = cl.lesson_id AND cs.class_id = c.id) AS "submissionCount"
       FROM class_lessons cl
       JOIN classes c ON c.id = cl.class_id
      WHERE cl.lesson_id = $lessonId
      ORDER BY lower(c.name), c.name, c.id`,
    { bind: { lessonId }, type: QueryTypes.SELECT },
  );

  return { classes };
}

// Teachers: the lesson in their own class. Students: in a class they are connected to, and
// only while it is visible there; then also their latest version of its homework, built for
// a student, so without aiSuggestion (contract 3).
export async function getLesson(viewer: Viewer, classId: string, lessonId: string): Promise<LessonDetailDto> {
  if (viewer.role === 'teacher') {
    const { lesson } = await ownPlacedLesson(viewer.id, classId, lessonId);

    return lessonDetail(classId, lesson, 'teacher');
  }

  await assertVisibleToStudent(viewer.id, classId, lessonId, lessonNotFound);

  const lesson = await Lesson.findByPk(lessonId);

  if (!lesson) {
    throw lessonNotFound();
  }

  const row = await notFoundAs(getConnectedClassStudent(viewer.id, classId), lessonNotFound);
  const detail = await lessonDetail(classId, lesson, 'student');

  return {
    ...detail,
    mySubmission: detail.homework ? await latestSubmissionOf(row.id, detail.homework.id) : null,
  };
}

// For the routes to call before multer reads a body (see lessons/routes.ts).
export async function assertOwnLesson(teacherId: string, classId: string, lessonId: string): Promise<void> {
  await ownPlacedLesson(teacherId, classId, lessonId);
}

export async function assertOwnHomework(teacherId: string, classId: string, lessonId: string): Promise<void> {
  await ownPlacedLesson(teacherId, classId, lessonId);

  if ((await Homework.count({ where: { lessonId } })) === 0) {
    throw homeworkNotFound();
  }
}

// Every change to a lesson's file or homework holds this lock, so two at once can't both
// replace the same old file (orphaning one new one) or both create the homework. Deletes
// that collect the lesson's files lock it FOR UPDATE, which waits for this one.
async function lockLessonRow(
  teacherId: string,
  classId: string,
  lessonId: string,
  transaction: Transaction,
): Promise<Lesson> {
  await ownPlacedLesson(teacherId, classId, lessonId, transaction);

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
async function lockHomework(lessonId: string, transaction: Transaction): Promise<Homework | null> {
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
  classId: string,
  lessonId: string,
  upload: Upload,
): Promise<LessonDetailDto> {
  const { detail, replacedKeys } = await withStoredFile(upload.data, (storageKey) =>
    sequelize.transaction(async (transaction) => {
      const lesson = await lockLessonRow(teacherId, classId, lessonId, transaction);
      const file = await createFileRecord(teacherId, 'lesson', upload, storageKey, transaction);
      const replacedId = lesson.lessonFileId;

      lesson.lessonFileId = file.id;
      await lesson.save({ transaction });

      return {
        replacedKeys: replacedId ? await deleteFileRows([replacedId], transaction) : [],
        detail: await lessonDetail(classId, lesson, 'teacher', transaction),
      };
    }),
  );

  await removeStoredFiles(replacedKeys);
  return detail;
}

export async function removeLessonFile(teacherId: string, classId: string, lessonId: string): Promise<LessonDetailDto> {
  const { detail, removedKeys } = await sequelize.transaction(async (transaction) => {
    const lesson = await lockLessonRow(teacherId, classId, lessonId, transaction);
    const fileId = lesson.lessonFileId;

    if (!fileId) {
      throw new AppError('NOT_FOUND', 'Lesson file not found');
    }

    lesson.lessonFileId = null;
    await lesson.save({ transaction });

    return {
      removedKeys: await deleteFileRows([fileId], transaction),
      detail: await lessonDetail(classId, lesson, 'teacher', transaction),
    };
  });

  await removeStoredFiles(removedKeys);
  return detail;
}

// Creates or replaces (contract 2.1: PUT replaces), so an absent instructionsText clears
// it. Only the instructions file carries over (contract 8.7).
export async function putHomework(
  teacherId: string,
  classId: string,
  lessonId: string,
  input: { type: HomeworkType; instructionsText?: string | null },
): Promise<LessonDetailDto> {
  return sequelize.transaction(async (transaction) => {
    const lesson = await lockLessonRow(teacherId, classId, lessonId, transaction);
    const homework = await lockHomework(lessonId, transaction);
    const instructionsText = input.instructionsText ?? null;

    if (!homework) {
      await Homework.create(
        { lessonId, type: input.type, instructionsText, instructionsFileId: null },
        { transaction },
      );
    } else {
      // Any version of any submission counts, in any class that holds the lesson: its
      // content was made for the old type (contract 8.7).
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

    return lessonDetail(classId, lesson, 'teacher', transaction);
  });
}

// Deletes the homework with its submissions, grades and notifications (the database
// cascades them), then its instructions file and every submitted page once committed.
export async function deleteHomework(teacherId: string, classId: string, lessonId: string): Promise<LessonDetailDto> {
  const { detail, removedKeys } = await sequelize.transaction(async (transaction) => {
    const lesson = await lockLessonRow(teacherId, classId, lessonId, transaction);
    const homework = await requireHomework(lessonId, transaction);
    const fileIds = [
      ...(homework.instructionsFileId ? [homework.instructionsFileId] : []),
      ...(await pageFileIds({ homeworkIds: [homework.id] }, transaction)),
    ];

    await homework.destroy({ transaction });

    return {
      removedKeys: await deleteFileRows(fileIds, transaction),
      detail: await lessonDetail(classId, lesson, 'teacher', transaction),
    };
  });

  await removeStoredFiles(removedKeys);
  return detail;
}

export async function setHomeworkFile(
  teacherId: string,
  classId: string,
  lessonId: string,
  upload: Upload,
): Promise<LessonDetailDto> {
  const { detail, replacedKeys } = await withStoredFile(upload.data, (storageKey) =>
    sequelize.transaction(async (transaction) => {
      const lesson = await lockLessonRow(teacherId, classId, lessonId, transaction);
      const homework = await requireHomework(lessonId, transaction);
      const file = await createFileRecord(teacherId, 'instructions', upload, storageKey, transaction);
      const replacedId = homework.instructionsFileId;

      homework.instructionsFileId = file.id;
      await homework.save({ transaction });

      return {
        replacedKeys: replacedId ? await deleteFileRows([replacedId], transaction) : [],
        detail: await lessonDetail(classId, lesson, 'teacher', transaction),
      };
    }),
  );

  await removeStoredFiles(replacedKeys);
  return detail;
}

export async function removeHomeworkFile(teacherId: string, classId: string, lessonId: string): Promise<LessonDetailDto> {
  const { detail, removedKeys } = await sequelize.transaction(async (transaction) => {
    const lesson = await lockLessonRow(teacherId, classId, lessonId, transaction);
    const homework = await requireHomework(lessonId, transaction);
    const fileId = homework.instructionsFileId;

    if (!fileId) {
      throw new AppError('NOT_FOUND', 'Homework file not found');
    }

    homework.instructionsFileId = null;
    await homework.save({ transaction });

    return {
      removedKeys: await deleteFileRows([fileId], transaction),
      detail: await lessonDetail(classId, lesson, 'teacher', transaction),
    };
  });

  await removeStoredFiles(removedKeys);
  return detail;
}
