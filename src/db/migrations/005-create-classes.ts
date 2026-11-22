import type { QueryInterface } from 'sequelize';
import { DataTypes, Sequelize } from 'sequelize';

export async function up(queryInterface: QueryInterface): Promise<void> {
  await queryInterface.sequelize.transaction(async (transaction) => {
    await queryInterface.createTable(
      'classes',
      {
        id: {
          type: DataTypes.UUID,
          primaryKey: true,
          allowNull: false,
          defaultValue: Sequelize.literal('gen_random_uuid()'),
        },
        category_id: {
          type: DataTypes.UUID,
          allowNull: false,
          references: { model: 'categories', key: 'id' },
          onDelete: 'RESTRICT',
        },
        // Denormalized for authorization (contract section 5: "own" means classes.teacher_id = caller).
        teacher_id: {
          type: DataTypes.UUID,
          allowNull: false,
          references: { model: 'users', key: 'id' },
        },
        subject: { type: DataTypes.TEXT, allowNull: false },
        name: { type: DataTypes.TEXT, allowNull: true },
        public_id: { type: DataTypes.CHAR(8), allowNull: false },
        created_at: { type: DataTypes.DATE, allowNull: false, defaultValue: Sequelize.literal('now()') },
        updated_at: { type: DataTypes.DATE, allowNull: false, defaultValue: Sequelize.literal('now()') },
      },
      { transaction },
    );

    await queryInterface.addIndex('classes', {
      fields: ['public_id'],
      unique: true,
      name: 'classes_public_id_uq',
      transaction,
    });

    await queryInterface.addIndex('classes', {
      fields: ['category_id'],
      name: 'classes_category_id_idx',
      transaction,
    });

    await queryInterface.addIndex('classes', {
      fields: ['teacher_id'],
      name: 'classes_teacher_id_idx',
      transaction,
    });
  });
}

export async function down(queryInterface: QueryInterface): Promise<void> {
  await queryInterface.sequelize.transaction(async (transaction) => {
    await queryInterface.dropTable('classes', { transaction });
  });
}
