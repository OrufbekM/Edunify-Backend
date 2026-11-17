import { QueryTypes, Transaction } from 'sequelize';

import { sequelize } from '../../db/index.js';
import type { HomeworkType } from '../../db/models/enums.js';
import { ClassLesson } from '../../db/models/index.js';
import { notFoundAs, type AppError } from '../../lib/errors.js';
import { getConnectedClassStudent } from '../students/service.js';

// A class's outline as contract 4.1 defines it: its units in order, and each unit's lessons
// merged from the class-only lessons' slots and the linked order. Every reader of lesson
// numbers goes through buildOutline, so the outline, a lesson's page, the journal and the
// grades can't disagree.

export interface OutlineUnit {
  id: string;
  title: string;
  order: number;
}

export interface OutlineLesson {
  id: string;
  unitId: string;
  title: string;
  homeworkId: string | null;
  homeworkType: HomeworkType | null;
  linked: boolean;
  visible: boolean;
  // 1-based, continuous across units in outline order, hidden lessons included.
  number: number;
  // 0-based within its unit in this class.
  order: number;
}

export interface ClassOutline {
  units: OutlineUnit[];
  lessons: OutlineLesson[];
}

// What merging needs from a lesson: a class-only lesson has a slot, a linked one a place in
// the linked order.
export interface Mergeable {
  id: string;
  slot: number | null;
  linkedPosition: number | null;
}

function bySlot(a: Mergeable, b: Mergeable): number {
  return (a.slot ?? 0) - (b.slot ?? 0) || a.id.localeCompare(b.id);
}

function byLinkedPosition(a: Mergeable, b: Mergeable): number {
  return (a.linkedPosition ?? 0) - (b.linkedPosition ?? 0) || a.id.localeCompare(b.id);
}

// Contract 4.1: each class-only lesson takes its slot, in slot order, a slot past the end
// going last; the linked lessons fill the other places in linked order.
export function mergeUnit<T extends Mergeable>(lessons: readonly T[]): T[] {
  const classOnly = lessons.filter((lesson) => lesson.slot !== null).sort(bySlot);
  const linked = lessons.filter((lesson) => lesson.slot === null).sort(byLinkedPosition);
  const merged: T[] = [];

  while (classOnly.length > 0 || linked.length > 0) {
    const next = classOnly[0];
    const nextTakesThisPlace = next !== undefined && (next.slot ?? 0) <= merged.length;
    const taken = nextTakesThisPlace || linked.length === 0 ? classOnly.shift() : linked.shift();

    if (taken) {
      merged.push(taken);
    }
  }

  return merged;
}

interface PlacedRow extends Mergeable {
  unitId: string;
  title: string;
  homeworkId: string | null;
  homeworkType: HomeworkType | null;
  linked: boolean;
  visible: boolean;
}

// Two queries; callers that need one consistent picture run it in a REPEATABLE READ
// transaction or under the class lock.
export async function buildOutline(classId: string, transaction?: Transaction): Promise<ClassOutline> {
  const units = await sequelize.query<OutlineUnit>(
    `SELECT u.id, u.title, cu.position AS "order"
       FROM class_units cu
       JOIN units u ON u.id = cu.unit_id
      WHERE cu.class_id = $classId
      ORDER BY cu.position, u.id`,
    { bind: { classId }, type: QueryTypes.SELECT, transaction },
  );
  const placed = await sequelize.query<PlacedRow>(
    `SELECT l.id,
            l.unit_id AS "unitId",
            l.title,
            h.id AS "homeworkId",
            h.type AS "homeworkType",
            l.group_id IS NOT NULL AS linked,
            cl.visible,
            cl.position AS slot,
            l.position AS "linkedPosition"
       FROM class_lessons cl
       JOIN lessons l ON l.id = cl.lesson_id
       LEFT JOIN homeworks h ON h.lesson_id = l.id
      WHERE cl.class_id = $classId`,
    { bind: { classId }, type: QueryTypes.SELECT, transaction },
  );

  const byUnit = new Map<string, PlacedRow[]>();
  for (const row of placed) {
    byUnit.set(row.unitId, [...(byUnit.get(row.unitId) ?? []), row]);
  }

  const lessons: OutlineLesson[] = [];
  for (const unit of units) {
    mergeUnit(byUnit.get(unit.id) ?? []).forEach((row, order) => {
      lessons.push({
        id: row.id,
        unitId: row.unitId,
        title: row.title,
        homeworkId: row.homeworkId,
        homeworkType: row.homeworkType,
        linked: row.linked,
        visible: row.visible,
        number: lessons.length + 1,
        order,
      });
    });
  }

  return { units, lessons };
}

