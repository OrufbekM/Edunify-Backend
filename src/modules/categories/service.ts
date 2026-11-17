import { DatabaseError, Transaction, UniqueConstraintError } from 'sequelize';

import { sequelize } from '../../db/index.js';
import { Category, SchoolClass, User } from '../../db/models/index.js';
import { AppError } from '../../lib/errors.js';
import { orderOutOfRange, placeAt, writePositions } from '../../lib/positions.js';

const CATEGORY_CAP = 100;

export interface CategoryDto {
  id: string;
  name: string;
  order: number;
  classCount: number;
  createdAt: string;
}

function toCategoryDto(category: Category, classCount: number): CategoryDto {
  return {
    id: category.id,
    name: category.name,
    order: category.position,
    classCount,
    createdAt: category.createdAt.toISOString(),
  };
}

// Serializes cap checks and every change of order among a teacher's categories and classes.
// NO KEY UPDATE, so foreign-key checks on other tables (a login inserting a refresh token,
// for example) don't have to wait for it.
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

// The teacher's category ids in order.
async function categoryIds(teacherId: string, transaction: Transaction): Promise<string[]> {
  const categories = await Category.findAll({
    attributes: ['id'],
    where: { teacherId },
    order: [
      ['position', 'ASC'],
      ['id', 'ASC'],
    ],
    transaction,
  });

  return categories.map((category) => category.id);
}

// The unique index on (teacher_id, lower(name)) is the only name check, so a race can't
// slip past it.
function toNameTaken(err: unknown): unknown {
  return err instanceof UniqueConstraintError ? new AppError('CATEGORY_NAME_TAKEN') : err;
}

// Sorted by order (contract 8.2).
export async function listCategories(teacherId: string): Promise<CategoryDto[]> {
  const [categories, counts] = await Promise.all([
    Category.findAll({
      where: { teacherId },
      order: [
        ['position', 'ASC'],
        ['id', 'ASC'],
      ],
    }),
    SchoolClass.count({ where: { teacherId }, group: ['categoryId'] }),
  ]);
  const classCounts = new Map(counts.map((row) => [String(row.categoryId), row.count]));

  return categories.map((category) => toCategoryDto(category, classCounts.get(category.id) ?? 0));
}

// Placed last (contract 8.2).
export async function createCategory(
  teacherId: string,
  input: { name: string },
): Promise<CategoryDto> {
  try {
    return await sequelize.transaction(async (transaction) => {
      await lockTeacher(teacherId, transaction);

      const count = await Category.count({ where: { teacherId }, transaction });
      if (count >= CATEGORY_CAP) {
        throw new AppError('LIMIT_REACHED', `A teacher has at most ${CATEGORY_CAP} categories`);
      }

      const category = await Category.create({ teacherId, name: input.name, position: count }, { transaction });

      return toCategoryDto(category, 0);
    });
  } catch (err) {
    throw toNameTaken(err);
  }
}

// `order` is the category's new 0-based index among the teacher's categories (contract 8.2).
export async function updateCategory(
  teacherId: string,
  categoryId: string,
  input: { name?: string; order?: number },
): Promise<CategoryDto> {
  try {
    return await sequelize.transaction(async (transaction) => {
      await lockTeacher(teacherId, transaction);
      const category = await getOwnCategory(teacherId, categoryId, transaction);

      if (input.name !== undefined) {
        await category.update({ name: input.name }, { transaction });
      }

      if (input.order !== undefined) {
        const ids = await categoryIds(teacherId, transaction);

        if (input.order > ids.length - 1) {
          throw orderOutOfRange(ids.length - 1);
        }

        await writePositions('categories', placeAt(ids, category.id, input.order), transaction);
        await category.reload({ transaction });
      }

      return toCategoryDto(category, await SchoolClass.count({ where: { categoryId }, transaction }));
    });
  } catch (err) {
    throw toNameTaken(err);
  }
}

// PostgreSQL 18 reports a RESTRICT violation as 23001, but 17 (production and CI, contract
// 1.2) still reports 23503. Sequelize leaves 23001 a plain DatabaseError and maps 23503 to
// ForeignKeyConstraintError, a DatabaseError too. classes.category_id is the only key that
// points at categories, so either code means the category still has classes.
const RESTRICT_VIOLATION_CODES: ReadonlySet<string | undefined> = new Set(['23001', '23503']);

function isRestrictViolation(err: unknown): boolean {
  return err instanceof DatabaseError && RESTRICT_VIOLATION_CODES.has((err.parent as { code?: string }).code);
}

// The categories after it move up one, so the order stays dense (contract 4).
export async function deleteCategory(teacherId: string, categoryId: string): Promise<void> {
  await sequelize.transaction(async (transaction) => {
    await lockTeacher(teacherId, transaction);
    const category = await getOwnCategory(teacherId, categoryId, transaction);

    // The RESTRICT foreign key on classes.category_id is the only check, so a class created
    // at the same moment can't slip past it.
    try {
      await category.destroy({ transaction });
    } catch (err) {
      throw isRestrictViolation(err) ? new AppError('CATEGORY_NOT_EMPTY') : err;
    }

    await writePositions('categories', await categoryIds(teacherId, transaction), transaction);
  });
}
