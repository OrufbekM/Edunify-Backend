import type { QueryInterface } from 'sequelize';
import { DataTypes, Sequelize } from 'sequelize';

export async function up(queryInterface: QueryInterface): Promise<void> {
  await queryInterface.sequelize.transaction(async (transaction) => {
    await queryInterface.createTable(
      'homeworks',
      {
        id: {
          type: DataTypes.UUID,
          primaryKey: true,
          allowNull: false,
          defaultValue: Sequelize.literal('gen_random_uuid()'),
        },
        lesson_id: {
          type: DataTypes.UUID,
          allowNull: false,
          references: { model: 'lessons', key: 'id' },
          onDelete: 'CASCADE',
        },
        // math is stored exactly like draw (contract section 3).
        type: { type: DataTypes.ENUM('text', 'draw', 'math', 'code', 'photo'), allowNull: false },
        instructions_text: { type: DataTypes.TEXT, allowNull: true },
        instructions_file_id: {
          type: DataTypes.UUID,
          allowNull: true,
          references: { model: 'files', key: 'id' },
        },
        created_at: { type: DataTypes.DATE, allowNull: false, defaultValue: Sequelize.literal('now()') },
        updated_at: { type: DataTypes.DATE, allowNull: false, defaultValue: Sequelize.literal('now()') },
      },
      { transaction },
    );

    // At most one homework per lesson; also serves as the foreign key index.
    await queryInterface.addIndex('homeworks', {
      fields: ['lesson_id'],
      unique: true,
      name: 'homeworks_lesson_id_uq',
      transaction,
    });

    await queryInterface.addIndex('homeworks', {
      fields: ['instructions_file_id'],
      name: 'homeworks_instructions_file_id_idx',
      transaction,
    });
  });
}

export async function down(queryInterface: QueryInterface): Promise<void> {
  await queryInterface.sequelize.transaction(async (transaction) => {
    await queryInterface.dropTable('homeworks', { transaction });
    await queryInterface.sequelize.query('DROP TYPE IF EXISTS "enum_homeworks_type"', { transaction });
  });
}
