import { Router, type RequestHandler } from 'express';

import { emptyQuerySchema } from '../../lib/validation.js';
import { getAuth, requireAuth } from '../../middleware/auth.js';
import { generalLimiter, publicIdLookupLimiter } from '../../middleware/rateLimit.js';
import { requireRole } from '../../middleware/role.js';
import {
  addStudentBody,
  claimBody,
  classParams,
  classStudentParams,
  updateStudentBody,
} from './schemas.js';
import * as students from './service.js';

// Contract 2.5 counts a create or update as a lookup only when it carries a
// studentPublicId: adding a name alone, or unlinking with null, looks nothing up.
const limitStudentIdLookups: RequestHandler = (req, res, next) => {
  const studentPublicId: unknown = req.body?.studentPublicId;

  if (studentPublicId === undefined || studentPublicId === null) {
    next();
    return;
  }

  return publicIdLookupLimiter(req, res, next);
};

// Mounted at /classes/:classId/students, so mergeParams brings classId in.
export const classStudentsRouter = Router({ mergeParams: true });

classStudentsRouter.use(requireAuth, generalLimiter, requireRole('teacher'));

classStudentsRouter.get('/', async (req, res) => {
  const { classId } = classParams.parse(req.params);
  emptyQuerySchema.parse(req.query);

  res.json({ items: await students.listStudents(getAuth(req).id, classId) });
});

classStudentsRouter.post('/', limitStudentIdLookups, async (req, res) => {
  const { classId } = classParams.parse(req.params);
  const body = addStudentBody.parse(req.body);

  res.status(201).json(await students.addStudent(getAuth(req).id, classId, body));
});

classStudentsRouter.patch('/:id', limitStudentIdLookups, async (req, res) => {
  const { classId, id } = classStudentParams.parse(req.params);
  const body = updateStudentBody.parse(req.body);

  res.json(await students.updateStudent(getAuth(req).id, classId, id, body));
});

classStudentsRouter.delete('/:id', async (req, res) => {
  const { classId, id } = classStudentParams.parse(req.params);

  await students.deleteStudent(getAuth(req).id, classId, id);
  res.status(204).end();
});

export const studentRouter = Router();

studentRouter.use(requireAuth, generalLimiter, requireRole('student'));

studentRouter.post('/claims', publicIdLookupLimiter, async (req, res) => {
  const body = claimBody.parse(req.body);

  await students.claimClass(getAuth(req).id, body);
  res.json({ saved: true });
});

studentRouter.get('/classes', async (req, res) => {
  emptyQuerySchema.parse(req.query);

  res.json({ items: await students.listMyClasses(getAuth(req).id) });
});
