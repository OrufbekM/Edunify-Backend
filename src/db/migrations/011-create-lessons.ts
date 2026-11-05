import type { QueryInterface } from 'sequelize';
import { DataTypes, Sequelize } from 'sequelize';

export async function up(queryInterface: QueryInterface): Promise<void> {
  await queryInterface.sequelize.transaction(async (transaction) => {
    await queryInterface.createTable(
      'lessons',
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
        // Null means the no-unit group (contract section 8.6).
        unit_id: {
          type: DataTypes.UUID,
          allowNull: true,
          references: { model: 'units', key: 'id' },
          onDelete: 'CASCADE',
        },
        title: { type: DataTypes.TEXT, allowNull: false },
        position: { type: DataTypes.INTEGER, allowNull: false },
        lesson_file_id: {
          type: DataTypes.UUID,
          allowNull: true,
          references: { model: 'files', key: 'id' },
        },
        created_at: { type: DataTypes.DATE, allowNull: false, defaultValue: Sequelize.literal('now()') },
        updated_at: { type: DataTypes.DATE, allowNull: false, defaultValue: Sequelize.literal('now()') },
      },
      { transaction },
    );

    await queryInterface.addIndex('lessons', {
      fields: ['class_id'],
      name: 'lessons_class_id_idx',
      transaction,
    });

    await queryInterface.addIndex('lessons', {
      fields: ['unit_id'],
      name: 'lessons_unit_id_idx',
      transaction,
    });

    await queryInterface.addIndex('lessons', {
      fields: ['lesson_file_id'],
      name: 'lessons_lesson_file_id_idx',
      transaction,
    });
  });
}

export async function down(queryInterface: QueryInterface): Promise<void> {
  await queryInterface.sequelize.transaction(async (transaction) => {
    await queryInterface.dropTable('lessons', { transaction });
  });
}
