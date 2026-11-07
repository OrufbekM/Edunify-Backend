import { Router } from 'express';

import { emptyQuerySchema, idParamsSchema } from '../../lib/validation.js';
import { getAuth, requireAuth } from '../../middleware/auth.js';
import { generalLimiter } from '../../middleware/rateLimit.js';
import { requireRole } from '../../middleware/role.js';
import {
  classParams,
  createLessonBody,
  createUnitBody,
  updateLessonBody,
  updateUnitBody,
} from './schemas.js';
import * as lessons from './service.js';

// Mounted at /api/v1 because the paths span /classes, /units and /lessons. Guards sit on
// each route, not on the router, so requests for other paths pass through untouched.
export const lessonsRouter = Router();

// Routes with no requireRole take teachers and students both; the service decides what
// each may see (contract 5).
const teacherOnly = requireRole('teacher');

lessonsRouter.get('/classes/:classId/outline', requireAuth, generalLimiter, async (req, res) => {
  const { classId } = classParams.parse(req.params);
  emptyQuerySchema.parse(req.query);

  res.json(await lessons.getOutline(getAuth(req), classId));
});

lessonsRouter.post('/classes/:classId/units', requireAuth, generalLimiter, teacherOnly, async (req, res) => {
  const { classId } = classParams.parse(req.params);
  const body = createUnitBody.parse(req.body);

  res.status(201).json(await lessons.createUnit(getAuth(req).id, classId, body));
});

lessonsRouter.patch('/units/:id', requireAuth, generalLimiter, teacherOnly, async (req, res) => {
  const { id } = idParamsSchema.parse(req.params);
  const body = updateUnitBody.parse(req.body);

  res.json(await lessons.updateUnit(getAuth(req).id, id, body));
});

lessonsRouter.delete('/units/:id', requireAuth, generalLimiter, teacherOnly, async (req, res) => {
  const { id } = idParamsSchema.parse(req.params);

  await lessons.deleteUnit(getAuth(req).id, id);
  res.status(204).end();
});

lessonsRouter.post('/classes/:classId/lessons', requireAuth, generalLimiter, teacherOnly, async (req, res) => {
  const { classId } = classParams.parse(req.params);
  const body = createLessonBody.parse(req.body);

  res.status(201).json(await lessons.createLesson(getAuth(req).id, classId, body));
});

lessonsRouter.get('/lessons/:id', requireAuth, generalLimiter, async (req, res) => {
  const { id } = idParamsSchema.parse(req.params);
  emptyQuerySchema.parse(req.query);

  res.json(await lessons.getLesson(getAuth(req), id));
});

lessonsRouter.patch('/lessons/:id', requireAuth, generalLimiter, teacherOnly, async (req, res) => {
  const { id } = idParamsSchema.parse(req.params);
  const body = updateLessonBody.parse(req.body);

  res.json(await lessons.updateLesson(getAuth(req).id, id, body));
});

lessonsRouter.delete('/lessons/:id', requireAuth, generalLimiter, teacherOnly, async (req, res) => {
  const { id } = idParamsSchema.parse(req.params);

  await lessons.deleteLesson(getAuth(req).id, id);
  res.status(204).end();
});
