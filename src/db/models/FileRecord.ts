import {
  DataTypes,
  Model,
  Sequelize,
  type CreationOptional,
  type InferAttributes,
  type InferCreationAttributes,
} from 'sequelize';

import { sequelize } from '../index.js';
import { FILE_KINDS, type FileKind } from './enums.js';

// The `files` table. Named FileRecord so it does not shadow the global File type,
// and to stay distinct from the FileRef DTO in contract section 3.
export class FileRecord extends Model<
  InferAttributes<FileRecord>,
  InferCreationAttributes<FileRecord>
> {
  declare id: CreationOptional<string>;
  declare ownerUserId: string;
  declare kind: FileKind;
  declare originalName: string;
  declare mime: string;
  declare size: number;
  // A random path that never contains user input (contract section 7).
  declare storageKey: string;
  declare createdAt: CreationOptional<Date>;
  declare updatedAt: CreationOptional<Date>;
}

FileRecord.init(
  {
    id: {
      type: DataTypes.UUID,
      primaryKey: true,
      allowNull: false,
      defaultValue: Sequelize.literal('gen_random_uuid()'),
    },
    ownerUserId: { type: DataTypes.UUID, allowNull: false },
    kind: { type: DataTypes.ENUM(...FILE_KINDS), allowNull: false },
    originalName: { type: DataTypes.TEXT, allowNull: false },
    mime: { type: DataTypes.TEXT, allowNull: false },
    size: { type: DataTypes.INTEGER, allowNull: false },
    storageKey: { type: DataTypes.TEXT, allowNull: false },
    createdAt: { type: DataTypes.DATE, allowNull: false },
    updatedAt: { type: DataTypes.DATE, allowNull: false },
  },
  { sequelize, tableName: 'files', underscored: true },
);
