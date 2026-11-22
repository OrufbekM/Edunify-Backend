import type { QueryInterface, Transaction } from 'sequelize';

// Contract v2 calls the two-sided link a "connection" (section 6), so the audit table follows.
// Its rows are kept. Every constraint and index named after the table is renamed with it,
// whatever PostgreSQL version named them.
async function renameTable(
  queryInterface: QueryInterface,
  from: string,
  to: string,
  transaction: Transaction,
): Promise<void> {
  await queryInterface.sequelize.query(
    `ALTER TABLE "${from}" RENAME TO "${to}";
     DO $$
     DECLARE r record;
     BEGIN
       FOR r IN SELECT conname FROM pg_constraint
                 WHERE conrelid = '"${to}"'::regclass AND conname LIKE '${from}\\_%' LOOP
         EXECUTE format('ALTER TABLE %I RENAME CONSTRAINT %I TO %I',
                        '${to}', r.conname, '${to}' || substr(r.conname, ${from.length + 1}));
       END LOOP;
       FOR r IN SELECT indexname FROM pg_indexes
                 WHERE tablename = '${to}' AND indexname LIKE '${from}\\_%' LOOP
         EXECUTE format('ALTER INDEX %I RENAME TO %I',
                        r.indexname, '${to}' || substr(r.indexname, ${from.length + 1}));
       END LOOP;
     END $$;`,
    { transaction },
  );
}

export async function up(queryInterface: QueryInterface): Promise<void> {
  await queryInterface.sequelize.transaction(async (transaction) => {
    await renameTable(queryInterface, 'link_audit', 'connection_audit', transaction);
  });
}

export async function down(queryInterface: QueryInterface): Promise<void> {
  await queryInterface.sequelize.transaction(async (transaction) => {
    await renameTable(queryInterface, 'connection_audit', 'link_audit', transaction);
  });
}