// The lessons of one unit in this class, in order.
export function lessonsOfUnit(outline: ClassOutline, unitId: string): OutlineLesson[] {
  return outline.lessons.filter((lesson) => lesson.unitId === unitId);
}

// Gives the class's units positions 0..n-1 in the order listed (contract 4). Rows already
// in place are left alone.
export async function writeUnitOrder(classId: string, unitIds: string[], transaction: Transaction): Promise<void> {
  if (unitIds.length === 0) {
    return;
  }

  await sequelize.query(
    `UPDATE class_units AS cu
        SET position = v.n - 1, updated_at = now()
       FROM unnest($unitIds::uuid[]) WITH ORDINALITY AS v(id, n)
      WHERE cu.class_id = $classId AND cu.unit_id = v.id AND cu.position <> v.n - 1`,
    { bind: { classId, unitIds }, transaction },
  );
}

// `lessonIds` is a unit's list in this class, in order. Each class-only lesson in it gets its
// index as its slot, so the merge gives back exactly this list and stale slots past the end
// are cleaned up (plan, contract fix 7). Linked lessons keep the linked order.
export async function writeSlots(classId: string, lessonIds: string[], transaction: Transaction): Promise<void> {
  if (lessonIds.length === 0) {
    return;
  }

  await sequelize.query(
    `UPDATE class_lessons AS cl
        SET position = v.n - 1, updated_at = now()
       FROM unnest($lessonIds::uuid[]) WITH ORDINALITY AS v(id, n)
      WHERE cl.class_id = $classId
        AND cl.lesson_id = v.id
        AND cl.position IS NOT NULL
        AND cl.position <> v.n - 1`,
    { bind: { classId, lessonIds }, transaction },
  );
}

// After a change to these units, every class listed gets its class-only slots rewritten to
// the indices they now have (plan, contract fix 7). The lists don't change: it only keeps
// stale slots from pointing past the end once linked lessons have moved.
export async function normalizeSlots(
  classIds: readonly string[],
  unitIds: readonly string[],
  transaction: Transaction,
): Promise<void> {
  for (const classId of classIds) {
    const outline = await buildOutline(classId, transaction);

    for (const unitId of new Set(unitIds)) {
      await writeSlots(
        classId,
        lessonsOfUnit(outline, unitId).map((lesson) => lesson.id),
        transaction,
      );
    }
  }
}

// The lesson's placement in the class, or null if the class doesn't hold it.
export async function findPlacement(
  classId: string,
  lessonId: string,
  transaction?: Transaction,
  { lock = false }: { lock?: boolean } = {},
): Promise<ClassLesson | null> {
  return ClassLesson.findOne({
    where: { classId, lessonId },
    ...(lock ? { lock: Transaction.LOCK.NO_KEY_UPDATE } : {}),
    transaction,
  });
}

// For what a student reaches through a lesson of a class: the caller must be connected to
// the class, and the class must hold the lesson and show it (contract 4.1). Anything else is
// the caller's own NOT_FOUND.
export async function assertVisibleToStudent(
  userId: string,
  classId: string,
  lessonId: string,
  notFound: () => AppError,
  transaction?: Transaction,
): Promise<void> {
  await notFoundAs(getConnectedClassStudent(userId, classId, transaction), notFound);

  const placement = await findPlacement(classId, lessonId, transaction);

  if (!placement?.visible) {
    throw notFound();
  }
}
