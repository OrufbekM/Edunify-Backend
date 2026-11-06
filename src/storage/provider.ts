export interface StorageProvider {
  put(data: Buffer): Promise<string>;
  get(key: string): Promise<Buffer>;
  delete(key: string): Promise<void>;
}

export class StorageNotFoundError extends Error {
  constructor(key: string) {
    super(`No stored file for key ${key}`);
    this.name = 'StorageNotFoundError';
  }
}
