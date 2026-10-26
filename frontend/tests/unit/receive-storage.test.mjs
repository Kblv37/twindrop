import assert from 'node:assert/strict';
import test from 'node:test';

import {
  MEMORY_RECEIVE_LIMIT_BYTES,
  OPFS_RECEIVE_DIR,
  cleanupStaleReceiveFiles,
  createReceiveStorage,
  deleteOpfsFile,
  getOpfsFile,
  isOpfsAvailable,
  receiveStorageErrorMessage,
} from '../../src/services/receive-storage.js';

const HOUR_MS = 60 * 60 * 1000;

function bytesOf(value) {
  return new TextEncoder().encode(value);
}

function notFoundError() {
  const error = new Error('not found');
  error.name = 'NotFoundError';
  return error;
}

function quotaError(message = 'quota exceeded') {
  const error = new Error(message);
  error.name = 'QuotaExceededError';
  return error;
}

class FakeFileHandle {
  constructor(directory, name) {
    this.directory = directory;
    this.name = name;
    this.file = null;
    this.writable = null;
  }

  async createWritable() {
    const handle = this;

    this.writable = {
      chunks: [],
      closed: false,
      aborted: false,

      async write(chunk) {
        if (handle.directory.writeError) {
          throw handle.directory.writeError;
        }

        this.chunks.push(new Uint8Array(chunk.slice(0)));
      },

      async close() {
        if (handle.directory.closeError) {
          throw handle.directory.closeError;
        }

        this.closed = true;
        const blob = new Blob(this.chunks);
        blob.lastModified = handle.directory.now();
        handle.file = blob;
      },

      async abort() {
        this.aborted = true;
        handle.file = null;
        handle.directory.files.delete(handle.name);
      },
    };

    return this.writable;
  }

  async getFile() {
    if (!this.file) {
      throw notFoundError();
    }

    return this.file;
  }
}

class FakeDirectory {
  constructor({ writeError = null, closeError = null, now = Date.now } = {}) {
    this.files = new Map();
    this.writeError = writeError;
    this.closeError = closeError;
    this.now = now;
    this.removed = [];
  }

  async getFileHandle(name, { create = false } = {}) {
    const existing = this.files.get(name);

    if (existing) {
      return existing;
    }

    if (!create) {
      throw notFoundError();
    }

    const handle = new FakeFileHandle(this, name);
    this.files.set(name, handle);
    return handle;
  }

  async removeEntry(name) {
    if (!this.files.has(name)) {
      throw notFoundError();
    }

    this.files.delete(name);
    this.removed.push(name);
  }

  async *entries() {
    for (const [name, handle] of [...this.files.entries()]) {
      yield [name, handle];
    }
  }

  addFile(name, file) {
    const handle = new FakeFileHandle(this, name);
    handle.file = file;
    this.files.set(name, handle);
    return handle;
  }
}

class FakeRoot {
  constructor(directory = new FakeDirectory()) {
    this.directory = directory;
    this.calls = [];
  }

  async getDirectoryHandle(name, options = {}) {
    this.calls.push({ name, options });

    if (name !== OPFS_RECEIVE_DIR) {
      throw notFoundError();
    }

    if (options.create === false && this.directory.missing) {
      throw notFoundError();
    }

    return this.directory;
  }
}

function createRoot(options = {}) {
  const directory = new FakeDirectory(options);
  return { root: new FakeRoot(directory), directory };
}

test('isOpfsAvailable uses feature detection', () => {
  const originalNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  const originalHandle = Object.getOwnPropertyDescriptor(globalThis, 'FileSystemFileHandle');

  try {
    Object.defineProperty(globalThis, 'navigator', {
      value: undefined,
      configurable: true,
    });
    assert.equal(isOpfsAvailable(), false);

    Object.defineProperty(globalThis, 'navigator', {
      value: { storage: { getDirectory() {} } },
      configurable: true,
    });
    assert.equal(isOpfsAvailable(), true);

    Object.defineProperty(globalThis, 'FileSystemFileHandle', {
      value: function FileSystemFileHandle() {},
      configurable: true,
    });
    assert.equal(isOpfsAvailable(), false);
  } finally {
    if (originalNavigator) {
      Object.defineProperty(globalThis, 'navigator', originalNavigator);
    } else {
      delete globalThis.navigator;
    }

    if (originalHandle) {
      Object.defineProperty(globalThis, 'FileSystemFileHandle', originalHandle);
    } else {
      delete globalThis.FileSystemFileHandle;
    }
  }
});

test('createReceiveStorage falls back to bounded memory when OPFS is unavailable', async () => {
  const storage = await createReceiveStorage({
    transferId: 'transfer-memory-1',
    fileName: 'memory.txt',
    fileSize: 5,
    mimeType: 'text/plain',
    opfs: false,
  });

  assert.equal(storage.kind, 'memory');
  assert.equal(storage.path, '');

  await storage.write(bytesOf('hello'));
  const result = await storage.close();

  assert.equal(result.size, 5);
  assert.equal(await result.blob.text(), 'hello');
});

