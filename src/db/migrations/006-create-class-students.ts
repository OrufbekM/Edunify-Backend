import type { QueryInterface } from 'sequelize';
import { DataTypes, Sequelize } from 'sequelize';

export async function up(queryInterface: QueryInterface): Promise<void> {
  await queryInterface.sequelize.transaction(async (transaction) => {
    await queryInterface.createTable(
      'class_students',
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
        full_name: { type: DataTypes.TEXT, allowNull: false },
        // Contract section 6.3: grades stay on the row, so a deleted account only clears the link.
        student_user_id: {
          type: DataTypes.UUID,
          allowNull: true,
          references: { model: 'users', key: 'id' },
          onDelete: 'SET NULL',
        },
        created_at: { type: DataTypes.DATE, allowNull: false, defaultValue: Sequelize.literal('now()') },
        updated_at: { type: DataTypes.DATE, allowNull: false, defaultValue: Sequelize.literal('now()') },
      },
      { transaction },
    );

    // Contract section 4: unique (class_id, student_user_id) where not null. Partial, so addIndex cannot express it.
    await queryInterface.sequelize.query(
      `CREATE UNIQUE INDEX "class_students_class_id_student_user_id_uq"
         ON "class_students" ("class_id", "student_user_id")
         WHERE "student_user_id" IS NOT NULL`,
      { transaction },
    );

    // The unique index above is partial, so both foreign keys still need a plain index.
    await queryInterface.addIndex('class_students', {
      fields: ['class_id'],
      name: 'class_students_class_id_idx',
      transaction,
    });

    await queryInterface.addIndex('class_students', {
      fields: ['student_user_id'],
      name: 'class_students_student_user_id_idx',
      transaction,
    });
  });
}

export async function down(queryInterface: QueryInterface): Promise<void> {
  await queryInterface.sequelize.transaction(async (transaction) => {
    await queryInterface.dropTable('class_students', { transaction });
  });
}
