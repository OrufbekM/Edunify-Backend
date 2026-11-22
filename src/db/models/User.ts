import {
  DataTypes,
  Model,
  Sequelize,
  type CreationOptional,
  type InferAttributes,
  type InferCreationAttributes,
} from 'sequelize';

import { sequelize } from '../index.js';
import { ROLES, USER_STATUSES, type Role, type UserStatus } from './enums.js';

// Contract section 4. Which of email, phone, login and publicId are set depends on the role;
// the database checks it.
export class User extends Model<InferAttributes<User>, InferCreationAttributes<User>> {
  declare id: CreationOptional<string>;
  declare role: Role;
  declare firstName: string;
  declare lastName: string;
  // Teachers and students; null for the admin.
  declare email: string | null;
  // Teachers only, normalized to + and digits.
  declare phone: string | null;
  // The admin only.
  declare login: string | null;
  declare passwordHash: string;
  // 8 characters for students, null for everyone else (contract section 6.1).
  declare publicId: string | null;
  declare status: UserStatus;
  // Set by an admin password reset until the user picks a new password.
  declare mustChangePassword: CreationOptional<boolean>;
  declare createdAt: CreationOptional<Date>;
  declare updatedAt: CreationOptional<Date>;
}

User.init(
  {
    id: {
      type: DataTypes.UUID,
      primaryKey: true,
      allowNull: false,
      defaultValue: Sequelize.literal('gen_random_uuid()'),
    },
    role: { type: DataTypes.ENUM(...ROLES), allowNull: false },
    firstName: { type: DataTypes.TEXT, allowNull: false },
    lastName: { type: DataTypes.TEXT, allowNull: false },
    email: { type: DataTypes.CITEXT, allowNull: true },
    phone: { type: DataTypes.TEXT, allowNull: true },
    login: { type: DataTypes.CITEXT, allowNull: true },
    passwordHash: { type: DataTypes.TEXT, allowNull: false },
    publicId: { type: DataTypes.CHAR(8), allowNull: true },
    status: { type: DataTypes.ENUM(...USER_STATUSES), allowNull: false },
    mustChangePassword: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
    createdAt: { type: DataTypes.DATE, allowNull: false },
    updatedAt: { type: DataTypes.DATE, allowNull: false },
  },
  { sequelize, tableName: 'users', underscored: true },
);
