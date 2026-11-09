import { randomUUID } from 'node:crypto';

import type { Router } from 'express';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { app } from './app.js';
import { env } from './config/env.js';
import { AiJob } from './db/models/index.js';
import { generalLimiter, resetRateLimits } from './middleware/rateLimit.js';
import { aiRouter } from './modules/ai/routes.js';
import { authRouter, meRouter } from './modules/auth/routes.js';
import { categoriesRouter } from './modules/categories/routes.js';
import { classesRouter } from './modules/classes/routes.js';
import { filesRouter } from './modules/files/routes.js';
import { gradingRouter } from './modules/grading/routes.js';
import { journalRouter } from './modules/journal/routes.js';
import { lessonsRouter } from './modules/lessons/routes.js';
import { notificationsRouter } from './modules/notifications/routes.js';
import { classStudentsRouter, studentRouter } from './modules/students/routes.js';
import { submissionsRouter } from './modules/submissions/routes.js';
import { useTestDatabase } from './test/database.js';
import { api, createTestUser, type TestUser } from './test/users.js';

// Contract 2.4 and 5, on every route: no token -> 401, the wrong role -> 403, and a resource
// the caller doesn't own or isn't linked to -> the same 404 as one that doesn't exist.

useTestDatabase();

const realKey = env.ANTHROPIC_API_KEY;

interface Fixture {
  categoryId: string;
  emptyCategoryId: string;
  classId: string;
  classPublicId: string;
  rowId: string;
  spareRowId: string;
  unitId: string;
  lessonId: string;
  homeworkId: string;
  submissionId: string;
  notificationId: string;
  jobId: string;
}

type Caller = 'owner' | 'student' | 'otherTeacher' | 'otherStudent';
type Send = (user: TestUser | null, f: Fixture) => request.Test;

interface Case {
  // Who may call it at all: 'any' is every signed-in user.
  role: 'teacher' | 'student' | 'both' | 'any';
  // The fixture value the access check is about: put a random id there and the rightful
  // caller gets the "doesn't exist" answer that strangers must also get.
  resource?: keyof Fixture;
  // Rightful callers and their success status. Run last, since some of them delete.
  ok: Array<[Caller, number]>;
  send: Send;
}

let callers: Record<Caller, TestUser>;
let fixture: Fixture;

const MD = Buffer.from('# Notes\n');

function call(
  method: 'get' | 'post' | 'put' | 'patch' | 'delete',
  path: string,
  user: TestUser | null,
  body?: object,
): request.Test {
  let pending = request(app)[method](path);
  if (user) {
    pending = pending.set('Authorization', `Bearer ${user.token}`);
  }
  return body === undefined ? pending : pending.send(body);
}

function upload(path: string, user: TestUser | null): request.Test {
  let pending = request(app).put(path);
  if (user) {
    pending = pending.set('Authorization', `Bearer ${user.token}`);
  }
  return pending.attach('file', MD, 'notes.md');
}

const V1 = '/api/v1';

