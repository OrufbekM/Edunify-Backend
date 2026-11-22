import { Transaction } from 'sequelize';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { sequelize } from '../../db/index.js';
import { FileRecord, Lesson, SchoolClass } from '../../db/models/index.js';
import { resetRateLimits } from '../../middleware/rateLimit.js';
import { useTestDatabase } from '../../test/database.js';
import { firstUnitId } from '../../test/content.js';
import { addSubmission, isStored, storeFile, waitUntilBlocked } from '../../test/files.js';
import { api, createTestUser, type TestUser } from '../../test/users.js';

useTestDatabase();

afterEach(() => {
  vi.restoreAllMocks();
});

const PDF = Buffer.from('%PDF-1.7\nfile');

let teacher: TestUser;

// Named groups of files, so each test can say which must go and which must stay.
interface Fixture {
  classId: string;
  unitId: string;
  inUnit: string;
  inFirstUnit: string;
  rowA: string;
  rowB: string;
  files: Record<
    | 'inUnitFile'
    | 'inUnitInstructions'
    | 'inUnitPagesA'
    | 'inUnitPagesB'
    | 'inFirstUnitFile'
    | 'inFirstUnitPagesA'
    | 'otherClassFile',
    string[]
  >;
}

let fixture: Fixture;

async function createClass(): Promise<{ id: string; publicId: string }> {
  const category = await api(teacher).post('/api/v1/categories', { name: `C ${Math.random()}` });
  return (await api(teacher).post('/api/v1/classes', { categoryId: category.body.id, name: 'Maths' })).body;
}

// Without a unit, the lesson goes in the class's first unit.
async function addLesson(classId: string, title: string, unitId?: string): Promise<string> {
  const unit = unitId ?? (await firstUnitId(teacher, classId));
  return (await api(teacher).post(`/api/v1/classes/${classId}/lessons`, { title, unitId: unit })).body.id;
}

async function uploadLessonFile(classId: string, lessonId: string): Promise<string> {
  return (await api(teacher).upload(`/api/v1/lessons/${lessonId}/lesson-file?classId=${classId}`, PDF, 'lesson.pdf'))
    .body.lessonFile.id;
}

async function addHomework(classId: string, lessonId: string, withFile: boolean): Promise<string> {
  const { homework } = (await api(teacher).put(`/api/v1/lessons/${lessonId}/homework?classId=${classId}`, { type: 'photo' })).body;
  if (withFile) {
    await api(teacher).upload(`/api/v1/lessons/${lessonId}/homework/file?classId=${classId}`, PDF, 'task.pdf');
  }
  return homework.id;
}

async function linkStudent(classId: string, publicId: string): Promise<{ rowId: string; user: TestUser }> {
  const user = await createTestUser('student');
  const row = await api(teacher).post(`/api/v1/classes/${classId}/students`, {
    fullName: 'Student',
    studentPublicId: user.publicId,
  });
  await api(user).post('/api/v1/student/claims', { classPublicId: publicId });
  return { rowId: row.body.id, user };
}

async function pagesOf(homeworkId: string, classStudentId: string, ownerUserId: string, count: number) {
  const { pages } = await addSubmission({ homeworkId, classStudentId, ownerUserId, pages: count });
  return pages.map((page) => page.id);
}

// Every file of the named groups must be gone (row and bytes), and every other file kept.
async function expectOnlyRemoved(groups: (keyof Fixture['files'])[], keysBefore: Map<string, string>): Promise<void> {
  const removed = new Set(groups.flatMap((group) => fixture.files[group]));

  for (const [fileId, storageKey] of keysBefore) {
    const expected = !removed.has(fileId);
    expect([fileId, (await FileRecord.findByPk(fileId)) !== null]).toEqual([fileId, expected]);
    expect([fileId, await isStored(storageKey)]).toEqual([fileId, expected]);
  }
}

async function allKeys(): Promise<Map<string, string>> {
  const ids = Object.values(fixture.files).flat();
  const files = await FileRecord.findAll({ where: { id: ids } });
  expect(files).toHaveLength(ids.length);
  return new Map(files.map((file) => [file.id, file.storageKey]));
}

