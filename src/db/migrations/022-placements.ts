import type { QueryInterface } from 'sequelize';

// Contract v2, sections 4 and 4.1: units and lessons are placed in classes. A unit or lesson
// belongs to one class or to a class group; class_units and class_lessons place it in each
// class that holds it, with its order there and (for lessons) its visibility. Every lesson
// sits in a unit, and every class keeps at least one unit.
export async function up(queryInterface: QueryInterface): Promise<void> {
  await queryInterface.sequelize.transaction(async (transaction) => {
    const run = (sql: string) => queryInterface.sequelize.query(sql, { transaction });

    // Every class gets a unit if it has none. Lessons without a unit came first in v1, so
    // they go to the start of their class's first unit, ahead of the lessons already there.
    await run(
      `INSERT INTO "units" ("class_id", "title", "position")
       SELECT c.id, 'Unit 1', 0 FROM "classes" c
        WHERE NOT EXISTS (SELECT 1 FROM "units" u WHERE u.class_id = c.id)`,
    );
    await run(
      `WITH first_unit AS (SELECT DISTINCT ON (class_id) class_id, id FROM "units" ORDER BY class_id, position, id),
            loose AS (SELECT class_id, count(*)::int AS n FROM "lessons" WHERE unit_id IS NULL GROUP BY class_id)
       UPDATE "lessons" AS l SET "position" = l.position + loose.n
         FROM first_unit JOIN loose ON loose.class_id = first_unit.class_id
        WHERE l.unit_id = first_unit.id`,
    );
    await run(
      `UPDATE "lessons" AS l SET "unit_id" = f.id
         FROM (SELECT DISTINCT ON (class_id) class_id, id FROM "units" ORDER BY class_id, position, id) AS f
        WHERE l.unit_id IS NULL AND l.class_id = f.class_id`,
    );
    await run(`ALTER TABLE "lessons" ALTER COLUMN "unit_id" SET NOT NULL`);

    // Class groups (contract 4.1). A group exists only while it has two or more classes.
    await run(
      `CREATE TABLE "class_groups" (
         "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
         "created_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
         "updated_at" TIMESTAMPTZ NOT NULL DEFAULT now()
       )`,
    );
    await run(`ALTER TABLE "classes" ADD COLUMN "group_id" UUID REFERENCES "class_groups" ("id") ON DELETE SET NULL`);
    await run(`CREATE INDEX "classes_group_id_idx" ON "classes" ("group_id")`);

    // Units: owned by one class or by a group, placed in classes by class_units.
    await run(
      `ALTER TABLE "units"
         ADD COLUMN "group_id" UUID REFERENCES "class_groups" ("id") ON DELETE CASCADE,
         ALTER COLUMN "class_id" DROP NOT NULL,
         ADD CONSTRAINT "units_owner_chk" CHECK (("class_id" IS NULL) <> ("group_id" IS NULL))`,
    );
    await run(`CREATE INDEX "units_group_id_idx" ON "units" ("group_id")`);
    await run(
      `CREATE TABLE "class_units" (
         "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
         "class_id" UUID NOT NULL REFERENCES "classes" ("id") ON DELETE CASCADE,
         "unit_id" UUID NOT NULL REFERENCES "units" ("id") ON DELETE CASCADE,
         "position" INTEGER NOT NULL,
         "created_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
         "updated_at" TIMESTAMPTZ NOT NULL DEFAULT now()
       )`,
    );
    await run(`CREATE UNIQUE INDEX "class_units_class_id_unit_id_uq" ON "class_units" ("class_id", "unit_id")`);
    await run(`CREATE INDEX "class_units_unit_id_idx" ON "class_units" ("unit_id")`);
    await run(
      `INSERT INTO "class_units" ("class_id", "unit_id", "position")
       SELECT "class_id", "id", "position" FROM "units"`,
    );
    await run(`ALTER TABLE "units" DROP COLUMN "position"`);

    // Lessons: class-only (class_id) or linked (group_id, with the linked order in position),
    // placed in classes by class_lessons, which holds a class-only lesson's slot.
    await run(
      `ALTER TABLE "lessons"
         ADD COLUMN "group_id" UUID REFERENCES "class_groups" ("id") ON DELETE CASCADE,
         ALTER COLUMN "class_id" DROP NOT NULL,
         ALTER COLUMN "position" DROP NOT NULL`,
    );
    await run(`CREATE INDEX "lessons_group_id_idx" ON "lessons" ("group_id")`);
    await run(
      `CREATE TABLE "class_lessons" (
         "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
         "class_id" UUID NOT NULL REFERENCES "classes" ("id") ON DELETE CASCADE,
         "lesson_id" UUID NOT NULL REFERENCES "lessons" ("id") ON DELETE CASCADE,
         "position" INTEGER,
         "visible" BOOLEAN NOT NULL DEFAULT true,
         "created_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
         "updated_at" TIMESTAMPTZ NOT NULL DEFAULT now()
       )`,
    );
    await run(`CREATE UNIQUE INDEX "class_lessons_class_id_lesson_id_uq" ON "class_lessons" ("class_id", "lesson_id")`);
    await run(`CREATE INDEX "class_lessons_lesson_id_idx" ON "class_lessons" ("lesson_id")`);
    await run(
      `INSERT INTO "class_lessons" ("class_id", "lesson_id", "position", "visible")
       SELECT "class_id", "id", "position", true FROM "lessons"`,
    );
    await run(`UPDATE "lessons" SET "position" = NULL`);
    await run(
      `ALTER TABLE "lessons"
         ADD CONSTRAINT "lessons_owner_chk" CHECK (("class_id" IS NULL) <> ("group_id" IS NULL)),
         ADD CONSTRAINT "lessons_position_chk" CHECK (("group_id" IS NULL) = ("position" IS NULL))`,
    );

    // AI jobs belong to a lesson in one class (contract 8.11).
    await run(`ALTER TABLE "ai_jobs" ADD COLUMN "class_id" UUID REFERENCES "classes" ("id") ON DELETE CASCADE`);
    await run(`UPDATE "ai_jobs" AS j SET "class_id" = l.class_id FROM "lessons" l WHERE l.id = j.lesson_id`);
    await run(`ALTER TABLE "ai_jobs" ALTER COLUMN "class_id" SET NOT NULL`);
    await run(`CREATE INDEX "ai_jobs_class_id_idx" ON "ai_jobs" ("class_id")`);
  });
}

