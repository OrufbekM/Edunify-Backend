import { randomUUID } from 'node:crypto';

import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { app } from '../../app.js';
import { sequelize } from '../../db/index.js';
import { ClassStudent, Homework, Lesson, Submission, Unit } from '../../db/models/index.js';
import { resetRateLimits } from '../../middleware/rateLimit.js';
import { useTestDatabase } from '../../test/database.js';
import { api, createTestUser, type TestUser } from '../../test/users.js';

useTestDatabase();

afterEach(() => {
  vi.restoreAllMocks();
});

type Grade = number | 'denied' | null;
interface SchoolClass {
  id: string;
  publicId: string;
}

let teacher: TestUser;
let student: TestUser;
let schoolClass: SchoolClass;
let rowId: string;

async function createClass(subject = 'Maths', owner = teacher, name: string | null = '7A'): Promise<SchoolClass> {
  const category = await api(owner).post('/api/v1/categories', { name: `C ${randomUUID()}` });
  return (await api(owner).post('/api/v1/classes', { categoryId: category.body.id, subject, name })).body;
}

async function addRow(fullName: string, account?: TestUser, claim = true, forClass = schoolClass): Promise<string> {
  const row = await api(teacher).post(`/api/v1/classes/${forClass.id}/students`, {
    fullName,
    ...(account ? { studentPublicId: account.publicId } : {}),
  });
  if (account && claim) {
    await api(account).post('/api/v1/student/claims', { classPublicId: forClass.publicId });
  }
  return row.body.id as string;
}

async function addUnit(title: string, forClass = schoolClass): Promise<string> {
  return (await api(teacher).post(`/api/v1/classes/${forClass.id}/units`, { title })).body.id;
}

// A lesson, with text homework unless `homework` is false.
async function addLesson(
  title: string,
  options: { unitId?: string; homework?: boolean; forClass?: SchoolClass } = {},
): Promise<{ lessonId: string; homeworkId: string }> {
  const forClass = options.forClass ?? schoolClass;
  const lessonId = (
    await api(teacher).post(`/api/v1/classes/${forClass.id}/lessons`, {
      title,
      ...(options.unitId ? { unitId: options.unitId } : {}),
    })
  ).body.id as string;

  if (options.homework === false) {
    return { lessonId, homeworkId: '' };
  }

  const lesson = await api(teacher).put(`/api/v1/lessons/${lessonId}/homework`, { type: 'text' });
  return { lessonId, homeworkId: lesson.body.homework.id as string };
}

// A version written straight to the database: a grade value, a denial, or still submitted.
function addVersion(homeworkId: string, classStudentId: string, version: number, grade: Grade) {
  return Submission.create({
    homeworkId,
    classStudentId,
    version,
    status: grade === null ? 'submitted' : grade === 'denied' ? 'denied' : 'graded',
    content: { text: `v${version}` },
    gradeValue: typeof grade === 'number' ? grade : null,
    gradeDenied: grade === 'denied',
    gradeComment: grade === 'denied' ? 'Redo' : null,
    gradeSource: grade === null ? null : 'teacher',
    gradedAt: grade === null ? null : new Date(),
    aiSuggestion: null,
  });
}

const journalPath = (classId = schoolClass.id) => `/api/v1/classes/${classId}/journal`;

async function journal(user = teacher, classId = schoolClass.id) {
  const res = await api(user).get(journalPath(classId));
  expect(res.status).toBe(200);
  return res.body;
}

async function grades(user = student) {
  const res = await api(user).get('/api/v1/student/grades');
  expect(res.status).toBe(200);
  return res.body.items as Array<Record<string, unknown>>;
}

function expectError(res: request.Response, status: number, code: string): void {
  expect(res.status).toBe(status);
  expect(res.body.error.code).toBe(code);
}

beforeEach(async () => {
  await resetRateLimits();
  teacher = await createTestUser('teacher', 'Ms Teacher');
  student = await createTestUser('student');
  schoolClass = await createClass();
  rowId = await addRow('Ali Valiyev', student);
});

