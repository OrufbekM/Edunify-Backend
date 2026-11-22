import { randomUUID } from 'node:crypto';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { Submission } from '../../db/models/index.js';
import { logger } from '../../lib/logger.js';
import { resetRateLimits } from '../../middleware/rateLimit.js';
import { firstUnitId } from '../../test/content.js';
import { useTestDatabase } from '../../test/database.js';
import { api, createTestUser, type TestUser } from '../../test/users.js';

// newSubmissionCount on Class and on the teacher's LessonSummary (contract 3 and 8.12): one
// per student whose latest version of a homework has status `submitted`.

useTestDatabase();

afterEach(() => {
  vi.restoreAllMocks();
});

let teacher: TestUser;
let ali: TestUser;
let vali: TestUser;
let schoolClass: { id: string; publicId: string };
let aliRowId: string;

async function createClass(name: string, categoryId?: string) {
  const category = categoryId ?? (await api(teacher).post('/api/v1/categories', { name: `C ${randomUUID()}` })).body.id;
  return (await api(teacher).post('/api/v1/classes', { categoryId: category, name })).body as {
    id: string;
    publicId: string;
    categoryId: string;
  };
}

async function connect(student: TestUser, forClass = schoolClass): Promise<string> {
  const row = await api(teacher).post(`/api/v1/classes/${forClass.id}/students`, {
    fullName: `Student ${randomUUID()}`,
    studentPublicId: student.publicId,
  });
  await api(student).post('/api/v1/student/claims', { classPublicId: forClass.publicId });
  return row.body.id as string;
}

async function addLesson(title: string, forClass = schoolClass.id, homework = true) {
  const unitId = await firstUnitId(teacher, forClass);
  const lessonId = (await api(teacher).post(`/api/v1/classes/${forClass}/lessons`, { title, unitId })).body.id as string;
  const homeworkId = homework
    ? ((await api(teacher).put(`/api/v1/lessons/${lessonId}/homework?classId=${forClass}`, { type: 'text' })).body.homework
        .id as string)
    : null;
  return { lessonId, homeworkId: homeworkId as string };
}

async function submit(student: TestUser, homeworkId: string, forClass = schoolClass.id): Promise<string> {
  const res = await api(student).post(`/api/v1/homeworks/${homeworkId}/submissions?classId=${forClass}`, {
    text: 'answer',
  });
  expect(res.status).toBe(201);
  return res.body.id as string;
}

const gradePath = (submissionId: string) => `/api/v1/submissions/${submissionId}/grade`;

async function classCount(classId = schoolClass.id): Promise<number> {
  const res = await api(teacher).get(`/api/v1/classes/${classId}`);
  expect(res.status).toBe(200);
  return res.body.newSubmissionCount;
}

async function lessonCounts(classId = schoolClass.id): Promise<Record<string, number>> {
  const res = await api(teacher).get(`/api/v1/classes/${classId}/outline`);
  expect(res.status).toBe(200);
  return Object.fromEntries(
    res.body.lessons.map((lesson: { title: string; newSubmissionCount: number }) => [lesson.title, lesson.newSubmissionCount]),
  );
}

beforeEach(async () => {
  await resetRateLimits();
  teacher = await createTestUser('teacher');
  ali = await createTestUser('student');
  vali = await createTestUser('student');
  schoolClass = await createClass('Maths 7A');
  aliRowId = await connect(ali);
  await connect(vali);
});

