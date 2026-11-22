import type { QueryInterface } from 'sequelize';
import { DataTypes, Sequelize } from 'sequelize';

export async function up(queryInterface: QueryInterface): Promise<void> {
  await queryInterface.sequelize.transaction(async (transaction) => {
    await queryInterface.createTable(
      'notifications',
      {
        id: {
          type: DataTypes.UUID,
          primaryKey: true,
          allowNull: false,
          defaultValue: Sequelize.literal('gen_random_uuid()'),
        },
        user_id: {
          type: DataTypes.UUID,
          allowNull: false,
          references: { model: 'users', key: 'id' },
          onDelete: 'CASCADE',
        },
        kind: { type: DataTypes.ENUM('graded', 'denied', 'submitted'), allowNull: false },
        submission_id: {
          type: DataTypes.UUID,
          allowNull: false,
          references: { model: 'submissions', key: 'id' },
          onDelete: 'CASCADE',
        },
        read_at: { type: DataTypes.DATE, allowNull: true },
        created_at: { type: DataTypes.DATE, allowNull: false, defaultValue: Sequelize.literal('now()') },
        updated_at: { type: DataTypes.DATE, allowNull: false, defaultValue: Sequelize.literal('now()') },
      },
      { transaction },
    );

    // Contract section 8.12: at most one notification per (user, submission).
    // Leading column user_id, so this also serves as that foreign key's index.
    await queryInterface.addIndex('notifications', {
      fields: ['user_id', 'submission_id'],
      unique: true,
      name: 'notifications_user_id_submission_id_uq',
      transaction,
    });

    await queryInterface.addIndex('notifications', {
      fields: ['submission_id'],
      name: 'notifications_submission_id_idx',
      transaction,
    });
  });
}

export async function down(queryInterface: QueryInterface): Promise<void> {
  await queryInterface.sequelize.transaction(async (transaction) => {
    await queryInterface.dropTable('notifications', { transaction });
    await queryInterface.sequelize.query('DROP TYPE IF EXISTS "enum_notifications_kind"', { transaction });
  });
}
