import { Router, type Request, type RequestHandler, type Response } from 'express';

import type { HomeworkType } from '../../db/models/enums.js';
import { emptyQuerySchema, idParamsSchema } from '../../lib/validation.js';
import { getAuth, requireAuth } from '../../middleware/auth.js';
import { generalLimiter } from '../../middleware/rateLimit.js';
import { requireRole } from '../../middleware/role.js';
import { getUploads, uploadDrawPages, uploadPhotoPages } from '../../middleware/upload.js';
import {
  codeSubmissionBody,
  homeworkParams,
  studentSubmissionsQuery,
  textSubmissionBody,
} from './schemas.js';
import * as submissions from './service.js';
import type { NewSubmissionContent, PageType } from './service.js';

// Mounted at /api/v1 because the paths span /homeworks, /student and /submissions. Guards
// sit on each route, so requests for other paths pass through untouched.
export const submissionsRouter = Router();

const studentOnly = requireRole('student');

// Math pages are stored exactly like draw pages (contract 3).
const PAGE_UPLOADS: Record<PageType, RequestHandler> = {
  draw: uploadDrawPages,
  math: uploadDrawPages,
  photo: uploadPhotoPages,
};

function run(middleware: RequestHandler, req: Request, res: Response): Promise<void> {
  return new Promise((resolve, reject) => {
    void middleware(req, res, (err?: unknown) => (err ? reject(err) : resolve()));
  });
}

// The homework's type picks the body (contract 8.8). A body of the wrong kind fails here as
// VALIDATION_ERROR: JSON for a page homework has no pages, and multipart for a text or code
// homework has no JSON body.
async function readContent(
  type: HomeworkType,
  req: Request,
  res: Response,
): Promise<NewSubmissionContent> {
  switch (type) {
    case 'text':
      return { type, ...textSubmissionBody.parse(req.body) };
    case 'code':
      return { type, ...codeSubmissionBody.parse(req.body) };
    default:
      await run(PAGE_UPLOADS[type], req, res);
      return { type, pages: getUploads(req) };
  }
}

submissionsRouter.post(
  '/homeworks/:homeworkId/submissions',
  requireAuth,
  generalLimiter,
  studentOnly,
  async (req, res) => {
    const { homeworkId } = homeworkParams.parse(req.params);
    const userId = getAuth(req).id;
    // Access and the homework type are settled before multer reads a byte (plan, Phase 8).
    const type = await submissions.assertCanSubmit(userId, homeworkId);
    const content = await readContent(type, req, res);

    res.status(201).json(await submissions.createSubmission(userId, homeworkId, content));
  },
);

submissionsRouter.get('/student/submissions', requireAuth, generalLimiter, studentOnly, async (req, res) => {
  const filter = studentSubmissionsQuery.parse(req.query);

  res.json({ items: await submissions.listMySubmissions(getAuth(req).id, filter) });
});

submissionsRouter.get('/submissions/:id', requireAuth, generalLimiter, async (req, res) => {
  const { id } = idParamsSchema.parse(req.params);
  emptyQuerySchema.parse(req.query);

  res.json(await submissions.getSubmission(getAuth(req), id));
});
