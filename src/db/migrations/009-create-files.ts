import type { QueryInterface } from 'sequelize';
import { DataTypes, Sequelize } from 'sequelize';

export async function up(queryInterface: QueryInterface): Promise<void> {
  await queryInterface.sequelize.transaction(async (transaction) => {
    await queryInterface.createTable(
      'files',
      {
        id: {
          type: DataTypes.UUID,
          primaryKey: true,
          allowNull: false,
          defaultValue: Sequelize.literal('gen_random_uuid()'),
        },
        owner_user_id: {
          type: DataTypes.UUID,
          allowNull: false,
          references: { model: 'users', key: 'id' },
        },
        kind: { type: DataTypes.ENUM('lesson', 'instructions', 'page'), allowNull: false },
        original_name: { type: DataTypes.TEXT, allowNull: false },
        mime: { type: DataTypes.TEXT, allowNull: false },
        size: { type: DataTypes.INTEGER, allowNull: false },
        // Contract section 7: a random path that never contains user input.
        storage_key: { type: DataTypes.TEXT, allowNull: false },
        created_at: { type: DataTypes.DATE, allowNull: false, defaultValue: Sequelize.literal('now()') },
        updated_at: { type: DataTypes.DATE, allowNull: false, defaultValue: Sequelize.literal('now()') },
      },
      { transaction },
    );

    await queryInterface.addIndex('files', {
      fields: ['storage_key'],
      unique: true,
      name: 'files_storage_key_uq',
      transaction,
    });

    await queryInterface.addIndex('files', {
      fields: ['owner_user_id'],
      name: 'files_owner_user_id_idx',
      transaction,
    });
  });
}

export async function down(queryInterface: QueryInterface): Promise<void> {
  await queryInterface.sequelize.transaction(async (transaction) => {
    await queryInterface.dropTable('files', { transaction });
    await queryInterface.sequelize.query('DROP TYPE IF EXISTS "enum_files_kind"', { transaction });
  });
}