beforeEach(async () => {
  await resetRateLimits();
  teacher = await createTestUser('teacher');

  const schoolClass = await createClass();
  const unitId = (await api(teacher).post(`/api/v1/classes/${schoolClass.id}/units`, { title: 'Unit' })).body.id;
  const inUnit = await addLesson(schoolClass.id, 'In the unit', unitId);
  const inFirstUnit = await addLesson(schoolClass.id, 'In the first unit');
  const a = await linkStudent(schoolClass.id, schoolClass.publicId);
  const b = await linkStudent(schoolClass.id, schoolClass.publicId);

  const inUnitFile = await uploadLessonFile(schoolClass.id, inUnit);
  const inUnitHomework = await addHomework(schoolClass.id, inUnit, true);
  const inFirstUnitFile = await uploadLessonFile(schoolClass.id, inFirstUnit);
  const inFirstUnitHomework = await addHomework(schoolClass.id, inFirstUnit, false);
  const instructions = (await api(teacher).get(`/api/v1/lessons/${inUnit}?classId=${schoolClass.id}`)).body.homework
    .instructionsFile.id;

  const other = await createClass();
  const otherClassFile = await uploadLessonFile(other.id, await addLesson(other.id, 'Elsewhere'));

  fixture = {
    classId: schoolClass.id,
    unitId,
    inUnit,
    inFirstUnit,
    rowA: a.rowId,
    rowB: b.rowId,
    files: {
      inUnitFile: [inUnitFile],
      inUnitInstructions: [instructions],
      inUnitPagesA: await pagesOf(inUnitHomework, a.rowId, a.user.id, 2),
      inUnitPagesB: await pagesOf(inUnitHomework, b.rowId, b.user.id, 1),
      inFirstUnitFile: [inFirstUnitFile],
      inFirstUnitPagesA: await pagesOf(inFirstUnitHomework, a.rowId, a.user.id, 1),
      otherClassFile: [otherClassFile],
    },
  };
});

describe('deleting removes exactly the files it orphans, rows and bytes', () => {
  it('a class: every file in it, and nothing of another class', async () => {
    const keys = await allKeys();

    expect((await api(teacher).delete(`/api/v1/classes/${fixture.classId}`)).status).toBe(204);

    await expectOnlyRemoved(
      ['inUnitFile', 'inUnitInstructions', 'inUnitPagesA', 'inUnitPagesB', 'inFirstUnitFile', 'inFirstUnitPagesA'],
      keys,
    );
  });

  it("a roster row: that student's pages only", async () => {
    const keys = await allKeys();

    expect((await api(teacher).delete(`/api/v1/classes/${fixture.classId}/students/${fixture.rowA}`)).status).toBe(204);

    await expectOnlyRemoved(['inUnitPagesA', 'inFirstUnitPagesA'], keys);
  });

  it('a unit: the files of its lessons', async () => {
    const keys = await allKeys();

    expect((await api(teacher).delete(`/api/v1/units/${fixture.unitId}?classId=${fixture.classId}`)).status).toBe(204);

    await expectOnlyRemoved(['inUnitFile', 'inUnitInstructions', 'inUnitPagesA', 'inUnitPagesB'], keys);
  });

  it('a lesson: its file and its pages', async () => {
    const keys = await allKeys();

    expect((await api(teacher).delete(`/api/v1/lessons/${fixture.inFirstUnit}?classId=${fixture.classId}`)).status).toBe(204);

    await expectOnlyRemoved(['inFirstUnitFile', 'inFirstUnitPagesA'], keys);
  });

  it('a homework: its instructions and pages, not the lesson file', async () => {
    const keys = await allKeys();

    expect((await api(teacher).delete(`/api/v1/lessons/${fixture.inUnit}/homework?classId=${fixture.classId}`)).status).toBe(200);

    await expectOnlyRemoved(['inUnitInstructions', 'inUnitPagesA', 'inUnitPagesB'], keys);
  });

  it('keeps every file when the delete fails', async () => {
    const keys = await allKeys();
    vi.spyOn(SchoolClass.prototype, 'destroy').mockRejectedValueOnce(new Error('disk on fire'));

    expect((await api(teacher).delete(`/api/v1/classes/${fixture.classId}`)).status).toBe(500);

    await expectOnlyRemoved([], keys);
  });
});