test('createReceiveStorage uses memory by default in an environment without OPFS', async () => {
  const storage = await createReceiveStorage({
    transferId: 'transfer-memory-default',
    fileName: 'default.txt',
    fileSize: 3,
    mimeType: 'text/plain',
  });

  assert.equal(storage.kind, 'memory');
  await storage.abort();
});

test('memory fallback rejects files above the conservative limit', async () => {
  await assert.rejects(
    createReceiveStorage({
      transferId: 'transfer-memory-large',
      fileName: 'large.bin',
      fileSize: MEMORY_RECEIVE_LIMIT_BYTES + 1,
      mimeType: 'application/octet-stream',
      opfs: false,
    }),
    (error) => error?.code === 'memory-fallback-limit',
  );
});

test('memory fallback stops writing when the byte limit is exceeded', async () => {
  const storage = await createReceiveStorage({
    transferId: 'transfer-memory-limit',
    fileName: 'limited.bin',
    fileSize: 4,
    mimeType: 'application/octet-stream',
    opfs: false,
    memoryLimitBytes: 4,
  });

  await storage.write(bytesOf('1234'));
  await assert.rejects(
    storage.write(bytesOf('5')),
    (error) => error?.code === 'memory-receive-limit',
  );

  await storage.abort();
});

test('memory fallback verifies the final size', async () => {
  const storage = await createReceiveStorage({
    transferId: 'transfer-memory-mismatch',
    fileName: 'mismatch.bin',
    fileSize: 5,
    mimeType: 'application/octet-stream',
    opfs: false,
  });

  await storage.write(bytesOf('abc'));
  await assert.rejects(
    storage.close(),
    (error) => error?.code === 'size-mismatch',
  );
});

test('OPFS storage writes sequentially, closes and exposes the file', async () => {
  const { root, directory } = createRoot();
  const storage = await createReceiveStorage({
    transferId: 'transfer-opfs-1',
    fileName: 'file.bin',
    fileSize: 6,
    mimeType: 'application/octet-stream',
    opfs: true,
    getDirectory: async () => root,
  });

  assert.equal(storage.kind, 'opfs');
  assert.match(
    storage.path,
    /^twindrop-received\/receive-transfer-opfs-1-[A-Za-z0-9-]+\.bin$/,
  );

  await storage.write(bytesOf('abc'));
  await storage.write(bytesOf('def'));
  const result = await storage.close();

  assert.equal(result.size, 6);
  assert.equal(directory.files.size, 1);
  assert.equal(await (await storage.getFile()).text(), 'abcdef');
  assert.equal(storage.closed, true);
});

test('OPFS storage reports a size mismatch after close and can remove the file', async () => {
  const { root, directory } = createRoot();
  const storage = await createReceiveStorage({
    transferId: 'transfer-opfs-mismatch',
    fileName: 'mismatch.bin',
    fileSize: 5,
    mimeType: 'application/octet-stream',
    opfs: true,
    getDirectory: async () => root,
  });

  await storage.write(bytesOf('abc'));
  await assert.rejects(
    storage.close(),
    (error) => error?.code === 'size-mismatch',
  );

  assert.equal(directory.files.size, 1);
  await storage.abort();
  assert.equal(directory.files.size, 0);
  assert.equal(storage.aborted, true);
});

test('OPFS storage normalizes write and close quota errors', async () => {
  const writeRoot = createRoot({ writeError: quotaError() });
  const writeStorage = await createReceiveStorage({
    transferId: 'transfer-opfs-write-quota',
    fileName: 'quota.bin',
    fileSize: 1,
    mimeType: 'application/octet-stream',
    opfs: true,
    getDirectory: async () => writeRoot.root,
  });

  await assert.rejects(
    writeStorage.write(bytesOf('a')),
    (error) => error?.code === 'quota-exceeded',
  );
  await writeStorage.abort();

  const closeRoot = createRoot({ closeError: quotaError('quota on close') });
  const closeStorage = await createReceiveStorage({
    transferId: 'transfer-opfs-close-quota',
    fileName: 'quota-close.bin',
    fileSize: 1,
    mimeType: 'application/octet-stream',
    opfs: true,
    getDirectory: async () => closeRoot.root,
  });

  await closeStorage.write(bytesOf('a'));
  await assert.rejects(
    closeStorage.close(),
    (error) => error?.code === 'quota-exceeded',
  );
  await closeStorage.abort();
});

test('OPFS storage rejects when the storage estimate is clearly insufficient', async () => {
  const { root, directory } = createRoot();

  await assert.rejects(
    createReceiveStorage({
      transferId: 'transfer-opfs-estimate',
      fileName: 'estimate.bin',
      fileSize: 100,
      mimeType: 'application/octet-stream',
      opfs: true,
      getDirectory: async () => root,
      estimateStorage: async () => ({ quota: 100, usage: 50 }),
    }),
    (error) => error?.code === 'quota-exceeded',
  );

  assert.equal(directory.files.size, 0);
  assert.equal(root.calls.length, 0);
});

