import type { QueryInterface } from 'sequelize';
import { DataTypes, Sequelize } from 'sequelize';

export async function up(queryInterface: QueryInterface): Promise<void> {
  await queryInterface.sequelize.transaction(async (transaction) => {
    await queryInterface.createTable(
      'submission_pages',
      {
        id: {
          type: DataTypes.UUID,
          primaryKey: true,
          allowNull: false,
          defaultValue: Sequelize.literal('gen_random_uuid()'),
        },
        submission_id: {
          type: DataTypes.UUID,
          allowNull: false,
          references: { model: 'submissions', key: 'id' },
          onDelete: 'CASCADE',
        },
        // Page order, 1-9 pages per submission (contract section 2.7).
        position: { type: DataTypes.INTEGER, allowNull: false },
        file_id: {
          type: DataTypes.UUID,
          allowNull: false,
          references: { model: 'files', key: 'id' },
        },
        created_at: { type: DataTypes.DATE, allowNull: false, defaultValue: Sequelize.literal('now()') },
        updated_at: { type: DataTypes.DATE, allowNull: false, defaultValue: Sequelize.literal('now()') },
      },
      { transaction },
    );

    // Leading column submission_id, so this also serves as that foreign key's index.
    await queryInterface.addIndex('submission_pages', {
      fields: ['submission_id', 'position'],
      unique: true,
      name: 'submission_pages_submission_id_position_uq',
      transaction,
    });

    await queryInterface.addIndex('submission_pages', {
      fields: ['file_id'],
      name: 'submission_pages_file_id_idx',
      transaction,
    });
  });
}

export async function down(queryInterface: QueryInterface): Promise<void> {
  await queryInterface.sequelize.transaction(async (transaction) => {
    await queryInterface.dropTable('submission_pages', { transaction });
  });
}
