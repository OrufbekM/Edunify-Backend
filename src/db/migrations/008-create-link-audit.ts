import type { QueryInterface } from 'sequelize';
import { DataTypes, Sequelize } from 'sequelize';

export async function up(queryInterface: QueryInterface): Promise<void> {
  await queryInterface.sequelize.transaction(async (transaction) => {
    await queryInterface.createTable(
      'link_audit',
      {
        id: {
          type: DataTypes.UUID,
          primaryKey: true,
          allowNull: false,
          defaultValue: Sequelize.literal('gen_random_uuid()'),
        },
        class_student_id: {
          type: DataTypes.UUID,
          allowNull: false,
          references: { model: 'class_students', key: 'id' },
          onDelete: 'CASCADE',
        },
        // Contract section 4 marks only changed_by as a foreign key: an audit row must survive
        // the deletion of the accounts it names.
        old_user_id: { type: DataTypes.UUID, allowNull: true },
        new_user_id: { type: DataTypes.UUID, allowNull: true },
        changed_by: {
          type: DataTypes.UUID,
          allowNull: false,
          references: { model: 'users', key: 'id' },
        },
        // created_at only.
        created_at: { type: DataTypes.DATE, allowNull: false, defaultValue: Sequelize.literal('now()') },
      },
      { transaction },
    );

    await queryInterface.addIndex('link_audit', {
      fields: ['class_student_id'],
      name: 'link_audit_class_student_id_idx',
      transaction,
    });

    await queryInterface.addIndex('link_audit', {
      fields: ['changed_by'],
      name: 'link_audit_changed_by_idx',
      transaction,
    });
  });
}

export async function down(queryInterface: QueryInterface): Promise<void> {
  await queryInterface.sequelize.transaction(async (transaction) => {
    await queryInterface.dropTable('link_audit', { transaction });
  });
}
