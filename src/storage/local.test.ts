import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { LocalStorageProvider } from './local.js';
import { StorageNotFoundError } from './provider.js';

const KEY_FORMAT =
  /^[0-9a-f]{2}\/[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

let sandbox: string;
let root: string;
let provider: LocalStorageProvider;

function validKey(): string {
  const id = randomUUID();
  return `${id.slice(0, 2)}/${id}`;
}

async function filesUnder(directory: string): Promise<string[]> {
  const entries = await fs.readdir(directory, { recursive: true, withFileTypes: true });
  return entries.filter((entry) => entry.isFile()).map((entry) => entry.name);
}

beforeEach(async () => {
  sandbox = await fs.mkdtemp(path.join(os.tmpdir(), 'edunify-local-storage-'));
  root = path.join(sandbox, 'root');
  provider = new LocalStorageProvider(root);
});

afterEach(async () => {
  vi.restoreAllMocks();
  await fs.rm(sandbox, { recursive: true, force: true });
});

describe('constructor', () => {
  it.each(['relative/path', './storage', ''])('rejects the root %j', (value) => {
    expect(() => new LocalStorageProvider(value)).toThrow('absolute path');
  });
});

describe('put and get', () => {
  it('round-trips binary data', async () => {
    const data = Buffer.from(Array.from({ length: 256 }, (_, byte) => byte));

    const key = await provider.put(data);

    await expect(provider.get(key)).resolves.toEqual(data);
  });

  it('round-trips an empty file', async () => {
    const key = await provider.put(Buffer.alloc(0));

    await expect(provider.get(key)).resolves.toHaveLength(0);
  });

  it('gives each put its own key', async () => {
    const first = await provider.put(Buffer.from('same'));
    const second = await provider.put(Buffer.from('same'));

    expect(first).not.toBe(second);
  });

  it('returns a key in the <first 2 chars>/<uuid> layout', async () => {
    const key = await provider.put(Buffer.from('data'));
    const [prefix, id] = key.split('/');

    expect(key).toMatch(KEY_FORMAT);
    expect(id?.startsWith(prefix ?? '')).toBe(true);
  });

  it('stores the file inside the root with no temp file left over', async () => {
    const key = await provider.put(Buffer.from('data'));

    await expect(fs.readFile(path.join(root, key), 'utf8')).resolves.toBe('data');
    await expect(filesUnder(root)).resolves.toEqual([key.split('/')[1]]);
  });

  it('removes the temp file when the final rename fails', async () => {
    vi.spyOn(fs, 'rename').mockRejectedValueOnce(new Error('disk full'));

    await expect(provider.put(Buffer.from('data'))).rejects.toThrow('disk full');
    await expect(filesUnder(root)).resolves.toEqual([]);
  });

  it('throws StorageNotFoundError for a key with no file', async () => {
    await expect(provider.get(validKey())).rejects.toBeInstanceOf(StorageNotFoundError);
  });
});

describe('delete', () => {
  it('removes the file', async () => {
    const key = await provider.put(Buffer.from('data'));

    await provider.delete(key);

    await expect(provider.get(key)).rejects.toBeInstanceOf(StorageNotFoundError);
  });

  it('is idempotent', async () => {
    const key = await provider.put(Buffer.from('data'));

    await provider.delete(key);

    await expect(provider.delete(key)).resolves.toBeUndefined();
  });

  it('ignores a valid key that never existed', async () => {
    await expect(provider.delete(validKey())).resolves.toBeUndefined();
  });
});

describe('key validation', () => {
  const id = randomUUID();

  const badKeys = [
    '../x',
    '/etc/passwd',
    'ab/../../x',
    '',
    'x',
    id,
    `${id.slice(0, 2)}/../${id}`,
    `${id.slice(0, 2)}/${id}/`,
    `${id.slice(0, 2)}/${id}.tmp`,
    `${id.slice(0, 2)}/${id}\n`,
    `/${id.slice(0, 2)}/${id}`,
    `${id.slice(0, 2).toUpperCase()}/${id.toUpperCase()}`,
    // The prefix must be the uuid's own first two characters.
    `${id.startsWith('zz') ? 'yy' : 'zz'}/${id}`,
    `${id.startsWith('00') ? '11' : '00'}/${id}`,
  ];

  it.each(badKeys)('get rejects %j', async (key) => {
    await expect(provider.get(key)).rejects.toThrow('Invalid storage key');
  });

  it.each(badKeys)('delete rejects %j', async (key) => {
    await expect(provider.delete(key)).rejects.toThrow('Invalid storage key');
  });

  it('never reaches a file outside the root', async () => {
    const outside = path.join(sandbox, 'outside.txt');
    await fs.writeFile(outside, 'keep me');

    await expect(provider.get('../outside.txt')).rejects.toThrow('Invalid storage key');
    await expect(provider.delete('../outside.txt')).rejects.toThrow('Invalid storage key');
    await expect(fs.readFile(outside, 'utf8')).resolves.toBe('keep me');
  });
});
