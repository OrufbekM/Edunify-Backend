import { QueryTypes, Transaction } from 'sequelize';

import { sequelize } from '../../db/index.js';
import type { HomeworkType, Role } from '../../db/models/enums.js';
import {
  AiJob,
  ClassLesson,
  ClassUnit,
  FileRecord,
  Homework,
  Lesson,
  SchoolClass,
  Submission,
  Unit,
} from '../../db/models/index.js';
import { LESSON_CAP, UNIT_CAP } from '../../lib/caps.js';
import { AppError, notFoundAs } from '../../lib/errors.js';
import { orderOutOfRange, placeAt, writePositions } from '../../lib/positions.js';
import { toFileRef, type FileRef } from '../../lib/signedUrl.js';
import type { Upload } from '../../middleware/upload.js';
import { getOwnClass, lockClassContent } from '../classes/service.js';
import {
  createFileRecord,
  deleteFileRows,
  lockLessonFiles,
  pageFileIds,
  removeStoredFiles,
  withStoredFile,
} from '../files/service.js';
import { getConnectedClassStudent } from '../students/service.js';
import { newSubmissionCountsByLesson } from '../submissions/counts.js';
import { latestSubmissionOf, type SubmissionDto } from '../submissions/service.js';
import { copyLessonsFor, deleteOrphanLessons, renumberLinked } from './copies.js';
import {
  assertVisibleToStudent,
  buildOutline,
  findPlacement,
  lessonsOfUnit,
  normalizeSlots,
  writeSlots,
  writeUnitOrder,
  type ClassOutline,
  type OutlineLesson,
} from './placements.js';

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

// Linked lessons need a class group (contract 8.6).
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

// What a content write holds (plan, rules: locking): the class, and in a group every class
// of the group, so moves that race still leave positions dense. `classIds` are the classes
// a group-wide change reaches: the group's, or the class alone.
interface Locked {
  schoolClass: SchoolClass;
  classIds: string[];
}

// A class that isn't the teacher's answers like a missing unit or lesson.
async function lockContent(
  teacherId: string,
  classId: string,
  notFound: () => AppError,
  transaction: Transaction,
): Promise<Locked> {
  return notFoundAs(lockClassContent(teacherId, classId, transaction), notFound);
}

// Contract 2.7: creating or linking an item may not push any class over a cap. In a group
// LIMIT_REACHED names the classes that would go over (`details.classIds`).
async function assertRoom(
  kind: 'units' | 'lessons',
  classIds: string[],
  grouped: boolean,
  transaction: Transaction,
): Promise<void> {
  if (classIds.length === 0) {
    return;
  }

  const cap = kind === 'units' ? UNIT_CAP : LESSON_CAP;
  const where = { classId: classIds };
  const rows =
    kind === 'units'
      ? await ClassUnit.count({ where, group: ['classId'], transaction })
      : await ClassLesson.count({ where, group: ['classId'], transaction });
  const counts = new Map(rows.map((row) => [String(row.classId), row.count]));
  const over = classIds.filter((id) => (counts.get(id) ?? 0) >= cap);

  if (over.length > 0) {
    throw new AppError('LIMIT_REACHED', `A class has at most ${cap} ${kind}`, grouped ? { classIds: over } : undefined);
  }
}

// The unit, placed in the teacher's own class (contract 8.6), with the content lock held.
async function ownPlacedUnit(
  teacherId: string,
  classId: string,
  unitId: string,
  transaction: Transaction,
): Promise<{ unit: Unit; placement: ClassUnit; locked: Locked }> {
  const locked = await lockContent(teacherId, classId, unitNotFound, transaction);
  const placement = await ClassUnit.findOne({ where: { classId, unitId }, transaction });
  const unit = placement && (await Unit.findByPk(unitId, { transaction }));

  if (!placement || !unit) {
    throw unitNotFound();
  }

  return { unit, placement, locked };
}

