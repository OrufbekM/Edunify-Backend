import { Router, type RequestHandler } from 'express';

import { emptyQuerySchema, idParamsSchema } from '../../lib/validation.js';
import { getAuth, requireAuth } from '../../middleware/auth.js';
import { generalLimiter } from '../../middleware/rateLimit.js';
import { requireRole } from '../../middleware/role.js';
import { getUpload, uploadLessonFile } from '../../middleware/upload.js';
import {
  classParams,
  createLessonBody,
  createUnitBody,
  putHomeworkBody,
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

// Runs before multer, so nobody can make the server buffer up to 20 MB for a lesson they
// don't own (plan, Phase 7). The service checks again inside its transaction.
function checkBeforeUpload(
  check: (teacherId: string, lessonId: string) => Promise<void>,
): RequestHandler {
  return async (req, _res, next) => {
    const { id } = idParamsSchema.parse(req.params);

    await check(getAuth(req).id, id);
    next();
  };
}

const ownLessonFirst = checkBeforeUpload(lessons.assertOwnLesson);
const ownHomeworkFirst = checkBeforeUpload(lessons.assertOwnHomework);

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

lessonsRouter.put(
  '/lessons/:id/lesson-file',
  requireAuth,
  generalLimiter,
  teacherOnly,
  ownLessonFirst,
  uploadLessonFile,
  async (req, res) => {
    const { id } = idParamsSchema.parse(req.params);

    res.json(await lessons.setLessonFile(getAuth(req).id, id, getUpload(req)));
  },
);

lessonsRouter.delete('/lessons/:id/lesson-file', requireAuth, generalLimiter, teacherOnly, async (req, res) => {
  const { id } = idParamsSchema.parse(req.params);

  res.json(await lessons.removeLessonFile(getAuth(req).id, id));
});

lessonsRouter.put('/lessons/:id/homework', requireAuth, generalLimiter, teacherOnly, async (req, res) => {
  const { id } = idParamsSchema.parse(req.params);
  const body = putHomeworkBody.parse(req.body);

  res.json(await lessons.putHomework(getAuth(req).id, id, body));
});

lessonsRouter.delete('/lessons/:id/homework', requireAuth, generalLimiter, teacherOnly, async (req, res) => {
  const { id } = idParamsSchema.parse(req.params);

  res.json(await lessons.deleteHomework(getAuth(req).id, id));
});

lessonsRouter.put(
  '/lessons/:id/homework/file',
  requireAuth,
  generalLimiter,
  teacherOnly,
  ownHomeworkFirst,
  uploadLessonFile,
  async (req, res) => {
    const { id } = idParamsSchema.parse(req.params);

    res.json(await lessons.setHomeworkFile(getAuth(req).id, id, getUpload(req)));
  },
);

lessonsRouter.delete(
  '/lessons/:id/homework/file',
  requireAuth,
  generalLimiter,
  teacherOnly,
  async (req, res) => {
    const { id } = idParamsSchema.parse(req.params);

    res.json(await lessons.removeHomeworkFile(getAuth(req).id, id));
  },
);
