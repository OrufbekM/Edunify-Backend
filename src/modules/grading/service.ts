import { QueryTypes, Transaction } from 'sequelize';

import { sequelize } from '../../db/index.js';
import { ClassStudent, Homework, Lesson, Submission } from '../../db/models/index.js';
import { AppError, notFoundAs } from '../../lib/errors.js';
import { getOwnClass } from '../classes/service.js';
import { lessonDetail, type HomeworkDto } from '../lessons/service.js';
import { notify, removeUnreadGradeNotices } from '../notifications/service.js';
import {
  lockSubmission,
  submissionDtosById,
  type Grade,
  type SubmissionDto,
} from '../submissions/service.js';

export type GradeInput =
  | { status: 'graded'; value: Grade; comment: string | null; fromAi: boolean }
  | { status: 'denied'; comment: string };

export interface GradingItemDto {
  classStudentId: string;
  fullName: string;
  submission: SubmissionDto | null;
}

export interface GradingDto {
  lesson: { id: string; title: string };
  homework: HomeworkDto;
  items: GradingItemDto[];
}

// One body for "missing", "not yours" and "no homework" (contract 2.4 and 8.9).
function lessonNotFound(): AppError {
  return new AppError('NOT_FOUND', 'Lesson not found');
}

function submissionNotFound(): AppError {
  return new AppError('NOT_FOUND', 'Submission not found');
}

// Every roster row, whatever its link state, sorted like the roster, each with its latest
// version built for a teacher, so with aiSuggestion (contract 8.9). One REPEATABLE READ
// snapshot, so the homework, the roster and the submissions agree with each other.
export async function getGrading(teacherId: string, lessonId: string): Promise<GradingDto> {
  return sequelize.transaction(
    { isolationLevel: Transaction.ISOLATION_LEVELS.REPEATABLE_READ },
    async (transaction) => {
      const lesson = await Lesson.findByPk(lessonId, { transaction });

      if (!lesson) {
        throw lessonNotFound();
      }

      await notFoundAs(getOwnClass(teacherId, lesson.classId, transaction), lessonNotFound);

      const detail = await lessonDetail(lesson, transaction);

      if (!detail.homework) {
        throw lessonNotFound();
      }

      const rows = await sequelize.query<{
        classStudentId: string;
        fullName: string;
        submissionId: string | null;
      }>(
        `SELECT cs.id AS "classStudentId",
                cs.full_name AS "fullName",
                (SELECT s.id FROM submissions s
                  WHERE s.homework_id = $homeworkId AND s.class_student_id = cs.id
                  ORDER BY s.version DESC
                  LIMIT 1) AS "submissionId"
           FROM class_students cs
          WHERE cs.class_id = $classId
          ORDER BY lower(cs.full_name), cs.full_name, cs.id`,
        {
          bind: { homeworkId: detail.homework.id, classId: lesson.classId },
          type: QueryTypes.SELECT,
          transaction,
        },
      );
      const submissions = await submissionDtosById(
        rows.flatMap((row) => (row.submissionId ? [row.submissionId] : [])),
        'teacher',
        transaction,
      );

      return {
        lesson: { id: lesson.id, title: lesson.title },
        homework: detail.homework,
        items: rows.map((row) => ({
          classStudentId: row.classStudentId,
          fullName: row.fullName,
          submission: row.submissionId ? (submissions.get(row.submissionId) ?? null) : null,
        })),
      };
    },
  );
}

// Ownership first, so a stranger takes no locks; then the locks a new version takes, so a
// grade and a new version can't cross (see lockSubmission). A submission deleted meanwhile
// is a 404.
async function lockLatest(
  teacherId: string,
  submissionId: string,
  transaction: Transaction,
): Promise<{ submission: Submission; row: ClassStudent }> {
  const found = await Submission.findByPk(submissionId, {
    attributes: ['homeworkId'],
    transaction,
  });
  const homework =
    found && (await Homework.findByPk(found.homeworkId, { attributes: ['lessonId'], transaction }));
  const lesson =
    homework && (await Lesson.findByPk(homework.lessonId, { attributes: ['classId'], transaction }));

  if (!lesson) {
    throw submissionNotFound();
  }

  await notFoundAs(getOwnClass(teacherId, lesson.classId, transaction), submissionNotFound);

  const locked = await lockSubmission(submissionId, transaction);

  if (!locked) {
    throw submissionNotFound();
  }

  if (!locked.isLatest) {
    throw new AppError('SUBMISSION_NOT_LATEST');
  }

  return locked;
}

async function teacherDto(submissionId: string, transaction: Transaction): Promise<SubmissionDto> {
  return (await submissionDtosById([submissionId], 'teacher', transaction)).get(
    submissionId,
  ) as SubmissionDto;
}

// Grades or denies the latest version; a second call overwrites the first (contract 8.9).
// fromAi confirms the AI suggestion, so there has to be one; the teacher may still change
// its value or comment. A grade entered by hand leaves the suggestion where it is.
export async function gradeSubmission(
  teacherId: string,
  submissionId: string,
  input: GradeInput,
): Promise<SubmissionDto> {
  return sequelize.transaction(async (transaction) => {
    const { submission, row } = await lockLatest(teacherId, submissionId, transaction);
    const fromAi = input.status === 'graded' && input.fromAi;

    if (fromAi && submission.aiSuggestion === null) {
      throw new AppError('VALIDATION_ERROR', 'Nothing to confirm', [
        { path: 'fromAi', message: 'There is no AI suggestion to confirm' },
      ]);
    }

    await submission.update(
      {
        status: input.status,
        gradeValue: input.status === 'graded' ? input.value : null,
        gradeDenied: input.status === 'denied',
        gradeComment: input.comment,
        gradeSource: fromAi ? 'ai_confirmed' : 'teacher',
        gradedAt: new Date(),
        ...(fromAi ? { aiSuggestion: null } : {}),
      },
      { transaction },
    );

    // The row's account, if it has one; until they claim the class it stays out of their
    // list, like everything else about it (contract 6.2).
    if (row.studentUserId !== null) {
      await notify(row.studentUserId, submission.id, input.status, transaction);
    }

    return teacherDto(submission.id, transaction);
  });
}

// Back to submitted with no grade; the AI suggestion is untouched. Ungraded already: no-op.
export async function removeGrade(teacherId: string, submissionId: string): Promise<SubmissionDto> {
  return sequelize.transaction(async (transaction) => {
    const { submission } = await lockLatest(teacherId, submissionId, transaction);

    if (submission.status !== 'submitted') {
      await submission.update(
        {
          status: 'submitted',
          gradeValue: null,
          gradeDenied: false,
          gradeComment: null,
          gradeSource: null,
          gradedAt: null,
        },
        { transaction },
      );
      await removeUnreadGradeNotices(submission.id, transaction);
    }

    return teacherDto(submission.id, transaction);
  });
}
