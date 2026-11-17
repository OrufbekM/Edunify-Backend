import { randomUUID } from 'node:crypto';

import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { app } from '../../app.js';
import { sequelize } from '../../db/index.js';
import { ClassLesson, ClassStudent, Homework, Lesson, Submission } from '../../db/models/index.js';
import { resetRateLimits } from '../../middleware/rateLimit.js';
import { useTestDatabase } from '../../test/database.js';
import { firstUnitId } from '../../test/content.js';
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

async function createClass(name = 'Maths 7A', owner = teacher): Promise<SchoolClass> {
  const category = await api(owner).post('/api/v1/categories', { name: `C ${randomUUID()}` });
  return (await api(owner).post('/api/v1/classes', { categoryId: category.body.id, name })).body;
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

// A lesson, with text homework unless `homework` is false; in the class's first unit unless
// `unitId` says otherwise.
async function addLesson(
  title: string,
  options: { unitId?: string; homework?: boolean; forClass?: SchoolClass } = {},
): Promise<{ lessonId: string; homeworkId: string }> {
  const forClass = options.forClass ?? schoolClass;
  const unitId = options.unitId ?? (await firstUnitId(teacher, forClass.id));
  const lessonId = (await api(teacher).post(`/api/v1/classes/${forClass.id}/lessons`, { title, unitId })).body
    .id as string;

  if (options.homework === false) {
    return { lessonId, homeworkId: '' };
  }

  const lesson = await api(teacher).put(`/api/v1/lessons/${lessonId}/homework?classId=${forClass.id}`, { type: 'text' });
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
  it('lists every unit and, as columns, only lessons with homework in outline order, numbered', async () => {
    const unit1 = await firstUnitId(teacher, schoolClass.id);
    const first = await addUnit('First');
    const second = await addUnit('Second');
    const empty = await addUnit('Empty');
    await api(teacher).patch(`/api/v1/units/${second}?classId=${schoolClass.id}`, { order: 0 });
    const f1 = await addLesson('f1', { unitId: first });
    await addLesson('f2 (no homework)', { unitId: first, homework: false });
    const f3 = await addLesson('f3', { unitId: first });
    const s1 = await addLesson('s1', { unitId: second });
    const n1 = await addLesson('n1', { unitId: unit1 });
    await addLesson('e1 (no homework)', { unitId: empty, homework: false });
    const n2 = await addLesson('n2', { unitId: unit1 });
    await api(teacher).patch(`/api/v1/lessons/${n2.lessonId}?classId=${schoolClass.id}`, { order: 0 });

    const body = await journal();

    expect(body.units).toEqual([
      { id: second, classId: schoolClass.id, title: 'Second', order: 0 },
      { id: unit1, classId: schoolClass.id, title: 'Unit 1', order: 1 },
      { id: first, classId: schoolClass.id, title: 'First', order: 2 },
      { id: empty, classId: schoolClass.id, title: 'Empty', order: 3 },
    ]);
    // Numbers count every lesson, so f2 (no homework, no column) leaves a gap at 5.
    expect(body.columns).toEqual([
      { lessonId: s1.lessonId, number: 1, title: 's1', unitId: second },
      { lessonId: n2.lessonId, number: 2, title: 'n2', unitId: unit1 },
      { lessonId: n1.lessonId, number: 3, title: 'n1', unitId: unit1 },
      { lessonId: f1.lessonId, number: 4, title: 'f1', unitId: first },
      { lessonId: f3.lessonId, number: 6, title: 'f3', unitId: first },
    ]);
  });

  it('keeps hidden lessons, with their numbers', async () => {
    const a = await addLesson('A');
    const b = await addLesson('B');
    await api(teacher).patch(`/api/v1/lessons/${a.lessonId}?classId=${schoolClass.id}`, { visible: false });

    const { columns } = await journal();

    expect(columns.map((column: { lessonId: string; number: number }) => [column.lessonId, column.number])).toEqual([
      [a.lessonId, 1],
      [b.lessonId, 2],
    ]);
  });

  it('orders the unit groups by unit order, whatever their ids', async () => {
    const [one, two] = [await addUnit('One'), await addUnit('Two')];
    // Puts the unit with the smaller id last, so that id order and unit order disagree.
    const [low, high] = one < two ? [one, two] : [two, one];
    await api(teacher).patch(`/api/v1/units/${low}?classId=${schoolClass.id}`, { order: 2 });
    const inLow = await addLesson('in low', { unitId: low });
    const inHigh = await addLesson('in high', { unitId: high });

    const { columns } = await journal();

    expect(columns.map((column: { lessonId: string }) => column.lessonId)).toEqual([inHigh.lessonId, inLow.lessonId]);
  });

  it('gives every roster row, sorted by name, with its connectionState and empty cells', async () => {
    const awaiting = await createTestUser('student');
    const zRow = await addRow('Zara', awaiting, false);
    const bRow = await addRow('bobur');
    const { lessonId } = await addLesson('L');
    const unit1 = await firstUnitId(teacher, schoolClass.id);

    await expect(journal()).resolves.toEqual({
      units: [{ id: unit1, classId: schoolClass.id, title: 'Unit 1', order: 0 }],
      columns: [{ lessonId, number: 1, title: 'L', unitId: unit1 }],
      rows: [
        {
          classStudentId: rowId,
          fullName: 'Ali Valiyev',
          connectionState: 'connected',
          cells: [{ lessonId, status: 'empty', value: null, submissionId: null }],
          average: null,
        },
        {
          classStudentId: bRow,
          fullName: 'bobur',
          connectionState: 'not_connected',
          cells: [{ lessonId, status: 'empty', value: null, submissionId: null }],
          average: null,
        },
        {
          classStudentId: zRow,
          fullName: 'Zara',
          connectionState: 'awaiting_student',
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
      units: [{ id: await firstUnitId(teacher, schoolClass.id), classId: schoolClass.id, title: 'Unit 1', order: 0 }],
      columns: [],
      rows: [{ classStudentId: rowId, fullName: 'Ali Valiyev', connectionState: 'connected', cells: [], average: null }],
    });
  });

  it('reads units, columns and rows from one snapshot', async () => {
    const { homeworkId } = await addLesson('Before');
    await addVersion(homeworkId, rowId, 1, 4);

    const unitId = await firstUnitId(teacher, schoolClass.id);
    const realQuery = sequelize.query.bind(sequelize) as (...args: unknown[]) => Promise<unknown>;
    let committed = false;

    // Commits, from another connection right after the units are read, a new homework
    // with a grade, a new roster row, and a better grade on the first homework.
    vi.spyOn(sequelize, 'query').mockImplementation((async (...args: unknown[]) => {
      const result = await realQuery(...args);
      if (!committed && String(args[0]).includes('FROM class_units')) {
        committed = true;
        const lesson = await Lesson.create({ classId: schoolClass.id, groupId: null, unitId, title: 'Late', position: null, lessonFileId: null });
        await ClassLesson.create({ classId: schoolClass.id, lessonId: lesson.id, position: 1 });
        const late = await Homework.create({ lessonId: lesson.id, type: 'text', instructionsText: null, instructionsFileId: null });
        await addVersion(late.id, rowId, 1, 2);
        await addVersion(homeworkId, rowId, 2, 5);
        await ClassStudent.create({ classId: schoolClass.id, fullName: 'Late Row', studentUserId: null });
      }
      return result;
    }) as never);

    const body = await journal();

    expect(committed).toBe(true);
    expect(body.columns.map((column: { title: string }) => column.title)).toEqual(['Before']);
    expect(body.rows).toEqual([expect.objectContaining({ fullName: 'Ali Valiyev', average: 4 })]);
    expect(body.rows[0].cells).toEqual([expect.objectContaining({ status: 'graded', value: 4 })]);
    vi.restoreAllMocks();

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
  it('gives one item per connected class, sorted by name, with only their own cells', async () => {
    const biology = await createClass('biology');
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
        class: { id: biology.id, name: 'biology' },
        columns: [{ lessonId, number: 1, title: 'Cells', unitId: await firstUnitId(teacher, biology.id) }],
        cells: [{ lessonId, status: 'graded', value: 5, submissionId: graded.id }],
        average: 5,
      },
      {
        class: { id: schoolClass.id, name: 'Maths 7A' },
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
        { lessonId: loose.lessonId, number: 1, title: 'Loose', unitId: await firstUnitId(teacher, schoolClass.id) },
        { lessonId: inUnit.lessonId, number: 3, title: 'In unit', unitId: unit },
      ],
      cells: journalRow.cells,
      average: 3,
    });
  });

  it('leaves out lessons hidden in the class, their marks included, until they are shown again', async () => {
    const first = await addLesson('First');
    const hidden = await addLesson('Hidden');
    const third = await addLesson('Third');
    await addVersion(hidden.homeworkId, rowId, 1, 2);
    await addVersion(third.homeworkId, rowId, 1, 5);
    const show = (visible: boolean) =>
      api(teacher).patch(`/api/v1/lessons/${hidden.lessonId}?classId=${schoolClass.id}`, { visible });
    const summary = async () => {
      const [item] = (await grades()) as Array<{
        columns: Array<{ title: string; number: number }>;
        cells: Array<{ lessonId: string }>;
        average: number | null;
      }>;
      return {
        columns: item?.columns.map((column) => [column.title, column.number]),
        cells: item?.cells.map((cell) => cell.lessonId),
        average: item?.average,
      };
    };

    await show(false);

    // The 2 on the hidden lesson would make the average 3.5.
    await expect(summary()).resolves.toEqual({
      columns: [
        ['First', 1],
        ['Third', 3],
      ],
      cells: [first.lessonId, third.lessonId],
      average: 5,
    });
    expect((await journal()).rows[0].average).toBe(3.5);

    await show(true);

    await expect(summary()).resolves.toEqual({
      columns: [
        ['First', 1],
        ['Hidden', 2],
        ['Third', 3],
      ],
      cells: [first.lessonId, hidden.lessonId, third.lessonId],
      average: 3.5,
    });
  });

  it('gives a null average when the only grades are on hidden lessons', async () => {
    const hidden = await addLesson('Hidden');
    await addVersion(hidden.homeworkId, rowId, 1, 4);
    await api(teacher).patch(`/api/v1/lessons/${hidden.lessonId}?classId=${schoolClass.id}`, { visible: false });

    const [item] = await grades();

    expect(item).toMatchObject({ columns: [], cells: [], average: null });
  });

  it('drops a class once the row is reconnected to another account', async () => {
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

// Contract 4.1: one number per lesson in a class, computed on read by the same outline
// function everywhere, so no two views can disagree.
describe('lesson numbers', () => {
  it('are the same in the outline, the lesson page, the journal and the grades, for the teacher and the student', async () => {
    const second = await addUnit('Second');
    const a = await addLesson('A');
    const b = await addLesson('B', { homework: false });
    const c = await addLesson('C');
    const d = await addLesson('D', { unitId: second });
    const lessonUrl = (lessonId: string) => `/api/v1/lessons/${lessonId}?classId=${schoolClass.id}`;
    // B, A, C (hidden) in the first unit, then D: 1, 2, 3, 4.
    expect((await api(teacher).patch(lessonUrl(a.lessonId), { order: 1 })).status).toBe(200);
    expect((await api(teacher).patch(lessonUrl(c.lessonId), { visible: false })).status).toBe(200);
    const everyLesson = { [b.lessonId]: 1, [a.lessonId]: 2, [c.lessonId]: 3, [d.lessonId]: 4 };
    const visible = { [b.lessonId]: 1, [a.lessonId]: 2, [d.lessonId]: 4 };
    type Numbered = { id?: string; lessonId?: string; number: number };
    const numbers = (items: Numbered[]) => Object.fromEntries(items.map((item) => [item.id ?? item.lessonId, item.number]));
    const outlineOf = async (user: TestUser) =>
      (await api(user).get(`/api/v1/classes/${schoolClass.id}/outline`)).body.lessons as Numbered[];
    const pageNumbers = async (user: TestUser, lessonIds: string[]) => {
      const pages = await Promise.all(lessonIds.map((lessonId) => api(user).get(lessonUrl(lessonId))));
      return Object.fromEntries(pages.map((page, index) => [lessonIds[index], page.body.number]));
    };

    expect(numbers(await outlineOf(teacher))).toEqual(everyLesson);
    expect(await pageNumbers(teacher, Object.keys(everyLesson))).toEqual(everyLesson);
    expect(numbers((await journal()).columns)).toEqual({ [a.lessonId]: 2, [c.lessonId]: 3, [d.lessonId]: 4 });

    expect(numbers(await outlineOf(student))).toEqual(visible);
    expect(await pageNumbers(student, Object.keys(visible))).toEqual(visible);
    const [item] = (await grades()) as Array<{ columns: Numbered[] }>;
    expect(numbers(item?.columns ?? [])).toEqual({ [a.lessonId]: 2, [d.lessonId]: 4 });
  });
});