// The lesson, placed in the teacher's own class (contract 8.6).
async function ownPlacedLesson(
  teacherId: string,
  classId: string,
  lessonId: string,
  transaction?: Transaction,
): Promise<{ lesson: Lesson; placement: ClassLesson }> {
  await notFoundAs(getOwnClass(teacherId, classId, transaction), lessonNotFound);

  const placement = await findPlacement(classId, lessonId, transaction);
  const lesson = placement && (await Lesson.findByPk(lessonId, { transaction }));

  if (!placement || !lesson) {
    throw lessonNotFound();
  }

  return { lesson, placement };
}

// The same, for writes that change the class's content: the content lock first.
async function lockPlacedLesson(
  teacherId: string,
  classId: string,
  lessonId: string,
  transaction: Transaction,
): Promise<{ lesson: Lesson; placement: ClassLesson; locked: Locked }> {
  const locked = await lockContent(teacherId, classId, lessonNotFound, transaction);
  const placed = await ownPlacedLesson(teacherId, classId, lessonId, transaction);

  return { ...placed, locked };
}

function unitIdsOf(outline: ClassOutline): string[] {
  return outline.units.map((unit) => unit.id);
}

// The group's linked lessons in a unit, in linked order.
async function linkedOrderOf(groupId: string, unitId: string, transaction: Transaction): Promise<string[]> {
  const lessons = await Lesson.findAll({
    attributes: ['id'],
    where: { groupId, unitId },
    order: [
      ['position', 'ASC'],
      ['id', 'ASC'],
    ],
    transaction,
  });

  return lessons.map((lesson) => lesson.id);
}

// Where a linked lesson goes in its unit's linked order (contract 4.1, "Lesson order inside
// a unit"): right after the linked lesson that comes before it in this class's list, or
// first if none does. `list` is this class's list for the unit with the lesson in place.
async function placeLinked(
  groupId: string,
  unitId: string,
  lessonId: string,
  list: OutlineLesson[],
  transaction: Transaction,
): Promise<void> {
  const index = list.findIndex((entry) => entry.id === lessonId);
  const before = list
    .slice(0, index)
    .filter((entry) => entry.linked)
    .at(-1);
  const order = (await linkedOrderOf(groupId, unitId, transaction)).filter((id) => id !== lessonId);
  const at = before ? order.indexOf(before.id) + 1 : 0;

  await writePositions('lessons', [...order.slice(0, at), lessonId, ...order.slice(at)], transaction);
}

// Units in order, then lessons in outline order, each with its number (contract 8.6).
// Students get visible lessons only, and only units that hold one; numbers keep their gaps.
// Teachers also get each lesson's newSubmissionCount. One REPEATABLE READ snapshot, so a
// move made between the reads can't split the picture.
export async function getOutline(viewer: Viewer, classId: string): Promise<OutlineDto> {
  return sequelize.transaction(
    { isolationLevel: Transaction.ISOLATION_LEVELS.REPEATABLE_READ },
    async (transaction) => {
      await assertCanView(viewer, classId, transaction);

      const outline = await buildOutline(classId, transaction);
      const teacher = viewer.role === 'teacher';
      const lessons = teacher ? outline.lessons : outline.lessons.filter((lesson) => lesson.visible);
      const newSubmissions = teacher ? await newSubmissionCountsByLesson(classId, transaction) : new Map<string, number>();
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
          ...(teacher
            ? {
                linked: lesson.linked,
                visible: lesson.visible,
                newSubmissionCount: newSubmissions.get(lesson.id) ?? 0,
              }
            : {}),
        })),
      };
    },
  );
}

// Appended last (contract 8.6). In a group the unit is the group's, appended last in every
// class of the group.
export async function createUnit(teacherId: string, classId: string, input: { title: string }): Promise<UnitDto> {
  return sequelize.transaction(async (transaction) => {
    const { schoolClass, classIds } = await lockClassContent(teacherId, classId, transaction);
    const groupId = schoolClass.groupId;

    await assertRoom('units', classIds, groupId !== null, transaction);

    const count = await ClassUnit.count({ where: { classId }, transaction });
    const unit = await Unit.create({ classId: groupId ? null : classId, groupId, title: input.title }, { transaction });
    await ClassUnit.bulkCreate(
      classIds.map((id) => ({ classId: id, unitId: unit.id, position: count })),
      { transaction },
    );

    return { id: unit.id, classId, title: unit.title, order: count };
  });
}

