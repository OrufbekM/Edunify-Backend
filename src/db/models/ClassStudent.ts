import {
  DataTypes,
  Model,
  Sequelize,
  type CreationOptional,
  type InferAttributes,
  type InferCreationAttributes,
} from 'sequelize';

import { sequelize } from '../index.js';

// A roster row. Grades and submissions hang off this, never off the user account
// (contract section 4), so re-linking keeps the work.
export class ClassStudent extends Model<
  InferAttributes<ClassStudent>,
  InferCreationAttributes<ClassStudent>
> {
  declare id: CreationOptional<string>;
  declare classId: string;
  declare fullName: string;
  // The teacher side of the link; null means linkState 'no_id' (contract section 6.2).
  declare studentUserId: string | null;
  declare createdAt: CreationOptional<Date>;
  declare updatedAt: CreationOptional<Date>;
}

ClassStudent.init(
  {
    id: {
      type: DataTypes.UUID,
      primaryKey: true,
      allowNull: false,
      defaultValue: Sequelize.literal('gen_random_uuid()'),
    },
    classId: { type: DataTypes.UUID, allowNull: false },
    fullName: { type: DataTypes.TEXT, allowNull: false },
    studentUserId: { type: DataTypes.UUID, allowNull: true },
    createdAt: { type: DataTypes.DATE, allowNull: false },
    updatedAt: { type: DataTypes.DATE, allowNull: false },
  },
  { sequelize, tableName: 'class_students', underscored: true },
);