const MATRIX: Record<string, Case> = {
  'GET /api/v1/me': { role: 'any', ok: [['owner', 200], ['student', 200]], send: (u) => call('get', `${V1}/me`, u) },
  'PATCH /api/v1/me': { role: 'any', ok: [['owner', 200]], send: (u) => call('patch', `${V1}/me`, u, { fullName: 'Renamed' }) },
  'POST /api/v1/me/password': {
    role: 'any',
    ok: [],
    send: (u) => call('post', `${V1}/me/password`, u, { currentPassword: 'wrong-password', newPassword: 'new-password-1' }),
  },

  'GET /api/v1/categories': { role: 'teacher', ok: [['owner', 200]], send: (u) => call('get', `${V1}/categories`, u) },
  'POST /api/v1/categories': { role: 'teacher', ok: [['owner', 201]], send: (u) => call('post', `${V1}/categories`, u, { name: 'Fresh' }) },
  'PATCH /api/v1/categories/:id': {
    role: 'teacher',
    resource: 'categoryId',
    ok: [['owner', 200]],
    send: (u, f) => call('patch', `${V1}/categories/${f.categoryId}`, u, { name: 'Renamed' }),
  },
  'DELETE /api/v1/categories/:id': {
    role: 'teacher',
    resource: 'emptyCategoryId',
    ok: [['owner', 204]],
    send: (u, f) => call('delete', `${V1}/categories/${f.emptyCategoryId}`, u),
  },

  'GET /api/v1/classes': { role: 'teacher', ok: [['owner', 200]], send: (u) => call('get', `${V1}/classes`, u) },
  'POST /api/v1/classes': {
    role: 'teacher',
    ok: [['owner', 201]],
    send: (u, f) => call('post', `${V1}/classes`, u, { categoryId: f.categoryId, subject: 'Physics' }),
  },
  'GET /api/v1/classes/:id': {
    role: 'teacher',
    resource: 'classId',
    ok: [['owner', 200]],
    send: (u, f) => call('get', `${V1}/classes/${f.classId}`, u),
  },
  'PATCH /api/v1/classes/:id': {
    role: 'teacher',
    resource: 'classId',
    ok: [['owner', 200]],
    send: (u, f) => call('patch', `${V1}/classes/${f.classId}`, u, { subject: 'Geometry' }),
  },
  'DELETE /api/v1/classes/:id': {
    role: 'teacher',
    resource: 'classId',
    ok: [['owner', 204]],
    send: (u, f) => call('delete', `${V1}/classes/${f.classId}`, u),
  },

  'GET /api/v1/classes/:classId/students': {
    role: 'teacher',
    resource: 'classId',
    ok: [['owner', 200]],
    send: (u, f) => call('get', `${V1}/classes/${f.classId}/students`, u),
  },
  'POST /api/v1/classes/:classId/students': {
    role: 'teacher',
    resource: 'classId',
    ok: [['owner', 201]],
    send: (u, f) => call('post', `${V1}/classes/${f.classId}/students`, u, { fullName: 'New Kid' }),
  },
  'PATCH /api/v1/classes/:classId/students/:id': {
    role: 'teacher',
    resource: 'classId',
    ok: [['owner', 200]],
    send: (u, f) => call('patch', `${V1}/classes/${f.classId}/students/${f.rowId}`, u, { fullName: 'Renamed' }),
  },
  'DELETE /api/v1/classes/:classId/students/:id': {
    role: 'teacher',
    resource: 'classId',
    ok: [['owner', 204]],
    send: (u, f) => call('delete', `${V1}/classes/${f.classId}/students/${f.spareRowId}`, u),
  },

  'POST /api/v1/student/claims': {
    role: 'student',
    ok: [['student', 200]],
    send: (u, f) => call('post', `${V1}/student/claims`, u, { classPublicId: f.classPublicId }),
  },
  'GET /api/v1/student/classes': { role: 'student', ok: [['student', 200]], send: (u) => call('get', `${V1}/student/classes`, u) },
  'GET /api/v1/student/submissions': {
    role: 'student',
    ok: [['student', 200]],
    send: (u) => call('get', `${V1}/student/submissions`, u),
  },
  'GET /api/v1/student/grades': { role: 'student', ok: [['student', 200]], send: (u) => call('get', `${V1}/student/grades`, u) },

  'GET /api/v1/classes/:classId/outline': {
    role: 'both',
    resource: 'classId',
    ok: [['owner', 200], ['student', 200]],
    send: (u, f) => call('get', `${V1}/classes/${f.classId}/outline`, u),
  },
  'POST /api/v1/classes/:classId/units': {
    role: 'teacher',
    resource: 'classId',
    ok: [['owner', 201]],
    send: (u, f) => call('post', `${V1}/classes/${f.classId}/units`, u, { title: 'Unit 2' }),
  },
  'PATCH /api/v1/units/:id': {
    role: 'teacher',
    resource: 'unitId',
    ok: [['owner', 200]],
    send: (u, f) => call('patch', `${V1}/units/${f.unitId}`, u, { title: 'Renamed' }),
  },
  'DELETE /api/v1/units/:id': {
    role: 'teacher',
    resource: 'unitId',
    ok: [['owner', 204]],
    send: (u, f) => call('delete', `${V1}/units/${f.unitId}`, u),
  },
  'POST /api/v1/classes/:classId/lessons': {
    role: 'teacher',
    resource: 'classId',
    ok: [['owner', 201]],
    send: (u, f) => call('post', `${V1}/classes/${f.classId}/lessons`, u, { title: 'Lesson 2' }),
  },
  'GET /api/v1/lessons/:id': {
    role: 'both',
    resource: 'lessonId',
    ok: [['owner', 200], ['student', 200]],
    send: (u, f) => call('get', `${V1}/lessons/${f.lessonId}`, u),
  },
  'PATCH /api/v1/lessons/:id': {
    role: 'teacher',
    resource: 'lessonId',
    ok: [['owner', 200]],
    send: (u, f) => call('patch', `${V1}/lessons/${f.lessonId}`, u, { title: 'Renamed' }),
  },
  'DELETE /api/v1/lessons/:id': {
    role: 'teacher',
    resource: 'lessonId',
    ok: [['owner', 204]],
    send: (u, f) => call('delete', `${V1}/lessons/${f.lessonId}`, u),
  },
  'PUT /api/v1/lessons/:id/lesson-file': {
    role: 'teacher',
    resource: 'lessonId',
    ok: [['owner', 200]],
    send: (u, f) => upload(`${V1}/lessons/${f.lessonId}/lesson-file`, u),
  },
  'DELETE /api/v1/lessons/:id/lesson-file': {
    role: 'teacher',
    resource: 'lessonId',
    ok: [['owner', 200]],
    send: (u, f) => call('delete', `${V1}/lessons/${f.lessonId}/lesson-file`, u),
  },
  'PUT /api/v1/lessons/:id/homework': {
    role: 'teacher',
    resource: 'lessonId',
    ok: [['owner', 200]],
    send: (u, f) => call('put', `${V1}/lessons/${f.lessonId}/homework`, u, { type: 'text' }),
  },
  'DELETE /api/v1/lessons/:id/homework': {
    role: 'teacher',
    resource: 'lessonId',
    ok: [['owner', 200]],
    send: (u, f) => call('delete', `${V1}/lessons/${f.lessonId}/homework`, u),
  },
  'PUT /api/v1/lessons/:id/homework/file': {
    role: 'teacher',
    resource: 'lessonId',
    ok: [['owner', 200]],
    send: (u, f) => upload(`${V1}/lessons/${f.lessonId}/homework/file`, u),
  },
  'DELETE /api/v1/lessons/:id/homework/file': {
    role: 'teacher',
    resource: 'lessonId',
    ok: [['owner', 200]],
    send: (u, f) => call('delete', `${V1}/lessons/${f.lessonId}/homework/file`, u),
  },

  'POST /api/v1/homeworks/:homeworkId/submissions': {
    role: 'student',
    resource: 'homeworkId',
    ok: [['student', 201]],
    send: (u, f) => call('post', `${V1}/homeworks/${f.homeworkId}/submissions`, u, { text: 'Again' }),
  },
  'GET /api/v1/submissions/:id': {
    role: 'both',
    resource: 'submissionId',
    ok: [['owner', 200], ['student', 200]],
    send: (u, f) => call('get', `${V1}/submissions/${f.submissionId}`, u),
  },

  'GET /api/v1/lessons/:lessonId/grading': {
    role: 'teacher',
    resource: 'lessonId',
    ok: [['owner', 200]],
    send: (u, f) => call('get', `${V1}/lessons/${f.lessonId}/grading`, u),
  },
  'PUT /api/v1/submissions/:id/grade': {
    role: 'teacher',
    resource: 'submissionId',
    ok: [['owner', 200]],
    send: (u, f) => call('put', `${V1}/submissions/${f.submissionId}/grade`, u, { value: 5 }),
  },
  'DELETE /api/v1/submissions/:id/grade': {
    role: 'teacher',
    resource: 'submissionId',
    ok: [['owner', 200]],
    send: (u, f) => call('delete', `${V1}/submissions/${f.submissionId}/grade`, u),
  },
  'GET /api/v1/classes/:classId/journal': {
    role: 'teacher',
    resource: 'classId',
    ok: [['owner', 200]],
    send: (u, f) => call('get', `${V1}/classes/${f.classId}/journal`, u),
  },

  'POST /api/v1/lessons/:lessonId/ai-grade': {
    role: 'teacher',
    resource: 'lessonId',
    ok: [['owner', 202]],
    send: (u, f) => call('post', `${V1}/lessons/${f.lessonId}/ai-grade`, u),
  },
  'GET /api/v1/ai-jobs/:id': {
    role: 'teacher',
    resource: 'jobId',
    ok: [['owner', 200]],
    send: (u, f) => call('get', `${V1}/ai-jobs/${f.jobId}`, u),
  },

  'GET /api/v1/notifications/count': {
    role: 'any',
    ok: [['owner', 200], ['student', 200]],
    send: (u) => call('get', `${V1}/notifications/count`, u),
  },
  'GET /api/v1/notifications': {
    role: 'any',
    ok: [['owner', 200], ['student', 200]],
    send: (u) => call('get', `${V1}/notifications`, u),
  },
  'POST /api/v1/notifications/:id/read': {
    role: 'any',
    resource: 'notificationId',
    ok: [['owner', 204]],
    send: (u, f) => call('post', `${V1}/notifications/${f.notificationId}/read`, u),
  },
};