describe('GET /classes/:classId/journal', () => {
  it('lists every unit and, as columns, only lessons with homework in display order', async () => {
    const first = await addUnit('First');
    const second = await addUnit('Second');
    const empty = await addUnit('Empty');
    await api(teacher).patch(`/api/v1/units/${second}`, { order: 0 });
    const f1 = await addLesson('f1', { unitId: first });
    await addLesson('f2 (no homework)', { unitId: first, homework: false });
    const f3 = await addLesson('f3', { unitId: first });
    const s1 = await addLesson('s1', { unitId: second });
    const n1 = await addLesson('n1');
    await addLesson('e1 (no homework)', { unitId: empty, homework: false });
    const n2 = await addLesson('n2');
    await api(teacher).patch(`/api/v1/lessons/${n2.lessonId}`, { order: 0 });

    const body = await journal();

    expect(body.units).toEqual([
      { id: second, classId: schoolClass.id, title: 'Second', order: 0 },
      { id: first, classId: schoolClass.id, title: 'First', order: 1 },
      { id: empty, classId: schoolClass.id, title: 'Empty', order: 2 },
    ]);
    expect(body.columns).toEqual([
      { lessonId: n2.lessonId, title: 'n2', unitId: null },
      { lessonId: n1.lessonId, title: 'n1', unitId: null },
      { lessonId: s1.lessonId, title: 's1', unitId: second },
      { lessonId: f1.lessonId, title: 'f1', unitId: first },
      { lessonId: f3.lessonId, title: 'f3', unitId: first },
    ]);
  });

  it('orders the unit groups by unit order, whatever their ids', async () => {
    const [one, two] = [await addUnit('One'), await addUnit('Two')];
    // Puts the unit with the smaller id last, so that id order and unit order disagree.
    const [low, high] = one < two ? [one, two] : [two, one];
    await api(teacher).patch(`/api/v1/units/${low}`, { order: 1 });
    const inLow = await addLesson('in low', { unitId: low });
    const inHigh = await addLesson('in high', { unitId: high });

    const { columns } = await journal();

    expect(columns.map((column: { lessonId: string }) => column.lessonId)).toEqual([inHigh.lessonId, inLow.lessonId]);
  });

  it('gives every roster row, sorted by name, with its linkState and empty cells', async () => {
    const awaiting = await createTestUser('student');
    const zRow = await addRow('Zara', awaiting, false);
    const bRow = await addRow('bobur');
    const { lessonId } = await addLesson('L');

    await expect(journal()).resolves.toEqual({
      units: [],
      columns: [{ lessonId, title: 'L', unitId: null }],
      rows: [
        {
          classStudentId: rowId,
          fullName: 'Ali Valiyev',
          linkState: 'active',
          cells: [{ lessonId, status: 'empty', value: null, submissionId: null }],
          average: null,
        },
        {
          classStudentId: bRow,
          fullName: 'bobur',
          linkState: 'no_id',
          cells: [{ lessonId, status: 'empty', value: null, submissionId: null }],
          average: null,
        },
        {
          classStudentId: zRow,
          fullName: 'Zara',
          linkState: 'awaiting_student',
          cells: [{ lessonId, status: 'empty', value: null, submissionId: null }],
          average: null,
        },
      ],
    });
  });

  it('fills each cell from the latest version: submitted, denied, graded or empty', async () => {
    const a = await addLesson('A');
    const b = await addLesson('B');
    const c = await addLesson('C');
    const d = await addLesson('D');
    await addVersion(a.homeworkId, rowId, 1, 5);
    const aLatest = await addVersion(a.homeworkId, rowId, 2, null);
    const bLatest = await addVersion(b.homeworkId, rowId, 1, 3);
    const cLatest = await addVersion(c.homeworkId, rowId, 1, 'denied');

    const [row] = (await journal()).rows;

    expect(row.cells).toEqual([
      { lessonId: a.lessonId, status: 'submitted', value: null, submissionId: aLatest.id },
      { lessonId: b.lessonId, status: 'graded', value: 3, submissionId: bLatest.id },
      { lessonId: c.lessonId, status: 'denied', value: null, submissionId: cLatest.id },
      { lessonId: d.lessonId, status: 'empty', value: null, submissionId: null },
    ]);
    // Only the latest graded value counts: the 5 on version 1 of A doesn't.
    expect(row.average).toBe(3);
  });

  it('averages graded cells to 2 decimals as a number, leaving denied and empty ones out', async () => {
    const [a, b, c, d] = [await addLesson('A'), await addLesson('B'), await addLesson('C'), await addLesson('D')];
    await addVersion(a.homeworkId, rowId, 1, 3);
    await addVersion(b.homeworkId, rowId, 1, 4);
    await addVersion(c.homeworkId, rowId, 1, 4);
    await addVersion(d.homeworkId, rowId, 1, 'denied');
    const halves = await addRow('Bek');
    await addVersion(a.homeworkId, halves, 1, 2);
    await addVersion(b.homeworkId, halves, 1, 3);

    const { rows } = await journal();

    expect(rows.map((row: { average: unknown }) => row.average)).toEqual([3.67, 2.5]);
  });

  it('gives a null average when every cell is denied or still submitted', async () => {
    const [a, b] = [await addLesson('A'), await addLesson('B')];
    await addVersion(a.homeworkId, rowId, 1, 'denied');
    await addVersion(b.homeworkId, rowId, 1, 'denied');
    const waiting = await addRow('Bek');
    await addVersion(a.homeworkId, waiting, 1, null);

    const { rows } = await journal();

    expect(rows.map((row: { average: unknown }) => row.average)).toEqual([null, null]);
  });

  it('gives a class without lessons empty columns and cells', async () => {
    await expect(journal()).resolves.toEqual({
      units: [],
      columns: [],
      rows: [{ classStudentId: rowId, fullName: 'Ali Valiyev', linkState: 'active', cells: [], average: null }],
    });
  });

  it('reads units, columns and rows from one snapshot', async () => {
    const { homeworkId } = await addLesson('Before');
    await addVersion(homeworkId, rowId, 1, 4);

    // Commits, from another connection right after the units are read, a new homework
    // with a grade, a new roster row, and a better grade on the first homework.
    Unit.addHook('afterFind', 'commitAfterUnits', async () => {
      Unit.removeHook('afterFind', 'commitAfterUnits');
      const lesson = await Lesson.create({ classId: schoolClass.id, unitId: null, title: 'Late', position: 1, lessonFileId: null });
      const late = await Homework.create({ lessonId: lesson.id, type: 'text', instructionsText: null, instructionsFileId: null });
      await addVersion(late.id, rowId, 1, 2);
      await addVersion(homeworkId, rowId, 2, 5);
      await ClassStudent.create({ classId: schoolClass.id, fullName: 'Late Row', studentUserId: null });
    });

    try {
      const body = await journal();

      expect(body.columns.map((column: { title: string }) => column.title)).toEqual(['Before']);
      expect(body.rows).toEqual([expect.objectContaining({ fullName: 'Ali Valiyev', average: 4 })]);
      expect(body.rows[0].cells).toEqual([expect.objectContaining({ status: 'graded', value: 4 })]);
    } finally {
      Unit.removeHook('afterFind', 'commitAfterUnits');
    }

    expect((await journal()).columns).toHaveLength(2);
  });

  it("gives another teacher's class the same 404 as a missing one", async () => {
    const other = await createTestUser('teacher');

    const foreign = await api(other).get(journalPath());

    expectError(foreign, 404, 'NOT_FOUND');
    expect(foreign.body).toEqual((await api(other).get(journalPath(randomUUID()))).body);
  });

  it('refuses students, anonymous callers, a malformed id and query parameters', async () => {
    expectError(await api(student).get(journalPath()), 403, 'FORBIDDEN');
    expectError(await request(app).get(journalPath()), 401, 'UNAUTHENTICATED');
    expectError(await api(teacher).get(journalPath('nope')), 400, 'VALIDATION_ERROR');
    expectError(await api(teacher).get(`${journalPath()}?unit=1`), 400, 'VALIDATION_ERROR');
  });
});