test('OPFS storage tolerates an unavailable storage estimate', async () => {
  const { root } = createRoot();
  const storage = await createReceiveStorage({
    transferId: 'transfer-opfs-estimate-error',
    fileName: 'estimate-error.bin',
    fileSize: 1,
    mimeType: 'application/octet-stream',
    opfs: true,
    getDirectory: async () => root,
    estimateStorage: async () => {
      throw new Error('estimate unavailable');
    },
  });

  assert.equal(storage.kind, 'opfs');
  await storage.abort();
});

test('OPFS creation failure falls back to memory only for bounded files', async () => {
  const fallback = await createReceiveStorage({
    transferId: 'transfer-opfs-fallback',
    fileName: 'fallback.txt',
    fileSize: 5,
    mimeType: 'text/plain',
    opfs: true,
    getDirectory: async () => {
      throw new Error('storage denied');
    },
  });

  assert.equal(fallback.kind, 'memory');
  await fallback.abort();

  await assert.rejects(
    createReceiveStorage({
      transferId: 'transfer-opfs-fallback-large',
      fileName: 'fallback-large.bin',
      fileSize: MEMORY_RECEIVE_LIMIT_BYTES + 1,
      mimeType: 'application/octet-stream',
      opfs: true,
      getDirectory: async () => {
        throw new Error('storage denied');
      },
    }),
    (error) => error?.code === 'memory-fallback-limit',
  );
});

test('getOpfsFile and deleteOpfsFile operate on the receive directory only', async () => {
  const { root, directory } = createRoot();
  const storage = await createReceiveStorage({
    transferId: 'transfer-opfs-download',
    fileName: 'download.txt',
    fileSize: 4,
    mimeType: 'text/plain',
    opfs: true,
    getDirectory: async () => root,
  });

  await storage.write(bytesOf('data'));
  await storage.close();

  const file = await getOpfsFile(storage.path, { getDirectory: async () => root });
  assert.equal(file.size, 4);
  assert.equal(await file.text(), 'data');

  await deleteOpfsFile(storage.path, { getDirectory: async () => root });
  assert.equal(directory.files.size, 0);

  // Deleting an already missing file is idempotent.
  await deleteOpfsFile(storage.path, { getDirectory: async () => root });

  await assert.rejects(
    getOpfsFile(storage.path, { getDirectory: async () => root }),
    (error) => error?.name === 'NotFoundError',
  );
});

test('getOpfsFile rejects invalid paths without touching OPFS', async () => {
  const { root, directory } = createRoot();

  for (const path of ['', 'other/file.bin', 'twindrop-received/../file.bin', 'twindrop-received/a/b.bin']) {
    await assert.rejects(
      getOpfsFile(path, { getDirectory: async () => root }),
      (error) => error?.code === 'invalid-opfs-path',
    );
  }

  assert.equal(directory.files.size, 0);
});

test('getOpfsFile reports an unavailable directory', async () => {
  const { root, directory } = createRoot();
  directory.missing = true;

  await assert.rejects(
    getOpfsFile(`${OPFS_RECEIVE_DIR}/file.bin`, { getDirectory: async () => root }),
    (error) => error?.code === 'file-unavailable',
  );
});

test('cleanupStaleReceiveFiles removes only old entries', async () => {
  const now = Date.now();
  const { root, directory } = createRoot({ now: () => now });
  directory.addFile('old.bin', { size: 1, lastModified: now - 25 * HOUR_MS });
  directory.addFile('fresh.bin', { size: 1, lastModified: now - HOUR_MS });
  directory.addFile('unknown.bin', { size: 1, lastModified: 0 });

  const result = await cleanupStaleReceiveFiles({
    maxAgeMs: 24 * HOUR_MS,
    now,
    getDirectory: async () => root,
  });

  assert.equal(result.removed, 1);
  assert.deepEqual([...directory.files.keys()].sort(), ['fresh.bin', 'unknown.bin']);
});

test('cleanupStaleReceiveFiles is a no-op without a receive directory', async () => {
  const { root, directory } = createRoot();
  directory.missing = true;

  const result = await cleanupStaleReceiveFiles({
    getDirectory: async () => root,
  });

  assert.equal(result.removed, 0);
});

test('receiveStorageErrorMessage maps storage failures to user-facing text', () => {
  assert.match(receiveStorageErrorMessage(quotaError()), /недостаточно свободного места/);

  assert.match(
    receiveStorageErrorMessage({ code: 'memory-fallback-limit', limitBytes: 1024 }),
    /не больше 1.00 KB/,
  );

  assert.match(
    receiveStorageErrorMessage({ code: 'memory-receive-limit', limitBytes: 1024 }),
    /безопасный лимит/,
  );

  assert.match(
    receiveStorageErrorMessage({ code: 'opfs-unavailable' }),
    /не поддерживает потоковое сохранение/,
  );

  assert.match(
    receiveStorageErrorMessage({ code: 'size-mismatch' }),
    /Размер сохранённого файла/,
  );

  assert.match(
    receiveStorageErrorMessage(new Error('other')),
    /Не удалось сохранить полученный файл/,
  );
});
