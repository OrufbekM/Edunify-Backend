import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

import { StorageNotFoundError, type StorageProvider } from './provider.js';

// <first 2 characters of the uuid>/<uuid v4>
const KEY_PATTERN =
  /^([0-9a-f]{2})\/\1[0-9a-f]{6}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function isMissingFileError(err: unknown): boolean {
  return (err as NodeJS.ErrnoException).code === 'ENOENT';
}

export class LocalStorageProvider implements StorageProvider {
  private readonly root: string;

  constructor(root: string) {
    if (!path.isAbsolute(root)) {
      throw new Error(`Storage root must be an absolute path: ${root}`);
    }
    this.root = path.resolve(root);
  }

  async put(data: Buffer): Promise<string> {
    const id = randomUUID();
    const key = `${id.slice(0, 2)}/${id}`;
    const finalPath = this.resolveKey(key);
    const tempPath = `${finalPath}.tmp`;

    await fs.mkdir(path.dirname(finalPath), { recursive: true });

    try {
      await fs.writeFile(tempPath, data);
      await fs.rename(tempPath, finalPath);
    } catch (err) {
      await fs.rm(tempPath, { force: true });
      throw err;
    }

    return key;
  }

  async get(key: string): Promise<Buffer> {
    const filePath = this.resolveKey(key);

    try {
      return await fs.readFile(filePath);
    } catch (err) {
      if (isMissingFileError(err)) {
        throw new StorageNotFoundError(key);
      }
      throw err;
    }
  }

  async delete(key: string): Promise<void> {
    await fs.rm(this.resolveKey(key), { force: true });
  }

  private resolveKey(key: string): string {
    if (!KEY_PATTERN.test(key)) {
      throw new Error('Invalid storage key');
    }

    const resolved = path.resolve(this.root, key);
    const relative = path.relative(this.root, resolved);

    if (relative.startsWith('..') || path.isAbsolute(relative)) {
      throw new Error('Invalid storage key');
    }

    return resolved;
  }
}
