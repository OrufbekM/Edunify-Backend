import type { QueryInterface } from 'sequelize';

// Contract v2, sections 4 and 8.2-8.3: teachers order their categories and the classes in
// each one, and a class has a name and no subject.
export async function up(queryInterface: QueryInterface): Promise<void> {
  await queryInterface.sequelize.transaction(async (transaction) => {
    const run = (sql: string) => queryInterface.sequelize.query(sql, { transaction });

    // Existing rows keep the order teachers saw before: categories by name, classes
    // newest first.
    await run(`ALTER TABLE "categories" ADD COLUMN "position" INTEGER`);
    await run(
      `UPDATE "categories" AS c SET "position" = r.n - 1
         FROM (SELECT id, row_number() OVER (PARTITION BY teacher_id ORDER BY lower(name), name, id) AS n
                 FROM "categories") AS r
        WHERE r.id = c.id`,
    );
    await run(`ALTER TABLE "categories" ALTER COLUMN "position" SET NOT NULL`);

    await run(`ALTER TABLE "classes" ADD COLUMN "position" INTEGER`);
    await run(
      `UPDATE "classes" AS c SET "position" = r.n - 1
         FROM (SELECT id, row_number() OVER (PARTITION BY category_id ORDER BY created_at DESC, id DESC) AS n
                 FROM "classes") AS r
        WHERE r.id = c.id`,
    );

    // The subject and the optional name become one required name (plan, open item 1).
    await run(`UPDATE "classes" SET "name" = left(btrim("subject" || ' ' || coalesce("name", '')), 80)`);
    await run(
      `ALTER TABLE "classes"
         ALTER COLUMN "position" SET NOT NULL,
         ALTER COLUMN "name" SET NOT NULL,
         DROP COLUMN "subject"`,
    );
  });
}

export async function down(queryInterface: QueryInterface): Promise<void> {
  await queryInterface.sequelize.transaction(async (transaction) => {
    const run = (sql: string) => queryInterface.sequelize.query(sql, { transaction });

    await run(`ALTER TABLE "classes" ADD COLUMN "subject" TEXT`);
    await run(`UPDATE "classes" SET "subject" = "name"`);
    await run(
      `ALTER TABLE "classes"
         ALTER COLUMN "subject" SET NOT NULL,
         ALTER COLUMN "name" DROP NOT NULL,
         DROP COLUMN "position"`,
    );
    await run(`ALTER TABLE "categories" DROP COLUMN "position"`);
  });
}