describe('a delete waits for a file that is being attached, then removes it too', () => {
  // Opens a transaction that does what an upload or a submission does, and keeps it open.
  async function holdOpen(work: (transaction: Transaction) => Promise<FileRecord[]>) {
    const transaction = await sequelize.transaction();
    try {
      return { transaction, files: await work(transaction) };
    } catch (err) {
      await transaction.rollback();
      throw err;
    }
  }

  async function expectAllRemoved(files: FileRecord[]): Promise<void> {
    for (const file of files) {
      await expect(FileRecord.findByPk(file.id)).resolves.toBeNull();
      await expect(isStored(file.storageKey)).resolves.toBe(false);
    }
  }

  it('a class delete and a lesson file being replaced', async () => {
    const { transaction, files } = await holdOpen(async (t) => {
      await Lesson.findByPk(fixture.inUnit, { lock: Transaction.LOCK.NO_KEY_UPDATE, transaction: t });
      const file = await storeFile(teacher.id, 'lesson', { transaction: t });
      await Lesson.update({ lessonFileId: file.id }, { where: { id: fixture.inUnit }, transaction: t });
      return [file];
    });
    const deleting = api(teacher).delete(`/api/v1/classes/${fixture.classId}`).then((res) => res);

    await waitUntilBlocked();
    await transaction.commit();

    expect((await deleting).status).toBe(204);
    await expectAllRemoved(files);
  });

  it('a roster row delete and a submission being saved', async () => {
    const homeworkId = (await api(teacher).get(`/api/v1/lessons/${fixture.inUnit}?classId=${fixture.classId}`)).body.homework.id;
    const { transaction, files } = await holdOpen(async (t) => {
      const { pages } = await addSubmission({
        homeworkId,
        classStudentId: fixture.rowA,
        ownerUserId: teacher.id,
        pages: 2,
        version: 2,
        transaction: t,
      });
      return pages;
    });
    const deleting = api(teacher)
      .delete(`/api/v1/classes/${fixture.classId}/students/${fixture.rowA}`)
      .then((res) => res);

    await waitUntilBlocked();
    await transaction.commit();

    expect((await deleting).status).toBe(204);
    await expectAllRemoved(files);
  });

  it('a lesson delete and a submission being saved', async () => {
    const homeworkId = (await api(teacher).get(`/api/v1/lessons/${fixture.inFirstUnit}?classId=${fixture.classId}`)).body.homework.id;
    const { transaction, files } = await holdOpen(async (t) => {
      const { pages } = await addSubmission({
        homeworkId,
        classStudentId: fixture.rowB,
        ownerUserId: teacher.id,
        pages: 1,
        transaction: t,
      });
      return pages;
    });
    const deleting = api(teacher).delete(`/api/v1/lessons/${fixture.inFirstUnit}?classId=${fixture.classId}`).then((res) => res);

    await waitUntilBlocked();
    await transaction.commit();

    expect((await deleting).status).toBe(204);
    await expectAllRemoved(files);
  });

  it('a homework delete and a submission being saved', async () => {
    const homeworkId = (await api(teacher).get(`/api/v1/lessons/${fixture.inFirstUnit}?classId=${fixture.classId}`)).body.homework.id;
    const { transaction, files } = await holdOpen(async (t) => {
      const { pages } = await addSubmission({
        homeworkId,
        classStudentId: fixture.rowB,
        ownerUserId: teacher.id,
        pages: 1,
        transaction: t,
      });
      return pages;
    });
    const deleting = api(teacher).delete(`/api/v1/lessons/${fixture.inFirstUnit}/homework?classId=${fixture.classId}`).then((res) => res);

    await waitUntilBlocked();
    await transaction.commit();

    expect((await deleting).status).toBe(200);
    await expectAllRemoved(files);
  });
});
