import type { QueryInterface } from 'sequelize';

export async function up(queryInterface: QueryInterface): Promise<void> {
  await queryInterface.sequelize.transaction(async (transaction) => {
    await queryInterface.addIndex('refresh_tokens', {
      fields: ['family_id'],
      name: 'refresh_tokens_family_id_idx',
      transaction,
    });
  });
}

export async function down(queryInterface: QueryInterface): Promise<void> {
  await queryInterface.sequelize.transaction(async (transaction) => {
    await queryInterface.removeIndex('refresh_tokens', 'refresh_tokens_family_id_idx', {
      transaction,
    });
  });
}
