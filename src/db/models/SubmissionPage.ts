import {
  DataTypes,
  Model,
  Sequelize,
  type CreationOptional,
  type InferAttributes,
  type InferCreationAttributes,
} from 'sequelize';

import { sequelize } from '../index.js';

// One page of a draw, math or photo submission; 1-9 per submission (contract section 2.7).
export class SubmissionPage extends Model<
  InferAttributes<SubmissionPage>,
  InferCreationAttributes<SubmissionPage>
> {
  declare id: CreationOptional<string>;
  declare submissionId: string;
  declare position: number;
  declare fileId: string;
  declare createdAt: CreationOptional<Date>;
  declare updatedAt: CreationOptional<Date>;
}

SubmissionPage.init(
  {
    id: {
      type: DataTypes.UUID,
      primaryKey: true,
      allowNull: false,
      defaultValue: Sequelize.literal('gen_random_uuid()'),
    },
    submissionId: { type: DataTypes.UUID, allowNull: false },
    position: { type: DataTypes.INTEGER, allowNull: false },
    fileId: { type: DataTypes.UUID, allowNull: false },
    createdAt: { type: DataTypes.DATE, allowNull: false },
    updatedAt: { type: DataTypes.DATE, allowNull: false },
  },
  { sequelize, tableName: 'submission_pages', underscored: true },
);
