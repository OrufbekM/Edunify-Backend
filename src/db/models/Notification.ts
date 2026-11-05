import {
  DataTypes,
  Model,
  Sequelize,
  type CreationOptional,
  type InferAttributes,
  type InferCreationAttributes,
} from 'sequelize';

import { sequelize } from '../index.js';
import { NOTIFICATION_KINDS, type NotificationKind } from './enums.js';

// At most one row per (user, submission): a later event updates kind and createdAt
// and clears readAt (contract section 8.12).
export class Notification extends Model<
  InferAttributes<Notification>,
  InferCreationAttributes<Notification>
> {
  declare id: CreationOptional<string>;
  declare userId: string;
  declare kind: NotificationKind;
  declare submissionId: string;
  declare readAt: Date | null;
  declare createdAt: CreationOptional<Date>;
  declare updatedAt: CreationOptional<Date>;
}

Notification.init(
  {
    id: {
      type: DataTypes.UUID,
      primaryKey: true,
      allowNull: false,
      defaultValue: Sequelize.literal('gen_random_uuid()'),
    },
    userId: { type: DataTypes.UUID, allowNull: false },
    kind: { type: DataTypes.ENUM(...NOTIFICATION_KINDS), allowNull: false },
    submissionId: { type: DataTypes.UUID, allowNull: false },
    readAt: { type: DataTypes.DATE, allowNull: true },
    createdAt: { type: DataTypes.DATE, allowNull: false },
    updatedAt: { type: DataTypes.DATE, allowNull: false },
  },
  { sequelize, tableName: 'notifications', underscored: true },
);
