import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { initStorage, storage } from './index.js';

let sandbox: string;

beforeEach(async () => {
  sandbox = await fs.mkdtemp(path.join(os.tmpdir(), 'edunify-init-storage-'));
});

afterEach(async () => {
  await fs.rm(sandbox, { recursive: true, force: true });
});

describe('initStorage', () => {
  it('creates a nested directory', async () => {
    const root = path.join(sandbox, 'a', 'b', 'c');

    await initStorage(root);

    expect((await fs.stat(root)).isDirectory()).toBe(true);
  });

  it('accepts a directory that already exists', async () => {
    await expect(initStorage(sandbox)).resolves.toBeUndefined();
  });

  it('throws a readable error when the directory cannot be created', async () => {
    const file = path.join(sandbox, 'a-file');
    await fs.writeFile(file, 'not a directory');
    const root = path.join(file, 'storage');

    await expect(initStorage(root)).rejects.toThrow(
      `STORAGE_DIR ${root} cannot be created or is not writable`,
    );
  });
});

describe('storage', () => {
  it('stores files under STORAGE_DIR', async () => {
    await initStorage();

    const key = await storage.put(Buffer.from('data'));

    await expect(storage.get(key)).resolves.toEqual(Buffer.from('data'));
    await storage.delete(key);
  });
});
