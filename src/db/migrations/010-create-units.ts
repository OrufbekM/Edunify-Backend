import type { QueryInterface } from 'sequelize';
import { DataTypes, Sequelize } from 'sequelize';

export async function up(queryInterface: QueryInterface): Promise<void> {
  await queryInterface.sequelize.transaction(async (transaction) => {
    await queryInterface.createTable(
      'units',
      {
        id: {
          type: DataTypes.UUID,
          primaryKey: true,
          allowNull: false,
          defaultValue: Sequelize.literal('gen_random_uuid()'),
        },
        class_id: {
          type: DataTypes.UUID,
          allowNull: false,
          references: { model: 'classes', key: 'id' },
          onDelete: 'CASCADE',
        },
        title: { type: DataTypes.TEXT, allowNull: false },
        // Contract section 4: dense and 0-based; the server renumbers siblings, so no unique constraint.
        position: { type: DataTypes.INTEGER, allowNull: false },
        created_at: { type: DataTypes.DATE, allowNull: false, defaultValue: Sequelize.literal('now()') },
        updated_at: { type: DataTypes.DATE, allowNull: false, defaultValue: Sequelize.literal('now()') },
      },
      { transaction },
    );

    await queryInterface.addIndex('units', {
      fields: ['class_id'],
      name: 'units_class_id_idx',
      transaction,
    });
  });
}

export async function down(queryInterface: QueryInterface): Promise<void> {
  await queryInterface.sequelize.transaction(async (transaction) => {
    await queryInterface.dropTable('units', { transaction });
  });
}
