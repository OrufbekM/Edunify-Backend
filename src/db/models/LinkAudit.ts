import {
  DataTypes,
  Model,
  Sequelize,
  type CreationOptional,
  type InferAttributes,
  type InferCreationAttributes,
} from 'sequelize';

import { sequelize } from '../index.js';

// Written on every re-link and unlink (contract section 6.3). Append-only: created_at only.
export class LinkAudit extends Model<
  InferAttributes<LinkAudit>,
  InferCreationAttributes<LinkAudit>
> {
  declare id: CreationOptional<string>;
  declare classStudentId: string;
  // Plain uuid columns, not foreign keys: an audit row outlives the accounts it names.
  declare oldUserId: string | null;
  declare newUserId: string | null;
  declare changedBy: string;
  declare createdAt: CreationOptional<Date>;
}

LinkAudit.init(
  {
    id: {
      type: DataTypes.UUID,
      primaryKey: true,
      allowNull: false,
      defaultValue: Sequelize.literal('gen_random_uuid()'),
    },
    classStudentId: { type: DataTypes.UUID, allowNull: false },
    oldUserId: { type: DataTypes.UUID, allowNull: true },
    newUserId: { type: DataTypes.UUID, allowNull: true },
    changedBy: { type: DataTypes.UUID, allowNull: false },
    createdAt: { type: DataTypes.DATE, allowNull: false },
  },
  { sequelize, tableName: 'link_audit', underscored: true, updatedAt: false },
);
