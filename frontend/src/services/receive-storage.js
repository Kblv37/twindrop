import { formatBytes } from './utils.js';

export const OPFS_RECEIVE_DIR = 'twindrop-received';
export const MEMORY_RECEIVE_LIMIT_BYTES = 32 * 1024 * 1024;

const STALE_RECEIVE_AGE_MS = 24 * 60 * 60 * 1000;

function createAbortError() {
  return new DOMException('Приём отменён.', 'AbortError');
}

function createStorageError(code, message, details = {}) {
  const error = new Error(message);
  error.code = code;
  Object.assign(error, details);
  return error;
}

export function isQuotaError(error) {
  if (!error) {
    return false;
  }

  return error.name === 'QuotaExceededError'
    || error.name === 'NS_ERROR_DOM_QUOTA_REACHED'
    || error.code === 'quota-exceeded'
    || error.code === 22
    || error.code === 1014;
}

function normalizeStorageError(error, fallbackCode = 'write-failed') {
  if (isQuotaError(error)) {
    return createStorageError('quota-exceeded', 'quota-exceeded', { cause: error });
  }

  if (error?.code === 'opfs-unsupported' || error?.code === 'opfs-unavailable') {
    return error;
  }

  return createStorageError(fallbackCode, error?.message || fallbackCode, { cause: error });
}

export function isOpfsAvailable() {
  try {
    if (typeof globalThis.navigator?.storage?.getDirectory !== 'function') {
      return false;
    }

    const FileSystemFileHandleClass = globalThis.FileSystemFileHandle;

    if (FileSystemFileHandleClass && typeof FileSystemFileHandleClass.prototype?.createWritable !== 'function') {
      return false;
    }

    return true;
  } catch {
    return false;
  }
}

function getStorageRoot(getDirectory) {
  const resolver = getDirectory
    || globalThis.navigator?.storage?.getDirectory?.bind(globalThis.navigator.storage);

  if (typeof resolver !== 'function') {
    throw createStorageError('opfs-unavailable', 'opfs-unavailable');
  }

  return resolver();
}

async function getReceiveDirectory({ create = false, getDirectory } = {}) {
  let root;

  try {
    root = await getStorageRoot(getDirectory);
  } catch (error) {
    if (error?.code === 'opfs-unavailable') {
      throw error;
    }

    throw normalizeStorageError(error, 'opfs-unavailable');
  }

  try {
    return await root.getDirectoryHandle(OPFS_RECEIVE_DIR, { create });
  } catch (error) {
    if (!create && error?.name === 'NotFoundError') {
      return null;
    }

    throw normalizeStorageError(error, 'opfs-unavailable');
  }
}

