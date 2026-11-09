import cookieParser from 'cookie-parser';
import express from 'express';
import helmet from 'helmet';
import { pinoHttp } from 'pino-http';

import { logger } from './lib/logger.js';
import { errorHandler, notFoundHandler } from './middleware/error.js';
import { authRouter, meRouter } from './modules/auth/routes.js';
import { categoriesRouter } from './modules/categories/routes.js';
import { classesRouter } from './modules/classes/routes.js';
import { filesRouter } from './modules/files/routes.js';
import { gradingRouter } from './modules/grading/routes.js';
import { journalRouter } from './modules/journal/routes.js';
import { lessonsRouter } from './modules/lessons/routes.js';
import { notificationsRouter } from './modules/notifications/routes.js';
import { classStudentsRouter, studentRouter } from './modules/students/routes.js';
import { submissionsRouter } from './modules/submissions/routes.js';

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
// These come before classesRouter and studentRouter, whose router-wide guards would
// otherwise run first on their paths too (students read a class outline, and
// /student/submissions and /student/grades live with their own modules).
app.use('/api/v1/classes/:classId/students', classStudentsRouter);
app.use('/api/v1', lessonsRouter);
app.use('/api/v1', submissionsRouter);
app.use('/api/v1', gradingRouter);
app.use('/api/v1', journalRouter);
app.use('/api/v1/classes', classesRouter);
app.use('/api/v1/student', studentRouter);
app.use('/api/v1/files', filesRouter);
app.use('/api/v1/notifications', notificationsRouter);

app.use(notFoundHandler);
app.use(errorHandler);
