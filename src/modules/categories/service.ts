import { DatabaseError, Transaction, UniqueConstraintError, col, fn } from 'sequelize';

import { sequelize } from '../../db/index.js';
import { Category, SchoolClass, User } from '../../db/models/index.js';
import { AppError } from '../../lib/errors.js';

const CATEGORY_CAP = 100;

export interface CategoryDto {
  id: string;
  name: string;
  classCount: number;
  createdAt: string;
}

function toCategoryDto(category: Category, classCount: number): CategoryDto {
  return {
    id: category.id,
    name: category.name,
    classCount,
    createdAt: category.createdAt.toISOString(),
  };
}

// Serializes cap checks per teacher. NO KEY UPDATE, so foreign-key checks on other
// tables (a login inserting a refresh token, for example) don't have to wait for it.
export async function lockTeacher(teacherId: string, transaction: Transaction): Promise<void> {
  const teacher = await User.findByPk(teacherId, {
    attributes: ['id'],
    lock: Transaction.LOCK.NO_KEY_UPDATE,
    transaction,
  });

  if (!teacher) {
    throw new AppError('UNAUTHENTICATED', 'Account no longer exists');
  }
}

export async function getOwnCategory(
  teacherId: string,
  categoryId: string,
  transaction?: Transaction,
): Promise<Category> {
  const category = await Category.findOne({ where: { id: categoryId, teacherId }, transaction });

  if (!category) {
    throw new AppError('NOT_FOUND', 'Category not found');
  }

  return category;
}

// The unique index on (teacher_id, lower(name)) is the only name check, so a race can't
// slip past it.
function toNameTaken(err: unknown): unknown {
  return err instanceof UniqueConstraintError ? new AppError('CATEGORY_NAME_TAKEN') : err;
}

export async function listCategories(teacherId: string): Promise<CategoryDto[]> {
  const [categories, counts] = await Promise.all([
    Category.findAll({
      where: { teacherId },
      order: [
        [fn('lower', col('name')), 'ASC'],
        ['name', 'ASC'],
        ['id', 'ASC'],
      ],
    }),
    SchoolClass.count({ where: { teacherId }, group: ['categoryId'] }),
  ]);
  const classCounts = new Map(counts.map((row) => [String(row.categoryId), row.count]));

  return categories.map((category) => toCategoryDto(category, classCounts.get(category.id) ?? 0));
}

export async function createCategory(
  teacherId: string,
  input: { name: string },
): Promise<CategoryDto> {
  try {
    return await sequelize.transaction(async (transaction) => {
      await lockTeacher(teacherId, transaction);

      if ((await Category.count({ where: { teacherId }, transaction })) >= CATEGORY_CAP) {
        throw new AppError('LIMIT_REACHED', `A teacher has at most ${CATEGORY_CAP} categories`);
      }

      const category = await Category.create({ teacherId, name: input.name }, { transaction });

      return toCategoryDto(category, 0);
    });
  } catch (err) {
    throw toNameTaken(err);
  }
}

export async function renameCategory(
  teacherId: string,
  categoryId: string,
  input: { name: string },
): Promise<CategoryDto> {
  const category = await getOwnCategory(teacherId, categoryId);

  try {
    await category.update({ name: input.name });
  } catch (err) {
    throw toNameTaken(err);
  }

  return toCategoryDto(category, await SchoolClass.count({ where: { categoryId } }));
}

// PostgreSQL reports a RESTRICT violation as 23001, which Sequelize leaves as a plain
// DatabaseError: it maps only 23503 to ForeignKeyConstraintError.
function isRestrictViolation(err: unknown): boolean {
  return err instanceof DatabaseError && (err.parent as { code?: string }).code === '23001';
}

export async function deleteCategory(teacherId: string, categoryId: string): Promise<void> {
  const category = await getOwnCategory(teacherId, categoryId);

  // The RESTRICT foreign key on classes.category_id is the only check, so a class created
  // at the same moment can't slip past it.
  try {
    await category.destroy();
  } catch (err) {
    throw isRestrictViolation(err) ? new AppError('CATEGORY_NOT_EMPTY') : err;
  }
}
