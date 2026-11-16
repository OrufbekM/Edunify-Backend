import { Router } from 'express';

import { emptyQuerySchema, idParamsSchema } from '../../lib/validation.js';
import { getAuth, requireAuth } from '../../middleware/auth.js';
import { generalLimiter } from '../../middleware/rateLimit.js';
import { requireRole } from '../../middleware/role.js';
import { createCategoryBody, updateCategoryBody } from './schemas.js';
import * as categories from './service.js';

export const categoriesRouter = Router();

categoriesRouter.use(requireAuth, generalLimiter, requireRole('teacher'));

categoriesRouter.get('/', async (req, res) => {
  emptyQuerySchema.parse(req.query);

  res.json({ items: await categories.listCategories(getAuth(req).id) });
});

categoriesRouter.post('/', async (req, res) => {
  const body = createCategoryBody.parse(req.body);

  res.status(201).json(await categories.createCategory(getAuth(req).id, body));
});

categoriesRouter.patch('/:id', async (req, res) => {
  const { id } = idParamsSchema.parse(req.params);
  const body = updateCategoryBody.parse(req.body);

  res.json(await categories.updateCategory(getAuth(req).id, id, body));
});

categoriesRouter.delete('/:id', async (req, res) => {
  const { id } = idParamsSchema.parse(req.params);

  await categories.deleteCategory(getAuth(req).id, id);
  res.status(204).end();
});
