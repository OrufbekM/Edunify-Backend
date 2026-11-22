import {
  DataTypes,
  Model,
  Sequelize,
  type CreationOptional,
  type InferAttributes,
  type InferCreationAttributes,
} from 'sequelize';

import { sequelize } from '../index.js';

// Two or more of a teacher's classes that share units and linked lessons (contract 4.1). A
// group exists only while it has two or more classes.
export class ClassGroup extends Model<InferAttributes<ClassGroup>, InferCreationAttributes<ClassGroup>> {
  declare id: CreationOptional<string>;
  declare createdAt: CreationOptional<Date>;
  declare updatedAt: CreationOptional<Date>;
}

ClassGroup.init(
  {
    id: {
      type: DataTypes.UUID,
      primaryKey: true,
      allowNull: false,
      defaultValue: Sequelize.literal('gen_random_uuid()'),
    },
    createdAt: { type: DataTypes.DATE, allowNull: false },
    updatedAt: { type: DataTypes.DATE, allowNull: false },
  },
  { sequelize, tableName: 'class_groups', underscored: true },
);
