import {
  DataTypes,
  Model,
  Sequelize,
  type CreationOptional,
  type InferAttributes,
  type InferCreationAttributes,
} from 'sequelize';

import { sequelize } from '../index.js';

// The placement of a lesson in a class (contract 4): its visibility there, and for a
// class-only lesson its slot in its unit.
export class ClassLesson extends Model<InferAttributes<ClassLesson>, InferCreationAttributes<ClassLesson>> {
  declare id: CreationOptional<string>;
  declare classId: string;
  declare lessonId: string;
  // A class-only lesson's target index in its unit's list in this class (contract 4.1);
  // null for a linked lesson, which follows the group's linked order.
  declare position: number | null;
  declare visible: CreationOptional<boolean>;
  declare createdAt: CreationOptional<Date>;
  declare updatedAt: CreationOptional<Date>;
}

ClassLesson.init(
  {
    id: {
      type: DataTypes.UUID,
      primaryKey: true,
      allowNull: false,
      defaultValue: Sequelize.literal('gen_random_uuid()'),
    },
    classId: { type: DataTypes.UUID, allowNull: false },
    lessonId: { type: DataTypes.UUID, allowNull: false },
    position: { type: DataTypes.INTEGER, allowNull: true },
    visible: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
    createdAt: { type: DataTypes.DATE, allowNull: false },
    updatedAt: { type: DataTypes.DATE, allowNull: false },
  },
  { sequelize, tableName: 'class_lessons', underscored: true },
);
