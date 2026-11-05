import {
  DataTypes,
  Model,
  Sequelize,
  type CreationOptional,
  type InferAttributes,
  type InferCreationAttributes,
} from 'sequelize';

import { sequelize } from '../index.js';

// The `classes` table. Named SchoolClass to stay clear of the `class` keyword.
export class SchoolClass extends Model<
  InferAttributes<SchoolClass>,
  InferCreationAttributes<SchoolClass>
> {
  declare id: CreationOptional<string>;
  declare categoryId: string;
  // Denormalized from the category for authorization (contract section 5).
  declare teacherId: string;
  declare subject: string;
  declare name: string | null;
  declare publicId: string;
  declare createdAt: CreationOptional<Date>;
  declare updatedAt: CreationOptional<Date>;
}

SchoolClass.init(
  {
    id: {
      type: DataTypes.UUID,
      primaryKey: true,
      allowNull: false,
      defaultValue: Sequelize.literal('gen_random_uuid()'),
    },
    categoryId: { type: DataTypes.UUID, allowNull: false },
    teacherId: { type: DataTypes.UUID, allowNull: false },
    subject: { type: DataTypes.TEXT, allowNull: false },
    name: { type: DataTypes.TEXT, allowNull: true },
    publicId: { type: DataTypes.CHAR(8), allowNull: false },
    createdAt: { type: DataTypes.DATE, allowNull: false },
    updatedAt: { type: DataTypes.DATE, allowNull: false },
  },
  { sequelize, tableName: 'classes', underscored: true },
);
