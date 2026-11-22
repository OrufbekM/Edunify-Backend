import {
  DataTypes,
  Model,
  Sequelize,
  type CreationOptional,
  type InferAttributes,
  type InferCreationAttributes,
} from 'sequelize';

import { sequelize } from '../index.js';

export class Lesson extends Model<InferAttributes<Lesson>, InferCreationAttributes<Lesson>> {
  declare id: CreationOptional<string>;
  // Exactly one of the two is set: class-only, or linked and owned by a group (contract 4.1).
  declare classId: string | null;
  declare groupId: string | null;
  // Every lesson sits in a unit (contract 4).
  declare unitId: string;
  declare title: string;
  // A linked lesson's place in its unit's linked order, shared by the group; null for a
  // class-only lesson, whose slot is on its ClassLesson.
  declare position: number | null;
  declare lessonFileId: string | null;
  declare createdAt: CreationOptional<Date>;
  declare updatedAt: CreationOptional<Date>;
}

Lesson.init(
  {
    id: {
      type: DataTypes.UUID,
      primaryKey: true,
      allowNull: false,
      defaultValue: Sequelize.literal('gen_random_uuid()'),
    },
    classId: { type: DataTypes.UUID, allowNull: true },
    groupId: { type: DataTypes.UUID, allowNull: true },
    unitId: { type: DataTypes.UUID, allowNull: false },
    title: { type: DataTypes.TEXT, allowNull: false },
    position: { type: DataTypes.INTEGER, allowNull: true },
    lessonFileId: { type: DataTypes.UUID, allowNull: true },
    createdAt: { type: DataTypes.DATE, allowNull: false },
    updatedAt: { type: DataTypes.DATE, allowNull: false },
  },
  { sequelize, tableName: 'lessons', underscored: true },
);
