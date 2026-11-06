import { randomUUID } from 'node:crypto';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { sequelize } from '../../db/index.js';
import { FileRecord, User } from '../../db/models/index.js';
import { logger } from '../../lib/logger.js';
import { storage } from '../../storage/index.js';
import { StorageNotFoundError } from '../../storage/provider.js';
import { useTestDatabase } from '../../test/database.js';
import { deleteFileRows, removeStoredFiles, withStoredFiles } from './service.js';

useTestDatabase();

afterEach(() => {
  vi.restoreAllMocks();
});

async function createFile(): Promise<FileRecord> {
  const owner = await User.create({
    role: 'teacher',
    fullName: 'Teacher',
    email: `${randomUUID()}@example.com`,
    passwordHash: 'hash',
    publicId: null,
  });

  return FileRecord.create({
    ownerUserId: owner.id,
    kind: 'lesson',
    originalName: 'notes.md',
    mime: 'text/markdown',
    size: 4,
    storageKey: await storage.put(Buffer.from('data')),
  });
}

function expectStored(key: string) {
  return expect(storage.get(key)).resolves.toEqual(Buffer.from('data'));
}

function expectNotStored(key: string) {
  return expect(storage.get(key)).rejects.toBeInstanceOf(StorageNotFoundError);
}

describe('deleteFileRows', () => {
  it('deletes the rows and returns their storage keys, leaving the bytes for later', async () => {
    const file = await createFile();

    const keys = await sequelize.transaction((transaction) =>
      deleteFileRows([file.id], transaction),
    );

    expect(keys).toEqual([file.storageKey]);
    await expect(FileRecord.count()).resolves.toBe(0);
    await expectStored(file.storageKey);
  });

  it('touches only the files it is given', async () => {
    const [doomed, kept] = [await createFile(), await createFile()];

    await sequelize.transaction((transaction) => deleteFileRows([doomed.id], transaction));

    await expect(FileRecord.findByPk(doomed.id)).resolves.toBeNull();
    await expect(FileRecord.findByPk(kept.id)).resolves.not.toBeNull();
  });

  it('keeps the row when the transaction rolls back', async () => {
    const file = await createFile();

    const failing = sequelize.transaction(async (transaction) => {
      await deleteFileRows([file.id], transaction);
      throw new Error('rolled back');
    });

    await expect(failing).rejects.toThrow('rolled back');
    await expect(FileRecord.findByPk(file.id)).resolves.not.toBeNull();
    await expectStored(file.storageKey);
  });

  it('does nothing for an empty list', async () => {
    const file = await createFile();

    const keys = await sequelize.transaction((transaction) => deleteFileRows([], transaction));

    expect(keys).toEqual([]);
    await expect(FileRecord.findByPk(file.id)).resolves.not.toBeNull();
  });
});

describe('removeStoredFiles', () => {
  it('deletes the stored bytes', async () => {
    const key = await storage.put(Buffer.from('data'));

    await removeStoredFiles([key]);

    await expectNotStored(key);
  });

  it('logs a failure, carries on, and never rejects', async () => {
    const [broken, fine] = [
      await storage.put(Buffer.from('data')),
      await storage.put(Buffer.from('data')),
    ];
    const error = vi.spyOn(logger, 'error');
    const failure = new Error('disk gone');
    const realDelete = storage.delete.bind(storage);
    vi.spyOn(storage, 'delete').mockImplementation((key) =>
      key === broken ? Promise.reject(failure) : realDelete(key),
    );

    await expect(removeStoredFiles([broken, fine])).resolves.toBeUndefined();

    await expectNotStored(fine);
    await expectStored(broken);
    expect(error).toHaveBeenCalledOnce();
    expect(error).toHaveBeenCalledWith(
      { err: failure, storageKey: broken },
      'Could not delete a stored file',
    );
  });
});

describe('withStoredFiles', () => {
  it('passes the keys to the work and keeps the files when it succeeds', async () => {
    const seen: string[] = [];

    const result = await withStoredFiles([Buffer.from('data'), Buffer.from('data')], async (keys) => {
      seen.push(...keys);
      return 'done';
    });

    expect(result).toBe('done');
    expect(seen).toHaveLength(2);
    await expectStored(seen[0] ?? '');
    await expectStored(seen[1] ?? '');
  });

  it('removes what it wrote when the work fails', async () => {
    const seen: string[] = [];

    const failing = withStoredFiles([Buffer.from('data')], async (keys) => {
      seen.push(...keys);
      throw new Error('transaction failed');
    });

    await expect(failing).rejects.toThrow('transaction failed');
    await expectNotStored(seen[0] ?? '');
  });

  it('removes earlier files when a later write fails', async () => {
    const stored: string[] = [];
    const realPut = storage.put.bind(storage);
    vi.spyOn(storage, 'put')
      .mockImplementationOnce(async (data) => {
        const key = await realPut(data);
        stored.push(key);
        return key;
      })
      .mockRejectedValueOnce(new Error('disk full'));

    const failing = withStoredFiles([Buffer.from('a'), Buffer.from('b')], async () => 'never');

    await expect(failing).rejects.toThrow('disk full');
    await expectNotStored(stored[0] ?? '');
  });

  it('reports the original error even when cleanup fails too', async () => {
    vi.spyOn(storage, 'delete').mockRejectedValue(new Error('disk gone'));
    vi.spyOn(logger, 'error').mockImplementation(() => undefined);

    const failing = withStoredFiles([Buffer.from('data')], async () => {
      throw new Error('transaction failed');
    });

    await expect(failing).rejects.toThrow('transaction failed');
  });
});
