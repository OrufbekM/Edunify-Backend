import cookieParser from 'cookie-parser';
import express from 'express';
import helmet from 'helmet';
import { pinoHttp } from 'pino-http';

import { logger } from './lib/logger.js';
import { errorHandler, notFoundHandler } from './middleware/error.js';

export const app = express();

// Contract section 2.1: no ETags.
app.disable('etag');

app.use(
  pinoHttp({
    logger,
    // pino-http logs every response at `info` by default, even a 500.
    customLogLevel: (_req, res) => (res.statusCode >= 500 ? 'error' : 'info'),
  }),
);
app.use(helmet());
app.use(express.json({ limit: '1mb' }));
app.use(cookieParser());

app.get('/api/v1/health', (_req, res) => {
  res.json({ status: 'ok' });
});

app.use(notFoundHandler);
app.use(errorHandler);
