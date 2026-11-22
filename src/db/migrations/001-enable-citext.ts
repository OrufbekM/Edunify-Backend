import type { QueryInterface } from 'sequelize';

export async function up(queryInterface: QueryInterface): Promise<void> {
  await queryInterface.sequelize.transaction(async (transaction) => {
    // Needed by users.email: case-insensitive unique without a functional index.
    await queryInterface.sequelize.query('CREATE EXTENSION IF NOT EXISTS citext', { transaction });
  });
}

export async function down(queryInterface: QueryInterface): Promise<void> {
  await queryInterface.sequelize.transaction(async (transaction) => {
    await queryInterface.sequelize.query('DROP EXTENSION IF EXISTS citext', { transaction });
  });
}
