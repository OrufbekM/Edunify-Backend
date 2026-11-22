import { randomUUID } from 'node:crypto';

import { Op, QueryTypes, Transaction } from 'sequelize';

import { sequelize } from '../../db/index.js';
import { ClassGroup, ClassUnit, SchoolClass, Unit } from '../../db/models/index.js';
import { AppError } from '../../lib/errors.js';
import { copyLessonsFor, deleteOrphanLessons } from '../lessons/copies.js';
import { buildOutline, writeUnitOrder } from '../lessons/placements.js';
import {
  planGroupChange,
  type ClassFacts,
  type GroupFacts,
  type GroupPlan,
  type GroupPreviewItem,
} from './groupPlan.js';

// Class groups (contract 4.1 and 8.3): joining, leaving and dissolving, each in the
// caller's transaction. The plan comes from planGroupChange; this file carries it out.

function classNotFound(): AppError {
  return new AppError('NOT_FOUND', 'Class not found');
}

async function classFacts(
  teacherId: string,
  classIds: string[],
  transaction: Transaction,
): Promise<Map<string, ClassFacts>> {
  const rows = await sequelize.query<ClassFacts>(
    `SELECT c.id,
            c.name,
            c.group_id AS "groupId",
            (SELECT count(*)::int FROM class_units cu WHERE cu.class_id = c.id) AS units,
            (SELECT count(*)::int FROM class_lessons cl WHERE cl.class_id = c.id) AS lessons,
            (SELECT count(*)::int
               FROM class_lessons cl
               JOIN lessons l ON l.id = cl.lesson_id
              WHERE cl.class_id = c.id AND l.group_id IS NOT NULL) AS "linkedLessons"
       FROM classes c
      WHERE c.id = ANY($classIds::uuid[]) AND c.teacher_id = $teacherId`,
    { bind: { classIds, teacherId }, type: QueryTypes.SELECT, transaction },
  );

  return new Map(rows.map((row) => [row.id, row]));
}

async function groupFacts(groupId: string, transaction: Transaction): Promise<GroupFacts> {
  const members = await SchoolClass.findAll({
    attributes: ['id'],
    where: { groupId },
    order: [['id', 'ASC']],
    transaction,
  });
  const units = await Unit.count({ where: { groupId }, transaction });
  const lessons = await sequelize.query<{ holders: string[] }>(
    `SELECT coalesce(array_agg(cl.class_id) FILTER (WHERE cl.class_id IS NOT NULL), '{}') AS holders
       FROM lessons l
       LEFT JOIN class_lessons cl ON cl.lesson_id = l.id
      WHERE l.group_id = $groupId
      GROUP BY l.id`,
    { bind: { groupId }, type: QueryTypes.SELECT, transaction },
  );

  return {
    id: groupId,
    memberIds: members.map((member) => member.id),
    units,
    linkedLessonHolders: lessons.map((lesson) => lesson.holders),
  };
}

// Checks linkedClassIds against the database and plans the change. With `lock`, every class
// involved is locked first, in id order (plan, rules: locking). The caller holds the
// teacher's lock, which every change of group membership takes, so the group can't change
// underneath.
async function planFor(
  teacherId: string,
  classId: string,
  linkedClassIds: string[],
  transaction: Transaction,
  { lock }: { lock: boolean },
): Promise<GroupPlan> {
  if (linkedClassIds.includes(classId)) {
    throw new AppError('VALIDATION_ERROR', 'A class cannot be linked with itself', [
      { path: 'linkedClassIds', message: 'Must not contain the class itself' },
    ]);
  }

  const own = await SchoolClass.findOne({ attributes: ['groupId'], where: { id: classId, teacherId }, transaction });

  if (!own) {
    throw classNotFound();
  }

  if (lock) {
    await SchoolClass.findAll({
      attributes: ['id'],
      where: {
        teacherId,
        [Op.or]: [{ id: [classId, ...linkedClassIds] }, ...(own.groupId ? [{ groupId: own.groupId }] : [])],
      },
      order: [['id', 'ASC']],
      lock: Transaction.LOCK.NO_KEY_UPDATE,
      transaction,
    });
  }

  const group = own.groupId ? await groupFacts(own.groupId, transaction) : null;
  const classes = await classFacts(
    teacherId,
    [...new Set([classId, ...linkedClassIds, ...(group?.memberIds ?? [])])],
    transaction,
  );

  if (linkedClassIds.some((id) => !classes.has(id))) {
    throw classNotFound();
  }

  return planGroupChange({ self: classes.get(classId) as ClassFacts, group, classes, linkedClassIds });
}

