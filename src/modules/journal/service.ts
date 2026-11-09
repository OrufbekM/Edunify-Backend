import { QueryTypes, Transaction } from 'sequelize';

import { sequelize } from '../../db/index.js';
import type { SubmissionStatus } from '../../db/models/enums.js';
import { Unit } from '../../db/models/index.js';
import { getOwnClass } from '../classes/service.js';
import { toUnitDto, type UnitDto } from '../lessons/service.js';
import { listMyClasses, rosterRows, type LinkState } from '../students/service.js';
import type { Grade } from '../submissions/service.js';

// Contract section 3: 'empty' means no submission yet.
export type CellStatus = 'empty' | SubmissionStatus;

export interface JournalColumnDto {
  lessonId: string;
  title: string;
  unitId: string | null;
}

export interface JournalCellDto {
  lessonId: string;
  status: CellStatus;
  value: Grade | null;
  submissionId: string | null;
}

export interface JournalRowDto {
  classStudentId: string;
  fullName: string;
  linkState: LinkState;
  cells: JournalCellDto[];
  average: number | null;
}

export interface JournalDto {
  units: UnitDto[];
  columns: JournalColumnDto[];
  rows: JournalRowDto[];
}

export interface StudentGradesItemDto {
  class: { id: string; subject: string; name: string | null };
  columns: JournalColumnDto[];
  cells: JournalCellDto[];
  average: number | null;
}

interface Column extends JournalColumnDto {
  classId: string;
  homeworkId: string;
}

interface Latest {
  classStudentId: string;
  homeworkId: string;
  submissionId: string;
  status: SubmissionStatus;
  value: number | null;
  average: string | null;
}

// A row's cells and average, from its latest version of each homework.
interface Marks {
  byHomework: Map<string, Latest>;
  average: number | null;
}

// Only lessons with homework, in display order: no-unit lessons first, then unit order,
// then lesson order (contract 8.10), the order the outline uses.
async function columnsOf(classIds: string[], transaction: Transaction): Promise<Column[]> {
  return sequelize.query<Column>(
    `SELECT l.class_id AS "classId",
            l.id AS "lessonId",
            l.title,
            l.unit_id AS "unitId",
            h.id AS "homeworkId"
       FROM lessons l
       JOIN homeworks h ON h.lesson_id = l.id
       LEFT JOIN units u ON u.id = l.unit_id
      WHERE l.class_id = ANY($classIds::uuid[])
      ORDER BY l.class_id, u.position NULLS FIRST, u.id NULLS FIRST, l.position, l.id`,
    { bind: { classIds }, type: QueryTypes.SELECT, transaction },
  );
}

// Each row's latest version of each homework, and the row's average over the graded ones,
// rounded in SQL as exact numeric (plan, Phase 9). Denied and empty cells don't count.
async function marksOf(
  classStudentIds: string[],
  transaction: Transaction,
): Promise<Map<string, Marks>> {
  const latest = await sequelize.query<Latest>(
    `WITH latest AS (
       SELECT DISTINCT ON (s.class_student_id, s.homework_id)
              s.class_student_id, s.homework_id, s.id, s.status, s.grade_value
         FROM submissions s
        WHERE s.class_student_id = ANY($classStudentIds::uuid[])
        ORDER BY s.class_student_id, s.homework_id, s.version DESC
     )
     SELECT class_student_id AS "classStudentId",
            homework_id AS "homeworkId",
            id AS "submissionId",
            status,
            grade_value AS "value",
            round(avg(grade_value) FILTER (WHERE status = 'graded')
                    OVER (PARTITION BY class_student_id), 2)::text AS average
       FROM latest`,
    { bind: { classStudentIds }, type: QueryTypes.SELECT, transaction },
  );
  const marks = new Map<string, Marks>();

  for (const entry of latest) {
    const row = marks.get(entry.classStudentId) ?? {
      byHomework: new Map<string, Latest>(),
      average: entry.average === null ? null : Number(entry.average),
    };
    row.byHomework.set(entry.homeworkId, entry);
    marks.set(entry.classStudentId, row);
  }

  return marks;
}

function toColumnDto(column: Column): JournalColumnDto {
  return { lessonId: column.lessonId, title: column.title, unitId: column.unitId };
}

// Parallel to columns: same length, same order (contract 8.10).
function cellsOf(columns: Column[], marks: Marks | undefined): JournalCellDto[] {
  return columns.map((column) => {
    const latest = marks?.byHomework.get(column.homeworkId);

    if (!latest) {
      return { lessonId: column.lessonId, status: 'empty', value: null, submissionId: null };
    }

    return {
      lessonId: column.lessonId,
      status: latest.status,
      value: latest.status === 'graded' ? (latest.value as Grade) : null,
      submissionId: latest.submissionId,
    };
  });
}

// One REPEATABLE READ snapshot, so columns, rows and cells all describe the same moment.
function inSnapshot<T>(work: (transaction: Transaction) => Promise<T>): Promise<T> {
  return sequelize.transaction(
    { isolationLevel: Transaction.ISOLATION_LEVELS.REPEATABLE_READ },
    work,
  );
}

// Every roster row, sorted like the roster, with its linkState (contract 8.10).
export async function getJournal(teacherId: string, classId: string): Promise<JournalDto> {
  return inSnapshot(async (transaction) => {
    await getOwnClass(teacherId, classId, transaction);

    const units = await Unit.findAll({
      where: { classId },
      order: [
        ['position', 'ASC'],
        ['id', 'ASC'],
      ],
      transaction,
    });
    const columns = await columnsOf([classId], transaction);
    const roster = await rosterRows(classId, { transaction });
    const marks = await marksOf(
      roster.map((row) => row.id),
      transaction,
    );

    return {
      units: units.map(toUnitDto),
      columns: columns.map(toColumnDto),
      rows: roster.map((row) => ({
        classStudentId: row.id,
        fullName: row.fullName,
        linkState: row.linkState,
        cells: cellsOf(columns, marks.get(row.id)),
        average: marks.get(row.id)?.average ?? null,
      })),
    };
  });
}

// One item per class with an active link, sorted like GET /student/classes, holding only
// the caller's own row (contract 8.10). A class without homework still appears.
export async function listMyGrades(userId: string): Promise<StudentGradesItemDto[]> {
  return inSnapshot(async (transaction) => {
    const classes = await listMyClasses(userId, transaction);

    if (classes.length === 0) {
      return [];
    }

    const columns = await columnsOf(
      classes.map((item) => item.id),
      transaction,
    );
    const marks = await marksOf(
      classes.map((item) => item.classStudentId),
      transaction,
    );

    return classes.map((item) => {
      const own = columns.filter((column) => column.classId === item.id);
      const mine = marks.get(item.classStudentId);

      return {
        class: { id: item.id, subject: item.subject, name: item.name },
        columns: own.map(toColumnDto),
        cells: cellsOf(own, mine),
        average: mine?.average ?? null,
      };
    });
  });
}