// Open on purpose: the auth routes work from the refresh cookie or no credentials at all, and
// a signed URL is the only credential a file needs (contract 7). Each module tests them.
const PUBLIC = [
  'GET /api/v1/health',
  'POST /api/v1/auth/register',
  'POST /api/v1/auth/login',
  'POST /api/v1/auth/refresh',
  'POST /api/v1/auth/logout',
  'GET /api/v1/files/:id',
];

// Where app.ts mounts each router.
const MOUNTS: Array<[string, Router]> = [
  ['/api/v1/auth', authRouter],
  ['/api/v1/me', meRouter],
  ['/api/v1/categories', categoriesRouter],
  ['/api/v1/classes/:classId/students', classStudentsRouter],
  ['/api/v1', lessonsRouter],
  ['/api/v1', submissionsRouter],
  ['/api/v1', gradingRouter],
  ['/api/v1', journalRouter],
  ['/api/v1', aiRouter],
  ['/api/v1/classes', classesRouter],
  ['/api/v1/student', studentRouter],
  ['/api/v1/files', filesRouter],
  ['/api/v1/notifications', notificationsRouter],
];

interface RouteLayer {
  route?: { path: string; methods: Record<string, boolean>; stack: Array<{ handle: unknown }> };
  handle: unknown;
}

