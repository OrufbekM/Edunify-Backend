import { app } from './app.js';
import { env } from './config/env.js';
import { sequelize } from './db/index.js';
import { logger } from './lib/logger.js';

try {
  await sequelize.authenticate();
  logger.info('PostgreSQL connection has been established successfully.');
} catch (err) {
  logger.fatal({ err }, 'Could not connect to PostgreSQL');
  process.exit(1);
}

// Express 5 hands listen failures such as EADDRINUSE to this callback instead of throwing.
app.listen(env.PORT, (err) => {
  if (err) {
    logger.fatal({ err }, 'Could not start the HTTP server');
    process.exit(1);
  }

  logger.info(`EdunifyBackend running on http://localhost:${env.PORT}`);
});