// In a group the title and the order change in every class (contract 8.6): the unit row is
// shared, and every class gets the same order.
export async function updateUnit(
  teacherId: string,
  classId: string,
  unitId: string,
  input: { title?: string; order?: number },
): Promise<UnitDto> {
  return sequelize.transaction(async (transaction) => {
    const { unit, placement, locked } = await ownPlacedUnit(teacherId, classId, unitId, transaction);

    if (input.order !== undefined) {
      const ids = unitIdsOf(await buildOutline(classId, transaction));

      if (input.order > ids.length - 1) {
        throw orderOutOfRange(ids.length - 1);
      }

      const order = placeAt(ids, unitId, input.order);
      for (const id of locked.classIds) {
        await writeUnitOrder(id, order, transaction);
      }
      await placement.reload({ transaction });
    }

    if (input.title !== undefined) {
      unit.title = input.title;
      await unit.save({ transaction });
    }

    return { id: unit.id, classId, title: unit.title, order: placement.position };
  });
}

// Every class keeps at least one unit (contract 8.6). Outside a group the unit goes with
// its lessons, their homework and submissions, and their files once the transaction has
// committed. A group's unit goes from every class, and only once no class has a lesson in it.
export async function deleteUnit(teacherId: string, classId: string, unitId: string): Promise<void> {
  const storageKeys = await sequelize.transaction(async (transaction) => {
    const { unit, locked } = await ownPlacedUnit(teacherId, classId, unitId, transaction);
    const ids = unitIdsOf(await buildOutline(classId, transaction));

    if (ids.length <= 1) {
      throw new AppError('LAST_UNIT', 'A class must keep at least one unit', { classIds: locked.classIds });
    }

    if (unit.groupId && (await Lesson.count({ where: { unitId }, transaction })) > 0) {
      throw new AppError('UNIT_NOT_EMPTY');
    }

    const fileIds = unit.groupId ? [] : await lockLessonFiles({ unitId }, transaction);

    await unit.destroy({ transaction });
    for (const id of locked.classIds) {
      await writeUnitOrder(
        id,
        ids.filter((other) => other !== unitId),
        transaction,
      );
    }

    return deleteFileRows(fileIds, transaction);
  });

  await removeStoredFiles(storageKeys);
}

