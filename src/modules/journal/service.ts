import { QueryTypes, Transaction } from 'sequelize';

import { sequelize } from '../../db/index.js';
import type { SubmissionStatus } from '../../db/models/enums.js';
import { getOwnClass } from '../classes/service.js';
import { buildOutline, type ClassOutline } from '../lessons/placements.js';
import type { UnitDto } from '../lessons/service.js';
import { listMyClasses, rosterRows, type ConnectionState } from '../students/service.js';
import type { Grade } from '../submissions/service.js';

// Contract section 3: 'empty' means no submission yet.
export type CellStatus = 'empty' | SubmissionStatus;

export interface JournalColumnDto {
  lessonId: string;
  number: number;
  title: string;
  unitId: string;
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
  connectionState: ConnectionState;
  cells: JournalCellDto[];
  average: number | null;
}

export interface JournalDto {
  units: UnitDto[];
  columns: JournalColumnDto[];
  rows: JournalRowDto[];
}

export interface StudentGradesItemDto {
  class: { id: string; name: string };
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

// Only lessons with homework, in outline order, each with its number (contract 8.10). The
// teacher's journal keeps hidden lessons; a student's grades leave them out (contract 4.1).
function columnsFrom(classId: string, outline: ClassOutline, { visibleOnly }: { visibleOnly: boolean }): Column[] {
  return outline.lessons.flatMap((lesson) =>
    lesson.homeworkId && (lesson.visible || !visibleOnly)
      ? [
          {
            classId,
            lessonId: lesson.id,
            number: lesson.number,
            title: lesson.title,
            unitId: lesson.unitId,
            homeworkId: lesson.homeworkId,
          },
        ]
      : [],
  );
}

// Each row's latest version of each homework in `columns`, and the row's average over the
// graded ones, rounded in SQL as exact numeric (plan, Phase 9). Denied and empty cells don't
// count, and neither does homework outside the columns: a student's grades leave hidden
// lessons out, so their marks must not reach the average either (contract 4.1).
async function marksOf(
  classStudentIds: string[],
  columns: Column[],
  transaction: Transaction,
): Promise<Map<string, Marks>> {
  const homeworkIds = columns.map((column) => column.homeworkId);
  const latest = await sequelize.query<Latest>(
    `WITH latest AS (
       SELECT DISTINCT ON (s.class_student_id, s.homework_id)
              s.class_student_id, s.homework_id, s.id, s.status, s.grade_value
         FROM submissions s
        WHERE s.class_student_id = ANY($classStudentIds::uuid[])
          AND s.homework_id = ANY($homeworkIds::uuid[])
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
    { bind: { classStudentIds, homeworkIds }, type: QueryTypes.SELECT, transaction },
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
  return { lessonId: column.lessonId, number: column.number, title: column.title, unitId: column.unitId };
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

// Every roster row, sorted like the roster, with its connectionState (contract 8.10).
export async function getJournal(teacherId: string, classId: string): Promise<JournalDto> {
  return inSnapshot(async (transaction) => {
    await getOwnClass(teacherId, classId, transaction);

    const outline = await buildOutline(classId, transaction);
    const columns = columnsFrom(classId, outline, { visibleOnly: false });
    const roster = await rosterRows(classId, { transaction });
    const marks = await marksOf(
      roster.map((row) => row.id),
      columns,
      transaction,
    );

    return {
      units: outline.units.map((unit) => ({ id: unit.id, classId, title: unit.title, order: unit.order })),
      columns: columns.map(toColumnDto),
      rows: roster.map((row) => ({
        classStudentId: row.id,
        fullName: row.fullName,
        connectionState: row.connectionState,
        cells: cellsOf(columns, marks.get(row.id)),
        average: marks.get(row.id)?.average ?? null,
      })),
    };
  });
}

// One item per connected class, sorted like GET /student/classes, holding only
// the caller's own row (contract 8.10). A class without homework still appears.
export async function listMyGrades(userId: string): Promise<StudentGradesItemDto[]> {
  return inSnapshot(async (transaction) => {
    const classes = await listMyClasses(userId, transaction);

    if (classes.length === 0) {
      return [];
    }

    const columns: Column[] = [];
    for (const item of classes) {
      columns.push(...columnsFrom(item.id, await buildOutline(item.id, transaction), { visibleOnly: true }));
    }
    const marks = await marksOf(
      classes.map((item) => item.classStudentId),
      columns,
      transaction,
    );

    return classes.map((item) => {
      const own = columns.filter((column) => column.classId === item.id);
      const mine = marks.get(item.classStudentId);

      return {
        class: { id: item.id, name: item.name },
        columns: own.map(toColumnDto),
        cells: cellsOf(own, mine),
        average: mine?.average ?? null,
      };
    });
  });
}
