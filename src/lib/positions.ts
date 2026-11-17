import type { Transaction } from 'sequelize';

import { sequelize } from '../db/index.js';
import { AppError } from './errors.js';

// Every table with a dense, 0-based `position` among its siblings (contract 4).
export type PositionedTable = 'categories' | 'classes' | 'units' | 'lessons';

// Returns ids with `id` taken out (if it is there) and put back at index `order`.
export function placeAt(ids: string[], id: string, order: number): string[] {
  const rest = ids.filter((other) => other !== id);

  return [...rest.slice(0, order), id, ...rest.slice(order)];
}

// An `order` outside 0..max is a VALIDATION_ERROR on the field (plan, open item 6).
export function orderOutOfRange(max: number): AppError {
  return new AppError('VALIDATION_ERROR', 'Order out of range', [
    { path: 'order', message: `Must be between 0 and ${max}` },
  ]);
}

// Gives the rows positions 0..n-1 in the order listed, so the group stays dense
// (contract 4). Rows already in place are left alone. The rows are locked in id order first:
// content writes in a class group lock several classes in that order too, so the two can't
// deadlock.
export async function writePositions(
  table: PositionedTable,
  ids: string[],
  transaction: Transaction,
): Promise<void> {
  if (ids.length === 0) {
    return;
  }

  await sequelize.query(`SELECT id FROM ${table} WHERE id = ANY($ids::uuid[]) ORDER BY id FOR NO KEY UPDATE`, {
    bind: { ids },
    transaction,
  });

  await sequelize.query(
    `UPDATE ${table} AS t
        SET position = v.n - 1, updated_at = now()
       FROM unnest($ids::uuid[]) WITH ORDINALITY AS v(id, n)
      WHERE t.id = v.id AND t.position <> v.n - 1`,
    { bind: { ids }, transaction },
  );
}
