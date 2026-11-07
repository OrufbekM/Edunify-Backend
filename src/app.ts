import cookieParser from 'cookie-parser';
import express from 'express';
import helmet from 'helmet';
import { pinoHttp } from 'pino-http';

import { logger } from './lib/logger.js';
import { errorHandler, notFoundHandler } from './middleware/error.js';
import { authRouter, meRouter } from './modules/auth/routes.js';
import { categoriesRouter } from './modules/categories/routes.js';
import { classesRouter } from './modules/classes/routes.js';
import { lessonsRouter } from './modules/lessons/routes.js';
import { classStudentsRouter, studentRouter } from './modules/students/routes.js';

export const app = express();

app.disable('etag');
app.set('trust proxy', 1);

app.use(
  pinoHttp({
    logger,
    customLogLevel: (_req, res) => (res.statusCode >= 500 ? 'error' : 'info'),
  }),
);
app.use(helmet());
app.use(express.json({ limit: '1mb' }));
app.use(cookieParser());

app.get('/api/v1/health', (_req, res) => {
  res.json({ status: 'ok' });
});

app.use('/api/v1/auth', authRouter);
app.use('/api/v1/me', meRouter);
app.use('/api/v1/categories', categoriesRouter);
// Both before classesRouter, whose teacher-only guards would otherwise run first on these
// paths too (students may read a class outline).
app.use('/api/v1/classes/:classId/students', classStudentsRouter);
app.use('/api/v1', lessonsRouter);
app.use('/api/v1/classes', classesRouter);
app.use('/api/v1/student', studentRouter);

app.use(notFoundHandler);
app.use(errorHandler);
