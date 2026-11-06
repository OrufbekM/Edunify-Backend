import { constants } from 'node:fs';
import fs from 'node:fs/promises';

import { env } from '../config/env.js';
import { LocalStorageProvider } from './local.js';
import type { StorageProvider } from './provider.js';

export const storage: StorageProvider = new LocalStorageProvider(env.STORAGE_DIR);

export async function initStorage(root = env.STORAGE_DIR): Promise<void> {
  try {
    await fs.mkdir(root, { recursive: true });
    await fs.access(root, constants.W_OK | constants.X_OK);
  } catch (err) {
    throw new Error(`STORAGE_DIR ${root} cannot be created or is not writable`, { cause: err });
  }
}