function stackOf(router: unknown): RouteLayer[] {
  return (router as { stack: RouteLayer[] }).stack;
}

function routesIn(prefix: string, router: unknown): string[] {
  return stackOf(router).flatMap(({ route }) =>
    route
      ? Object.keys(route.methods).map((method) => `${method.toUpperCase()} ${`${prefix}${route.path}`.replace(/\/$/, '')}`)
      : [],
  );
}

// Routes whose own middleware, or whose router's, doesn't include the general limiter.
function unlimitedIn(prefix: string, router: unknown): string[] {
  const routerWide = stackOf(router).some((layer) => !layer.route && layer.handle === generalLimiter);

  return stackOf(router).flatMap((layer) =>
    layer.route && !routerWide && !layer.route.stack.some(({ handle }) => handle === generalLimiter)
      ? routesIn(prefix, { stack: [layer] })
      : [],
  );
}

async function buildFixture(): Promise<Fixture> {
  const { owner, student, otherStudent } = callers;
  const category = await api(owner).post('/api/v1/categories', { name: 'Maths' });
  const emptyCategory = await api(owner).post('/api/v1/categories', { name: 'Empty' });
  const schoolClass = await api(owner).post('/api/v1/classes', { categoryId: category.body.id, subject: 'Algebra' });
  const classId = schoolClass.body.id as string;
  const classPublicId = schoolClass.body.publicId as string;
  const row = await api(owner).post(`/api/v1/classes/${classId}/students`, {
    fullName: 'Ali',
    studentPublicId: student.publicId,
  });
  const spare = await api(owner).post(`/api/v1/classes/${classId}/students`, { fullName: 'Spare' });
  // A claim without a roster row: still no access (contract 6.2).
  for (const account of [student, otherStudent]) {
    await api(account).post('/api/v1/student/claims', { classPublicId });
  }
  const unit = await api(owner).post(`/api/v1/classes/${classId}/units`, { title: 'Unit 1' });
  const lesson = await api(owner).post(`/api/v1/classes/${classId}/lessons`, { title: 'Lesson 1', unitId: unit.body.id });
  const lessonId = lesson.body.id as string;
  const homework = await api(owner).put(`/api/v1/lessons/${lessonId}/homework`, { type: 'text' });
  await api(owner).upload(`/api/v1/lessons/${lessonId}/lesson-file`, MD, 'lesson.md');
  await api(owner).upload(`/api/v1/lessons/${lessonId}/homework/file`, MD, 'task.md');
  const homeworkId = homework.body.homework.id as string;
  const submission = await api(student).post(`/api/v1/homeworks/${homeworkId}/submissions`, { text: 'x = 3' });
  const [notification] = (await api(owner).get('/api/v1/notifications')).body.items;
  const job = await AiJob.create({
    lessonId,
    createdBy: owner.id,
    status: 'done',
    submissionIds: [submission.body.id],
    total: 1,
    error: null,
    finishedAt: new Date(),
  });

  return {
    categoryId: category.body.id,
    emptyCategoryId: emptyCategory.body.id,
    classId,
    classPublicId,
    rowId: row.body.id,
    spareRowId: spare.body.id,
    unitId: unit.body.id,
    lessonId,
    homeworkId,
    submissionId: submission.body.id,
    notificationId: notification.id,
    jobId: job.id,
  };
}

