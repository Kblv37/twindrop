import assert from 'node:assert/strict';
import test from 'node:test';

import {
  resolveReceivedFile,
  saveReceivedFile,
} from '../../src/services/received-download.js';

const OPFS_PATH = 'twindrop-received/received-file.bin';

function bytesOf(value) {
  return new TextEncoder().encode(value);
}

function joinChunks(chunks) {
  return new TextDecoder().decode(
    chunks.reduce((result, chunk) => {
      const merged = new Uint8Array(result.byteLength + chunk.byteLength);
      merged.set(result);
      merged.set(chunk, result.byteLength);
      return merged;
    }, new Uint8Array(0)),
  );
}

function createFakeDocument() {
  const appended = [];
  const anchor = {
    href: '',
    download: '',
    rel: '',
    style: {},
    clicked: false,
    click() {
      this.clicked = true;
    },
    remove() {
      const index = appended.indexOf(this);
      if (index >= 0) {
        appended.splice(index, 1);
      }
    },
  };

  const documentRef = {
    createElement(tagName) {
      assert.equal(tagName, 'a');
      return anchor;
    },
    body: {
      appendChild(node) {
        appended.push(node);
      },
      removeChild(node) {
        const index = appended.indexOf(node);
        if (index >= 0) {
          appended.splice(index, 1);
        }
      },
    },
  };

  return { documentRef, anchor, appended };
}

function createFakeDirectory(file) {
  return {
    async getDirectoryHandle() {
      return {
        async getFileHandle(name) {
          assert.equal(name, 'received-file.bin');
          return {
            async getFile() {
              return file;
            },
          };
        },
      };
    },
  };
}

test('resolveReceivedFile returns the bounded memory Blob when present', async () => {
  const blob = new Blob(['memory'], { type: 'text/plain' });
  const file = await resolveReceivedFile({ memoryBlob: blob, opfsPath: '' });

  assert.equal(file, blob);
});

test('resolveReceivedFile reads the file referenced by the OPFS path', async () => {
  const file = new Blob(['opfs content'], { type: 'text/plain' });
  const resolved = await resolveReceivedFile(
    { memoryBlob: null, opfsPath: OPFS_PATH },
    { getDirectory: async () => createFakeDirectory(file) },
  );

  assert.equal(await resolved.text(), 'opfs content');
});

test('resolveReceivedFile reports a missing OPFS entry with a friendly message', async () => {
  const missing = new Error('not found');
  missing.name = 'NotFoundError';
  const directory = {
    async getDirectoryHandle() {
      return {
        async getFileHandle() {
          throw missing;
        },
      };
    },
  };

  await assert.rejects(
    resolveReceivedFile(
      { memoryBlob: null, opfsPath: OPFS_PATH },
      { getDirectory: async () => directory },
    ),
    /больше не доступен в хранилище/,
  );
});

test('resolveReceivedFile maps an unavailable OPFS to a friendly message', async () => {
  await assert.rejects(
    resolveReceivedFile(
      { memoryBlob: null, opfsPath: OPFS_PATH },
      {
        getDirectory: async () => {
          const error = new Error('OPFS unavailable');
          error.code = 'opfs-unavailable';
          throw error;
        },
      },
    ),
    /больше не доступен в хранилище/,
  );
});

test('resolveReceivedFile rejects a record without any stored file', async () => {
  await assert.rejects(
    resolveReceivedFile({ memoryBlob: null, opfsPath: '' }),
    /больше не доступен/,
  );
});

test('saveReceivedFile streams through File System Access without a full Blob buffer', async () => {
  const chunks = [];
  let writableClosed = false;
  let streamCalled = false;
  const blob = new Blob(['streamed through fs access'], { type: 'text/plain' });
  const fileLike = {
    size: blob.size,
    stream() {
      streamCalled = true;
      return blob.stream();
    },
    arrayBuffer() {
      throw new Error('arrayBuffer must not be called for a streamed file');
    },
    slice() {
      throw new Error('slice must not be used for a streamed file');
    },
  };

  const result = await saveReceivedFile(
    { name: 'download.txt', memoryBlob: fileLike },
    {
      resolveFile: async () => fileLike,
      showSaveFilePicker: async () => ({
        async createWritable() {
          return new WritableStream({
            write(chunk) {
              chunks.push(new Uint8Array(chunk.slice(0)));
            },
            close() {
              writableClosed = true;
            },
          });
        },
      }),
      createObjectURL: () => {
        throw new Error('object URL must not be created for FS Access');
      },
    },
  );

  assert.equal(result.method, 'file-system-access');
  assert.equal(joinChunks(chunks), 'streamed through fs access');
  assert.equal(writableClosed, true);
  assert.equal(streamCalled, true);
});

