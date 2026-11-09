import { app } from './app.js';
import { env } from './config/env.js';
import { startAiWorker } from './jobs/aiWorker.js';
import { sequelize } from './db/index.js';
import { logger } from './lib/logger.js';
import { initStorage } from './storage/index.js';

try {
  await sequelize.authenticate();
  logger.info('PostgreSQL connection has been established successfully.');
} catch (err) {
  logger.fatal({ err }, 'Could not connect to PostgreSQL');
  process.exit(1);
}

try {
  await initStorage();
  logger.info(`Storage directory is ready: ${env.STORAGE_DIR}`);
} catch (err) {
  logger.fatal({ err }, 'Could not prepare the storage directory');
  process.exit(1);
}

// Express 5 hands listen failures such as EADDRINUSE to this callback instead of throwing.
app.listen(env.PORT, (err) => {
  if (err) {
    logger.fatal({ err }, 'Could not start the HTTP server');
    process.exit(1);
  }

  logger.info(`EdunifyBackend running on http://localhost:${env.PORT}`);
  startAiWorker();
});
