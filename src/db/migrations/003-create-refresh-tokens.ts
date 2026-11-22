import type { QueryInterface } from 'sequelize';
import { DataTypes, Sequelize } from 'sequelize';

export async function up(queryInterface: QueryInterface): Promise<void> {
  await queryInterface.sequelize.transaction(async (transaction) => {
    await queryInterface.createTable(
      'refresh_tokens',
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
        family_id: { type: DataTypes.UUID, allowNull: false },
        token_hash: { type: DataTypes.TEXT, allowNull: false },
        expires_at: { type: DataTypes.DATE, allowNull: false },
        revoked_at: { type: DataTypes.DATE, allowNull: true },
        replaced_at: { type: DataTypes.DATE, allowNull: true },
        created_at: { type: DataTypes.DATE, allowNull: false, defaultValue: Sequelize.literal('now()') },
        updated_at: { type: DataTypes.DATE, allowNull: false, defaultValue: Sequelize.literal('now()') },
      },
      { transaction },
    );

    await queryInterface.addIndex('refresh_tokens', {
      fields: ['token_hash'],
      unique: true,
      name: 'refresh_tokens_token_hash_uq',
      transaction,
    });

    await queryInterface.addIndex('refresh_tokens', {
      fields: ['user_id'],
      name: 'refresh_tokens_user_id_idx',
      transaction,
    });
  });
}

export async function down(queryInterface: QueryInterface): Promise<void> {
  await queryInterface.sequelize.transaction(async (transaction) => {
    await queryInterface.dropTable('refresh_tokens', { transaction });
  });
}
