import type { Transaction } from 'sequelize';

import { sequelize } from '../../db/index.js';
import { Category, ClassStudent, SchoolClass } from '../../db/models/index.js';
import { AppError } from '../../lib/errors.js';
import { insertWithPublicId } from '../../lib/publicId.js';
import { lockTeacher } from '../categories/service.js';

const CLASS_CAP = 100;

// Only teacher routes return this, so a class publicId reaches only its teacher (contract 6.1).
export interface ClassDto {
  id: string;
  categoryId: string;
  subject: string;
  name: string | null;
  publicId: string;
  studentCount: number;
  createdAt: string;
}

function toClassDto(schoolClass: SchoolClass, studentCount: number): ClassDto {
  return {
    id: schoolClass.id,
    categoryId: schoolClass.categoryId,
    subject: schoolClass.subject,
    name: schoolClass.name,
    publicId: schoolClass.publicId,
    studentCount,
    createdAt: schoolClass.createdAt.toISOString(),
  };
}

export async function getOwnClass(
  teacherId: string,
  classId: string,
  transaction?: Transaction,
): Promise<SchoolClass> {
  const schoolClass = await SchoolClass.findOne({ where: { id: classId, teacherId }, transaction });

  if (!schoolClass) {
    throw new AppError('NOT_FOUND', 'Class not found');
  }

  return schoolClass;
}

// Someone else's category gets the same answer as one that doesn't exist.
async function assertOwnCategory(
  teacherId: string,
  categoryId: string,
  transaction?: Transaction,
): Promise<void> {
  const category = await Category.findOne({
    attributes: ['id'],
    where: { id: categoryId, teacherId },
    transaction,
  });

  if (!category) {
    throw new AppError('VALIDATION_ERROR', 'Unknown category', [
      { path: 'categoryId', message: 'Unknown category' },
    ]);
  }
}

async function studentCount(classId: string): Promise<number> {
  return ClassStudent.count({ where: { classId } });
}

export async function listClasses(
  teacherId: string,
  filter: { categoryId?: string },
): Promise<ClassDto[]> {
  const classes = await SchoolClass.findAll({
    where: { teacherId, ...(filter.categoryId ? { categoryId: filter.categoryId } : {}) },
    order: [
      ['createdAt', 'DESC'],
      ['id', 'DESC'],
    ],
  });

  if (classes.length === 0) {
    return [];
  }

  const counts = await ClassStudent.count({
    where: { classId: classes.map((schoolClass) => schoolClass.id) },
    group: ['classId'],
  });
  const studentCounts = new Map(counts.map((row) => [String(row.classId), row.count]));

  return classes.map((schoolClass) =>
    toClassDto(schoolClass, studentCounts.get(schoolClass.id) ?? 0),
  );
}

export async function getClass(teacherId: string, classId: string): Promise<ClassDto> {
  const schoolClass = await getOwnClass(teacherId, classId);

  return toClassDto(schoolClass, await studentCount(classId));
}

export async function createClass(
  teacherId: string,
  input: { categoryId: string; subject: string; name?: string | null },
): Promise<ClassDto> {
  return insertWithPublicId((publicId) =>
    sequelize.transaction(async (transaction) => {
      await lockTeacher(teacherId, transaction);

      if ((await SchoolClass.count({ where: { teacherId }, transaction })) >= CLASS_CAP) {
        throw new AppError('LIMIT_REACHED', `A teacher has at most ${CLASS_CAP} classes`);
      }

      await assertOwnCategory(teacherId, input.categoryId, transaction);
      const schoolClass = await SchoolClass.create(
        {
          categoryId: input.categoryId,
          teacherId,
          subject: input.subject,
          name: input.name ?? null,
          publicId,
        },
        { transaction },
      );

      return toClassDto(schoolClass, 0);
    }),
  );
}

export async function updateClass(
  teacherId: string,
  classId: string,
  input: { categoryId?: string; subject?: string; name?: string | null },
): Promise<ClassDto> {
  const schoolClass = await getOwnClass(teacherId, classId);
  const changes: { categoryId?: string; subject?: string; name?: string | null } = {};

  if (input.categoryId !== undefined) {
    await assertOwnCategory(teacherId, input.categoryId);
    changes.categoryId = input.categoryId;
  }
  if (input.subject !== undefined) {
    changes.subject = input.subject;
  }
  // `name: null` clears it; an absent name leaves it alone.
  if (input.name !== undefined) {
    changes.name = input.name;
  }

  await schoolClass.update(changes);

  return toClassDto(schoolClass, await studentCount(classId));
}

// The database cascades everything in the class. Removing its stored files arrives in Phase 7.
export async function deleteClass(teacherId: string, classId: string): Promise<void> {
  await (await getOwnClass(teacherId, classId)).destroy();
}
