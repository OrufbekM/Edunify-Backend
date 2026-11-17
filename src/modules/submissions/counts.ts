import { QueryTypes, type Transaction } from 'sequelize';

import { sequelize } from '../../db/index.js';

// newSubmissionCount (contract 3 and 8.12): one per roster row whose latest version of a
// homework is still `submitted`. It goes down when that version is graded or denied, and up
// again on a new version or when the grade is removed. Counted over the lessons the class
// holds, hidden ones included, so a class's count is the sum of its lessons' counts.
//
// One grouped query per request: the frontend polls these. submissions_submitted_idx keeps
// the scan to the rows still waiting.
const NEW_SUBMISSIONS = `
    FROM submissions s
    JOIN class_students cs ON cs.id = s.class_student_id
    JOIN homeworks h ON h.id = s.homework_id
    JOIN class_lessons cl ON cl.class_id = cs.class_id AND cl.lesson_id = h.lesson_id
   WHERE s.status = 'submitted'
     AND NOT EXISTS (SELECT 1 FROM submissions later
                      WHERE later.homework_id = s.homework_id
                        AND later.class_student_id = s.class_student_id
                        AND later.version > s.version)`;

// Keyed by class id; a class with nothing waiting is missing from the map.
export async function newSubmissionCountsByClass(
  classIds: string[],
  transaction?: Transaction,
): Promise<Map<string, number>> {
  if (classIds.length === 0) {
    return new Map();
  }

  const rows = await sequelize.query<{ classId: string; count: number }>(
    `SELECT cs.class_id AS "classId", count(*)::int AS count
       ${NEW_SUBMISSIONS}
       AND cs.class_id = ANY($classIds::uuid[])
     GROUP BY cs.class_id`,
    { bind: { classIds }, type: QueryTypes.SELECT, transaction },
  );

  return new Map(rows.map((row) => [row.classId, row.count]));
}

// Keyed by lesson id, for one class; a lesson with nothing waiting (or no homework) is
// missing from the map.
export async function newSubmissionCountsByLesson(
  classId: string,
  transaction?: Transaction,
): Promise<Map<string, number>> {
  const rows = await sequelize.query<{ lessonId: string; count: number }>(
    `SELECT h.lesson_id AS "lessonId", count(*)::int AS count
       ${NEW_SUBMISSIONS}
       AND cs.class_id = $classId
     GROUP BY h.lesson_id`,
    { bind: { classId }, type: QueryTypes.SELECT, transaction },
  );

  return new Map(rows.map((row) => [row.lessonId, row.count]));
}
