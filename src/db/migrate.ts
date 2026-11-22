import path from 'node:path';
import { pathToFileURL } from 'node:url';

import type { QueryInterface } from 'sequelize';
import { SequelizeStorage, Umzug } from 'umzug';

import { env } from '../config/env.js';
import { sequelize } from './index.js';

interface MigrationModule {
  up: (queryInterface: QueryInterface) => Promise<void>;
  down: (queryInterface: QueryInterface) => Promise<void>;
}

async function loadMigration(filePath: string): Promise<MigrationModule> {
  // A file URL keeps the dynamic import working for .ts under tsx and .js under dist/.
  return (await import(pathToFileURL(filePath).href)) as MigrationModule;
}

const umzug = new Umzug({
  migrations: {
    // cwd is this file's own folder, so the same code finds src/db/migrations and dist/db/migrations.
    glob: ['*.{ts,js}', { cwd: path.join(import.meta.dirname, 'migrations'), ignore: '*.d.ts' }],
    resolve: ({ name, path: filePath, context }) => {
      if (!filePath) {
        throw new Error(`Migration ${name} has no file path`);
      }

      return {
        // Strip the extension so one migration keeps the same recorded name under
        // tsx (.ts) and in dist (.js). Otherwise production would re-apply everything.
        name: name.replace(/\.(ts|js)$/, ''),
        up: async () => {
          const migration = await loadMigration(filePath);
          await migration.up(context);
        },
        down: async () => {
          const migration = await loadMigration(filePath);
          await migration.down(context);
        },
      };
    },
  },
  context: sequelize.getQueryInterface(),
  // The only table without created_at and updated_at.
  storage: new SequelizeStorage({ sequelize, tableName: 'sequelize_meta' }),
  logger: console,
});

const USAGE = 'Usage: migrate <up|down|reset|status>';

async function run(command: string | undefined): Promise<void> {
  switch (command) {
    case 'up': {
      const applied = await umzug.up();
      console.log(applied.length > 0 ? `Applied ${applied.length} migration(s)` : 'Nothing to apply');
      return;
    }

    case 'down': {
      const reverted = await umzug.down();
      console.log(reverted.length > 0 ? `Reverted ${reverted[0]?.name}` : 'Nothing to revert');
      return;
    }

    case 'reset': {
      if (env.NODE_ENV === 'production') {
        throw new Error('reset drops every table and is refused when NODE_ENV=production');
      }

      const reverted = await umzug.down({ to: 0 });
      console.log(reverted.length > 0 ? `Reverted ${reverted.length} migration(s)` : 'Nothing to revert');
      return;
    }

    case 'status': {
      const executed = await umzug.executed();
      const pending = await umzug.pending();

      console.log(`Applied (${executed.length}):`);
      for (const migration of executed) {
        console.log(`  ${migration.name}`);
      }

      console.log(`Pending (${pending.length}):`);
      for (const migration of pending) {
        console.log(`  ${migration.name}`);
      }
      return;
    }

    default:
      throw new Error(`Unknown command: ${command ?? '(none)'}. ${USAGE}`);
  }
}

try {
  await run(process.argv[2]);
} catch (err) {
  console.error(err);
  process.exitCode = 1;
} finally {
  await sequelize.close();
}
