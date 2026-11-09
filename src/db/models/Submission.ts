import {
  DataTypes,
  Model,
  Sequelize,
  type CreationOptional,
  type InferAttributes,
  type InferCreationAttributes,
} from 'sequelize';

import { sequelize } from '../index.js';
import {
  GRADE_SOURCES,
  SUBMISSION_STATUSES,
  type GradeSource,
  type SubmissionStatus,
} from './enums.js';

export class Submission extends Model<
  InferAttributes<Submission>,
  InferCreationAttributes<Submission>
> {
  declare id: CreationOptional<string>;
  declare homeworkId: string;
  declare classStudentId: string;
  // 1, 2, 3...; the highest version for a (homework, student) pair is the latest.
  declare version: number;
  declare status: SubmissionStatus;
  // Text or code content; null for the page types, which live in submission_pages.
  // Shape is validated with zod in the service layer, not here.
  declare content: unknown;
  // At most one of gradeValue and gradeDenied is set (neither until it is graded); the
  // database enforces it.
  declare gradeValue: number | null;
  declare gradeDenied: CreationOptional<boolean>;
  declare gradeComment: string | null;
  declare gradeSource: GradeSource | null;
  declare gradedAt: Date | null;
  // Never sent to students and never applied as a grade (contract section 9).
  declare aiSuggestion: unknown;
  declare createdAt: CreationOptional<Date>;
  declare updatedAt: CreationOptional<Date>;
}

Submission.init(
  {
    id: {
      type: DataTypes.UUID,
      primaryKey: true,
      allowNull: false,
      defaultValue: Sequelize.literal('gen_random_uuid()'),
    },
    homeworkId: { type: DataTypes.UUID, allowNull: false },
    classStudentId: { type: DataTypes.UUID, allowNull: false },
    version: { type: DataTypes.INTEGER, allowNull: false },
    status: { type: DataTypes.ENUM(...SUBMISSION_STATUSES), allowNull: false },
    content: { type: DataTypes.JSONB, allowNull: true },
    gradeValue: { type: DataTypes.SMALLINT, allowNull: true },
    gradeDenied: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
    gradeComment: { type: DataTypes.TEXT, allowNull: true },
    gradeSource: { type: DataTypes.ENUM(...GRADE_SOURCES), allowNull: true },
    gradedAt: { type: DataTypes.DATE, allowNull: true },
    aiSuggestion: { type: DataTypes.JSONB, allowNull: true },
    createdAt: { type: DataTypes.DATE, allowNull: false },
    updatedAt: { type: DataTypes.DATE, allowNull: false },
  },
  { sequelize, tableName: 'submissions', underscored: true },
);