test('saveReceivedFile streams a file-like object without arrayBuffer()', async () => {
  const payload = bytesOf('custom stream');
  const chunks = [];
  const fileLike = {
    size: payload.byteLength,
    stream() {
      return new ReadableStream({
        start(controller) {
          controller.enqueue(payload);
          controller.close();
        },
      });
    },
    slice() {
      throw new Error('slice must not be used while streaming');
    },
  };

  const result = await saveReceivedFile(
    { name: 'custom.bin' },
    {
      resolveFile: async () => fileLike,
      showSaveFilePicker: async () => ({
        async createWritable() {
          return new WritableStream({
            write(chunk) {
              chunks.push(new Uint8Array(chunk.slice(0)));
            },
          });
        },
      }),
    },
  );

  assert.equal(result.method, 'file-system-access');
  assert.equal(joinChunks(chunks), 'custom stream');
});

test('saveReceivedFile returns canceled when the save picker is dismissed', async () => {
  const file = new Blob(['cancel me']);
  let objectUrlCreated = false;
  const result = await saveReceivedFile(
    { name: 'cancel.txt' },
    {
      resolveFile: async () => file,
      showSaveFilePicker: async () => {
        throw new DOMException('The user aborted a request.', 'AbortError');
      },
      createObjectURL: () => {
        objectUrlCreated = true;
        return 'blob:cancel';
      },
    },
  );

  assert.equal(result.method, 'canceled');
  assert.equal(objectUrlCreated, false);
});

test('saveReceivedFile falls back to an anchor when FS Access is denied', async () => {
  const file = new Blob(['anchor fallback']);
  const { documentRef, anchor, appended } = createFakeDocument();
  const scheduled = [];
  const revoked = [];

  const result = await saveReceivedFile(
    { name: 'fallback.txt' },
    {
      resolveFile: async () => file,
      showSaveFilePicker: async () => {
        throw new DOMException('Permission denied.', 'SecurityError');
      },
      createObjectURL: () => 'blob:fallback',
      revokeObjectURL: (url) => revoked.push(url),
      documentRef,
      schedule: (callback, delay) => {
        scheduled.push({ callback, delay });
        return 1;
      },
    },
  );

  assert.equal(result.method, 'object-url');
  assert.equal(anchor.href, 'blob:fallback');
  assert.equal(anchor.download, 'fallback.txt');
  assert.equal(anchor.clicked, true);
  assert.equal(appended.length, 0);
  assert.equal(revoked.length, 0);
  assert.equal(scheduled.length, 1);
  assert.equal(scheduled[0].delay, 60_000);

  scheduled[0].callback();
  assert.deepEqual(revoked, ['blob:fallback']);
});

test('saveReceivedFile falls back to an anchor when createWritable() is denied', async () => {
  const file = new Blob(['writable denied']);
  const { documentRef, anchor } = createFakeDocument();

  const result = await saveReceivedFile(
    { name: 'denied.txt' },
    {
      resolveFile: async () => file,
      showSaveFilePicker: async () => ({
        async createWritable() {
          throw new DOMException('Write access denied.', 'NotAllowedError');
        },
      }),
      createObjectURL: () => 'blob:denied',
      revokeObjectURL: () => {},
      documentRef,
      schedule: () => 1,
    },
  );

  assert.equal(result.method, 'object-url');
  assert.equal(anchor.href, 'blob:denied');
  assert.equal(anchor.clicked, true);
});

test('saveReceivedFile uses the anchor fallback when no picker exists', async () => {
  const file = new Blob(['mobile fallback']);
  const { documentRef, anchor } = createFakeDocument();

  const result = await saveReceivedFile(
    { name: 'mobile.txt' },
    {
      resolveFile: async () => file,
      showSaveFilePicker: undefined,
      createObjectURL: () => 'blob:mobile',
      revokeObjectURL: () => {},
      documentRef,
      schedule: () => 1,
    },
  );

  assert.equal(result.method, 'object-url');
  assert.equal(anchor.href, 'blob:mobile');
  assert.equal(anchor.download, 'mobile.txt');
  assert.equal(anchor.clicked, true);
});

test('saveReceivedFile reports an unsupported download environment', async () => {
  await assert.rejects(
    saveReceivedFile(
      { name: 'unsupported.txt' },
      {
        resolveFile: async () => new Blob(['data']),
        showSaveFilePicker: undefined,
        createObjectURL: undefined,
        documentRef: null,
      },
    ),
    /не поддерживает скачивание/,
  );
});

test('saveReceivedFile propagates resolve errors without creating a URL', async () => {
  let objectUrlCreated = false;

  await assert.rejects(
    saveReceivedFile(
      { name: 'missing.txt', opfsPath: OPFS_PATH },
      {
        resolveFile: async () => {
          throw new Error('Полученный файл больше не доступен.');
        },
        showSaveFilePicker: undefined,
        createObjectURL: () => {
          objectUrlCreated = true;
          return 'blob:missing';
        },
      },
    ),
    /больше не доступен/,
  );

  assert.equal(objectUrlCreated, false);
});
