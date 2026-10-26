import { createSha256 } from './sha256.js';
import {
  createReceiveStorage,
  receiveStorageErrorMessage,
} from './receive-storage.js';
import { createTransferId, formatBytes, sanitizeFileName, yieldToBrowser } from './utils.js';

const CONTROL_TYPES = {
  META: 'transfer-meta',
  PROGRESS: 'transfer-progress',
  COMPLETE: 'transfer-complete',
  COMPLETE_ACK: 'transfer-complete-ack',
  ERROR: 'transfer-error',
};

// Incoming chunks are queued only up to this many bytes while the previous
// write is still in flight. A slow disk must fail the transfer instead of
// turning the receive path into an unbounded in-memory buffer.
const MAX_PENDING_WRITE_BYTES = 16 * 1024 * 1024;
// A byte window alone is not enough: a peer sending tiny chunks could queue
// millions of write tasks while staying below the byte limit. Cap the number
// of outstanding writes as well.
const MAX_PENDING_WRITES = 1024;

// Used only when the browser does not expose RTCSctpTransport.maxMessageSize.
// 64 KiB is the most conservative DataChannel payload size supported by the
// browsers this application targets.
const SAFE_FALLBACK_CHUNK_SIZE = 64 * 1024;

const ACK_INTEGRITY_ERROR = 'Получатель не подтвердил целостность файла. Файл оставлен в очереди.';
const ACK_MISMATCH_ERROR = 'Получатель вернул некорректное подтверждение файла. Файл оставлен в очереди.';
const SEND_FAILED_ERROR = 'Не удалось отправить данные по P2P-каналу. Проверьте соединение и повторите передачу.';

function isValidSha256(value) {
  return typeof value === 'string' && value.length === 64 && /^[0-9a-f]{64}$/i.test(value);
}

function createAckError(message) {
  const error = new Error(message);
  error.code = 'ack-integrity-failed';
  return error;
}

function createSendError() {
  const error = new Error(SEND_FAILED_ERROR);
  error.code = 'data-channel-send-failed';
  return error;
}

async function computeSha256(buffer) {
  const hashBuffer = await crypto.subtle.digest('SHA-256', buffer);
  const hashArray = new Uint8Array(hashBuffer);
  return Array.from(hashArray, (b) => b.toString(16).padStart(2, '0')).join('');
}

async function computeFileSha256(file) {
  const buffer = await file.arrayBuffer();
  return computeSha256(buffer);
}

