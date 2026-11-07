import { randomBytes, randomUUID } from 'node:crypto';

import { hash, verify } from 'argon2';
import { UniqueConstraintError, type Transaction } from 'sequelize';

import { sequelize } from '../../db/index.js';
import type { Role } from '../../db/models/enums.js';
import { RefreshToken, User } from '../../db/models/index.js';
import { AppError } from '../../lib/errors.js';
import { insertWithPublicId } from '../../lib/publicId.js';
import {
  REFRESH_TOKEN_TTL_SECONDS,
  generateRefreshToken,
  hashRefreshToken,
  signAccessToken,
} from '../../lib/tokens.js';

// Contract 2.3: a token reused this soon after its rotation is a multi-tab race, not a theft.
const REUSE_GRACE_MS = 10_000;
const REFRESH_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

// Verified against when the email is unknown, so a failed login takes as long either way.
const dummyHash = hash(randomBytes(32).toString('hex'));

export interface UserDto {
  id: string;
  role: Role;
  fullName: string;
  email: string;
  publicId: string | null;
  createdAt: string;
}

export interface Session {
  user: UserDto;
  accessToken: string;
  refreshToken: string;
}

export interface Refreshed {
  user: UserDto;
  accessToken: string;
  // Null inside the reuse grace window: the caller keeps the token it already has.
  refreshToken: string | null;
}

export function toUserDto(user: User): UserDto {
  return {
    id: user.id,
    role: user.role,
    fullName: user.fullName,
    email: user.email,
    publicId: user.publicId,
    createdAt: user.createdAt.toISOString(),
  };
}

function isUniqueViolationOn(err: unknown, column: string): boolean {
  return err instanceof UniqueConstraintError && column in err.fields;
}

function isWellFormed(rawToken: string | undefined): rawToken is string {
  return rawToken !== undefined && REFRESH_TOKEN_PATTERN.test(rawToken);
}

async function issueRefreshToken(
  userId: string,
  familyId: string,
  transaction?: Transaction,
): Promise<string> {
  const token = generateRefreshToken();

  await RefreshToken.create(
    {
      userId,
      familyId,
      tokenHash: hashRefreshToken(token),
      expiresAt: new Date(Date.now() + REFRESH_TOKEN_TTL_SECONDS * 1000),
      revokedAt: null,
      replacedAt: null,
    },
    { transaction },
  );

  return token;
}

async function startSession(user: User, transaction?: Transaction): Promise<Session> {
  return {
    user: toUserDto(user),
    accessToken: signAccessToken(user),
    refreshToken: await issueRefreshToken(user.id, randomUUID(), transaction),
  };
}

async function revokeTokens(
  scope: { familyId: string } | { userId: string },
  transaction?: Transaction,
): Promise<void> {
  await RefreshToken.update(
    { revokedAt: new Date() },
    { where: { ...scope, revokedAt: null }, transaction },
  );
}

async function findUser(userId: string): Promise<User> {
  const user = await User.findByPk(userId);

  // An access token stays valid for up to 15 minutes, so it can outlive its account.
  if (!user) {
    throw new AppError('UNAUTHENTICATED', 'Account no longer exists');
  }

  return user;
}

export async function register(input: {
  role: Role;
  fullName: string;
  email: string;
  password: string;
}): Promise<Session> {
  if (await User.findOne({ attributes: ['id'], where: { email: input.email } })) {
    throw new AppError('EMAIL_TAKEN');
  }

  const passwordHash = await hash(input.password);
  const create = (publicId: string | null) =>
    sequelize.transaction(async (transaction) => {
      const user = await User.create(
        {
          role: input.role,
          fullName: input.fullName,
          email: input.email,
          passwordHash,
          publicId,
        },
        { transaction },
      );

      return startSession(user, transaction);
    });

  try {
    return input.role === 'student' ? await insertWithPublicId(create) : await create(null);
  } catch (err) {
    // Two registrations raced past the check above.
    if (isUniqueViolationOn(err, 'email')) {
      throw new AppError('EMAIL_TAKEN');
    }
    throw err;
  }
}

