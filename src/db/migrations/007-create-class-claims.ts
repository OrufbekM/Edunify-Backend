import type { QueryInterface } from 'sequelize';
import { DataTypes, Sequelize } from 'sequelize';

export async function up(queryInterface: QueryInterface): Promise<void> {
  await queryInterface.sequelize.transaction(async (transaction) => {
    await queryInterface.createTable(
      'class_claims',
      {
        id: {
          type: DataTypes.UUID,
          primaryKey: true,
          allowNull: false,
          defaultValue: Sequelize.literal('gen_random_uuid()'),
        },
        student_user_id: {
          type: DataTypes.UUID,
          allowNull: false,
          references: { model: 'users', key: 'id' },
          onDelete: 'CASCADE',
        },
        class_id: {
          type: DataTypes.UUID,
          allowNull: false,
          references: { model: 'classes', key: 'id' },
          onDelete: 'CASCADE',
        },
        created_at: { type: DataTypes.DATE, allowNull: false, defaultValue: Sequelize.literal('now()') },
        updated_at: { type: DataTypes.DATE, allowNull: false, defaultValue: Sequelize.literal('now()') },
      },
      { transaction },
    );

    // Leading column student_user_id, so this also serves as that foreign key's index.
    await queryInterface.addIndex('class_claims', {
      fields: ['student_user_id', 'class_id'],
      unique: true,
      name: 'class_claims_student_user_id_class_id_uq',
      transaction,
    });

    await queryInterface.addIndex('class_claims', {
      fields: ['class_id'],
      name: 'class_claims_class_id_idx',
      transaction,
    });
  });
}

export async function down(queryInterface: QueryInterface): Promise<void> {
  await queryInterface.sequelize.transaction(async (transaction) => {
    await queryInterface.dropTable('class_claims', { transaction });
  });
}
