import type { QueryInterface } from 'sequelize';
import { DataTypes, Sequelize } from 'sequelize';

export async function up(queryInterface: QueryInterface): Promise<void> {
  await queryInterface.sequelize.transaction(async (transaction) => {
    await queryInterface.createTable(
      'ai_jobs',
      {
        id: {
          type: DataTypes.UUID,
          primaryKey: true,
          allowNull: false,
          defaultValue: Sequelize.literal('gen_random_uuid()'),
        },
        lesson_id: {
          type: DataTypes.UUID,
          allowNull: false,
          references: { model: 'lessons', key: 'id' },
          onDelete: 'CASCADE',
        },
        created_by: {
          type: DataTypes.UUID,
          allowNull: false,
          references: { model: 'users', key: 'id' },
        },
        status: { type: DataTypes.ENUM('queued', 'running', 'done', 'failed'), allowNull: false },
        submission_ids: { type: DataTypes.ARRAY(DataTypes.UUID), allowNull: false },
        total: { type: DataTypes.INTEGER, allowNull: false },
        completed: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
        failed: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
        // Set only when the job itself could not run (contract section 9).
        error: { type: DataTypes.TEXT, allowNull: true },
        finished_at: { type: DataTypes.DATE, allowNull: true },
        created_at: { type: DataTypes.DATE, allowNull: false, defaultValue: Sequelize.literal('now()') },
        updated_at: { type: DataTypes.DATE, allowNull: false, defaultValue: Sequelize.literal('now()') },
      },
      { transaction },
    );

    await queryInterface.addIndex('ai_jobs', {
      fields: ['lesson_id'],
      name: 'ai_jobs_lesson_id_idx',
      transaction,
    });

    await queryInterface.addIndex('ai_jobs', {
      fields: ['created_by'],
      name: 'ai_jobs_created_by_idx',
      transaction,
    });
  });
}

export async function down(queryInterface: QueryInterface): Promise<void> {
  await queryInterface.sequelize.transaction(async (transaction) => {
    await queryInterface.dropTable('ai_jobs', { transaction });
    await queryInterface.sequelize.query('DROP TYPE IF EXISTS "enum_ai_jobs_status"', { transaction });
  });
}
