import {
  DataTypes,
  Model,
  Sequelize,
  type CreationOptional,
  type InferAttributes,
  type InferCreationAttributes,
} from 'sequelize';

import { sequelize } from '../index.js';

export class RefreshToken extends Model<
  InferAttributes<RefreshToken>,
  InferCreationAttributes<RefreshToken>
> {
  declare id: CreationOptional<string>;
  declare userId: string;
  // Rotation keeps every descendant of one login in the same family (contract section 2.3).
  declare familyId: string;
  declare tokenHash: string;
  declare expiresAt: Date;
  declare revokedAt: Date | null;
  declare replacedAt: Date | null;
  declare createdAt: CreationOptional<Date>;
  declare updatedAt: CreationOptional<Date>;
}

RefreshToken.init(
  {
    id: {
      type: DataTypes.UUID,
      primaryKey: true,
      allowNull: false,
      defaultValue: Sequelize.literal('gen_random_uuid()'),
    },
    userId: { type: DataTypes.UUID, allowNull: false },
    familyId: { type: DataTypes.UUID, allowNull: false },
    tokenHash: { type: DataTypes.TEXT, allowNull: false },
    expiresAt: { type: DataTypes.DATE, allowNull: false },
    revokedAt: { type: DataTypes.DATE, allowNull: true },
    replacedAt: { type: DataTypes.DATE, allowNull: true },
    createdAt: { type: DataTypes.DATE, allowNull: false },
    updatedAt: { type: DataTypes.DATE, allowNull: false },
  },
  { sequelize, tableName: 'refresh_tokens', underscored: true },
);
