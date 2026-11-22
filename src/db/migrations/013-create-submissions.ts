import type { QueryInterface } from 'sequelize';
import { DataTypes, Sequelize } from 'sequelize';

export async function up(queryInterface: QueryInterface): Promise<void> {
  await queryInterface.sequelize.transaction(async (transaction) => {
    await queryInterface.createTable(
      'submissions',
      {
        id: {
          type: DataTypes.UUID,
          primaryKey: true,
          allowNull: false,
          defaultValue: Sequelize.literal('gen_random_uuid()'),
        },
        homework_id: {
          type: DataTypes.UUID,
          allowNull: false,
          references: { model: 'homeworks', key: 'id' },
          onDelete: 'CASCADE',
        },
        // Contract section 4: submissions belong to class_students, never to the user account.
        class_student_id: {
          type: DataTypes.UUID,
          allowNull: false,
          references: { model: 'class_students', key: 'id' },
          onDelete: 'CASCADE',
        },
        version: { type: DataTypes.INTEGER, allowNull: false },
        status: { type: DataTypes.ENUM('submitted', 'denied', 'graded'), allowNull: false },
        // Text or code content; null for the page types.
        content: { type: DataTypes.JSONB, allowNull: true },
        grade_value: { type: DataTypes.SMALLINT, allowNull: true },
        grade_denied: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
        grade_comment: { type: DataTypes.TEXT, allowNull: true },
        grade_source: { type: DataTypes.ENUM('teacher', 'ai_confirmed'), allowNull: true },
        graded_at: { type: DataTypes.DATE, allowNull: true },
        // Contract section 9: never sent to students, never changes the grade.
        ai_suggestion: { type: DataTypes.JSONB, allowNull: true },
        created_at: { type: DataTypes.DATE, allowNull: false, defaultValue: Sequelize.literal('now()') },
        updated_at: { type: DataTypes.DATE, allowNull: false, defaultValue: Sequelize.literal('now()') },
      },
      { transaction },
    );

    // Leading column homework_id, so this also serves as that foreign key's index.
    await queryInterface.addIndex('submissions', {
      fields: ['homework_id', 'class_student_id', 'version'],
      unique: true,
      name: 'submissions_homework_id_class_student_id_version_uq',
      transaction,
    });

    await queryInterface.addIndex('submissions', {
      fields: ['class_student_id'],
      name: 'submissions_class_student_id_idx',
      transaction,
    });

    // Contract section 3: Grade is 2 | 3 | 4 | 5.
    await queryInterface.sequelize.query(
      `ALTER TABLE "submissions" ADD CONSTRAINT "submissions_grade_value_chk"
         CHECK ("grade_value" IS NULL OR "grade_value" BETWEEN 2 AND 5)`,
      { transaction },
    );

    // Contract section 3: exactly one of value != null, denied = true.
    await queryInterface.sequelize.query(
      `ALTER TABLE "submissions" ADD CONSTRAINT "submissions_grade_exclusive_chk"
         CHECK (NOT ("grade_value" IS NOT NULL AND "grade_denied"))`,
      { transaction },
    );
  });
}

export async function down(queryInterface: QueryInterface): Promise<void> {
  await queryInterface.sequelize.transaction(async (transaction) => {
    await queryInterface.dropTable('submissions', { transaction });
    await queryInterface.sequelize.query('DROP TYPE IF EXISTS "enum_submissions_status"', { transaction });
    await queryInterface.sequelize.query('DROP TYPE IF EXISTS "enum_submissions_grade_source"', { transaction });
  });
}
