import { Op, QueryTypes, Transaction, UniqueConstraintError, literal } from 'sequelize';

import { sequelize } from '../../db/index.js';
import { ClassClaim, ClassStudent, LinkAudit, SchoolClass, User } from '../../db/models/index.js';
import { AppError } from '../../lib/errors.js';
import { getOwnClass, lockOwnClass } from '../classes/service.js';
import { deleteFileRows, pageFileIds, removeStoredFiles } from '../files/service.js';

const STUDENT_CAP = 200;

// Contract section 3. Computed by query on every read, never stored (contract 6.2).
export type LinkState = 'no_id' | 'awaiting_student' | 'active';

export interface ClassStudentDto {
  id: string;
  fullName: string;
  // The linked account's publicId, so the teacher sees the ID as it is stored.
  studentPublicId: string | null;
  linkState: LinkState;
}

export interface StudentClassDto {
  id: string;
  subject: string;
  name: string | null;
  teacherName: string;
  classStudentId: string;
}

// The claim join feeds linkState and nothing else: teachers never see claims (contract 6.2).
// Sorted by fullName, ignoring case.
export async function rosterRows(
  classId: string,
  options: { studentId?: string; transaction?: Transaction } = {},
): Promise<ClassStudentDto[]> {
  const oneRow = options.studentId !== undefined;

  return sequelize.query<ClassStudentDto>(
    `SELECT cs.id,
            cs.full_name AS "fullName",
            u.public_id AS "studentPublicId",
            CASE
              WHEN cs.student_user_id IS NULL THEN 'no_id'
              WHEN cc.id IS NULL THEN 'awaiting_student'
              ELSE 'active'
            END AS "linkState"
       FROM class_students cs
       LEFT JOIN users u ON u.id = cs.student_user_id
       LEFT JOIN class_claims cc
         ON cc.student_user_id = cs.student_user_id AND cc.class_id = cs.class_id
      WHERE cs.class_id = $classId${oneRow ? ' AND cs.id = $studentId' : ''}
      ORDER BY lower(cs.full_name), cs.full_name, cs.id`,
    {
      bind: oneRow ? { classId, studentId: options.studentId } : { classId },
      type: QueryTypes.SELECT,
      transaction: options.transaction,
    },
  );
}

async function rosterEntry(
  classId: string,
  studentId: string,
  transaction: Transaction,
): Promise<ClassStudentDto> {
  const [entry] = await rosterRows(classId, { studentId, transaction });

  if (!entry) {
    throw new AppError('NOT_FOUND', 'Class student not found');
  }

  return entry;
}

// Only students have a publicId (the users check constraint), so a teacher is never found.
// KEY SHARE keeps the account in place until the row that points at it is written.
async function findStudentAccount(publicId: string, transaction: Transaction): Promise<string> {
  const student = await User.findOne({
    attributes: ['id'],
    where: { publicId, role: 'student' },
    lock: Transaction.LOCK.KEY_SHARE,
    transaction,
  });

  if (!student) {
    throw new AppError('STUDENT_ID_NOT_FOUND');
  }

  return student.id;
}

// The unique index on (class_id, student_user_id) is the only check, so two requests
// linking the same account at once can't both pass it.
function toIdInUse(err: unknown): unknown {
  return err instanceof UniqueConstraintError ? new AppError('STUDENT_ID_IN_USE') : err;
}

export async function listStudents(teacherId: string, classId: string): Promise<ClassStudentDto[]> {
  await getOwnClass(teacherId, classId);

  return rosterRows(classId);
}

// Not audited: link_audit records changes to a row's link (contract 6.3), and a new row
// has no earlier link to change.
export async function addStudent(
  teacherId: string,
  classId: string,
  input: { fullName: string; studentPublicId?: string | null },
): Promise<ClassStudentDto> {
  try {
    return await sequelize.transaction(async (transaction) => {
      await lockOwnClass(teacherId, classId, transaction);

      if ((await ClassStudent.count({ where: { classId }, transaction })) >= STUDENT_CAP) {
        throw new AppError('LIMIT_REACHED', `A class has at most ${STUDENT_CAP} students`);
      }

      const studentUserId =
        input.studentPublicId == null
          ? null
          : await findStudentAccount(input.studentPublicId, transaction);
      const row = await ClassStudent.create(
        { classId, fullName: input.fullName, studentUserId },
        { transaction },
      );

      return rosterEntry(classId, row.id, transaction);
    });
  } catch (err) {
    throw toIdInUse(err);
  }
}

