import { Router } from 'express';

import { emptyQuerySchema } from '../../lib/validation.js';
import { getAuth, requireAuth } from '../../middleware/auth.js';
import { generalLimiter } from '../../middleware/rateLimit.js';
import { requireRole } from '../../middleware/role.js';
import { classParams } from './schemas.js';
import * as journal from './service.js';

// Mounted at /api/v1 because the paths span /classes and /student. Guards sit on each
// route, so requests for other paths pass through untouched.
export const journalRouter = Router();

journalRouter.get(
  '/classes/:classId/journal',
  requireAuth,
  generalLimiter,
  requireRole('teacher'),
  async (req, res) => {
    const { classId } = classParams.parse(req.params);
    emptyQuerySchema.parse(req.query);

    res.json(await journal.getJournal(getAuth(req).id, classId));
  },
);

journalRouter.get('/student/grades', requireAuth, generalLimiter, requireRole('student'), async (req, res) => {
  emptyQuerySchema.parse(req.query);

  res.json({ items: await journal.listMyGrades(getAuth(req).id) });
});
