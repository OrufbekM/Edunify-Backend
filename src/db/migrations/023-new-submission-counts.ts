import type { QueryInterface } from 'sequelize';

// Teachers no longer get notifications; they see newSubmissionCount on classes and lessons
// instead (contract 8.12). PostgreSQL can't drop an enum value in place, so the kind type is
// rebuilt without 'submitted' once those rows are gone.
//
// The partial index serves the counts, which the frontend polls: the latest versions still
// waiting for a grade, found among the submitted rows only.
export async function up(queryInterface: QueryInterface): Promise<void> {
  await queryInterface.sequelize.transaction(async (transaction) => {
    const run = (sql: string) => queryInterface.sequelize.query(sql, { transaction });

    await run(`DELETE FROM "notifications" WHERE "kind" = 'submitted'`);
    await run(`ALTER TYPE "enum_notifications_kind" RENAME TO "enum_notifications_kind_old"`);
    await run(`CREATE TYPE "enum_notifications_kind" AS ENUM ('graded', 'denied')`);
    await run(
      `ALTER TABLE "notifications"
         ALTER COLUMN "kind" TYPE "enum_notifications_kind" USING "kind"::text::"enum_notifications_kind"`,
    );
    await run(`DROP TYPE "enum_notifications_kind_old"`);

    await run(
      `CREATE INDEX "submissions_submitted_idx"
         ON "submissions" ("class_student_id", "homework_id", "version")
         WHERE "status" = 'submitted'`,
    );
  });
}

// The deleted teacher notifications don't come back; teachers start again with none.
export async function down(queryInterface: QueryInterface): Promise<void> {
  await queryInterface.sequelize.transaction(async (transaction) => {
    const run = (sql: string) => queryInterface.sequelize.query(sql, { transaction });

    await run(`DROP INDEX "submissions_submitted_idx"`);
    await run(`ALTER TYPE "enum_notifications_kind" RENAME TO "enum_notifications_kind_new"`);
    await run(`CREATE TYPE "enum_notifications_kind" AS ENUM ('graded', 'denied', 'submitted')`);
    await run(
      `ALTER TABLE "notifications"
         ALTER COLUMN "kind" TYPE "enum_notifications_kind" USING "kind"::text::"enum_notifications_kind"`,
    );
    await run(`DROP TYPE "enum_notifications_kind_new"`);
  });
}