// A new studentPublicId replaces the linked account, and null unlinks; either one is
// audited in the same transaction (contract 6.3). The row keeps its id, so its submissions
// and grades stay where they are.
export async function updateStudent(
  teacherId: string,
  classId: string,
  studentId: string,
  input: { fullName?: string; studentPublicId?: string | null },
): Promise<ClassStudentDto> {
  try {
    return await sequelize.transaction(async (transaction) => {
      await getOwnClass(teacherId, classId, transaction);

      // Locked so that two simultaneous re-links can't both record the same old account.
      const row = await ClassStudent.findOne({
        where: { id: studentId, classId },
        lock: Transaction.LOCK.NO_KEY_UPDATE,
        transaction,
      });

      if (!row) {
        throw new AppError('NOT_FOUND', 'Class student not found');
      }

      const oldUserId = row.studentUserId;

      if (input.fullName !== undefined) {
        row.fullName = input.fullName;
      }
      if (input.studentPublicId !== undefined) {
        row.studentUserId =
          input.studentPublicId === null
            ? null
            : await findStudentAccount(input.studentPublicId, transaction);
      }

      await row.save({ transaction });

      // Sending the account that is already linked changes nothing, so nothing is audited.
      if (row.studentUserId !== oldUserId) {
        await LinkAudit.create(
          {
            classStudentId: row.id,
            oldUserId,
            newUserId: row.studentUserId,
            changedBy: teacherId,
          },
          { transaction },
        );
      }

      return rosterEntry(classId, row.id, transaction);
    });
  } catch (err) {
    throw toIdInUse(err);
  }
}

// The database cascades the row's submissions, grades and audit rows; their files go once
// the transaction has committed.
export async function deleteStudent(
  teacherId: string,
  classId: string,
  studentId: string,
): Promise<void> {
  const storageKeys = await sequelize.transaction(async (transaction) => {
    await getOwnClass(teacherId, classId, transaction);

    // FOR UPDATE: a new submission's foreign key needs KEY SHARE on this row, so none can
    // appear while its pages are collected.
    const row = await ClassStudent.findOne({
      where: { id: studentId, classId },
      lock: Transaction.LOCK.UPDATE,
      transaction,
    });

    if (!row) {
      throw new AppError('NOT_FOUND', 'Class student not found');
    }

    const fileIds = await pageFileIds({ classStudentId: row.id }, transaction);

    await row.destroy({ transaction });

    return deleteFileRows(fileIds, transaction);
  });

  await removeStoredFiles(storageKeys);
}

// The same answer for every existing class, whether or not the teacher has linked the
// student, so a claim reveals nothing about the roster (contract 8.5).
export async function claimClass(userId: string, input: { classPublicId: string }): Promise<void> {
  await sequelize.transaction(async (transaction) => {
    // KEY SHARE keeps the class from being deleted before the claim is written.
    const schoolClass = await SchoolClass.findOne({
      attributes: ['id'],
      where: { publicId: input.classPublicId },
      lock: Transaction.LOCK.KEY_SHARE,
      transaction,
    });

    if (!schoolClass) {
      throw new AppError('CLASS_ID_NOT_FOUND');
    }

    // ON CONFLICT DO NOTHING, so claiming the same class again is a no-op.
    await ClassClaim.bulkCreate([{ studentUserId: userId, classId: schoolClass.id }], {
      ignoreDuplicates: true,
      transaction,
    });
  });
}

// Active links only (contract 6.2); the class publicId stays with the teacher (contract 6.1).
export async function listMyClasses(
  userId: string,
  transaction?: Transaction,
): Promise<StudentClassDto[]> {
  return sequelize.query<StudentClassDto>(
    `SELECT c.id,
            c.subject,
            c.name,
            t.full_name AS "teacherName",
            cs.id AS "classStudentId"
       FROM class_students cs
       JOIN class_claims cc
         ON cc.student_user_id = cs.student_user_id AND cc.class_id = cs.class_id
       JOIN classes c ON c.id = cs.class_id
       JOIN users t ON t.id = c.teacher_id
      WHERE cs.student_user_id = $userId
      ORDER BY lower(c.subject), c.subject, lower(c.name), c.name, c.id`,
    { bind: { userId }, type: QueryTypes.SELECT, transaction },
  );
}

// The gate for every student-facing service: the caller's row in the class, and only
// while the caller has also claimed the class. Anything else is 404, so a student can't
// tell a class they aren't linked to from one that doesn't exist (contract 2.4).
//
// With `lock`, the row is locked FOR NO KEY UPDATE, so a re-link or unlink of it waits for
// the caller's transaction, or has already committed and the link is checked against it.
export async function getActiveClassStudent(
  userId: string,
  classId: string,
  transaction?: Transaction,
  { lock = false }: { lock?: boolean } = {},
): Promise<ClassStudent> {
  const row = await ClassStudent.findOne({
    where: {
      classId,
      studentUserId: userId,
      [Op.and]: literal(
        `EXISTS (SELECT 1 FROM class_claims cc
                  WHERE cc.student_user_id = "ClassStudent"."student_user_id"
                    AND cc.class_id = "ClassStudent"."class_id")`,
      ),
    },
    ...(lock ? { lock: Transaction.LOCK.NO_KEY_UPDATE } : {}),
    transaction,
  });

  if (!row) {
    throw new AppError('NOT_FOUND', 'Class not found');
  }

  return row;
}