// Callers who may not see the resource at all, by the route's role.
function strangers(role: Case['role']): Caller[] {
  switch (role) {
    case 'teacher':
      return ['otherTeacher'];
    case 'student':
      return ['otherStudent'];
    case 'both':
      return ['otherTeacher', 'otherStudent'];
    case 'any':
      return ['student', 'otherTeacher', 'otherStudent'];
  }
}

function wrongRole(role: Case['role']): Caller[] {
  return role === 'teacher' ? ['student', 'otherStudent'] : role === 'student' ? ['owner', 'otherTeacher'] : [];
}

beforeEach(async () => {
  await resetRateLimits();
  env.ANTHROPIC_API_KEY = 'test-key';
  callers = {
    owner: await createTestUser('teacher'),
    student: await createTestUser('student'),
    otherTeacher: await createTestUser('teacher'),
    otherStudent: await createTestUser('student'),
  };
  fixture = await buildFixture();
});

afterEach(() => {
  env.ANTHROPIC_API_KEY = realKey;
});

describe('every route', () => {
  it('has a row in this matrix or is public on purpose', () => {
    const appRoutes = routesIn('', app.router);
    const mounted = stackOf(app.router)
      .map((layer) => layer.handle)
      .filter((handle) => MOUNTS.some(([, router]) => router === handle));

    expect(mounted).toHaveLength(MOUNTS.length);
    expect([...appRoutes, ...MOUNTS.flatMap(([prefix, router]) => routesIn(prefix, router))].sort()).toEqual(
      [...Object.keys(MATRIX), ...PUBLIC].sort(),
    );
  });
});

describe('the general rate limit (contract 2.5)', () => {
  it('covers every route, public ones included, which are counted per IP', () => {
    expect([unlimitedIn('', app.router), ...MOUNTS.map(([prefix, router]) => unlimitedIn(prefix, router))].flat()).toEqual([]);
  });
});

describe.each(Object.entries(MATRIX))('%s', (_route, route) => {
  it('answers 401 without a token, 403 to the wrong role, the missing-resource 404 to strangers, and serves its callers', async () => {
    const f = fixture;
    const anonymous = await route.send(null, f);

    expect(anonymous.status).toBe(401);
    expect(anonymous.body.error.code).toBe('UNAUTHENTICATED');

    for (const caller of wrongRole(route.role)) {
      const res = await route.send(callers[caller], f);
      expect(res.status, caller).toBe(403);
      expect(res.body.error.code).toBe('FORBIDDEN');
    }

    if (route.resource) {
      const [rightful] = route.ok[0] ?? [];
      const missing = await route.send(callers[rightful as Caller], { ...f, [route.resource]: randomUUID() });
      expect(missing.status).toBe(404);
      expect(missing.body.error.code).toBe('NOT_FOUND');

      for (const caller of strangers(route.role)) {
        const res = await route.send(callers[caller], f);
        expect(res.status, caller).toBe(404);
        expect(res.body, caller).toEqual(missing.body);
      }
    }

    for (const [caller, status] of route.ok) {
      const res = await route.send(callers[caller], f);
      expect(res.status, `${caller}: ${JSON.stringify(res.body)}`).toBe(status);
    }
  });
});
