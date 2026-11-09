import { Router } from 'express';

import { emptyQuerySchema, idParamsSchema } from '../../lib/validation.js';
import { getAuth, requireAuth } from '../../middleware/auth.js';
import { generalLimiter } from '../../middleware/rateLimit.js';
import { requireRole } from '../../middleware/role.js';
import { gradeBody, lessonParams } from './schemas.js';
import * as grading from './service.js';

// Mounted at /api/v1 because the paths span /lessons and /submissions. Guards sit on each
// route, so requests for other paths pass through untouched.
export const gradingRouter = Router();

const teacherOnly = requireRole('teacher');

gradingRouter.get('/lessons/:lessonId/grading', requireAuth, generalLimiter, teacherOnly, async (req, res) => {
  const { lessonId } = lessonParams.parse(req.params);
  emptyQuerySchema.parse(req.query);

  res.json(await grading.getGrading(getAuth(req).id, lessonId));
});

gradingRouter.put('/submissions/:id/grade', requireAuth, generalLimiter, teacherOnly, async (req, res) => {
  const { id } = idParamsSchema.parse(req.params);
  const input = gradeBody.parse(req.body);

  res.json(await grading.gradeSubmission(getAuth(req).id, id, input));
});

gradingRouter.delete('/submissions/:id/grade', requireAuth, generalLimiter, teacherOnly, async (req, res) => {
  const { id } = idParamsSchema.parse(req.params);

  res.json(await grading.removeGrade(getAuth(req).id, id));
});
