// npm run seed:admin [-- --reset-password]   (production: npm run seed:admin:prod)
//
// Creates the one admin account (contract 11). ADMIN_LOGIN (default edunify_admin) and
// ADMIN_PASSWORD (12+ characters) are read only here, never by the server. An existing admin
// is never changed, except its password with --reset-password.
import { z } from 'zod';

import { adminLoginName } from '../modules/auth/schemas.js';
import { seedAdmin } from '../modules/auth/service.js';
import { sequelize } from './index.js';

const RESET_FLAG = '--reset-password';
const USAGE = `Usage: ADMIN_PASSWORD=... npm run seed:admin [-- ${RESET_FLAG}]`;

const settings = z.object({
  login: adminLoginName,
  password: z.string().min(12, 'ADMIN_PASSWORD must be at least 12 characters').max(128),
});

async function run(args: string[]): Promise<void> {
  const unknown = args.filter((arg) => arg !== RESET_FLAG);
  if (unknown.length > 0) {
    throw new Error(`Unknown argument: ${unknown.join(' ')}. ${USAGE}`);
  }

  const parsed = settings.safeParse({
    login: process.env.ADMIN_LOGIN || 'edunify_admin',
    password: process.env.ADMIN_PASSWORD ?? '',
  });
  if (!parsed.success) {
    throw new Error(`${z.prettifyError(parsed.error)}\n${USAGE}`);
  }

  const { outcome, login } = await seedAdmin({ ...parsed.data, resetPassword: args.includes(RESET_FLAG) });

  switch (outcome) {
    case 'created':
      console.log(`Created the admin "${login}".`);
      return;
    case 'exists':
      console.log(`An admin already exists ("${login}"); nothing changed. Add -- ${RESET_FLAG} to replace its password.`);
      return;
    case 'password-reset':
      console.log(`Replaced the password of the admin "${login}" and ended its sessions.`);
      return;
  }
}

try {
  await run(process.argv.slice(2));
} catch (err) {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
} finally {
  await sequelize.close();
}
