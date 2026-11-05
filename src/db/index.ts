import { Sequelize } from 'sequelize';

import { env } from '../config/env.js';

export const sequelize = new Sequelize(env.DATABASE_URL, {
  dialect: 'postgres',
  logging: false,
  define: {
    underscored: true,
  },
});
