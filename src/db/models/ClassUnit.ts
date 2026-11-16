import {
  DataTypes,
  Model,
  Sequelize,
  type CreationOptional,
  type InferAttributes,
  type InferCreationAttributes,
} from 'sequelize';

import { sequelize } from '../index.js';

// The placement of a unit in a class (contract 4). Every class keeps at least one; in a group
// every class holds every unit of the group at the same position.
export class ClassUnit extends Model<InferAttributes<ClassUnit>, InferCreationAttributes<ClassUnit>> {
  declare id: CreationOptional<string>;
  declare classId: string;
  declare unitId: string;
  // Dense and 0-based among the units of the class.
  declare position: number;
  declare createdAt: CreationOptional<Date>;
  declare updatedAt: CreationOptional<Date>;
}

ClassUnit.init(
  {
    id: {
      type: DataTypes.UUID,
      primaryKey: true,
      allowNull: false,
      defaultValue: Sequelize.literal('gen_random_uuid()'),
    },
    classId: { type: DataTypes.UUID, allowNull: false },
    unitId: { type: DataTypes.UUID, allowNull: false },
    position: { type: DataTypes.INTEGER, allowNull: false },
    createdAt: { type: DataTypes.DATE, allowNull: false },
    updatedAt: { type: DataTypes.DATE, allowNull: false },
  },
  { sequelize, tableName: 'class_units', underscored: true },
);