// POST /classes/:id/linked-classes/preview (contract 8.3): the same plan as the save, with
// the same errors, and nothing changed.
export async function previewGroupChange(
  teacherId: string,
  classId: string,
  linkedClassIds: string[],
): Promise<GroupPreviewItem[]> {
  return sequelize.transaction(
    { isolationLevel: Transaction.ISOLATION_LEVELS.REPEATABLE_READ },
    async (transaction) => (await planFor(teacherId, classId, linkedClassIds, transaction, { lock: false })).preview,
  );
}

// A class leaving its group keeps everything it holds as class-only copies (contract 4.1):
// a copy of every group unit, with its class-only lessons moved into them, and a copy of
// every linked lesson it holds, with its placement, submissions and AI jobs moved over.
// Every lesson's slot becomes its index, so the class's outline reads exactly as before.
async function leaveGroup(classId: string, transaction: Transaction): Promise<void> {
  const outline = await buildOutline(classId, transaction);
  const units = await sequelize.query<{ id: string; title: string }>(
    `SELECT u.id, u.title
       FROM class_units cu
       JOIN units u ON u.id = cu.unit_id
      WHERE cu.class_id = $classId AND u.group_id IS NOT NULL`,
    { bind: { classId }, type: QueryTypes.SELECT, transaction },
  );
  const unitCopies = new Map(units.map((unit) => [unit.id, randomUUID()]));

  if (units.length > 0) {
    await Unit.bulkCreate(
      units.map((unit) => ({ id: unitCopies.get(unit.id) as string, classId, groupId: null, title: unit.title })),
      { transaction },
    );

    const bind = { classId, originals: [...unitCopies.keys()], copyIds: [...unitCopies.values()] };
    await sequelize.query(
      `UPDATE class_units AS cu
          SET unit_id = m.copy_id, updated_at = now()
         FROM unnest($originals::uuid[], $copyIds::uuid[]) AS m(original_id, copy_id)
        WHERE cu.class_id = $classId AND cu.unit_id = m.original_id`,
      { bind, transaction },
    );
    await sequelize.query(
      `UPDATE lessons AS l
          SET unit_id = m.copy_id, updated_at = now()
         FROM unnest($originals::uuid[], $copyIds::uuid[]) AS m(original_id, copy_id)
        WHERE l.class_id = $classId AND l.unit_id = m.original_id`,
      { bind, transaction },
    );
  }

  await copyLessonsFor(
    classId,
    outline.lessons.filter((lesson) => lesson.linked).map((lesson) => ({ lessonId: lesson.id, slot: lesson.order })),
    unitCopies,
    transaction,
  );

  const classOnly = outline.lessons.filter((lesson) => !lesson.linked);
  await sequelize.query(
    `UPDATE class_lessons AS cl
        SET position = m.slot, updated_at = now()
       FROM unnest($lessonIds::uuid[], $slots::int[]) AS m(lesson_id, slot)
      WHERE cl.class_id = $classId AND cl.lesson_id = m.lesson_id AND cl.position IS DISTINCT FROM m.slot`,
    {
      bind: { classId, lessonIds: classOnly.map((lesson) => lesson.id), slots: classOnly.map((lesson) => lesson.order) },
      transaction,
    },
  );
  await SchoolClass.update({ groupId: null }, { where: { id: classId }, transaction });
}

async function unitOrderOf(classId: string, transaction: Transaction): Promise<string[]> {
  const placements = await ClassUnit.findAll({
    attributes: ['unitId'],
    where: { classId },
    order: [
      ['position', 'ASC'],
      ['unitId', 'ASC'],
    ],
    transaction,
  });

  return placements.map((placement) => placement.unitId);
}