export async function login(input: { email: string; password: string }): Promise<Session> {
  const user = await User.findOne({ where: { email: input.email } });
  const matches = await verify(user?.passwordHash ?? (await dummyHash), input.password);

  if (!user || !matches) {
    throw new AppError('INVALID_CREDENTIALS');
  }

  return startSession(user);
}

type RefreshOutcome =
  | { kind: 'rejected' }
  | { kind: 'rotated'; user: User; refreshToken: string }
  | { kind: 'grace'; user: User };

export async function refresh(rawToken: string | undefined): Promise<Refreshed> {
  if (!isWellFormed(rawToken)) {
    throw new AppError('UNAUTHENTICATED', 'Missing or malformed refresh token');
  }

  const outcome = await sequelize.transaction(async (transaction): Promise<RefreshOutcome> => {
    // The row lock makes parallel refreshes of one token take turns, so only one rotates it.
    const token = await RefreshToken.findOne({
      where: { tokenHash: hashRefreshToken(rawToken) },
      lock: true,
      transaction,
    });
    const now = Date.now();

    if (!token || token.expiresAt.getTime() <= now) {
      return { kind: 'rejected' };
    }

    const user = await User.findByPk(token.userId, { transaction });
    if (!user) {
      return { kind: 'rejected' };
    }

    if (!token.revokedAt && !token.replacedAt) {
      await token.update({ replacedAt: new Date(now) }, { transaction });
      const refreshToken = await issueRefreshToken(user.id, token.familyId, transaction);
      return { kind: 'rotated', user, refreshToken };
    }

    // Plan open item 3: every reuse inside the window is accepted, not only the first.
    if (!token.revokedAt && token.replacedAt && now - token.replacedAt.getTime() < REUSE_GRACE_MS) {
      return { kind: 'grace', user };
    }

    // Any other reuse means the token leaked: end the whole session. Returning instead of
    // throwing lets the revocation commit.
    await revokeTokens({ familyId: token.familyId }, transaction);
    return { kind: 'rejected' };
  });

  if (outcome.kind === 'rejected') {
    throw new AppError('UNAUTHENTICATED', 'Refresh token is invalid, expired or revoked');
  }

  return {
    user: toUserDto(outcome.user),
    accessToken: signAccessToken(outcome.user),
    refreshToken: outcome.kind === 'rotated' ? outcome.refreshToken : null,
  };
}

export async function logout(rawToken: string | undefined): Promise<void> {
  if (!isWellFormed(rawToken)) {
    return;
  }

  const token = await RefreshToken.findOne({
    attributes: ['familyId'],
    where: { tokenHash: hashRefreshToken(rawToken) },
  });

  if (token) {
    await revokeTokens({ familyId: token.familyId });
  }
}

export async function getMe(userId: string): Promise<UserDto> {
  return toUserDto(await findUser(userId));
}

export async function updateMe(userId: string, input: { fullName: string }): Promise<UserDto> {
  const user = await findUser(userId);

  await user.update({ fullName: input.fullName });

  return toUserDto(user);
}

// Plan open item 2: the refresh cookie never reaches /me, so the server cannot tell which
// session is the caller's. It ends them all and returns a token for a fresh one.
export async function changePassword(
  userId: string,
  input: { currentPassword: string; newPassword: string },
): Promise<string> {
  const user = await findUser(userId);

  if (!(await verify(user.passwordHash, input.currentPassword))) {
    throw new AppError('INVALID_CREDENTIALS');
  }

  const passwordHash = await hash(input.newPassword);

  return sequelize.transaction(async (transaction) => {
    await user.update({ passwordHash }, { transaction });
    await revokeTokens({ userId }, transaction);
    return issueRefreshToken(userId, randomUUID(), transaction);
  });
}
