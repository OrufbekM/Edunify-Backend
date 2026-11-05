import {
  DataTypes,
  Model,
  Sequelize,
  type CreationOptional,
  type InferAttributes,
  type InferCreationAttributes,
} from 'sequelize';

import { sequelize } from '../index.js';
import { JOB_STATUSES, type JobStatus } from './enums.js';

// Drives the in-process worker (contract section 9): one job at a time per process.
export class AiJob extends Model<InferAttributes<AiJob>, InferCreationAttributes<AiJob>> {
  declare id: CreationOptional<string>;
  declare lessonId: string;
  declare createdBy: string;
  declare status: JobStatus;
  declare submissionIds: string[];
  declare total: number;
  declare completed: CreationOptional<number>;
  declare failed: CreationOptional<number>;
  // Set only when the job itself could not run.
  declare error: string | null;
  declare finishedAt: Date | null;
  declare createdAt: CreationOptional<Date>;
  declare updatedAt: CreationOptional<Date>;
}

AiJob.init(
  {
    id: {
      type: DataTypes.UUID,
      primaryKey: true,
      allowNull: false,
      defaultValue: Sequelize.literal('gen_random_uuid()'),
    },
    lessonId: { type: DataTypes.UUID, allowNull: false },
    createdBy: { type: DataTypes.UUID, allowNull: false },
    status: { type: DataTypes.ENUM(...JOB_STATUSES), allowNull: false },
    submissionIds: { type: DataTypes.ARRAY(DataTypes.UUID), allowNull: false },
    total: { type: DataTypes.INTEGER, allowNull: false },
    completed: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    failed: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    error: { type: DataTypes.TEXT, allowNull: true },
    finishedAt: { type: DataTypes.DATE, allowNull: true },
    createdAt: { type: DataTypes.DATE, allowNull: false },
    updatedAt: { type: DataTypes.DATE, allowNull: false },
  },
  { sequelize, tableName: 'ai_jobs', underscored: true },
);
