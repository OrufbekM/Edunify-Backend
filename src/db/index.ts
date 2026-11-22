import { Sequelize } from 'sequelize';

import { env } from '../config/env.js';
import { logger } from '../lib/logger.js';

export const sequelize = new Sequelize(env.DATABASE_URL, {
  dialect: 'postgres',
  logging: (sql) => {
    logger.debug({ sql }, 'SQL query');
  },
  define: {
    underscored: true,
  },
});