// Back to one class per unit and lesson. Group-owned units and lessons can't exist in the
// old shape, so they go; lessons stay in the units they were moved into.
export async function down(queryInterface: QueryInterface): Promise<void> {
  await queryInterface.sequelize.transaction(async (transaction) => {
    const run = (sql: string) => queryInterface.sequelize.query(sql, { transaction });

    await run(`ALTER TABLE "ai_jobs" DROP COLUMN "class_id"`);

    await run(`DELETE FROM "lessons" WHERE "group_id" IS NOT NULL`);
    await run(`ALTER TABLE "lessons" DROP CONSTRAINT "lessons_owner_chk", DROP CONSTRAINT "lessons_position_chk"`);
    await run(
      `UPDATE "lessons" AS l SET "position" = cl.position
         FROM "class_lessons" cl WHERE cl.lesson_id = l.id AND cl.class_id = l.class_id`,
    );
    await run(`DROP TABLE "class_lessons"`);
    await run(
      `ALTER TABLE "lessons"
         DROP COLUMN "group_id",
         ALTER COLUMN "class_id" SET NOT NULL,
         ALTER COLUMN "position" SET NOT NULL,
         ALTER COLUMN "unit_id" DROP NOT NULL`,
    );

    await run(`DELETE FROM "units" WHERE "group_id" IS NOT NULL`);
    await run(`ALTER TABLE "units" ADD COLUMN "position" INTEGER`);
    await run(
      `UPDATE "units" AS u SET "position" = cu.position
         FROM "class_units" cu WHERE cu.unit_id = u.id AND cu.class_id = u.class_id`,
    );
    await run(`DROP TABLE "class_units"`);
    await run(
      `ALTER TABLE "units"
         DROP CONSTRAINT "units_owner_chk",
         DROP COLUMN "group_id",
         ALTER COLUMN "class_id" SET NOT NULL,
         ALTER COLUMN "position" SET NOT NULL`,
    );

    await run(`ALTER TABLE "classes" DROP COLUMN "group_id"`);
    await run(`DROP TABLE "class_groups"`);
  });
}