describe('GET /student/grades', () => {
  it('gives one item per class with an active link, sorted by subject, with only their own cells', async () => {
    const biology = await createClass('biology', teacher, null);
    const chemistry = await createClass('Chemistry');
    const art = await createClass('Art');
    const bioRow = await addRow('Ali V.', student, true, biology);
    await addRow('Ali', student, false, chemistry);
    await api(student).post('/api/v1/student/claims', { classPublicId: art.publicId });
    const { lessonId, homeworkId } = await addLesson('Cells', { forClass: biology });
    const graded = await addVersion(homeworkId, bioRow, 1, 5);
    const classmate = await addRow('Classmate', undefined, true, biology);
    await addVersion(homeworkId, classmate, 1, 2);

    await expect(grades()).resolves.toEqual([
      {
        class: { id: biology.id, subject: 'biology', name: null },
        columns: [{ lessonId, title: 'Cells', unitId: null }],
        cells: [{ lessonId, status: 'graded', value: 5, submissionId: graded.id }],
        average: 5,
      },
      {
        class: { id: schoolClass.id, subject: 'Maths', name: '7A' },
        columns: [],
        cells: [],
        average: null,
      },
    ]);
  });

  it('uses the same columns, cells and average rules as the journal', async () => {
    const unit = await addUnit('U');
    const inUnit = await addLesson('In unit', { unitId: unit });
    const loose = await addLesson('Loose');
    await addLesson('No homework', { homework: false });
    await addVersion(inUnit.homeworkId, rowId, 1, 3);
    await addVersion(loose.homeworkId, rowId, 1, 4);
    await addVersion(loose.homeworkId, rowId, 2, 'denied');

    const [item] = await grades();
    const [journalRow] = (await journal()).rows;

    expect(item).toMatchObject({
      columns: [
        { lessonId: loose.lessonId, title: 'Loose', unitId: null },
        { lessonId: inUnit.lessonId, title: 'In unit', unitId: unit },
      ],
      cells: journalRow.cells,
      average: 3,
    });
  });

  it('drops a class once the row is re-linked to another account', async () => {
    const newAccount = await createTestUser('student');

    await api(teacher).patch(`/api/v1/classes/${schoolClass.id}/students/${rowId}`, {
      studentPublicId: newAccount.publicId,
    });

    await expect(grades()).resolves.toEqual([]);
  });

  it('reads the classes and their cells from one snapshot', async () => {
    const { homeworkId } = await addLesson('Before');
    await addVersion(homeworkId, rowId, 1, 4);
    const realQuery = sequelize.query.bind(sequelize) as (...args: unknown[]) => Promise<unknown>;
    let committed = false;

    // Right after the class list is read, commits a better grade from another connection.
    vi.spyOn(sequelize, 'query').mockImplementation((async (...args: unknown[]) => {
      const result = await realQuery(...args);
      if (!committed && String(args[0]).includes('"teacherName"')) {
        committed = true;
        await addVersion(homeworkId, rowId, 2, 5);
      }
      return result;
    }) as never);

    const [item] = await grades();

    expect(committed).toBe(true);
    expect(item).toMatchObject({ cells: [expect.objectContaining({ value: 4 })], average: 4 });
  });

  it('refuses teachers, anonymous callers and query parameters', async () => {
    expectError(await api(teacher).get('/api/v1/student/grades'), 403, 'FORBIDDEN');
    expectError(await request(app).get('/api/v1/student/grades'), 401, 'UNAUTHENTICATED');
    expectError(await api(student).get('/api/v1/student/grades?classId=x'), 400, 'VALIDATION_ERROR');
  });
});
