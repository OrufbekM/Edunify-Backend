import type { QueryInterface } from 'sequelize';

// Contract v2, section 4: names split in two, the teacher's phone, the admin's login, the
// account status, and the forced password change after an admin reset.
export async function up(queryInterface: QueryInterface): Promise<void> {
  await queryInterface.sequelize.transaction(async (transaction) => {
    const run = (sql: string) => queryInterface.sequelize.query(sql, { transaction });

    await run(`CREATE TYPE "enum_users_status" AS ENUM ('pending', 'active', 'blocked')`);
    await run(
      `ALTER TABLE "users"
         ADD COLUMN "first_name" TEXT,
         ADD COLUMN "last_name" TEXT,
         ADD COLUMN "phone" TEXT,
         ADD COLUMN "login" CITEXT,
         ADD COLUMN "status" "enum_users_status" NOT NULL DEFAULT 'active',
         ADD COLUMN "must_change_password" BOOLEAN NOT NULL DEFAULT false`,
    );

    // Existing accounts (development data only, plan open item 1): the name splits at its
    // first space, teachers stay active, and their phone starts empty for the profile.
    await run(
      `UPDATE "users"
          SET "first_name" = split_part("full_name", ' ', 1),
              "last_name" = CASE WHEN strpos("full_name", ' ') > 0
                                 THEN substr("full_name", strpos("full_name", ' ') + 1)
                                 ELSE '' END,
              "phone" = CASE WHEN "role" = 'teacher' THEN '' END`,
    );

    // No default status: every insert must say it, so a teacher can't skip approval by
    // accident.
    await run(
      `ALTER TABLE "users"
         ALTER COLUMN "first_name" SET NOT NULL,
         ALTER COLUMN "last_name" SET NOT NULL,
         ALTER COLUMN "email" DROP NOT NULL,
         ALTER COLUMN "status" DROP DEFAULT,
         DROP COLUMN "full_name",
         DROP CONSTRAINT "users_public_id_role_chk"`,
    );

    await queryInterface.addIndex('users', {
      fields: ['login'],
      unique: true,
      name: 'users_login_uq',
      transaction,
    });

    // There is exactly one admin (contract 13), so a second seed can't race the first.
    await run(`CREATE UNIQUE INDEX "users_one_admin_uq" ON "users" ((true)) WHERE "role" = 'admin'`);

    await run(
      `ALTER TABLE "users"
         ADD CONSTRAINT "users_teacher_chk" CHECK ("role" <> 'teacher' OR (
           "email" IS NOT NULL AND "phone" IS NOT NULL AND "public_id" IS NULL AND "login" IS NULL)),
         ADD CONSTRAINT "users_student_chk" CHECK ("role" <> 'student' OR (
           "email" IS NOT NULL AND "public_id" IS NOT NULL AND "phone" IS NULL AND "login" IS NULL)),
         ADD CONSTRAINT "users_admin_chk" CHECK ("role" <> 'admin' OR (
           "login" IS NOT NULL AND "email" IS NULL AND "phone" IS NULL AND "public_id" IS NULL)),
         ADD CONSTRAINT "users_pending_chk" CHECK ("status" <> 'pending' OR "role" = 'teacher')`,
    );
  });
}

// The admin can't exist in the old shape, so it goes; everyone else gets their name back.
export async function down(queryInterface: QueryInterface): Promise<void> {
  await queryInterface.sequelize.transaction(async (transaction) => {
    const run = (sql: string) => queryInterface.sequelize.query(sql, { transaction });

    await run(`DELETE FROM "users" WHERE "role" = 'admin'`);
    await run(
      `ALTER TABLE "users"
         DROP CONSTRAINT "users_teacher_chk",
         DROP CONSTRAINT "users_student_chk",
         DROP CONSTRAINT "users_admin_chk",
         DROP CONSTRAINT "users_pending_chk"`,
    );
    await run(`DROP INDEX "users_one_admin_uq"`);
    await queryInterface.removeIndex('users', 'users_login_uq', { transaction });

    await run(`ALTER TABLE "users" ADD COLUMN "full_name" TEXT`);
    await run(`UPDATE "users" SET "full_name" = trim("first_name" || ' ' || "last_name")`);
    await run(
      `ALTER TABLE "users"
         ALTER COLUMN "full_name" SET NOT NULL,
         ALTER COLUMN "email" SET NOT NULL,
         DROP COLUMN "first_name",
         DROP COLUMN "last_name",
         DROP COLUMN "phone",
         DROP COLUMN "login",
         DROP COLUMN "status",
         DROP COLUMN "must_change_password"`,
    );
    await run(`DROP TYPE "enum_users_status"`);
    await run(
      `ALTER TABLE "users" ADD CONSTRAINT "users_public_id_role_chk"
         CHECK (("public_id" IS NOT NULL) = ("role" = 'student'))`,
    );
  });
}
