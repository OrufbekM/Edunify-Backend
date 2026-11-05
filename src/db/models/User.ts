import {
  DataTypes,
  Model,
  Sequelize,
  type CreationOptional,
  type InferAttributes,
  type InferCreationAttributes,
} from 'sequelize';

import { sequelize } from '../index.js';
import { ROLES, type Role } from './enums.js';

export class User extends Model<InferAttributes<User>, InferCreationAttributes<User>> {
  declare id: CreationOptional<string>;
  declare role: Role;
  declare fullName: string;
  declare email: string;
  declare passwordHash: string;
  // 8 characters for students, null for teachers (contract section 6.1).
  declare publicId: string | null;
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
    fullName: { type: DataTypes.TEXT, allowNull: false },
    email: { type: DataTypes.CITEXT, allowNull: false },
    passwordHash: { type: DataTypes.TEXT, allowNull: false },
    publicId: { type: DataTypes.CHAR(8), allowNull: true },
    createdAt: { type: DataTypes.DATE, allowNull: false },
    updatedAt: { type: DataTypes.DATE, allowNull: false },
  },
  { sequelize, tableName: 'users', underscored: true },
);