function makeReceiveFileName(transferId) {
  const safeId = String(transferId || 'transfer')
    .replace(/[^A-Za-z0-9_-]/g, '_')
    .slice(0, 80) || 'transfer';
  const randomId = globalThis.crypto?.randomUUID?.()
    || `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;

  return `receive-${safeId}-${randomId}.bin`;
}

function parseOpfsPath(path) {
  const parts = String(path || '').split('/');

  if (parts.length !== 2 || parts[0] !== OPFS_RECEIVE_DIR || !parts[1]) {
    throw createStorageError('invalid-opfs-path', 'invalid-opfs-path');
  }

  if (parts[1].includes('\\') || parts[1] === '.' || parts[1] === '..') {
    throw createStorageError('invalid-opfs-path', 'invalid-opfs-path');
  }

  return parts[1];
}

async function assertEstimatedSpace(fileSize, estimateStorage) {
  if (typeof estimateStorage !== 'function') {
    return;
  }

  let estimate;

  try {
    estimate = await estimateStorage();
  } catch {
    // The estimate is advisory. The real quota error is handled by the write
    // and close calls below.
    return;
  }

  const quota = Number(estimate?.quota);
  const usage = Number(estimate?.usage);

  if (
    Number.isFinite(quota)
    && quota > 0
    && Number.isFinite(usage)
    && usage >= 0
    && quota - usage < fileSize
  ) {
    throw createStorageError('quota-exceeded', 'storage-estimate-insufficient', {
      quota,
      usage,
      fileSize,
    });
  }
}

class OpfsReceiveFile {
  constructor({
    directory,
    handle,
    writer,
    name,
    fileName,
    expectedSize,
    mimeType,
  }) {
    this.directory = directory;
    this.handle = handle;
    this.writer = writer;
    this.name = name;
    this.fileName = fileName;
    this.expectedSize = expectedSize;
    this.mimeType = mimeType;
    this.kind = 'opfs';
    this.path = `${OPFS_RECEIVE_DIR}/${name}`;
    this.aborted = false;
    this.closed = false;
    this.result = null;
  }

  async write(buffer) {
    if (this.aborted || this.closed) {
      throw createAbortError();
    }

    try {
      await this.writer.write(buffer);
    } catch (error) {
      throw normalizeStorageError(error);
    }
  }

  async close() {
    if (this.closed) {
      return this.result;
    }

    try {
      await this.writer.close();
    } catch (error) {
      throw normalizeStorageError(error);
    }

    this.closed = true;
    const file = await this.handle.getFile();

    if (Number(file?.size) !== this.expectedSize) {
      throw createStorageError('size-mismatch', 'size-mismatch', {
        expectedSize: this.expectedSize,
        actualSize: Number(file?.size),
      });
    }

    this.result = { file, size: file.size };
    return this.result;
  }

  async getFile() {
    if (this.result?.file) {
      return this.result.file;
    }

    return this.handle.getFile();
  }

  async abort() {
    if (this.aborted) {
      return;
    }

    this.aborted = true;

    try {
      if (!this.closed) {
        await this.writer.abort();
      }
    } catch {
      // The writable stream can already be closed or errored. Removing the
      // entry below is still required.
    }

    this.closed = true;

    try {
      await this.directory.removeEntry(this.name);
    } catch (error) {
      if (error?.name !== 'NotFoundError') {
        throw error;
      }
    }
  }

  async remove() {
    await this.abort();
  }
}

class MemoryReceiveFile {
  constructor({
    fileName,
    expectedSize,
    mimeType,
    limitBytes,
  }) {
    this.fileName = fileName;
    this.expectedSize = expectedSize;
    this.mimeType = mimeType;
    this.limitBytes = limitBytes;
    this.kind = 'memory';
    this.path = '';
    this.chunks = [];
    this.bytes = 0;
    this.blob = null;
    this.aborted = false;
    this.closed = false;
  }

  async write(buffer) {
    if (this.aborted || this.closed) {
      throw createAbortError();
    }

    const length = Number(buffer?.byteLength) || 0;

    if (this.bytes + length > this.limitBytes) {
      throw createStorageError('memory-receive-limit', 'memory-receive-limit', {
        limitBytes: this.limitBytes,
      });
    }

    this.chunks.push(buffer);
    this.bytes += length;
  }

  async close() {
    if (this.closed) {
      return { blob: this.blob, size: this.blob?.size || 0 };
    }

    const blob = new Blob(this.chunks, { type: this.mimeType });
    this.chunks = [];
    this.closed = true;

    if (blob.size !== this.expectedSize) {
      throw createStorageError('size-mismatch', 'size-mismatch', {
        expectedSize: this.expectedSize,
        actualSize: blob.size,
      });
    }

    this.blob = blob;
    return { blob, size: blob.size };
  }

  async getFile() {
    return this.blob;
  }

  async abort() {
    this.aborted = true;
    this.closed = true;
    this.chunks = [];
    this.blob = null;
  }

  async remove() {
    await this.abort();
  }
}

async function createOpfsReceiveFile({
  transferId,
  fileName,
  fileSize,
  mimeType,
  getDirectory,
  estimateStorage,
}) {
  await assertEstimatedSpace(fileSize, estimateStorage);

  const directory = await getReceiveDirectory({ create: true, getDirectory });
  const name = makeReceiveFileName(transferId);
  let handle;

  try {
    handle = await directory.getFileHandle(name, { create: true });
  } catch (error) {
    throw normalizeStorageError(error, 'opfs-unavailable');
  }

  if (typeof handle.createWritable !== 'function') {
    try {
      await directory.removeEntry(name);
    } catch {}

    throw createStorageError('opfs-unsupported', 'opfs-unsupported');
  }

  let writer;

  try {
    writer = await handle.createWritable({ keepExistingData: false });
  } catch (error) {
    try {
      await directory.removeEntry(name);
    } catch {}

    throw normalizeStorageError(error, 'opfs-unavailable');
  }

  return new OpfsReceiveFile({
    directory,
    handle,
    writer,
    name,
    fileName,
    expectedSize: fileSize,
    mimeType,
  });
}

export async function createReceiveStorage({
  transferId,
  fileName,
  fileSize,
  mimeType,
  opfs = isOpfsAvailable(),
  memoryLimitBytes = MEMORY_RECEIVE_LIMIT_BYTES,
  getDirectory,
  estimateStorage,
} = {}) {
  const normalizedSize = Number(fileSize) || 0;
  let opfsError = null;

  if (opfs) {
    try {
      return await createOpfsReceiveFile({
        transferId,
        fileName,
        fileSize: normalizedSize,
        mimeType,
        getDirectory,
        estimateStorage,
      });
    } catch (error) {
      if (isQuotaError(error)) {
        throw error;
      }

      opfsError = error;
    }
  }

  if (normalizedSize > memoryLimitBytes) {
    throw createStorageError('memory-fallback-limit', 'memory-fallback-limit', {
      limitBytes: memoryLimitBytes,
      cause: opfsError || undefined,
    });
  }

  return new MemoryReceiveFile({
    fileName,
    expectedSize: normalizedSize,
    mimeType,
    limitBytes: memoryLimitBytes,
  });
}

export function receiveStorageErrorMessage(error) {
  if (isQuotaError(error)) {
    return 'В браузере недостаточно свободного места для сохранения файла. Приём остановлен, файл не подтверждён.';
  }

  if (error?.code === 'memory-fallback-limit') {
    return `Браузер не поддерживает потоковое сохранение в OPFS. В этом браузере можно принимать файлы не больше ${formatBytes(error.limitBytes || MEMORY_RECEIVE_LIMIT_BYTES)}.`;
  }

  if (error?.code === 'memory-receive-limit') {
    return `Файл превышает безопасный лимит временной памяти (${formatBytes(error.limitBytes || MEMORY_RECEIVE_LIMIT_BYTES)}). Приём остановлен.`;
  }

  if (error?.code === 'opfs-unsupported' || error?.code === 'opfs-unavailable') {
    return 'Браузер не поддерживает потоковое сохранение файлов. Приём остановлен.';
  }

  if (error?.code === 'size-mismatch') {
    return 'Размер сохранённого файла не совпадает с ожидаемым. Приём остановлен, файл не подтверждён.';
  }

  return 'Не удалось сохранить полученный файл. Приём остановлен, файл не подтверждён.';
}

export async function getOpfsFile(path, { getDirectory } = {}) {
  const name = parseOpfsPath(path);
  const directory = await getReceiveDirectory({ create: false, getDirectory });

  if (!directory) {
    throw createStorageError('file-unavailable', 'file-unavailable');
  }

  const handle = await directory.getFileHandle(name);
  return handle.getFile();
}

export async function deleteOpfsFile(path, { getDirectory } = {}) {
  const name = parseOpfsPath(path);
  const directory = await getReceiveDirectory({ create: false, getDirectory });

  if (!directory) {
    return;
  }

  try {
    await directory.removeEntry(name);
  } catch (error) {
    if (error?.name !== 'NotFoundError') {
      throw error;
    }
  }
}

export async function cleanupStaleReceiveFiles({
  maxAgeMs = STALE_RECEIVE_AGE_MS,
  now = Date.now(),
  getDirectory,
} = {}) {
  if (!isOpfsAvailable() && !getDirectory) {
    return { removed: 0 };
  }

  let directory;

  try {
    directory = await getReceiveDirectory({ create: false, getDirectory });
  } catch {
    return { removed: 0 };
  }

  if (!directory || typeof directory.entries !== 'function') {
    return { removed: 0 };
  }

  let removed = 0;

  for await (const [name, handle] of directory.entries()) {
    try {
      const file = await handle.getFile();
      const modifiedAt = Number(file?.lastModified) || 0;

      if (modifiedAt > 0 && now - modifiedAt > maxAgeMs) {
        await directory.removeEntry(name);
        removed += 1;
      }
    } catch {
      // A concurrent transfer or a browser cleanup can invalidate an entry
      // between iteration and inspection. Continue with the remaining files.
    }
  }

  return { removed };
}
