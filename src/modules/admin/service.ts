import { randomInt } from 'node:crypto';

import { hash } from 'argon2';
import { Op, Sequelize, type Transaction, type WhereOptions } from 'sequelize';

import { sequelize } from '../../db/index.js';
import type { UserStatus } from '../../db/models/enums.js';
import { User } from '../../db/models/index.js';
import { AppError } from '../../lib/errors.js';
import { endAllSessions, toUserDto, type UserDto } from '../auth/service.js';

// Contract 6.1: a student's publicId goes only to that student, so the admin gets null
// (plan, open item 2).
function toAdminUserDto(user: User): UserDto {
  return { ...toUserDto(user), publicId: null };
}

// Contract 8.14: pending -> active (approve) or blocked (reject); active -> blocked;
// blocked -> active. Anything else, the same status included, is refused.
const TRANSITIONS: Record<UserStatus, readonly UserStatus[]> = {
  pending: ['active', 'blocked'],
  active: ['blocked'],
  blocked: ['active'],
};

// Contract 8.14: 12 characters without the look-alikes 0, O, 1, l and I.
const TEMPORARY_PASSWORD_ALPHABET = 'abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const TEMPORARY_PASSWORD_LENGTH = 12;

export function generateTemporaryPassword(): string {
  let password = '';

  for (let i = 0; i < TEMPORARY_PASSWORD_LENGTH; i += 1) {
    password += TEMPORARY_PASSWORD_ALPHABET.charAt(randomInt(TEMPORARY_PASSWORD_ALPHABET.length));
  }

  return password;
}

// A search is taken literally: % and _ match themselves, not any text.
function containing(text: string): string {
  return `%${text.replace(/[\\%_]/g, '\\$&')}%`;
}

export interface ListUsersQuery {
  role?: 'teacher' | 'student';
  status?: UserStatus;
  q?: string;
  limit: number;
  offset: number;
}

// Contract 8.14: teachers and students, never the admin, newest first. The id breaks ties
// so that paging never repeats or skips an account.
export async function listUsers(query: ListUsersQuery): Promise<{ items: UserDto[]; total: number }> {
  const conditions: WhereOptions[] = [{ role: query.role ?? { [Op.ne]: 'admin' } }];

  if (query.status) {
    conditions.push({ status: query.status });
  }

  if (query.q) {
    const pattern = containing(query.q);
    const fullName = Sequelize.fn('concat', Sequelize.col('first_name'), ' ', Sequelize.col('last_name'));
    const search: WhereOptions[] = [
      { firstName: { [Op.iLike]: pattern } },
      { lastName: { [Op.iLike]: pattern } },
      Sequelize.where(fullName, { [Op.iLike]: pattern }),
      { email: { [Op.iLike]: pattern } },
    ];

    // Phones are stored as + and digits, so "+998 (90) 123" finds +99890123...
    const phone = query.q.replace(/[\s()-]/g, '');
    if (phone) {
      search.push({ phone: { [Op.iLike]: containing(phone) } });
    }

    conditions.push({ [Op.or]: search });
  }

  const { rows, count } = await User.findAndCountAll({
    where: { [Op.and]: conditions },
    order: [
      ['createdAt', 'DESC'],
      ['id', 'DESC'],
    ],
    limit: query.limit,
    offset: query.offset,
  });

  return { items: rows.map(toAdminUserDto), total: count };
}

// Contract 8.14: the target must be a teacher or a student; the admin, like a missing id,
// is NOT_FOUND. Locked, so two admin actions on one account take turns.
async function findTarget(userId: string, transaction: Transaction): Promise<User> {
  const user = await User.findByPk(userId, { lock: true, transaction });

  if (!user || user.role === 'admin') {
    throw new AppError('NOT_FOUND');
  }

  return user;
}

export async function setUserStatus(userId: string, status: 'active' | 'blocked'): Promise<UserDto> {
  return sequelize.transaction(async (transaction) => {
    const user = await findTarget(userId, transaction);

    if (!TRANSITIONS[user.status].includes(status)) {
      throw new AppError('INVALID_STATUS_TRANSITION', `Cannot change ${user.status} to ${status}`);
    }

    await user.update({ status }, { transaction });

    // Contract 8.14: blocking ends every session. The account check stops the access token
    // already handed out on its next request.
    if (status === 'blocked') {
      await endAllSessions(user.id, transaction);
    }

    return toAdminUserDto(user);
  });
}

// Contract 8.14: the temporary password is returned once and only its hash is stored. The
// user is signed out everywhere and, after signing in with it, must choose a new one before
// anything else works.
export async function resetUserPassword(userId: string): Promise<{ temporaryPassword: string }> {
  const temporaryPassword = generateTemporaryPassword();
  // Hashed before the transaction, so the slow hash doesn't hold the row lock.
  const passwordHash = await hash(temporaryPassword);

  await sequelize.transaction(async (transaction) => {
    const user = await findTarget(userId, transaction);

    await user.update({ passwordHash, mustChangePassword: true }, { transaction });
    await endAllSessions(user.id, transaction);
  });

  return { temporaryPassword };
}
