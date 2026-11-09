import { Router } from 'express';

import { emptyQuerySchema, idParamsSchema } from '../../lib/validation.js';
import { getAuth, requireAuth } from '../../middleware/auth.js';
import { aiGradeLimiter, generalLimiter } from '../../middleware/rateLimit.js';
import { requireRole } from '../../middleware/role.js';
import { aiGradeBody, lessonParams } from './schemas.js';
import * as ai from './service.js';

// Mounted at /api/v1 because the paths span /lessons and /ai-jobs. Guards sit on each route,
// so requests for other paths pass through untouched.
export const aiRouter = Router();

const teacherOnly = requireRole('teacher');

// 5 per minute per user on top of the general limit (contract 2.5), counted after the role
// check so a student's attempts don't use it up.
aiRouter.post(
  '/lessons/:lessonId/ai-grade',
  requireAuth,
  generalLimiter,
  teacherOnly,
  aiGradeLimiter,
  async (req, res) => {
    const { lessonId } = lessonParams.parse(req.params);
    const body = aiGradeBody.parse(req.body);

    res.status(202).json(await ai.startAiGrading(getAuth(req).id, lessonId, body));
  },
);

aiRouter.get('/ai-jobs/:id', requireAuth, generalLimiter, teacherOnly, async (req, res) => {
  const { id } = idParamsSchema.parse(req.params);
  emptyQuerySchema.parse(req.query);

  res.json(await ai.getAiJob(getAuth(req).id, id));
});