// A class joining a group (contract 4.1): its own units become the group's and every class
// of the group gets them, after the units it already has; the joining class gets the group's
// units first, then its own, and every linked lesson of the group, hidden from students. Its
// own lessons stay class-only and keep their slots.
async function joinGroup(groupId: string, classId: string, transaction: Transaction): Promise<void> {
  const members = await SchoolClass.findAll({
    attributes: ['id'],
    where: { groupId },
    order: [['id', 'ASC']],
    transaction,
  });
  const shared = members[0] ? await unitOrderOf(members[0].id, transaction) : [];
  const own = await unitOrderOf(classId, transaction);

  await Unit.update({ classId: null, groupId }, { where: { classId }, transaction });
  await ClassUnit.bulkCreate(
    [
      ...shared.map((unitId, position) => ({ classId, unitId, position })),
      ...members.flatMap((member) =>
        own.map((unitId, index) => ({ classId: member.id, unitId, position: shared.length + index })),
      ),
    ],
    { transaction },
  );
  await writeUnitOrder(classId, [...shared, ...own], transaction);
  await sequelize.query(
    `INSERT INTO class_lessons (class_id, lesson_id, position, visible)
     SELECT $classId, l.id, NULL, false FROM lessons l WHERE l.group_id = $groupId`,
    { bind: { classId, groupId }, transaction },
  );
  await SchoolClass.update({ groupId }, { where: { id: classId }, transaction });
}

// The last class of a group gets copies like a leaving one, and the group goes (contract
// 4.1). Returns the files of linked lessons deleted on the way.
async function dissolve(groupId: string, classId: string | undefined, transaction: Transaction): Promise<string[]> {
  if (classId) {
    await leaveGroup(classId, transaction);
  }

  const fileIds = await deleteOrphanLessons(groupId, transaction);
  await ClassGroup.destroy({ where: { id: groupId }, transaction });

  return fileIds;
}

// PATCH /classes/:id with linkedClassIds (contract 8.3), in the caller's transaction, which
// holds the teacher's lock. Leaving classes go first, so they take copies of what they hold
// now; then the group is dissolved if one class is left, or the joining classes come in.
// Returns files that may have lost their last reference, for deleteFileRows.
export async function applyGroupChange(
  teacherId: string,
  classId: string,
  linkedClassIds: string[],
  transaction: Transaction,
): Promise<string[]> {
  const plan = await planFor(teacherId, classId, linkedClassIds, transaction, { lock: true });
  const fileIds: string[] = [];

  if (plan.groupId) {
    for (const leaving of plan.leaves) {
      await leaveGroup(leaving, transaction);
    }

    fileIds.push(
      ...(plan.dissolve
        ? await dissolve(plan.groupId, plan.dissolve, transaction)
        : await deleteOrphanLessons(plan.groupId, transaction)),
    );
  }

  if (plan.joins.length > 0) {
    const groupId = plan.groupId ?? (await ClassGroup.create({}, { transaction })).id;

    for (const joining of plan.joins) {
      await joinGroup(groupId, joining, transaction);
    }
  }

  return fileIds;
}

// After a class of the group has been deleted (contract 4.1: it leaves first, without
// copies): linked lessons nobody holds any more go, and a group left with one class is
// dissolved. Returns files for deleteFileRows.
export async function afterMemberDeleted(groupId: string, transaction: Transaction): Promise<string[]> {
  const rest = await SchoolClass.findAll({ attributes: ['id'], where: { groupId }, transaction });

  if (rest.length <= 1) {
    return dissolve(groupId, rest[0]?.id, transaction);
  }

  return deleteOrphanLessons(groupId, transaction);
}

// Class.linkedClasses (contract 3): the other classes of each class's group, by name.
export async function linkedClassesOf(
  classes: SchoolClass[],
  transaction?: Transaction,
): Promise<Map<string, { id: string; name: string }[]>> {
  const groupIds = [...new Set(classes.flatMap((schoolClass) => (schoolClass.groupId ? [schoolClass.groupId] : [])))];
  const linked = new Map<string, { id: string; name: string }[]>();

  if (groupIds.length === 0) {
    return linked;
  }

  const members = await SchoolClass.findAll({
    attributes: ['id', 'name', 'groupId'],
    where: { groupId: groupIds },
    transaction,
  });
  const byName = (a: { id: string; name: string }, b: { id: string; name: string }) =>
    a.name.toLowerCase().localeCompare(b.name.toLowerCase()) || a.id.localeCompare(b.id);

  for (const schoolClass of classes) {
    linked.set(
      schoolClass.id,
      members
        .filter((member) => member.groupId === schoolClass.groupId && member.id !== schoolClass.id)
        .map((member) => ({ id: member.id, name: member.name }))
        .sort(byName),
    );
  }

  return linked;
}
