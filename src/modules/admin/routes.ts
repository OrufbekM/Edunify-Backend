import { Router } from 'express';

import { idParamsSchema } from '../../lib/validation.js';
import { requireAuth } from '../../middleware/auth.js';
import { generalLimiter } from '../../middleware/rateLimit.js';
import { requireRole } from '../../middleware/role.js';
import { listUsersQuery, noBody, setStatusBody } from './schemas.js';
import * as admin from './service.js';

// Contract 8.14: the admin only. The admin sees accounts, never classes, lessons or work.
export const adminRouter = Router();

adminRouter.use(requireAuth, generalLimiter, requireRole('admin'));

adminRouter.get('/users', async (req, res) => {
  res.json(await admin.listUsers(listUsersQuery.parse(req.query)));
});

adminRouter.patch('/users/:id/status', async (req, res) => {
  const { id } = idParamsSchema.parse(req.params);
  const { status } = setStatusBody.parse(req.body);

  res.json(await admin.setUserStatus(id, status));
});

adminRouter.post('/users/:id/reset-password', async (req, res) => {
  const { id } = idParamsSchema.parse(req.params);
  noBody.parse(req.body);

  const result = await admin.resetUserPassword(id);

  // Shown once (contract 8.14), so no cache along the way may keep it.
  res.set('Cache-Control', 'no-store');
  res.json(result);
});