function isControlMessage(value) {
  if (typeof value !== 'string') {
    return null;
  }

  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function isValidTransferId(value) {
  return typeof value === 'string' && value.length >= 8 && value.length <= 128;
}

function createAbortError() {
  return new DOMException('Передача отменена.', 'AbortError');
}

function throwIfAborted(signal) {
  if (signal?.aborted) {
    throw createAbortError();
  }
}

export class FileSender {
  constructor({
    getChannel,
    getMaxMessageSize,
    maxFileSizeBytes,
    maxFilesPerTransfer,
    onProgress,
    onRemoteProgress,
    onFileStart,
    onFileComplete,
    onAllComplete,
  }) {
    this.getChannel = getChannel;
    this.getMaxMessageSize = getMaxMessageSize;
    this.maxFileSizeBytes = maxFileSizeBytes;
    this.maxFilesPerTransfer = maxFilesPerTransfer;
    this.onProgress = onProgress;
    this.onRemoteProgress = onRemoteProgress;
    this.onFileStart = onFileStart;
    this.onFileComplete = onFileComplete;
    this.onAllComplete = onAllComplete;
    this.ackWaiters = new Map();
    this.activeSend = null;
  }

  resolveChunkSize(requestedChunkSize) {
    const requested = Math.floor(Number(requestedChunkSize));
    const safeRequested = requested > 0 ? requested : 128 * 1024;
    let maxMessageSize = 0;

    try {
      maxMessageSize = Number(this.getMaxMessageSize?.());
    } catch {
      maxMessageSize = 0;
    }

    if (!Number.isFinite(maxMessageSize) || maxMessageSize <= 0) {
      return Math.min(safeRequested, SAFE_FALLBACK_CHUNK_SIZE);
    }

    return Math.max(1, Math.min(safeRequested, Math.floor(maxMessageSize)));
  }

  validateFiles(files) {
    if (!files || files.length === 0) {
      throw new Error('Выберите хотя бы один файл.');
    }

    if (files.length > this.maxFilesPerTransfer) {
      throw new Error(`Можно отправить не больше ${this.maxFilesPerTransfer} файлов за раз.`);
    }

    for (const file of files) {
      if (file.size <= 0) {
        throw new Error(`Файл ${sanitizeFileName(file.name)} пустой.`);
      }

      if (file.size > this.maxFileSizeBytes) {
        throw new Error(`Файл ${sanitizeFileName(file.name)} превышает лимит ${formatBytes(this.maxFileSizeBytes)}.`);
      }
    }
  }

  async waitForWritable(channel, timeoutMs = 15000, signal) {
    throwIfAborted(signal);

    if (channel.bufferedAmount <= channel.bufferedAmountLowThreshold) {
      return;
    }

    await new Promise((resolve, reject) => {
      const cleanup = () => {
        window.clearTimeout(timer);
        channel.removeEventListener('bufferedamountlow', handleLow);
        signal?.removeEventListener('abort', handleAbort);
      };

      const timer = window.setTimeout(() => {
        cleanup();
        reject(new Error('data-channel-backpressure-timeout'));
      }, timeoutMs);

      const handleLow = () => {
        cleanup();
        resolve();
      };

      const handleAbort = () => {
        cleanup();
        reject(createAbortError());
      };

      channel.addEventListener('bufferedamountlow', handleLow, { once: true });
      signal?.addEventListener('abort', handleAbort, { once: true });
    });
  }

  sendControlMessage(channel, payload) {
    if (!channel || channel.readyState !== 'open') {
      return false;
    }

    try {
      channel.send(JSON.stringify(payload));
      return true;
    } catch {
      // A closing data channel should not mask the original transfer error.
      return false;
    }
  }

  ackTimeoutFor(fileSize) {
    // Large files can take a while to hash on the receiver. Keep a generous
    // size-dependent timeout, but never wait indefinitely for a confirmation.
    const hashAllowanceMs = Math.ceil((Number(fileSize) || 0) / (4 * 1024 * 1024)) * 1000;
    return Math.max(120000, Math.min(600000, hashAllowanceMs + 60000));
  }

  resolveAck(transferId, value) {
    const waiter = this.ackWaiters.get(transferId);

    if (!waiter) {
      return false;
    }

    this.ackWaiters.delete(transferId);
    window.clearTimeout(waiter.timer);
    waiter.signal?.removeEventListener('abort', waiter.handleAbort);
    waiter.resolve(value);
    return true;
  }

  rejectAck(transferId, error) {
    const waiter = this.ackWaiters.get(transferId);

    if (!waiter) {
      return false;
    }

    this.ackWaiters.delete(transferId);
    window.clearTimeout(waiter.timer);
    waiter.signal?.removeEventListener('abort', waiter.handleAbort);
    waiter.reject(error);
    return true;
  }

  rejectAllAcks(error) {
    for (const transferId of [...this.ackWaiters.keys()]) {
      this.rejectAck(transferId, error);
    }
  }

  waitForAck(transferId, {
    timeoutMs,
    signal,
    fileSize,
    sha256,
  } = {}) {
    throwIfAborted(signal);

    return new Promise((resolve, reject) => {
      const waiter = {
        resolve,
        reject,
        signal,
        fileSize,
        sha256,
        handleAbort: null,
        timer: null,
      };

      waiter.handleAbort = () => {
        this.rejectAck(transferId, createAbortError());
      };

      waiter.timer = window.setTimeout(() => {
        this.rejectAck(
          transferId,
          new Error('Получатель не подтвердил получение файла. Файл оставлен в очереди.'),
        );
      }, timeoutMs);

      this.ackWaiters.set(transferId, waiter);
      signal?.addEventListener('abort', waiter.handleAbort, { once: true });
    });
  }

  handleData(data) {
    const controlMessage = isControlMessage(data);

    if (!controlMessage || !isValidTransferId(controlMessage.transferId)) {
      return;
    }

    if (controlMessage.type === CONTROL_TYPES.PROGRESS) {
      const receivedBytes = Number(controlMessage.receivedBytes);
      const totalBytes = Number(controlMessage.totalBytes);

      if (!Number.isFinite(receivedBytes) || !Number.isFinite(totalBytes) || totalBytes <= 0) {
        return;
      }

      this.onRemoteProgress?.({
        stage: 'progress',
        transferId: controlMessage.transferId,
        fileName: sanitizeFileName(controlMessage.fileName || ''),
        receivedBytes,
        totalBytes,
      });
      return;
    }

    if (controlMessage.type === CONTROL_TYPES.COMPLETE_ACK) {
      const waiter = this.ackWaiters.get(controlMessage.transferId);

      // Repeated, late and unknown ACKs must never affect the queue or the
      // history. Only an ACK that belongs to a transfer currently waiting for
      // confirmation is considered.
      if (!waiter) {
        return;
      }

      const integrity = controlMessage.integrity === 'verified' ? 'verified' : 'unknown';
      const totalBytes = Number(controlMessage.totalBytes);
      const sha256 = typeof controlMessage.sha256 === 'string'
        ? controlMessage.sha256.toLowerCase()
        : '';
      const matchesTransfer = Number.isFinite(totalBytes)
        && totalBytes === waiter.fileSize
        && sha256 === String(waiter.sha256 || '').toLowerCase();

      if (integrity !== 'verified') {
        this.rejectAck(controlMessage.transferId, createAckError(ACK_INTEGRITY_ERROR));
        return;
      }

      if (!matchesTransfer) {
        this.rejectAck(controlMessage.transferId, createAckError(ACK_MISMATCH_ERROR));
        return;
      }

      if (!this.resolveAck(controlMessage.transferId, {
        transferId: controlMessage.transferId,
        integrity,
      })) {
        return;
      }

      this.onRemoteProgress?.({
        stage: 'complete',
        transferId: controlMessage.transferId,
        fileName: sanitizeFileName(controlMessage.fileName || ''),
        receivedBytes: totalBytes,
        totalBytes,
        sha256,
        integrity,
      });
      return;
    }

    if (controlMessage.type === CONTROL_TYPES.ERROR) {
      const message = controlMessage.message || 'Передача завершилась с ошибкой.';

      // The receiver can reject the file before the sender reaches COMPLETE,
      // for example when OPFS quota is exhausted. Stop sending immediately
      // instead of wasting bandwidth until the ACK timeout.
      if (this.activeSend && this.activeSend.transferId === controlMessage.transferId) {
        const error = new Error(message);
        error.code = 'remote-receive-error';
        this.activeSend.remoteError = error;
        this.activeSend.controller.abort();
        this.rejectAck(controlMessage.transferId, error);
        return;
      }

      const rejected = this.rejectAck(controlMessage.transferId, new Error(message));

      // Ignore errors that belong to a transfer this sender is no longer
      // waiting for (for example, a late error after cancellation).
      if (rejected) {
        this.onRemoteProgress?.({
          stage: 'error',
          transferId: controlMessage.transferId,
          fileName: sanitizeFileName(controlMessage.fileName || ''),
          message,
        });
      }
    }
  }

  async sendFiles(files, chunkSize, { signal } = {}) {
    this.validateFiles(files);
    throwIfAborted(signal);

    const channel = this.getChannel();

    if (!channel || channel.readyState !== 'open') {
      throw new Error('Канал передачи ещё не готов.');
    }

    const effectiveChunkSize = this.resolveChunkSize(chunkSize);
    channel.bufferedAmountLowThreshold = Math.max(256 * 1024, effectiveChunkSize * 2);
    const fileCount = files.length;

    try {
      for (let fileIndex = 0; fileIndex < files.length; fileIndex += 1) {
        throwIfAborted(signal);

        const file = files[fileIndex];
        const transferId = createTransferId();
        const fileName = sanitizeFileName(file.name);
        const fileController = new AbortController();
        const handleExternalAbort = () => fileController.abort();

        if (signal) {
          if (signal.aborted) {
            throw createAbortError();
          }

          signal.addEventListener('abort', handleExternalAbort, { once: true });
        }

        const sendState = {
          transferId,
          controller: fileController,
          remoteError: null,
        };
        let sentBytes = 0;

        try {
          // Hashing reads the whole file and is not abortable through
          // WebCrypto. The signal is checked immediately after it resolves so
          // a canceled transfer never starts sending metadata or chunks.
          const sha256 = await computeFileSha256(file);
          throwIfAborted(fileController.signal);

          this.activeSend = sendState;

          this.onFileStart?.({
            transferId,
            fileName,
            fileSize: file.size,
            fileIndex,
            fileCount,
          });

          const metaSent = this.sendControlMessage(channel, {
            type: CONTROL_TYPES.META,
            transferId,
            fileName,
            fileSize: file.size,
            mimeType: file.type || 'application/octet-stream',
            chunkSize: effectiveChunkSize,
            sha256,
          });

          if (!metaSent) {
            throw new Error('Не удалось отправить метаданные файла: канал передачи закрыт.');
          }

          try {
            for (let offset = 0; offset < file.size; offset += effectiveChunkSize) {
              throwIfAborted(fileController.signal);

              const slice = file.slice(offset, offset + effectiveChunkSize);
              const buffer = await slice.arrayBuffer();
              throwIfAborted(fileController.signal);

              if (channel.readyState !== 'open') {
                throw new Error('data-channel-closed');
              }

              await this.waitForWritable(channel, 15000, fileController.signal);

              try {
                channel.send(buffer);
              } catch {
                throw createSendError();
              }

              sentBytes += buffer.byteLength;

              this.onProgress?.({
                transferId,
                fileName,
                sentBytes,
                totalBytes: file.size,
                fileIndex,
                fileCount,
              });

              if ((offset / effectiveChunkSize) % 8 === 0) {
                await yieldToBrowser();
              }
            }
          } catch (error) {
            const remoteError = sendState.remoteError;

            if (!remoteError) {
              this.sendControlMessage(channel, {
                type: CONTROL_TYPES.ERROR,
                transferId,
                message: error?.name === 'AbortError'
                  ? 'Передача отменена отправителем.'
                  : (error?.code === 'data-channel-send-failed'
                    ? SEND_FAILED_ERROR
                    : 'Передача файла была прервана.'),
              });
            }

            throw remoteError || error;
          }

          try {
            // Register the waiter before sending COMPLETE so an immediate ACK
            // cannot arrive before the sender starts waiting for it.
            const ackPromise = this.waitForAck(transferId, {
              timeoutMs: this.ackTimeoutFor(file.size),
              signal: fileController.signal,
              fileSize: file.size,
              sha256,
            });

            const completeSent = this.sendControlMessage(channel, {
              type: CONTROL_TYPES.COMPLETE,
              transferId,
            });

            if (!completeSent) {
              throw new Error('Не удалось отправить подтверждение завершения: канал передачи закрыт.');
            }

            this.onFileComplete?.({
              transferId,
              fileName,
              fileSize: file.size,
              fileIndex,
              fileCount,
            });

            // Do not remove a file from the persisted queue or start the next
            // one until the receiver has verified and explicitly acknowledged it.
            await ackPromise;
          } catch (error) {
            const remoteError = sendState.remoteError;

            if (!remoteError) {
              this.sendControlMessage(channel, {
                type: CONTROL_TYPES.ERROR,
                transferId,
                message: error?.name === 'AbortError'
                  ? 'Передача отменена отправителем.'
                  : (error?.message || 'Передача не была подтверждена получателем.'),
              });
            }

            throw remoteError || error;
          }
        } finally {
          if (this.activeSend === sendState) {
            this.activeSend = null;
          }

          signal?.removeEventListener('abort', handleExternalAbort);
        }
      }
    } finally {
      this.activeSend = null;
      this.rejectAllAcks(createAbortError());
    }

    this.onAllComplete?.({ fileCount });
  }
}

export class FileReceiver {
  constructor({
    sendControl,
    maxFileSizeBytes,
    onProgress,
    onTransferStart,
    onTransferReady,
    onError,
    createStorage = createReceiveStorage,
    maxPendingWriteBytes = MAX_PENDING_WRITE_BYTES,
    maxPendingWrites = MAX_PENDING_WRITES,
  }) {
    this.sendControl = sendControl;
    this.maxFileSizeBytes = maxFileSizeBytes;
    this.onProgress = onProgress;
    this.onTransferStart = onTransferStart;
    this.onTransferReady = onTransferReady;
    this.onError = onError;
    this.createStorage = createStorage;
    this.maxPendingWriteBytes = maxPendingWriteBytes;
    this.maxPendingWrites = maxPendingWrites;
    this.activeTransfer = null;
    this.finalizingTransfers = new Map();
    this.discardIncomingChunks = false;
  }

  resetActiveTransfer() {
    this.activeTransfer = null;
  }

  abortTransfer(transfer) {
    if (!transfer) {
      return;
    }

    transfer.aborted = true;
    transfer.pendingBytes = 0;
    transfer.pendingWrites = 0;

    const storage = transfer.storage;
    transfer.storage = null;

    if (storage) {
      Promise.resolve()
        .then(() => storage.abort())
        .catch(() => {});
      return;
    }

    if (transfer.storagePromise) {
      transfer.storagePromise
        .then((resolved) => resolved?.abort())
        .catch(() => {});
    }
  }

  reportFailure(message, transfer, { notifyRemote = true } = {}) {
    if (!transfer || transfer.failureReported) {
      return;
    }

    transfer.failureReported = true;
    transfer.aborted = true;

    if (this.activeTransfer === transfer) {
      this.activeTransfer = null;
      this.discardIncomingChunks = true;
    } else if (!this.activeTransfer) {
      this.discardIncomingChunks = true;
    }

    this.abortTransfer(transfer);

    if (notifyRemote && isValidTransferId(transfer.transferId)) {
      this.sendControl?.({
        type: CONTROL_TYPES.ERROR,
        transferId: transfer.transferId,
        message,
      });
    }

    this.onError?.(new Error(message), {
      transferId: transfer.transferId || '',
      fileName: transfer.fileName || '',
      fileSize: transfer.fileSize || 0,
    });
  }

  failTransfer(message, transfer = this.activeTransfer, options = {}) {
    this.reportFailure(message, transfer, options);
  }

  cancelAll() {
    this.discardIncomingChunks = true;

    const active = this.activeTransfer;
    this.activeTransfer = null;

    if (active) {
      this.abortTransfer(active);
    }

    for (const { controller, transfer } of this.finalizingTransfers.values()) {
      controller.abort();
      this.abortTransfer(transfer);
    }

    this.finalizingTransfers.clear();
  }

  handleMeta(message) {
    if (!isValidTransferId(message.transferId)) {
      this.failTransfer('Получен некорректный идентификатор передачи.');
      return;
    }

    const fileName = sanitizeFileName(message.fileName);
    const fileSize = Number(message.fileSize);

    if (!Number.isFinite(fileSize) || fileSize <= 0 || fileSize > this.maxFileSizeBytes) {
      this.failTransfer('Получены некорректные метаданные файла.');
      return;
    }

    const sha256 = message.sha256;
    if (!isValidSha256(sha256)) {
      this.failTransfer('Получены некорректные метаданные файла: отсутствует или неверный SHA-256.');
      return;
    }

    if (this.activeTransfer) {
      // A sender must finish the previous file before starting a new one. If
      // it does not, clean up the old partial file instead of leaking it.
      this.reportFailure(
        'Получены новые метаданные до завершения предыдущей передачи.',
        this.activeTransfer,
        { notifyRemote: false },
      );
    }

    const transfer = {
      transferId: message.transferId,
      fileName,
      fileSize,
      mimeType: typeof message.mimeType === 'string' ? message.mimeType : 'application/octet-stream',
      sha256,
      receivedBytes: 0,
      writtenBytes: 0,
      pendingBytes: 0,
      pendingWrites: 0,
      nextProgressThreshold: 256 * 1024,
      hasher: createSha256(),
      storage: null,
      storagePromise: null,
      writeChain: Promise.resolve(),
      writeError: null,
      aborted: false,
      failureReported: false,
    };

    this.discardIncomingChunks = false;
    this.activeTransfer = transfer;

    this.onTransferStart?.({
      transferId: transfer.transferId,
      fileName,
      fileSize,
      mimeType: transfer.mimeType,
    });

    this.onProgress?.({
      transferId: transfer.transferId,
      fileName,
      mimeType: transfer.mimeType,
      receivedBytes: 0,
      totalBytes: fileSize,
    });

    transfer.storagePromise = Promise.resolve()
      .then(() => this.createStorage({
        transferId: transfer.transferId,
        fileName,
        fileSize,
        mimeType: transfer.mimeType,
      }))
      .then((storage) => {
        if (transfer.aborted) {
          Promise.resolve()
            .then(() => storage.abort())
            .catch(() => {});
          return null;
        }

        transfer.storage = storage;
        return storage;
      })
      .catch((error) => {
        transfer.writeError = error;

        if (!transfer.aborted) {
          this.reportFailure(receiveStorageErrorMessage(error), transfer);
        }

        return null;
      });

    transfer.writeChain = transfer.storagePromise.then(() => undefined);
  }

  emitProgress(transfer) {
    if (transfer.aborted) {
      return;
    }

    const receivedBytes = transfer.writtenBytes;

    this.onProgress?.({
      transferId: transfer.transferId,
      fileName: transfer.fileName,
      mimeType: transfer.mimeType,
      receivedBytes,
      totalBytes: transfer.fileSize,
    });

    if (
      receivedBytes >= transfer.nextProgressThreshold
      || receivedBytes === transfer.fileSize
    ) {
      this.sendControl?.({
        type: CONTROL_TYPES.PROGRESS,
        transferId: transfer.transferId,
        fileName: transfer.fileName,
        receivedBytes,
        totalBytes: transfer.fileSize,
      });
      transfer.nextProgressThreshold = receivedBytes + 256 * 1024;
    }
  }

  async finalizeTransfer(transfer) {
    if (!transfer || !isValidTransferId(transfer.transferId)) {
      return;
    }

    const controller = new AbortController();
    this.finalizingTransfers.set(transfer.transferId, { controller, transfer });

    try {
      throwIfAborted(controller.signal);

      // COMPLETE is ordered after all binary chunks, but the disk writes are
      // asynchronous. Wait for every queued write before closing the file.
      await transfer.writeChain;
      throwIfAborted(controller.signal);

      if (transfer.writeError) {
        this.reportFailure(receiveStorageErrorMessage(transfer.writeError), transfer);
        return;
      }

      if (transfer.receivedBytes !== transfer.fileSize) {
        this.reportFailure('Передача завершилась раньше, чем файл был получен полностью.', transfer);
        return;
      }

      if (transfer.writtenBytes !== transfer.fileSize) {
        this.reportFailure('Не все полученные данные были записаны в хранилище.', transfer);
        return;
      }

      if (!transfer.storage) {
        this.reportFailure('Хранилище для полученного файла недоступно.', transfer);
        return;
      }

      const result = await transfer.storage.close();
      throwIfAborted(controller.signal);

      if (Number(result?.size) !== transfer.fileSize) {
        this.reportFailure('Размер сохранённого файла не совпадает с ожидаемым.', transfer);
        return;
      }

      const receivedSha256 = transfer.hasher.digestHex();

      if (receivedSha256 !== transfer.sha256) {
        this.reportFailure(
          'Проверка целостности не пройдена. Полученный файл отличается от исходного.',
          transfer,
        );
        return;
      }

      const file = await transfer.storage.getFile();
      throwIfAborted(controller.signal);

      if (!file || Number(file.size) !== transfer.fileSize) {
        this.reportFailure('Сохранённый файл недоступен для скачивания.', transfer);
        return;
      }

      const accepted = this.onTransferReady?.({
        transferId: transfer.transferId,
        fileName: transfer.fileName,
        fileSize: transfer.fileSize,
        mimeType: transfer.mimeType,
        sha256: receivedSha256,
        storage: transfer.storage.kind,
        opfsPath: transfer.storage.path || '',
        blob: transfer.storage.kind === 'memory' ? file : null,
      });

      if (accepted === false) {
        await transfer.storage.remove();
        return;
      }

      // A closing channel must not turn a verified, downloadable file into a
      // failure. The sender will keep the file in its queue and can retry.
      try {
        this.sendControl?.({
          type: CONTROL_TYPES.COMPLETE_ACK,
          transferId: transfer.transferId,
          fileName: transfer.fileName,
          totalBytes: transfer.fileSize,
          sha256: transfer.sha256,
          integrity: 'verified',
        });
      } catch {}
    } catch (error) {
      // A canceled finalization must not create a download link or send a
      // late success ACK. The UI state is updated by cancelAll()/onError.
      if (!transfer.aborted && error?.name !== 'AbortError') {
        this.reportFailure(receiveStorageErrorMessage(error), transfer);
      }
    } finally {
      this.finalizingTransfers.delete(transfer.transferId);
    }
  }

  handleChunk(buffer) {
    if (!this.activeTransfer) {
      if (this.discardIncomingChunks) {
        return;
      }

      this.failTransfer('Получены данные без метаданных файла.');
      return;
    }

    if (!(buffer instanceof ArrayBuffer)) {
      this.failTransfer('Получен неподдерживаемый тип чанка.');
      return;
    }

    const transfer = this.activeTransfer;

    if (transfer.aborted || transfer.writeError) {
      return;
    }

    const length = buffer.byteLength;

    if (length === 0) {
      // A zero-length message would otherwise create an unbounded chain of
      // no-op write tasks without consuming the byte window.
      return;
    }

    const nextSize = transfer.receivedBytes + length;

    if (nextSize > transfer.fileSize) {
      this.failTransfer('Полученный файл превышает ожидаемый размер.', transfer);
      return;
    }

    if (
      transfer.pendingBytes + length > this.maxPendingWriteBytes
      || transfer.pendingWrites >= this.maxPendingWrites
    ) {
      this.failTransfer(
        'Устройство не успевает сохранять файл. Приём остановлен, чтобы не переполнить память.',
        transfer,
      );
      return;
    }

    transfer.receivedBytes = nextSize;
    transfer.pendingBytes += length;
    transfer.pendingWrites += 1;

    transfer.writeChain = transfer.writeChain.then(async () => {
      try {
        if (transfer.aborted || transfer.writeError) {
          return;
        }

        if (!transfer.storage) {
          // The storage promise failed and already reported the error.
          return;
        }

        try {
          await transfer.storage.write(buffer);
        } catch (error) {
          transfer.writeError = error;
          transfer.pendingBytes = 0;

          if (!transfer.aborted) {
            this.reportFailure(receiveStorageErrorMessage(error), transfer);
          }

          return;
        }

        // cancelAll() may have aborted the storage while the write was in
        // flight. Never advance the hash or progress after cancellation.
        if (transfer.aborted) {
          return;
        }

        transfer.writtenBytes += length;
        transfer.hasher.update(buffer);
        this.emitProgress(transfer);
      } finally {
        transfer.pendingWrites = Math.max(0, transfer.pendingWrites - 1);

        if (!transfer.aborted) {
          transfer.pendingBytes = Math.max(0, transfer.pendingBytes - length);
        }
      }
    });
  }

  handleData(data) {
    const controlMessage = isControlMessage(data);

    if (controlMessage?.type === CONTROL_TYPES.META) {
      this.handleMeta(controlMessage);
      return;
    }

    if (controlMessage?.type === CONTROL_TYPES.COMPLETE) {
      if (this.activeTransfer && controlMessage.transferId === this.activeTransfer.transferId) {
        const transfer = this.activeTransfer;
        // Free the receiver for the next metadata/chunks while the completed file is verified.
        this.activeTransfer = null;
        this.discardIncomingChunks = true;
        this.finalizeTransfer(transfer).catch((error) => {
          console.error('Ошибка при завершении передачи:', error);

          if (!transfer.failureReported) {
            this.reportFailure('Внутренняя ошибка при проверке целостности.', transfer);
          }
        });
      }
      return;
    }

    if (controlMessage?.type === CONTROL_TYPES.ERROR) {
      const message = controlMessage.message || 'Отправитель прервал передачу.';
      const finalizing = this.finalizingTransfers.get(controlMessage.transferId);

      if (finalizing) {
        // The sender canceled while the receiver was closing or verifying the
        // file. Stop finalization and make sure no success ACK is sent.
        finalizing.controller.abort();
        this.reportFailure(message, finalizing.transfer, { notifyRemote: false });
        this.finalizingTransfers.delete(controlMessage.transferId);
        return;
      }

      if (this.activeTransfer && controlMessage.transferId === this.activeTransfer.transferId) {
        this.reportFailure(message, this.activeTransfer, { notifyRemote: false });
      }
      return;
    }

    if (controlMessage) {
      return;
    }

    this.handleChunk(data);
  }
}