// Appended last in its unit, visible (contract 8.6). `linked: true` needs a group: the
// lesson is the group's, last in the unit's linked order, and every other class of the group
// gets it too, hidden.
export async function createLesson(
  teacherId: string,
  classId: string,
  input: { title: string; unitId: string; linked?: boolean },
): Promise<LessonDetailDto> {
  return sequelize.transaction(async (transaction) => {
    const { schoolClass, classIds } = await lockClassContent(teacherId, classId, transaction);
    const groupId = schoolClass.groupId;

    if (input.linked && groupId === null) {
      throw needsGroup();
    }

    await assertRoom('lessons', input.linked ? classIds : [classId], groupId !== null, transaction);

    const outline = await buildOutline(classId, transaction);

    if (!outline.units.some((unit) => unit.id === input.unitId)) {
      throw unknownUnit();
    }

    if (input.linked && groupId) {
      const lesson = await Lesson.create(
        {
          classId: null,
          groupId,
          unitId: input.unitId,
          title: input.title,
          position: (await linkedOrderOf(groupId, input.unitId, transaction)).length,
          lessonFileId: null,
        },
        { transaction },
      );
      await ClassLesson.bulkCreate(
        classIds.map((id) => ({ classId: id, lessonId: lesson.id, position: null, visible: id === classId })),
        { transaction },
      );

      return lessonDetail(classId, lesson, 'teacher', transaction);
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

// linked: true on a class-only lesson (contract 8.6). It keeps its place in this class's
// list: its slot goes, and it joins the linked order right after the linked lesson before
// it. Every other class of the group gets it, hidden. The slots are made the indices first,
// which is what keeps the place.
async function linkLesson(
  lesson: Lesson,
  placement: ClassLesson,
  locked: Locked,
  transaction: Transaction,
): Promise<void> {
  const classId = locked.schoolClass.id;
  const groupId = locked.schoolClass.groupId as string;
  const others = locked.classIds.filter((id) => id !== classId);

  await assertRoom('lessons', others, true, transaction);
  await normalizeSlots([classId], [lesson.unitId], transaction);

  const list = lessonsOfUnit(await buildOutline(classId, transaction), lesson.unitId);
  // Placed last for now: the linked order is written right after.
  await lesson.update({ classId: null, groupId, position: list.length }, { transaction });
  await placement.update({ position: null }, { transaction });
  await placeLinked(
    groupId,
    lesson.unitId,
    lesson.id,
    list.map((entry) => (entry.id === lesson.id ? { ...entry, linked: true } : entry)),
    transaction,
  );
  await ClassLesson.bulkCreate(
    others.map((id) => ({ classId: id, lessonId: lesson.id, position: null, visible: false })),
    { transaction },
  );
  await normalizeSlots(locked.classIds, [lesson.unitId], transaction);
}

// linked: false on a linked lesson (contract 8.6): a class-only copy in this class at the
// same place, with this class's submissions and AI jobs moved to it. The original stays in
// the other classes, or goes if no class holds it any more. Returns the copy, and files that
// may have lost their last reference.
async function unlinkLesson(
  lesson: Lesson,
  locked: Locked,
  transaction: Transaction,
): Promise<{ lesson: Lesson; placement: ClassLesson; fileIds: string[] }> {
  const classId = locked.schoolClass.id;
  const entry = placed(await buildOutline(classId, transaction), lesson.id);
  const copies = await copyLessonsFor(classId, [{ lessonId: lesson.id, slot: entry.order }], new Map(), transaction);
  const copyId = copies.get(lesson.id) as string;
  const fileIds = await deleteOrphanLessons(lesson.groupId as string, transaction);

  await normalizeSlots([classId], [lesson.unitId], transaction);

  return {
    lesson: (await Lesson.findByPk(copyId, { transaction })) as Lesson,
    placement: (await findPlacement(classId, copyId, transaction)) as ClassLesson,
    fileIds,
  };
}

// A linked lesson moves in every class (contract 4.1): to its new unit everywhere, and in
// the linked order right after the linked lesson that comes before it in this class's list.
// A class-only lesson moves in this class only, by its slot.
async function moveLesson(
  lesson: Lesson,
  locked: Locked,
  input: { unitId?: string; order?: number },
  transaction: Transaction,
): Promise<void> {
  const classId = locked.schoolClass.id;
  const fromUnitId = lesson.unitId;
  const toUnitId = input.unitId ?? fromUnitId;
  const outline = await buildOutline(classId, transaction);

  if (!outline.units.some((unit) => unit.id === toUnitId)) {
    throw unknownUnit();
  }

  const target = lessonsOfUnit(outline, toUnitId).filter((entry) => entry.id !== lesson.id);
  const order = input.order ?? target.length;

  if (order > target.length) {
    throw orderOutOfRange(target.length);
  }

  const self = placed(outline, lesson.id);
  const list = [...target.slice(0, order), { ...self, unitId: toUnitId }, ...target.slice(order)];

  if (toUnitId !== fromUnitId) {
    await lesson.update({ unitId: toUnitId }, { transaction });
  }

  if (lesson.groupId) {
    await placeLinked(lesson.groupId, toUnitId, lesson.id, list, transaction);

    if (toUnitId !== fromUnitId) {
      await renumberLinked(lesson.groupId, fromUnitId, transaction);
    }

    await normalizeSlots(locked.classIds, [fromUnitId, toUnitId], transaction);
    return;
  }

  await writeSlots(
    classId,
    list.map((entry) => entry.id),
    transaction,
  );

  if (toUnitId !== fromUnitId) {
    await writeSlots(
      classId,
      lessonsOfUnit(outline, fromUnitId)
        .map((entry) => entry.id)
        .filter((id) => id !== lesson.id),
      transaction,
    );
  }
}

// `linked` first, so the other changes apply to what the lesson has become: a title change
// on a linked lesson reaches every class, on the copy only this one. `unitId` and `order`
// follow contract 8.6; `visible` is this class only.
export async function updateLesson(
  teacherId: string,
  classId: string,
  lessonId: string,
  input: { title?: string; unitId?: string; order?: number; linked?: boolean; visible?: boolean },
): Promise<LessonDetailDto> {
  const { detail, storageKeys } = await sequelize.transaction(async (transaction) => {
    const owned = await lockPlacedLesson(teacherId, classId, lessonId, transaction);
    const { locked } = owned;
    let { lesson, placement } = owned;
    let fileIds: string[] = [];

    if (input.linked === true && lesson.groupId === null) {
      if (locked.schoolClass.groupId === null) {
        throw needsGroup();
      }

      await linkLesson(lesson, placement, locked, transaction);
    } else if (input.linked === false && lesson.groupId !== null) {
      ({ lesson, placement, fileIds } = await unlinkLesson(lesson, locked, transaction));
    }

    if (input.unitId !== undefined || input.order !== undefined) {
      await moveLesson(lesson, locked, input, transaction);
    }

    if (input.title !== undefined) {
      await lesson.update({ title: input.title }, { transaction });
    }

    if (input.visible !== undefined) {
      await placement.update({ visible: input.visible }, { transaction });
    }

    await lesson.reload({ transaction });

    return {
      detail: await lessonDetail(classId, lesson, 'teacher', transaction),
      storageKeys: await deleteFileRows(fileIds, transaction),
    };
  });

  await removeStoredFiles(storageKeys);
  return detail;
}

// A linked lesson leaves one class (contract 8.6, scope=class): the placement goes, with
// the class's submissions for its homework and its AI jobs for it. The lesson and its
// homework are locked FOR UPDATE first, so no new submission lands meanwhile.
async function removeFromClass(lesson: Lesson, classId: string, transaction: Transaction): Promise<string[]> {
  await Lesson.findByPk(lesson.id, { lock: Transaction.LOCK.UPDATE, transaction });

  const homework = await Homework.findOne({ where: { lessonId: lesson.id }, lock: Transaction.LOCK.UPDATE, transaction });
  const fileIds = homework ? await pageFileIds({ homeworkIds: [homework.id], classId }, transaction) : [];

  if (homework) {
    await sequelize.query(
      `DELETE FROM submissions s USING class_students cs
        WHERE s.homework_id = $homeworkId AND cs.id = s.class_student_id AND cs.class_id = $classId`,
      { bind: { homeworkId: homework.id, classId }, transaction },
    );
  }

  await AiJob.destroy({ where: { lessonId: lesson.id, classId }, transaction });
  await ClassLesson.destroy({ where: { classId, lessonId: lesson.id }, transaction });

  return [...fileIds, ...(await deleteOrphanLessons(lesson.groupId as string, transaction))];
}

// scope=class (the default) removes the lesson from this class: a class-only lesson is
// deleted, a linked one leaves this class only. scope=all deletes a linked lesson from every
// class (contract 8.6). Homework and submissions go with it where it goes; files once the
// transaction has committed, and only those nothing else references.
export async function deleteLesson(
  teacherId: string,
  classId: string,
  lessonId: string,
  scope: 'class' | 'all',
): Promise<void> {
  const storageKeys = await sequelize.transaction(async (transaction) => {
    const { lesson, locked } = await lockPlacedLesson(teacherId, classId, lessonId, transaction);
    const { groupId, unitId } = lesson;

    if (scope === 'all' && groupId === null) {
      throw new AppError('VALIDATION_ERROR', 'Only a linked lesson can be deleted from every class', [
        { path: 'scope', message: 'Only a linked lesson can be deleted from every class' },
      ]);
    }

    let fileIds: string[];

    if (groupId && scope === 'class') {
      fileIds = await removeFromClass(lesson, classId, transaction);
      await normalizeSlots([classId], [unitId], transaction);
    } else {
      fileIds = await lockLessonFiles({ lessonId }, transaction);
      await lesson.destroy({ transaction });

      if (groupId) {
        await renumberLinked(groupId, unitId, transaction);
      }

      await normalizeSlots(groupId ? locked.classIds : [classId], [unitId], transaction);
    }

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
