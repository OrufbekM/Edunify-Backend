import { Router } from 'express';

import { emptyQuerySchema, idParamsSchema } from '../../lib/validation.js';
import { getAuth, requireAuth } from '../../middleware/auth.js';
import { generalLimiter } from '../../middleware/rateLimit.js';
import { requireRole } from '../../middleware/role.js';
import { noBody } from './schemas.js';
import * as notifications from './service.js';

// Teachers and students, each for their own notifications; the admin has none (contract 5).
export const notificationsRouter = Router();

notificationsRouter.use(requireAuth, generalLimiter, requireRole('teacher', 'student'));

notificationsRouter.get('/count', async (req, res) => {
  emptyQuerySchema.parse(req.query);

  res.json({ unreadCount: await notifications.countUnread(getAuth(req).id) });
});

notificationsRouter.get('/', async (req, res) => {
  emptyQuerySchema.parse(req.query);

  res.json({ items: await notifications.listUnread(getAuth(req).id) });
});

notificationsRouter.post('/:id/read', async (req, res) => {
  const { id } = idParamsSchema.parse(req.params);
  noBody.parse(req.body);

  await notifications.markRead(getAuth(req).id, id);
  res.status(204).end();
});