describe('newSubmissionCount', () => {
  it('starts at 0 on the class and on every lesson, with or without homework', async () => {
    await addLesson('Fractions');
    await addLesson('Reading', schoolClass.id, false);

    await expect(classCount()).resolves.toBe(0);
    await expect(lessonCounts()).resolves.toEqual({ Fractions: 0, Reading: 0 });
  });

  it('counts one per student, however many versions they upload', async () => {
    const fractions = await addLesson('Fractions');
    const angles = await addLesson('Angles');

    await submit(ali, fractions.homeworkId);
    await submit(ali, fractions.homeworkId);
    await submit(ali, fractions.homeworkId);
    await submit(vali, fractions.homeworkId);
    await submit(vali, angles.homeworkId);

    await expect(classCount()).resolves.toBe(3);
    await expect(lessonCounts()).resolves.toEqual({ Fractions: 2, Angles: 1 });
  });

  it('goes down on a grade or a denial, up again when the grade is removed or a new version comes in', async () => {
    const { homeworkId } = await addLesson('Fractions');
    const first = await submit(ali, homeworkId);
    await expect(classCount()).resolves.toBe(1);

    await api(teacher).put(gradePath(first), { value: 5 });
    await expect(classCount()).resolves.toBe(0);
    await expect(lessonCounts()).resolves.toEqual({ Fractions: 0 });

    await api(teacher).delete(gradePath(first));
    await expect(classCount()).resolves.toBe(1);

    await api(teacher).put(gradePath(first), { denied: true, comment: 'Redo it' });
    await expect(classCount()).resolves.toBe(0);

    const second = await submit(ali, homeworkId);
    await expect(classCount()).resolves.toBe(1);
    await expect(lessonCounts()).resolves.toEqual({ Fractions: 1 });

    await api(teacher).put(gradePath(second), { value: 4 });
    await expect(classCount()).resolves.toBe(0);
  });

  it('looks at the latest version only: an older version still marked submitted does not count', async () => {
    const { homeworkId } = await addLesson('Fractions');
    await submit(ali, homeworkId);
    const latest = await submit(ali, homeworkId);

    await api(teacher).put(gradePath(latest), { value: 3 });

    await expect(Submission.count({ where: { status: 'submitted' } })).resolves.toBe(1);
    await expect(classCount()).resolves.toBe(0);
  });

  it('includes hidden lessons, on the class and on their own summary', async () => {
    const { lessonId, homeworkId } = await addLesson('Fractions');
    await submit(ali, homeworkId);

    await api(teacher).patch(`/api/v1/lessons/${lessonId}?classId=${schoolClass.id}`, { visible: false });

    await expect(classCount()).resolves.toBe(1);
    await expect(lessonCounts()).resolves.toEqual({ Fractions: 1 });
  });

  it('still counts the work of a row that is no longer connected: it is still waiting for a grade', async () => {
    const { homeworkId } = await addLesson('Fractions');
    await submit(ali, homeworkId);

    await api(teacher).patch(`/api/v1/classes/${schoolClass.id}/students/${aliRowId}`, { studentPublicId: null });

    await expect(classCount()).resolves.toBe(1);
  });

  it('drops the work of a deleted homework, lesson or roster row', async () => {
    const fractions = await addLesson('Fractions');
    const angles = await addLesson('Angles');
    const algebra = await addLesson('Algebra');
    for (const homeworkId of [fractions.homeworkId, angles.homeworkId, algebra.homeworkId]) {
      await submit(ali, homeworkId);
    }
    await submit(vali, algebra.homeworkId);
    await expect(classCount()).resolves.toBe(4);

    await api(teacher).delete(`/api/v1/lessons/${fractions.lessonId}/homework?classId=${schoolClass.id}`);
    await api(teacher).delete(`/api/v1/lessons/${angles.lessonId}?classId=${schoolClass.id}`);
    await expect(classCount()).resolves.toBe(2);

    await api(teacher).delete(`/api/v1/classes/${schoolClass.id}/students/${aliRowId}`);
    await expect(classCount()).resolves.toBe(1);
  });

  it('keeps each class to its own students, in the list, the class and its update', async () => {
    const other = await createClass('Maths 7B', (await api(teacher).get(`/api/v1/classes/${schoolClass.id}`)).body.categoryId);
    await connect(ali, other);
    const here = await addLesson('Here');
    const there = await addLesson('There', other.id);
    await submit(ali, here.homeworkId);
    await submit(vali, here.homeworkId);
    await submit(ali, there.homeworkId, other.id);

    const list = await api(teacher).get('/api/v1/classes');
    expect(list.body.items.map((item: { name: string; newSubmissionCount: number }) => [item.name, item.newSubmissionCount])).toEqual([
      ['Maths 7A', 2],
      ['Maths 7B', 1],
    ]);
    await expect(classCount(other.id)).resolves.toBe(1);
    expect((await api(teacher).patch(`/api/v1/classes/${other.id}`, { name: 'Renamed' })).body.newSubmissionCount).toBe(1);
    await expect(lessonCounts(other.id)).resolves.toEqual({ There: 1 });
  });

  it('is 0 on a new class', async () => {
    const res = await api(teacher).post('/api/v1/categories', { name: 'Fresh' });
    const created = await api(teacher).post('/api/v1/classes', { categoryId: res.body.id, name: 'New' });

    expect(created.status).toBe(201);
    expect(created.body.newSubmissionCount).toBe(0);
  });

  it('is never sent to a student', async () => {
    const { homeworkId } = await addLesson('Fractions');
    await submit(ali, homeworkId);

    const outline = await api(ali).get(`/api/v1/classes/${schoolClass.id}/outline`);

    expect(outline.status).toBe(200);
    expect(JSON.stringify(outline.body)).not.toContain('newSubmissionCount');
  });

  it('costs the same number of queries for one class or many (no N+1)', async () => {
    const countQueries = async (path: string): Promise<number> => {
      const debug = vi.spyOn(logger, 'debug');
      const res = await api(teacher).get(path);
      expect(res.status).toBe(200);
      const queries = debug.mock.calls.filter(([, message]) => message === 'SQL query').length;
      debug.mockRestore();
      return queries;
    };
    const { homeworkId } = await addLesson('Fractions');
    await submit(ali, homeworkId);
    const one = await countQueries('/api/v1/classes');
    const outlineOne = await countQueries(`/api/v1/classes/${schoolClass.id}/outline`);
    expect(one).toBeGreaterThan(0);
    expect(outlineOne).toBeGreaterThan(0);

    for (let index = 0; index < 4; index += 1) {
      const more = await createClass(`Extra ${index}`);
      const lesson = await addLesson(`Lesson ${index}`, more.id);
      await connect(ali, more);
      await submit(ali, lesson.homeworkId, more.id);
      await submit(ali, (await addLesson(`Second ${index}`)).homeworkId);
    }

    await expect(countQueries('/api/v1/classes')).resolves.toBe(one);
    await expect(countQueries(`/api/v1/classes/${schoolClass.id}/outline`)).resolves.toBe(outlineOne);
  });
});
