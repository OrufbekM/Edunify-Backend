import type { QueryInterface } from 'sequelize';

// A migration of its own: PostgreSQL can't use an enum value in the transaction that adds
// it, and 019 uses 'admin' in its checks.
export async function up(queryInterface: QueryInterface): Promise<void> {
  await queryInterface.sequelize.transaction(async (transaction) => {
    await queryInterface.sequelize.query(`ALTER TYPE "enum_users_role" ADD VALUE IF NOT EXISTS 'admin'`, {
      transaction,
    });
  });
}

// PostgreSQL can't drop an enum value, so the type is rebuilt without it. The check that
// mentions the role is dropped around the change: its stored expression names the old type.
export async function down(queryInterface: QueryInterface): Promise<void> {
  await queryInterface.sequelize.transaction(async (transaction) => {
    const run = (sql: string) => queryInterface.sequelize.query(sql, { transaction });

    await run(`DELETE FROM "users" WHERE "role" = 'admin'`);
    await run(`ALTER TABLE "users" DROP CONSTRAINT "users_public_id_role_chk"`);
    await run(`ALTER TYPE "enum_users_role" RENAME TO "enum_users_role_old"`);
    await run(`CREATE TYPE "enum_users_role" AS ENUM ('teacher', 'student')`);
    await run(
      `ALTER TABLE "users" ALTER COLUMN "role" TYPE "enum_users_role" USING "role"::text::"enum_users_role"`,
    );
    await run(`DROP TYPE "enum_users_role_old"`);
    await run(
      `ALTER TABLE "users" ADD CONSTRAINT "users_public_id_role_chk"
         CHECK (("public_id" IS NOT NULL) = ("role" = 'student'))`,
    );
  });
}
