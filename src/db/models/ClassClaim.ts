import {
  DataTypes,
  Model,
  Sequelize,
  type CreationOptional,
  type InferAttributes,
  type InferCreationAttributes,
} from 'sequelize';

import { sequelize } from '../index.js';

// The student side of the link: created when the student enters a class ID
// (contract section 6.2). Teachers never see these rows.
export class ClassClaim extends Model<
  InferAttributes<ClassClaim>,
  InferCreationAttributes<ClassClaim>
> {
  declare id: CreationOptional<string>;
  declare studentUserId: string;
  declare classId: string;
  declare createdAt: CreationOptional<Date>;
  declare updatedAt: CreationOptional<Date>;
}

ClassClaim.init(
  {
    id: {
      type: DataTypes.UUID,
      primaryKey: true,
      allowNull: false,
      defaultValue: Sequelize.literal('gen_random_uuid()'),
    },
    studentUserId: { type: DataTypes.UUID, allowNull: false },
    classId: { type: DataTypes.UUID, allowNull: false },
    createdAt: { type: DataTypes.DATE, allowNull: false },
    updatedAt: { type: DataTypes.DATE, allowNull: false },
  },
  { sequelize, tableName: 'class_claims', underscored: true },
);
