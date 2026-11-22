import type { QueryInterface } from 'sequelize';
import { DataTypes, Sequelize } from 'sequelize';

export async function up(queryInterface: QueryInterface): Promise<void> {
  await queryInterface.sequelize.transaction(async (transaction) => {
    await queryInterface.createTable(
      'categories',
      {
        id: {
          type: DataTypes.UUID,
          primaryKey: true,
          allowNull: false,
          defaultValue: Sequelize.literal('gen_random_uuid()'),
        },
        teacher_id: {
          type: DataTypes.UUID,
          allowNull: false,
          references: { model: 'users', key: 'id' },
        },
        name: { type: DataTypes.TEXT, allowNull: false },
        created_at: { type: DataTypes.DATE, allowNull: false, defaultValue: Sequelize.literal('now()') },
        updated_at: { type: DataTypes.DATE, allowNull: false, defaultValue: Sequelize.literal('now()') },
      },
      { transaction },
    );

    // Contract section 4: unique (teacher_id, lower(name)). Functional, so addIndex cannot express it.
    // Its leading column is teacher_id, so it also serves as the foreign key index.
    await queryInterface.sequelize.query(
      `CREATE UNIQUE INDEX "categories_teacher_id_lower_name_uq"
         ON "categories" ("teacher_id", lower("name"))`,
      { transaction },
    );
  });
}

export async function down(queryInterface: QueryInterface): Promise<void> {
  await queryInterface.sequelize.transaction(async (transaction) => {
    await queryInterface.dropTable('categories', { transaction });
  });
}
