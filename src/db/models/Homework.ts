import {
  DataTypes,
  Model,
  Sequelize,
  type CreationOptional,
  type InferAttributes,
  type InferCreationAttributes,
} from 'sequelize';

import { sequelize } from '../index.js';
import { HOMEWORK_TYPES, type HomeworkType } from './enums.js';

export class Homework extends Model<
  InferAttributes<Homework>,
  InferCreationAttributes<Homework>
> {
  declare id: CreationOptional<string>;
  declare lessonId: string;
  // Locked once submissions exist (contract section 8.7, HOMEWORK_TYPE_LOCKED).
  declare type: HomeworkType;
  declare instructionsText: string | null;
  declare instructionsFileId: string | null;
  declare createdAt: CreationOptional<Date>;
  declare updatedAt: CreationOptional<Date>;
}

Homework.init(
  {
    id: {
      type: DataTypes.UUID,
      primaryKey: true,
      allowNull: false,
      defaultValue: Sequelize.literal('gen_random_uuid()'),
    },
    lessonId: { type: DataTypes.UUID, allowNull: false },
    type: { type: DataTypes.ENUM(...HOMEWORK_TYPES), allowNull: false },
    instructionsText: { type: DataTypes.TEXT, allowNull: true },
    instructionsFileId: { type: DataTypes.UUID, allowNull: true },
    createdAt: { type: DataTypes.DATE, allowNull: false },
    updatedAt: { type: DataTypes.DATE, allowNull: false },
  },
  { sequelize, tableName: 'homeworks', underscored: true },
);
