import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import test from 'node:test';

import { FileReceiver, FileSender } from '../../src/services/file-transfer.js';
import { WebRtcPeerSession } from '../../src/services/webrtc-peer.js';

if (!globalThis.crypto) {
  globalThis.crypto = webcrypto;
}

globalThis.window = globalThis;
window.requestAnimationFrame = (callback) => setTimeout(callback, 0);

const TRANSFER_ID = 'transfer-test-0001';
const ACK_TYPE = 'transfer-complete-ack';
const ERROR_TYPE = 'transfer-error';

function bytesOf(value) {
  return new TextEncoder().encode(value);
}

function makeFile(name, bytes) {
  const data = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);

  return {
    name,
    size: data.byteLength,
    type: 'application/octet-stream',
    lastModified: 1,
    async arrayBuffer() {
      return data.slice().buffer;
    },
    slice(start, end) {
      const part = data.slice(start, end);
      return {
        async arrayBuffer() {
          return part.slice().buffer;
        },
      };
    },
  };
}

async function sha256Hex(bytes) {
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function parseControl(value) {
  if (typeof value !== 'string') {
    return null;
  }

  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function createGate() {
  let release;
  const promise = new Promise((resolve) => {
    release = resolve;
  });

  return { promise, release };
}

function joinChunks(chunks) {
  const total = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
  const result = new Uint8Array(total);
  let offset = 0;

  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }

  return result;
}

function splitBytes(data, sizes) {
  const parts = [];
  let offset = 0;

  for (const size of sizes) {
    parts.push(data.slice(offset, offset + size));
    offset += size;
  }

  if (offset < data.byteLength) {
    parts.push(data.slice(offset));
  }

  return parts;
}

class FakeReceiveStorage {
  constructor({ kind = 'opfs', path = 'twindrop-received/fake.bin' } = {}) {
    this.kind = kind;
    this.path = kind === 'opfs' ? path : '';
    this.writes = [];
    this.writeCalls = 0;
    this.closeCalls = 0;
    this.abortCalls = 0;
    this.removeCalls = 0;
    this.size = 0;
    this.closed = false;
    this.aborted = false;
    this.file = null;
    this.onWrite = null;
    this.onClose = null;
    this.writeError = null;
    this.closeError = null;
  }

  async write(buffer) {
    this.writeCalls += 1;

    if (this.onWrite) {
      await this.onWrite(this.writeCalls, buffer);
    }

    if (this.writeError) {
      throw this.writeError;
    }

    const copy = new Uint8Array(buffer.slice(0));
    this.writes.push(copy);
    this.size += copy.byteLength;
  }

  async close() {
    this.closeCalls += 1;

    if (this.onClose) {
      await this.onClose();
    }

    if (this.closeError) {
      throw this.closeError;
    }

    this.closed = true;
    this.file = new Blob(this.writes, { type: 'application/octet-stream' });
    return { blob: this.file, size: this.size };
  }

  async getFile() {
    return this.file;
  }

  async abort() {
    this.abortCalls += 1;
    this.aborted = true;
    this.file = null;
    this.writes = [];
  }

  async remove() {
    this.removeCalls += 1;
    this.aborted = true;
    this.file = null;
    this.writes = [];
  }

  bytes() {
    return joinChunks(this.writes);
  }
}

class FakeChannel {
  constructor({ maxMessageSize = 0, failBinary = false } = {}) {
    this.readyState = 'open';
    this.bufferedAmount = 0;
    this.bufferedAmountLowThreshold = 0;
    this.maxMessageSize = maxMessageSize;
    this.failBinary = failBinary;
    this.messages = [];
    this.onSend = null;
  }

  send(data) {
    if (typeof data !== 'string' && this.failBinary) {
      throw new Error('simulated send failure');
    }

    this.messages.push(data);
    this.onSend?.(data);
  }

  addEventListener() {}

  removeEventListener() {}
}

function createSender(channel, overrides = {}) {
  const events = {
    complete: [],
    error: [],
    starts: [],
  };

  const sender = new FileSender({
    getChannel: () => channel,
    getMaxMessageSize: () => channel.maxMessageSize,
    maxFileSizeBytes: 1024 * 1024 * 1024,
    maxFilesPerTransfer: 10,
    onFileStart: (event) => events.starts.push(event),
    onRemoteProgress: (event) => {
      if (event.stage === 'complete') {
        events.complete.push(event);
      }
      if (event.stage === 'error') {
        events.error.push(event);
      }
    },
    ...overrides,
  });

  return { sender, events };
}

function autoAcknowledge(channel, getSender, {
  integrity = 'verified',
  fileSize,
  sha256,
} = {}) {
  channel.onSend = (payload) => {
    const message = parseControl(payload);

    if (message?.type !== 'transfer-complete') {
      return;
    }

    queueMicrotask(() => {
      getSender().handleData(JSON.stringify({
        type: ACK_TYPE,
        transferId: message.transferId,
        fileName: 'file.bin',
        totalBytes: fileSize,
        sha256,
        integrity,
      }));
    });
  };
}

async function waitFor(predicate, timeoutMs = 2000) {
  const startedAt = Date.now();

  while (!predicate()) {
    if (Date.now() - startedAt > timeoutMs) {
      throw new Error('waitFor timeout');
    }

    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function createReceiver(overrides = {}) {
  const sent = [];
  const ready = [];
  const errors = [];
  const receiver = new FileReceiver({
    sendControl: (payload) => sent.push(payload),
    maxFileSizeBytes: 1024 * 1024,
    onProgress: () => {},
    onTransferStart: () => {},
    onTransferReady: (details) => {
      ready.push(details);
      return true;
    },
    onError: (error, details) => errors.push({ error, details }),
    ...overrides,
  });

  return {
    receiver,
    sent,
    ready,
    errors,
  };
}

function createReceiverWithStorage(storage, overrides = {}) {
  const state = { createCalls: 0, details: null };
  const result = createReceiver({
    createStorage: async (details) => {
      state.createCalls += 1;
      state.details = details;
      return storage;
    },
    ...overrides,
  });

  return { ...result, storage, state };
}

function buildMeta({
  transferId = TRANSFER_ID,
  fileName = 'received.txt',
  fileSize,
  sha256,
} = {}) {
  return JSON.stringify({
    type: 'transfer-meta',
    transferId,
    fileName,
    fileSize,
    mimeType: 'text/plain',
    chunkSize: 16 * 1024,
    sha256,
  });
}

async function feedTransfer(receiver, {
  transferId = TRANSFER_ID,
  content = 'hello receiver',
  fileName = 'received.txt',
  sha256,
  chunks = null,
  complete = true,
} = {}) {
  const data = typeof content === 'string' ? bytesOf(content) : content;
  const hash = sha256 || await sha256Hex(data);

  receiver.handleData(buildMeta({
    transferId,
    fileName,
    fileSize: data.byteLength,
    sha256: hash,
  }));

  const parts = chunks || [data];

  for (const part of parts) {
    receiver.handleData(part.buffer.slice(part.byteOffset, part.byteOffset + part.byteLength));
  }

  if (complete) {
    receiver.handleData(JSON.stringify({
      type: 'transfer-complete',
      transferId,
    }));
  }

  return { data, hash };
}

function hasAck(sent) {
  return sent.some((message) => message.type === ACK_TYPE);
}

test('sender completes only after a verified ACK with matching size and hash', async () => {
  const data = bytesOf('verified payload');
  const file = makeFile('verified.txt', data);
  const sha256 = await sha256Hex(data);
  const channel = new FakeChannel();
  const { sender, events } = createSender(channel);

  autoAcknowledge(channel, () => sender, {
    integrity: 'verified',
    fileSize: file.size,
    sha256,
  });

  await sender.sendFiles([file], 16 * 1024);

  assert.equal(events.complete.length, 1);
  assert.equal(events.complete[0].integrity, 'verified');
  assert.equal(events.error.length, 0);
  assert.equal(sender.ackWaiters.size, 0);
});

test('sender rejects an unknown ACK and keeps the transfer unconfirmed', async () => {
  const data = bytesOf('unknown integrity payload');
  const file = makeFile('unknown.txt', data);
  const sha256 = await sha256Hex(data);
  const channel = new FakeChannel();
  const { sender, events } = createSender(channel);

  autoAcknowledge(channel, () => sender, {
    integrity: 'unknown',
    fileSize: file.size,
    sha256,
  });

  await assert.rejects(
    sender.sendFiles([file], 16 * 1024),
    /не подтвердил целостность/,
  );

  assert.equal(events.complete.length, 0);
  assert.equal(sender.ackWaiters.size, 0);

  const errorMessage = channel.messages
    .map(parseControl)
    .find((message) => message?.type === ERROR_TYPE);
  assert.ok(errorMessage);
  assert.match(errorMessage.message, /целостность/);
});

test('sender rejects a verified ACK with mismatched file size or hash', async () => {
  const data = bytesOf('mismatched ack payload');
  const file = makeFile('mismatch.txt', data);
  const sha256 = await sha256Hex(data);
  const channel = new FakeChannel();
  const { sender, events } = createSender(channel);

  autoAcknowledge(channel, () => sender, {
    integrity: 'verified',
    fileSize: file.size + 1,
    sha256,
  });

  await assert.rejects(
    sender.sendFiles([file], 16 * 1024),
    /некорректное подтверждение/,
  );

  assert.equal(events.complete.length, 0);
});

test('sender ignores repeated and late ACKs', async () => {
  const data = bytesOf('late ack payload');
  const file = makeFile('late.txt', data);
  const sha256 = await sha256Hex(data);
  const channel = new FakeChannel();
  const { sender, events } = createSender(channel);

  autoAcknowledge(channel, () => sender, {
    integrity: 'verified',
    fileSize: file.size,
    sha256,
  });

  await sender.sendFiles([file], 16 * 1024);
  assert.equal(events.complete.length, 1);

  const meta = channel.messages
    .map(parseControl)
    .find((message) => message?.type === 'transfer-meta');

  sender.handleData(JSON.stringify({
    type: ACK_TYPE,
    transferId: meta.transferId,
    fileName: file.name,
    totalBytes: file.size,
    sha256,
    integrity: 'verified',
  }));

  assert.equal(events.complete.length, 1);
});

test('cancel while waiting for ACK sends an error and ignores a late success ACK', async () => {
  const data = bytesOf('cancel while waiting for ack');
  const file = makeFile('cancel-ack.txt', data);
  const sha256 = await sha256Hex(data);
  const channel = new FakeChannel();
  const { sender, events } = createSender(channel);
  const controller = new AbortController();
  let completeTransferId = '';
  let resolveCompleteSent;
  const completeSent = new Promise((resolve) => {
    resolveCompleteSent = resolve;
  });

  channel.onSend = (payload) => {
    const message = parseControl(payload);

    if (message?.type === 'transfer-complete') {
      completeTransferId = message.transferId;
      resolveCompleteSent();
    }
  };

  const sendPromise = sender.sendFiles([file], 16 * 1024, { signal: controller.signal });

  await completeSent;
  controller.abort();
  await assert.rejects(sendPromise, (error) => error?.name === 'AbortError');

  assert.equal(events.complete.length, 0);

  const cancelError = channel.messages
    .map(parseControl)
    .find((message) => message?.type === ERROR_TYPE);
  assert.ok(cancelError);
  assert.equal(cancelError.transferId, completeTransferId);
  assert.match(cancelError.message, /отменена отправителем/);

  sender.handleData(JSON.stringify({
    type: ACK_TYPE,
    transferId: completeTransferId,
    fileName: file.name,
    totalBytes: file.size,
    sha256,
    integrity: 'verified',
  }));

  assert.equal(events.complete.length, 0);
  assert.equal(sender.ackWaiters.size, 0);
});

test('chunk size is limited by RTCSctpTransport.maxMessageSize', async () => {
  const data = new Uint8Array(150 * 1024).fill(7);
  const file = makeFile('chunk-limit.bin', data);
  const sha256 = await sha256Hex(data);
  const channel = new FakeChannel({ maxMessageSize: 64 * 1024 });
  const { sender } = createSender(channel);

  autoAcknowledge(channel, () => sender, {
    integrity: 'verified',
    fileSize: file.size,
    sha256,
  });

  await sender.sendFiles([file], 128 * 1024);

  const meta = channel.messages
    .map(parseControl)
    .find((message) => message?.type === 'transfer-meta');
  assert.equal(meta.chunkSize, 64 * 1024);

  const binaryChunks = channel.messages.filter((message) => typeof message !== 'string');
  assert.deepEqual(binaryChunks.map((chunk) => chunk.byteLength), [
    64 * 1024,
    64 * 1024,
    22 * 1024,
  ]);
});

test('chunk size falls back to 64 KiB when the SCTP limit is unavailable', async () => {
  const data = bytesOf('fallback chunk size');
  const file = makeFile('fallback.bin', data);
  const sha256 = await sha256Hex(data);
  const channel = new FakeChannel({ maxMessageSize: 0 });
  const { sender } = createSender(channel);

  autoAcknowledge(channel, () => sender, {
    integrity: 'verified',
    fileSize: file.size,
    sha256,
  });

  await sender.sendFiles([file], 512 * 1024);

  const meta = channel.messages
    .map(parseControl)
    .find((message) => message?.type === 'transfer-meta');
  assert.equal(meta.chunkSize, 64 * 1024);
});

test('WebRtcPeerSession exposes maxMessageSize from pc.sctp', () => {
  const session = Object.create(WebRtcPeerSession.prototype);

  session.pc = { sctp: { maxMessageSize: 65536 } };
  assert.equal(session.getMaxMessageSize(), 65536);

  session.pc = { sctp: {} };
  assert.equal(session.getMaxMessageSize(), 0);

  session.pc = {};
  assert.equal(session.getMaxMessageSize(), 0);
});

test('sender reports channel.send failures without pretending success', async () => {
  const data = new Uint8Array(32 * 1024).fill(7);
  const file = makeFile('send-failure.bin', data);
  const channel = new FakeChannel({ failBinary: true });
  const { sender, events } = createSender(channel);

  await assert.rejects(
    sender.sendFiles([file], 16 * 1024),
    (error) => error?.code === 'data-channel-send-failed',
  );

  assert.equal(events.complete.length, 0);
  assert.equal(sender.ackWaiters.size, 0);

  const errorMessage = channel.messages
    .map(parseControl)
    .find((message) => message?.type === ERROR_TYPE);
  assert.ok(errorMessage);
  assert.match(errorMessage.message, /P2P-каналу/);
});

test('sender aborts an active transfer when the receiver reports a storage error', async () => {
  const data = new Uint8Array(256 * 1024).fill(3);
  const file = makeFile('remote-error.bin', data);
  const channel = new FakeChannel();
  const { sender, events } = createSender(channel);
  let transferId = '';
  let binarySent = 0;
  let remoteErrorSent = false;

  channel.onSend = (payload) => {
    const message = parseControl(payload);

    if (message?.type === 'transfer-meta') {
      transferId = message.transferId;
      return;
    }

    if (typeof payload === 'string') {
      return;
    }

    binarySent += 1;

    if (!remoteErrorSent) {
      remoteErrorSent = true;
      queueMicrotask(() => {
        sender.handleData(JSON.stringify({
          type: ERROR_TYPE,
          transferId,
          message: 'Не удалось сохранить файл: недостаточно места.',
        }));
      });
    }
  };

  await assert.rejects(
    sender.sendFiles([file], 64 * 1024),
    (error) => error?.code === 'remote-receive-error',
  );

  assert.equal(events.complete.length, 0);
  assert.equal(binarySent, 1);
  assert.equal(sender.ackWaiters.size, 0);

  const errorsSentBySender = channel.messages
    .map(parseControl)
    .filter((message) => message?.type === ERROR_TYPE);
  assert.equal(errorsSentBySender.length, 0);
});

test('receiver writes chunks sequentially and acknowledges the verified file', async () => {
  const gate = createGate();
  const storage = new FakeReceiveStorage();
  storage.onWrite = async (call) => {
    if (call === 1) {
      await gate.promise;
    }
  };
  const { receiver, sent, ready, errors, state } = createReceiverWithStorage(storage);
  const data = bytesOf('sequential-write-payload');
  const chunks = splitBytes(data, [5, 6, 7]);

  receiver.handleData(buildMeta({
    fileSize: data.byteLength,
    sha256: await sha256Hex(data),
  }));

  for (const chunk of chunks) {
    receiver.handleData(chunk.buffer.slice(chunk.byteOffset, chunk.byteOffset + chunk.byteLength));
  }

  await waitFor(() => storage.writeCalls === 1);

  // The second chunk must wait for the first storage.write() to resolve.
  assert.equal(storage.writeCalls, 1);

  receiver.handleData(JSON.stringify({
    type: 'transfer-complete',
    transferId: TRANSFER_ID,
  }));

  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(hasAck(sent), false);
  assert.equal(storage.closeCalls, 0);

  gate.release();
  await waitFor(() => hasAck(sent));

  assert.deepEqual([...storage.bytes()], [...data]);
  assert.equal(storage.writeCalls, chunks.length);
  assert.equal(storage.closeCalls, 1);
  assert.equal(errors.length, 0);
  assert.equal(ready.length, 1);
  assert.equal(ready[0].storage, 'opfs');
  assert.equal(ready[0].opfsPath, storage.path);
  assert.equal(ready[0].blob, null);
  assert.equal(state.createCalls, 1);
});

test('receiver verifies SHA-256 across arbitrary chunk boundaries', async () => {
  const data = new Uint8Array(1024);
  for (let index = 0; index < data.byteLength; index += 1) {
    data[index] = (index * 37 + 11) & 0xff;
  }

  const storage = new FakeReceiveStorage();
  const { receiver, sent, ready, errors } = createReceiverWithStorage(storage);
  const chunks = splitBytes(data, [1, 63, 64, 65, 7, 128]);

  receiver.handleData(buildMeta({
    fileSize: data.byteLength,
    sha256: await sha256Hex(data),
  }));

  for (const chunk of chunks) {
    receiver.handleData(chunk.buffer.slice(chunk.byteOffset, chunk.byteOffset + chunk.byteLength));
  }

  receiver.handleData(JSON.stringify({
    type: 'transfer-complete',
    transferId: TRANSFER_ID,
  }));

  await waitFor(() => hasAck(sent));

  assert.deepEqual([...storage.bytes()], [...data]);
  assert.equal(ready.length, 1);
  assert.equal(errors.length, 0);
});

test('receiver sends the ACK only after writer.close() and hash verification', async () => {
  const gate = createGate();
  const events = [];
  const storage = new FakeReceiveStorage();
  storage.onWrite = () => events.push('write');
  storage.onClose = async () => {
    events.push('close-start');
    await gate.promise;
    events.push('close-done');
  };
  const sent = [];
  const ready = [];
  const { receiver } = createReceiver({
    createStorage: async () => storage,
    sendControl: (payload) => {
      sent.push(payload);

      if (payload.type === ACK_TYPE) {
        events.push('ack');
      }
    },
    onTransferReady: (details) => {
      ready.push(details);
      return true;
    },
  });

  await feedTransfer(receiver, { content: 'ack-after-close-and-verify' });
  await waitFor(() => storage.closeCalls === 1);

  assert.equal(hasAck(sent), false);
  assert.equal(ready.length, 0);

  gate.release();
  await waitFor(() => hasAck(sent));

  assert.deepEqual(events, ['write', 'close-start', 'close-done', 'ack']);
  assert.equal(ready.length, 1);
  assert.equal(ready[0].sha256, await sha256Hex(bytesOf('ack-after-close-and-verify')));
});

test('receiver rejects an integrity mismatch, aborts storage and sends no ACK', async () => {
  const storage = new FakeReceiveStorage();
  const { receiver, sent, ready, errors } = createReceiverWithStorage(storage);

  await feedTransfer(receiver, {
    content: 'actual content',
    sha256: await sha256Hex(bytesOf('expected content')),
  });

  await waitFor(() => errors.length > 0);
  await waitFor(() => storage.abortCalls === 1);

  assert.equal(ready.length, 0);
  assert.equal(hasAck(sent), false);
  assert.match(errors[0].error.message, /целостности/);

  const errorMessage = sent.find((message) => message.type === ERROR_TYPE);
  assert.ok(errorMessage);
  assert.match(errorMessage.message, /целостности/);
  assert.equal(storage.closed, true);
});

test('receiver cancels finalization on a sender error and never sends a late ACK', async () => {
  const gate = createGate();
  const storage = new FakeReceiveStorage();
  storage.onClose = () => gate.promise;
  const { receiver, sent, ready, errors } = createReceiverWithStorage(storage);

  await feedTransfer(receiver, {
    content: 'cancel during finalization',
    fileName: 'cancel-finalize.txt',
  });

  await waitFor(() => storage.closeCalls === 1);

  receiver.handleData(JSON.stringify({
    type: ERROR_TYPE,
    transferId: TRANSFER_ID,
    message: 'Передача отменена отправителем.',
  }));

  gate.release();
  await new Promise((resolve) => setTimeout(resolve, 50));

  assert.equal(ready.length, 0);
  assert.equal(hasAck(sent), false);
  assert.equal(errors.length, 1);
  assert.match(errors[0].error.message, /отменена/);
  assert.equal(receiver.finalizingTransfers.size, 0);
  await waitFor(() => storage.abortCalls === 1);
});

test('receiver cancelAll stops writes, aborts storage and ignores late chunks', async () => {
  const gate = createGate();
  const storage = new FakeReceiveStorage();
  storage.onWrite = async (call) => {
    if (call === 1) {
      await gate.promise;
    }
  };
  const { receiver, sent, ready, errors, state } = createReceiverWithStorage(storage);
  const data = bytesOf('cancel-during-write-payload');
  const chunks = splitBytes(data, [8]);

  receiver.handleData(buildMeta({
    fileSize: data.byteLength,
    sha256: await sha256Hex(data),
  }));

  for (const chunk of chunks) {
    receiver.handleData(chunk.buffer.slice(chunk.byteOffset, chunk.byteOffset + chunk.byteLength));
  }

  await waitFor(() => storage.writeCalls === 1);
  receiver.cancelAll();

  assert.equal(receiver.activeTransfer, null);
  await waitFor(() => storage.abortCalls === 1);

  gate.release();

  receiver.handleData(new Uint8Array([1, 2, 3]).buffer);
  receiver.handleData(JSON.stringify({
    type: 'transfer-complete',
    transferId: TRANSFER_ID,
  }));

  await new Promise((resolve) => setTimeout(resolve, 50));

  assert.equal(ready.length, 0);
  assert.equal(hasAck(sent), false);
  assert.equal(errors.length, 0);
  assert.equal(state.createCalls, 1);
  assert.equal(storage.writeCalls, 1);
  assert.equal(storage.closeCalls, 0);
});

test('receiver stops the transfer when storage.write() reports a quota error', async () => {
  const storage = new FakeReceiveStorage();
  const quotaError = new Error('quota exceeded');
  quotaError.name = 'QuotaExceededError';
  storage.writeError = quotaError;
  const { receiver, sent, ready, errors } = createReceiverWithStorage(storage);

  await feedTransfer(receiver, { content: 'quota failure payload' });

  await waitFor(() => errors.length > 0);
  await waitFor(() => storage.abortCalls === 1);

  assert.equal(ready.length, 0);
  assert.equal(hasAck(sent), false);
  assert.match(errors[0].error.message, /недостаточно свободного места/);

  const errorMessage = sent.find((message) => message.type === ERROR_TYPE);
  assert.ok(errorMessage);
  assert.match(errorMessage.message, /недостаточно свободного места/);
});

test('receiver stops the transfer when writer.close() reports a quota error', async () => {
  const storage = new FakeReceiveStorage();
  const quotaError = new Error('quota exceeded on close');
  quotaError.name = 'QuotaExceededError';
  storage.closeError = quotaError;
  const { receiver, sent, ready, errors } = createReceiverWithStorage(storage);

  await feedTransfer(receiver, { content: 'close quota payload' });

  await waitFor(() => errors.length > 0);
  await waitFor(() => storage.abortCalls === 1);

  assert.equal(ready.length, 0);
  assert.equal(hasAck(sent), false);
  assert.match(errors[0].error.message, /недостаточно свободного места/);
});

test('receiver reports a storage creation error and never acknowledges the file', async () => {
  const storageError = new Error('memory-fallback-limit');
  storageError.code = 'memory-fallback-limit';
  storageError.limitBytes = 32 * 1024 * 1024;
  const state = { createCalls: 0 };
  const { receiver, sent, ready, errors } = createReceiver({
    createStorage: async () => {
      state.createCalls += 1;
      throw storageError;
    },
  });

  await feedTransfer(receiver, { content: 'storage creation failure' });

  await waitFor(() => errors.length > 0);

  assert.equal(state.createCalls, 1);
  assert.equal(ready.length, 0);
  assert.equal(hasAck(sent), false);
  assert.match(errors[0].error.message, /не больше/);
});

test('receiver removes the stored file when the transfer store rejects it', async () => {
  const storage = new FakeReceiveStorage();
  const { receiver, sent, ready } = createReceiverWithStorage(storage, {
    onTransferReady: () => false,
  });

  await feedTransfer(receiver, { content: 'rejected by store' });
  await waitFor(() => storage.removeCalls === 1);

  assert.equal(ready.length, 0);
  assert.equal(hasAck(sent), false);
});

test('receiver keeps only bounded pending writes and fails instead of buffering without limit', async () => {
  const gate = createGate();
  const storage = new FakeReceiveStorage();
  storage.onWrite = async (call) => {
    if (call === 1) {
      await gate.promise;
    }
  };
  const { receiver, sent, ready, errors } = createReceiverWithStorage(storage, {
    maxPendingWriteBytes: 10,
  });
  const data = new Uint8Array(12).fill(5);

  receiver.handleData(buildMeta({
    fileSize: data.byteLength,
    sha256: await sha256Hex(data),
  }));

  receiver.handleData(data.slice(0, 4).buffer);
  receiver.handleData(data.slice(4, 8).buffer);
  receiver.handleData(data.slice(8, 12).buffer);

  await waitFor(() => errors.length > 0);

  assert.match(errors[0].error.message, /не успевает сохранять/);
  assert.equal(ready.length, 0);
  assert.equal(hasAck(sent), false);

  gate.release();
  await waitFor(() => storage.abortCalls === 1);
});

test('receiver does not keep an array of every received chunk', async () => {
  const storage = new FakeReceiveStorage();
  const { receiver } = createReceiverWithStorage(storage);

  receiver.handleData(buildMeta({
    fileSize: 1024,
    sha256: await sha256Hex(new Uint8Array([1, 2, 3])),
  }));

  assert.ok(receiver.activeTransfer);
  assert.equal(
    Object.prototype.hasOwnProperty.call(receiver.activeTransfer, 'chunks'),
    false,
  );
  assert.equal(typeof receiver.activeTransfer.hasher.update, 'function');

  receiver.cancelAll();
  await waitFor(() => storage.abortCalls === 1);
});

test('receiver ignores zero-length chunks without queueing write tasks', async () => {
  const storage = new FakeReceiveStorage();
  const { receiver, sent, ready, errors } = createReceiverWithStorage(storage);
  const data = bytesOf('zero length chunks');

  receiver.handleData(buildMeta({
    fileSize: data.byteLength,
    sha256: await sha256Hex(data),
  }));

  receiver.handleData(new ArrayBuffer(0));
  receiver.handleData(new ArrayBuffer(0));
  receiver.handleData(data.buffer);
  receiver.handleData(JSON.stringify({
    type: 'transfer-complete',
    transferId: TRANSFER_ID,
  }));

  await waitFor(() => hasAck(sent));

  assert.equal(storage.writeCalls, 1);
  assert.equal(ready.length, 1);
  assert.equal(errors.length, 0);
});

test('receiver caps the number of outstanding write tasks', async () => {
  const gate = createGate();
  const storage = new FakeReceiveStorage();
  storage.onWrite = async (call) => {
    if (call === 1) {
      await gate.promise;
    }
  };
  const { receiver, sent, ready, errors } = createReceiverWithStorage(storage, {
    maxPendingWrites: 2,
  });
  const data = new Uint8Array(12).fill(9);

  receiver.handleData(buildMeta({
    fileSize: data.byteLength,
    sha256: await sha256Hex(data),
  }));

  receiver.handleData(data.slice(0, 4).buffer);
  receiver.handleData(data.slice(4, 8).buffer);
  receiver.handleData(data.slice(8, 12).buffer);

  await waitFor(() => errors.length > 0);

  assert.match(errors[0].error.message, /не успевает сохранять/);
  assert.equal(ready.length, 0);
  assert.equal(hasAck(sent), false);

  gate.release();
  await waitFor(() => storage.abortCalls === 1);
});

test('receiver exposes the memory fallback as a Blob only for bounded files', async () => {
  const storage = new FakeReceiveStorage({ kind: 'memory' });
  storage.close = async function closeMemory() {
    this.closeCalls += 1;
    this.closed = true;
    this.file = new Blob(this.writes, { type: 'application/octet-stream' });
    return { blob: this.file, size: this.size };
  };
  const { receiver, sent, ready } = createReceiverWithStorage(storage);

  await feedTransfer(receiver, { content: 'memory fallback payload' });
  await waitFor(() => hasAck(sent));

  assert.equal(ready.length, 1);
  assert.equal(ready[0].storage, 'memory');
  assert.equal(ready[0].opfsPath, '');
  assert.ok(ready[0].blob instanceof Blob);
  assert.equal(ready[0].blob.size, bytesOf('memory fallback payload').byteLength);
});
