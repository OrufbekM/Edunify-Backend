import { app } from './app.js';
import { env } from './config/env.js';
import { startAiWorker } from './jobs/aiWorker.js';
import { sequelize } from './db/index.js';
import { logger } from './lib/logger.js';
import { failUnfinishedJobs } from './modules/ai/service.js';
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

// AI grading is switched off for now (AI_GRADING_ENABLED): no worker runs, so close the jobs
// it left unfinished instead of letting teachers wait on them.
if (!env.AI_GRADING_ENABLED) {
  try {
    const closed = await failUnfinishedJobs('AI grading is turned off');
    logger.info({ closed }, 'AI grading is turned off (AI_GRADING_ENABLED)');
  } catch (err) {
    logger.error({ err }, 'Could not close unfinished AI jobs');
  }
}

// Express 5 hands listen failures such as EADDRINUSE to this callback instead of throwing.
app.listen(env.PORT, (err) => {
  if (err) {
    logger.fatal({ err }, 'Could not start the HTTP server');
    process.exit(1);
  }

  logger.info(`EdunifyBackend running on http://localhost:${env.PORT}`);

  if (env.AI_GRADING_ENABLED) {
    startAiWorker();
  }
});
