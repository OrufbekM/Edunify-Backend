import {
  DataTypes,
  Model,
  Sequelize,
  type CreationOptional,
  type InferAttributes,
  type InferCreationAttributes,
} from 'sequelize';

import { sequelize } from '../index.js';

export class Unit extends Model<InferAttributes<Unit>, InferCreationAttributes<Unit>> {
  declare id: CreationOptional<string>;
  // Exactly one of the two is set: a class's own unit, or a group's (contract 4). Where it
  // sits in each class is its ClassUnit.
  declare classId: string | null;
  declare groupId: string | null;
  declare title: string;
  declare createdAt: CreationOptional<Date>;
  declare updatedAt: CreationOptional<Date>;
}

Unit.init(
  {
    id: {
      type: DataTypes.UUID,
      primaryKey: true,
      allowNull: false,
      defaultValue: Sequelize.literal('gen_random_uuid()'),
    },
    classId: { type: DataTypes.UUID, allowNull: true },
    groupId: { type: DataTypes.UUID, allowNull: true },
    title: { type: DataTypes.TEXT, allowNull: false },
    createdAt: { type: DataTypes.DATE, allowNull: false },
    updatedAt: { type: DataTypes.DATE, allowNull: false },
  },
  { sequelize, tableName: 'units', underscored: true },
);
