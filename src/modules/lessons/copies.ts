import { randomUUID } from 'node:crypto';

import { QueryTypes, type Transaction } from 'sequelize';

import { sequelize } from '../../db/index.js';
import type { HomeworkType } from '../../db/models/enums.js';
import { Homework, Lesson } from '../../db/models/index.js';
import { writePositions } from '../../lib/positions.js';
import { lockLessonFiles } from '../files/service.js';

// Linked lessons and their copies (contract 4.1). A copy is a new class-only lesson and
// homework with the same title, type, instructions and file references; the class's
// placement, submissions and AI jobs move over to it before anything is deleted, so its
// student work survives.

export interface CopyRequest {
  lessonId: string;
  // The copy's slot in this class: the lesson's index in its unit there, so it stays put.
  slot: number;
}

// Copies the lessons for one class and moves the class over to the copies. `unitIds` maps
// a unit to the class's own copy of it when the class is leaving its group; a unit missing
// from it stays. Returns the copy of each lesson, by the original's id.
//
// Locks the originals and their homework FOR UPDATE, in id order, before anything else:
// a new submission takes the homework FOR SHARE first, so none can land on the original
// homework for this class after its submissions have moved.
export async function copyLessonsFor(
  classId: string,
  requests: CopyRequest[],
  unitIds: ReadonlyMap<string, string>,
  transaction: Transaction,
): Promise<Map<string, string>> {
  const copies = new Map<string, string>();

  if (requests.length === 0) {
    return copies;
  }

  const lessonIds = requests.map((request) => request.lessonId);
  const lessons = await sequelize.query<{ id: string; unitId: string; title: string; lessonFileId: string | null }>(
    `SELECT id, unit_id AS "unitId", title, lesson_file_id AS "lessonFileId" FROM lessons
      WHERE id = ANY($lessonIds::uuid[])
      ORDER BY id
        FOR UPDATE`,
    { bind: { lessonIds }, type: QueryTypes.SELECT, transaction },
  );
  const homeworks = await sequelize.query<{
    id: string;
    lessonId: string;
    type: HomeworkType;
    instructionsText: string | null;
    instructionsFileId: string | null;
  }>(
    `SELECT id, lesson_id AS "lessonId", type, instructions_text AS "instructionsText",
            instructions_file_id AS "instructionsFileId"
       FROM homeworks
      WHERE lesson_id = ANY($lessonIds::uuid[])
      ORDER BY id
        FOR UPDATE`,
    { bind: { lessonIds }, type: QueryTypes.SELECT, transaction },
  );

  for (const lesson of lessons) {
    copies.set(lesson.id, randomUUID());
  }
  const homeworkCopies = new Map(homeworks.map((homework) => [homework.id, randomUUID()]));

  await Lesson.bulkCreate(
    lessons.map((lesson) => ({
      id: copies.get(lesson.id) as string,
      classId,
      groupId: null,
      unitId: unitIds.get(lesson.unitId) ?? lesson.unitId,
      title: lesson.title,
      position: null,
      lessonFileId: lesson.lessonFileId,
    })),
    { transaction },
  );
  await Homework.bulkCreate(
    homeworks.map((homework) => ({
      id: homeworkCopies.get(homework.id) as string,
      lessonId: copies.get(homework.lessonId) as string,
      type: homework.type,
      instructionsText: homework.instructionsText,
      instructionsFileId: homework.instructionsFileId,
    })),
    { transaction },
  );

  const found = requests.filter((request) => copies.has(request.lessonId));
  await sequelize.query(
    `UPDATE class_lessons AS cl
        SET lesson_id = m.copy_id, position = m.slot, updated_at = now()
       FROM unnest($originals::uuid[], $copyIds::uuid[], $slots::int[]) AS m(original_id, copy_id, slot)
      WHERE cl.class_id = $classId AND cl.lesson_id = m.original_id`,
    {
      bind: {
        classId,
        originals: found.map((request) => request.lessonId),
        copyIds: found.map((request) => copies.get(request.lessonId)),
        slots: found.map((request) => request.slot),
      },
      transaction,
    },
  );

  if (homeworks.length > 0) {
    await sequelize.query(
      `UPDATE submissions AS s
          SET homework_id = m.copy_id
         FROM unnest($originals::uuid[], $copyIds::uuid[]) AS m(original_id, copy_id),
              class_students cs
        WHERE s.homework_id = m.original_id AND cs.id = s.class_student_id AND cs.class_id = $classId`,
      {
        bind: {
          classId,
          originals: homeworks.map((homework) => homework.id),
          copyIds: homeworks.map((homework) => homeworkCopies.get(homework.id)),
        },
        transaction,
      },
    );
  }

  await sequelize.query(
    `UPDATE ai_jobs AS j
        SET lesson_id = m.copy_id, updated_at = now()
       FROM unnest($originals::uuid[], $copyIds::uuid[]) AS m(original_id, copy_id)
      WHERE j.lesson_id = m.original_id AND j.class_id = $classId`,
    {
      bind: { classId, originals: [...copies.keys()], copyIds: [...copies.values()] },
      transaction,
    },
  );

  return copies;
}

// Makes a unit's linked order dense again (contract 4).
export async function renumberLinked(groupId: string, unitId: string, transaction: Transaction): Promise<void> {
  const lessons = await Lesson.findAll({
    attributes: ['id'],
    where: { groupId, unitId },
    order: [
      ['position', 'ASC'],
      ['id', 'ASC'],
    ],
    transaction,
  });

  await writePositions(
    'lessons',
    lessons.map((lesson) => lesson.id),
    transaction,
  );
}

// A linked lesson that no class holds any more is deleted (contract 4.1), and the linked
// order of its unit closes up. Returns the files to pass to deleteFileRows; copies may
// still share them, which deleteFileRows checks.
export async function deleteOrphanLessons(groupId: string, transaction: Transaction): Promise<string[]> {
  const orphans = await sequelize.query<{ id: string; unitId: string }>(
    `SELECT l.id, l.unit_id AS "unitId" FROM lessons l
      WHERE l.group_id = $groupId
        AND NOT EXISTS (SELECT 1 FROM class_lessons cl WHERE cl.lesson_id = l.id)`,
    { bind: { groupId }, type: QueryTypes.SELECT, transaction },
  );

  if (orphans.length === 0) {
    return [];
  }

  const lessonIds = orphans.map((orphan) => orphan.id);
  const fileIds = await lockLessonFiles({ lessonIds }, transaction);

  await Lesson.destroy({ where: { id: lessonIds }, transaction });
  for (const unitId of new Set(orphans.map((orphan) => orphan.unitId))) {
    await renumberLinked(groupId, unitId, transaction);
  }

  return fileIds;
}
