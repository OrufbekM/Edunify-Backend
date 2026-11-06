import type { Transaction } from 'sequelize';

import { FileRecord } from '../../db/models/index.js';
import { logger } from '../../lib/logger.js';
import { storage } from '../../storage/index.js';

// Call inside the transaction, then pass the returned keys to removeStoredFiles once it has
// committed. Not a transaction.afterCommit hook: Sequelize also runs those when COMMIT fails,
// which would delete the stored bytes of rows that still exist.
export async function deleteFileRows(
  fileIds: string[],
  transaction: Transaction,
): Promise<string[]> {
  const files = await FileRecord.findAll({
    attributes: ['storageKey'],
    where: { id: fileIds },
    transaction,
  });

  await FileRecord.destroy({ where: { id: fileIds }, transaction });

  return files.map((file) => file.storageKey);
}

export async function removeStoredFiles(storageKeys: string[]): Promise<void> {
  const results = await Promise.allSettled(storageKeys.map((key) => storage.delete(key)));

  results.forEach((result, index) => {
    if (result.status === 'rejected') {
      logger.error(
        { err: result.reason, storageKey: storageKeys[index] },
        'Could not delete a stored file',
      );
    }
  });
}

export async function withStoredFiles<T>(
  contents: Buffer[],
  work: (storageKeys: string[]) => Promise<T>,
): Promise<T> {
  const storageKeys: string[] = [];

  try {
    for (const content of contents) {
      storageKeys.push(await storage.put(content));
    }

    return await work(storageKeys);
  } catch (err) {
    await removeStoredFiles(storageKeys);
    throw err;
  }
}
