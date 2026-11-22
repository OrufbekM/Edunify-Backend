import type { QueryInterface } from 'sequelize';
import { DataTypes, Sequelize } from 'sequelize';

export async function up(queryInterface: QueryInterface): Promise<void> {
  await queryInterface.sequelize.transaction(async (transaction) => {
    await queryInterface.createTable(
      'users',
      {
        id: {
          type: DataTypes.UUID,
          primaryKey: true,
          allowNull: false,
          defaultValue: Sequelize.literal('gen_random_uuid()'),
        },
        role: { type: DataTypes.ENUM('teacher', 'student'), allowNull: false },
        full_name: { type: DataTypes.TEXT, allowNull: false },
        email: { type: DataTypes.CITEXT, allowNull: false },
        password_hash: { type: DataTypes.TEXT, allowNull: false },
        public_id: { type: DataTypes.CHAR(8), allowNull: true },
        created_at: { type: DataTypes.DATE, allowNull: false, defaultValue: Sequelize.literal('now()') },
        updated_at: { type: DataTypes.DATE, allowNull: false, defaultValue: Sequelize.literal('now()') },
      },
      { transaction },
    );

    await queryInterface.addIndex('users', {
      fields: ['email'],
      unique: true,
      name: 'users_email_uq',
      transaction,
    });

    await queryInterface.addIndex('users', {
      fields: ['public_id'],
      unique: true,
      name: 'users_public_id_uq',
      transaction,
    });

    // Contract section 4: public_id is not null exactly when role = 'student'.
    await queryInterface.sequelize.query(
      `ALTER TABLE "users" ADD CONSTRAINT "users_public_id_role_chk"
         CHECK (("public_id" IS NOT NULL) = ("role" = 'student'))`,
      { transaction },
    );
  });
}

export async function down(queryInterface: QueryInterface): Promise<void> {
  await queryInterface.sequelize.transaction(async (transaction) => {
    await queryInterface.dropTable('users', { transaction });
    // dropTable leaves the enum type behind.
    await queryInterface.sequelize.query('DROP TYPE IF EXISTS "enum_users_role"', { transaction });
  });
}
