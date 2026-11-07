import { Router } from 'express';

import { emptyQuerySchema, idParamsSchema } from '../../lib/validation.js';
import { getAuth, requireAuth } from '../../middleware/auth.js';
import { generalLimiter } from '../../middleware/rateLimit.js';
import { requireRole } from '../../middleware/role.js';
import { createClassBody, listClassesQuery, updateClassBody } from './schemas.js';
import * as classes from './service.js';

export const classesRouter = Router();

classesRouter.use(requireAuth, generalLimiter, requireRole('teacher'));

classesRouter.get('/', async (req, res) => {
  const query = listClassesQuery.parse(req.query);

  res.json({ items: await classes.listClasses(getAuth(req).id, query) });
});

classesRouter.post('/', async (req, res) => {
  const body = createClassBody.parse(req.body);

  res.status(201).json(await classes.createClass(getAuth(req).id, body));
});

classesRouter.get('/:id', async (req, res) => {
  const { id } = idParamsSchema.parse(req.params);
  emptyQuerySchema.parse(req.query);

  res.json(await classes.getClass(getAuth(req).id, id));
});

classesRouter.patch('/:id', async (req, res) => {
  const { id } = idParamsSchema.parse(req.params);
  const body = updateClassBody.parse(req.body);

  res.json(await classes.updateClass(getAuth(req).id, id, body));
});

classesRouter.delete('/:id', async (req, res) => {
  const { id } = idParamsSchema.parse(req.params);

  await classes.deleteClass(getAuth(req).id, id);
  res.status(204).end();
});
