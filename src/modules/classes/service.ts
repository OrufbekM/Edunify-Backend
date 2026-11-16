import { Transaction } from 'sequelize';

import { sequelize } from '../../db/index.js';
import { Category, ClassStudent, ClassUnit, SchoolClass, Unit } from '../../db/models/index.js';
import { AppError } from '../../lib/errors.js';
import { orderOutOfRange, writePositions } from '../../lib/positions.js';
import { insertWithPublicId } from '../../lib/publicId.js';
import { lockTeacher } from '../categories/service.js';
import { deleteFileRows, lockLessonFiles, removeStoredFiles } from '../files/service.js';

const CLASS_CAP = 100;

// Contract 8.3: every new class starts with one unit.
const FIRST_UNIT_TITLE = 'Unit 1';

// Only teacher routes return this, so a class publicId reaches only its teacher (contract 6.1).
export interface ClassDto {
  id: string;
  categoryId: string;
  order: number;
  name: string;
  publicId: string;
  studentCount: number;
  // Latest versions waiting for a grade; counted from plan Phase 16.
  newSubmissionCount: number;
  // The other classes of its group; class groups arrive in plan Phase 17.
  linkedClasses: { id: string; name: string }[];
  createdAt: string;
}

function toClassDto(schoolClass: SchoolClass, studentCount: number): ClassDto {
  return {
    id: schoolClass.id,
    categoryId: schoolClass.categoryId,
    order: schoolClass.position,
    name: schoolClass.name,
    publicId: schoolClass.publicId,
    studentCount,
    newSubmissionCount: 0,
    linkedClasses: [],
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

// Serializes cap checks per class, the way lockTeacher does per teacher. NO KEY UPDATE,
// so rows referencing the class can still be inserted elsewhere while it is held.
export async function lockOwnClass(
  teacherId: string,
  classId: string,
  transaction: Transaction,
): Promise<SchoolClass> {
  const schoolClass = await SchoolClass.findOne({
    where: { id: classId, teacherId },
    lock: Transaction.LOCK.NO_KEY_UPDATE,
    transaction,
  });

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

// The class ids of a category in order.
async function classIdsIn(categoryId: string, transaction: Transaction): Promise<string[]> {
  const classes = await SchoolClass.findAll({
    attributes: ['id'],
    where: { categoryId },
    order: [
      ['position', 'ASC'],
      ['id', 'ASC'],
    ],
    transaction,
  });

  return classes.map((schoolClass) => schoolClass.id);
}

async function studentCount(classId: string, transaction?: Transaction): Promise<number> {
  return ClassStudent.count({ where: { classId }, transaction });
}

// Sorted by category order, then class order (contract 8.3).
export async function listClasses(
  teacherId: string,
  filter: { categoryId?: string },
): Promise<ClassDto[]> {
  const classes = await SchoolClass.findAll({
    where: { teacherId, ...(filter.categoryId ? { categoryId: filter.categoryId } : {}) },
    include: [{ model: Category, attributes: [], required: true }],
    order: [
      [Category, 'position', 'ASC'],
      ['categoryId', 'ASC'],
      ['position', 'ASC'],
      ['id', 'ASC'],
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

// Placed last in its category, with its first unit (contract 8.3).
export async function createClass(
  teacherId: string,
  input: { categoryId: string; name: string },
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
          name: input.name,
          position: await SchoolClass.count({ where: { categoryId: input.categoryId }, transaction }),
          publicId,
        },
        { transaction },
      );
      const unit = await Unit.create({ classId: schoolClass.id, groupId: null, title: FIRST_UNIT_TITLE }, { transaction });
      await ClassUnit.create({ classId: schoolClass.id, unitId: unit.id, position: 0 }, { transaction });

      return toClassDto(schoolClass, 0);
    }),
  );
}

// `order` is the class's 0-based index in the category it ends up in: the new one when
// `categoryId` changes, else its own. A move to another category without `order` puts it
// last there (contract 8.3). Both categories stay dense.
export async function updateClass(
  teacherId: string,
  classId: string,
  input: { categoryId?: string; name?: string; order?: number },
): Promise<ClassDto> {
  return sequelize.transaction(async (transaction) => {
    await lockTeacher(teacherId, transaction);
    const schoolClass = await getOwnClass(teacherId, classId, transaction);
    const from = schoolClass.categoryId;
    const to = input.categoryId ?? from;

    if (to !== from) {
      await assertOwnCategory(teacherId, to, transaction);
    }

    if (input.name !== undefined) {
      schoolClass.name = input.name;
    }

    if (to !== from || input.order !== undefined) {
      const siblings = (await classIdsIn(to, transaction)).filter((id) => id !== classId);
      const order = input.order ?? siblings.length;

      if (order > siblings.length) {
        throw orderOutOfRange(siblings.length);
      }

      schoolClass.categoryId = to;
      await schoolClass.save({ transaction });
      await writePositions('classes', [...siblings.slice(0, order), classId, ...siblings.slice(order)], transaction);

      if (to !== from) {
        await writePositions('classes', await classIdsIn(from, transaction), transaction);
      }

      await schoolClass.reload({ transaction });
    } else {
      await schoolClass.save({ transaction });
    }

    return toClassDto(schoolClass, await studentCount(classId, transaction));
  });
}

// The database cascades everything in the class; its files go once the transaction has
// committed. The class lock keeps new lessons out while the files are collected, and the
// classes after it in its category move up one.
export async function deleteClass(teacherId: string, classId: string): Promise<void> {
  const storageKeys = await sequelize.transaction(async (transaction) => {
    await lockTeacher(teacherId, transaction);
    const schoolClass = await lockOwnClass(teacherId, classId, transaction);
    const fileIds = await lockLessonFiles({ classId }, transaction);

    await schoolClass.destroy({ transaction });
    await writePositions('classes', await classIdsIn(schoolClass.categoryId, transaction), transaction);

    return deleteFileRows(fileIds, transaction);
  });

  await removeStoredFiles(storageKeys);
}
