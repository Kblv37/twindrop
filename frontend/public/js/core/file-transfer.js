import { createTransferId, formatBytes, sanitizeFileName, yieldToBrowser } from './utils.js';

const CONTROL_TYPES = {
  META: 'transfer-meta',
  PROGRESS: 'transfer-progress',
  COMPLETE: 'transfer-complete',
  COMPLETE_ACK: 'transfer-complete-ack',
  ERROR: 'transfer-error',
};

function isValidSha256(value) {
  return typeof value === 'string' && value.length === 64 && /^[0-9a-f]{64}$/i.test(value);
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
    maxFileSizeBytes,
    maxFilesPerTransfer,
    onProgress,
    onRemoteProgress,
    onFileStart,
    onFileComplete,
    onAllComplete,
  }) {
    this.getChannel = getChannel;
    this.maxFileSizeBytes = maxFileSizeBytes;
    this.maxFilesPerTransfer = maxFilesPerTransfer;
    this.onProgress = onProgress;
    this.onRemoteProgress = onRemoteProgress;
    this.onFileStart = onFileStart;
    this.onFileComplete = onFileComplete;
    this.onAllComplete = onAllComplete;
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
    try {
      if (channel?.readyState === 'open') {
        channel.send(JSON.stringify(payload));
      }
    } catch {
      // A closing data channel should not mask the original transfer error.
    }
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
      const integrity = controlMessage.integrity === 'verified' ? 'verified' : 'unknown';
      this.onRemoteProgress?.({
        stage: 'complete',
        transferId: controlMessage.transferId,
        fileName: sanitizeFileName(controlMessage.fileName || ''),
        receivedBytes: Number(controlMessage.totalBytes) || 0,
        totalBytes: Number(controlMessage.totalBytes) || 0,
        sha256: controlMessage.sha256,
        integrity,
      });
    }

    if (controlMessage.type === CONTROL_TYPES.ERROR) {
      this.onRemoteProgress?.({
        stage: 'error',
        transferId: controlMessage.transferId,
        fileName: sanitizeFileName(controlMessage.fileName || ''),
        message: controlMessage.message || 'Передача завершилась с ошибкой.',
      });
    }
  }

  async sendFiles(files, chunkSize, { signal } = {}) {
    this.validateFiles(files);
    throwIfAborted(signal);

    const channel = this.getChannel();

    if (!channel || channel.readyState !== 'open') {
      throw new Error('Канал передачи ещё не готов.');
    }

    channel.bufferedAmountLowThreshold = Math.max(256 * 1024, chunkSize * 2);
    const fileCount = files.length;

    for (let fileIndex = 0; fileIndex < files.length; fileIndex += 1) {
      throwIfAborted(signal);

      const file = files[fileIndex];
      const transferId = createTransferId();
      const fileName = sanitizeFileName(file.name);
      let sentBytes = 0;

      const sha256 = await computeFileSha256(file);
      throwIfAborted(signal);

      this.onFileStart?.({
        transferId,
        fileName,
        fileSize: file.size,
        fileIndex,
        fileCount,
      });

      this.sendControlMessage(channel, {
        type: CONTROL_TYPES.META,
        transferId,
        fileName,
        fileSize: file.size,
        mimeType: file.type || 'application/octet-stream',
        chunkSize,
        sha256,
      });

      try {
        for (let offset = 0; offset < file.size; offset += chunkSize) {
          throwIfAborted(signal);

          const slice = file.slice(offset, offset + chunkSize);
          const buffer = await slice.arrayBuffer();
          throwIfAborted(signal);

          if (channel.readyState !== 'open') {
            throw new Error('data-channel-closed');
          }

          await this.waitForWritable(channel, 15000, signal);
          channel.send(buffer);
          sentBytes += buffer.byteLength;

          this.onProgress?.({
            transferId,
            fileName,
            sentBytes,
            totalBytes: file.size,
            fileIndex,
            fileCount,
          });

          if ((offset / chunkSize) % 8 === 0) {
            await yieldToBrowser();
          }
        }
      } catch (error) {
        this.sendControlMessage(channel, {
          type: CONTROL_TYPES.ERROR,
          transferId,
          message: error?.name === 'AbortError'
            ? 'Передача отменена отправителем.'
            : 'Передача файла была прервана.',
        });
        throw error;
      }

      this.sendControlMessage(channel, {
        type: CONTROL_TYPES.COMPLETE,
        transferId,
      });

      this.onFileComplete?.({
        transferId,
        fileName,
        fileSize: file.size,
        fileIndex,
        fileCount,
      });
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
  }) {
    this.sendControl = sendControl;
    this.maxFileSizeBytes = maxFileSizeBytes;
    this.onProgress = onProgress;
    this.onTransferStart = onTransferStart;
    this.onTransferReady = onTransferReady;
    this.onError = onError;
    this.activeTransfer = null;
  }

  resetActiveTransfer() {
    this.activeTransfer = null;
  }

  failTransfer(message, transfer = this.activeTransfer) {
    if (!transfer || this.activeTransfer === transfer) {
      this.resetActiveTransfer();
    }
    this.onError?.(new Error(message), {
      transferId: transfer?.transferId || '',
      fileName: transfer?.fileName || '',
      fileSize: transfer?.fileSize || 0,
    });
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

    this.activeTransfer = {
      transferId: message.transferId,
      fileName,
      fileSize,
      mimeType: typeof message.mimeType === 'string' ? message.mimeType : 'application/octet-stream',
      sha256,
      receivedBytes: 0,
      chunks: [],
      nextProgressThreshold: 256 * 1024,
    };

    this.onTransferStart?.({
      transferId: this.activeTransfer.transferId,
      fileName,
      fileSize,
      mimeType: this.activeTransfer.mimeType,
    });

    this.onProgress?.({
      transferId: this.activeTransfer.transferId,
      fileName,
      mimeType: this.activeTransfer.mimeType,
      receivedBytes: 0,
      totalBytes: fileSize,
    });
  }

  async finalizeTransfer(transfer) {
    if (!transfer || !isValidTransferId(transfer.transferId)) {
      return;
    }

    if (transfer.receivedBytes !== transfer.fileSize) {
      this.failTransfer('Передача завершилась раньше, чем файл был получен полностью.', transfer);
      return;
    }

    const blob = new Blob(transfer.chunks, { type: transfer.mimeType });

    let receivedBuffer;
    let receivedSha256;
    try {
      receivedBuffer = await blob.arrayBuffer();
      receivedSha256 = await computeSha256(receivedBuffer);
    } catch (error) {
      transfer.chunks = [];
      this.sendControl?.({
        type: CONTROL_TYPES.ERROR,
        transferId: transfer.transferId,
        message: 'Ошибка при проверке целостности файла.',
      });
      this.failTransfer('Ошибка при проверке целостности файла.', transfer);
      return;
    }

    if (receivedSha256 !== transfer.sha256) {
      transfer.chunks = [];
      this.sendControl?.({
        type: CONTROL_TYPES.ERROR,
        transferId: transfer.transferId,
        message: 'Проверка целостности не пройдена. Полученный файл отличается от исходного.',
      });
      this.failTransfer('Проверка целостности не пройдена. Полученный файл отличается от исходного.', transfer);
      return;
    }

    this.onTransferReady?.({
      transferId: transfer.transferId,
      fileName: transfer.fileName,
      fileSize: transfer.fileSize,
      mimeType: transfer.mimeType,
      blob,
      href: URL.createObjectURL(blob),
    });

    this.sendControl?.({
      type: CONTROL_TYPES.COMPLETE_ACK,
      transferId: transfer.transferId,
      fileName: transfer.fileName,
      totalBytes: transfer.fileSize,
      sha256: transfer.sha256,
      integrity: 'verified',
    });
  }

  handleChunk(buffer) {
    if (!this.activeTransfer) {
      this.failTransfer('Получены данные без метаданных файла.');
      return;
    }

    if (!(buffer instanceof ArrayBuffer)) {
      this.failTransfer('Получен неподдерживаемый тип чанка.');
      return;
    }

    const nextSize = this.activeTransfer.receivedBytes + buffer.byteLength;

    if (nextSize > this.activeTransfer.fileSize) {
      this.failTransfer('Полученный файл превышает ожидаемый размер.');
      return;
    }

    this.activeTransfer.chunks.push(buffer);
    this.activeTransfer.receivedBytes = nextSize;

    this.onProgress?.({
      transferId: this.activeTransfer.transferId,
      fileName: this.activeTransfer.fileName,
      mimeType: this.activeTransfer.mimeType,
      receivedBytes: this.activeTransfer.receivedBytes,
      totalBytes: this.activeTransfer.fileSize,
    });

    if (
      this.activeTransfer.receivedBytes >= this.activeTransfer.nextProgressThreshold ||
      this.activeTransfer.receivedBytes === this.activeTransfer.fileSize
    ) {
      this.sendControl?.({
        type: CONTROL_TYPES.PROGRESS,
        transferId: this.activeTransfer.transferId,
        fileName: this.activeTransfer.fileName,
        receivedBytes: this.activeTransfer.receivedBytes,
        totalBytes: this.activeTransfer.fileSize,
      });
      this.activeTransfer.nextProgressThreshold = this.activeTransfer.receivedBytes + 256 * 1024;
    }
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
        this.finalizeTransfer(transfer).catch((error) => {
          console.error('Ошибка при завершении передачи:', error);
          this.failTransfer('Внутренняя ошибка при проверке целостности.', transfer);
        });
      }
      return;
    }

    if (controlMessage?.type === CONTROL_TYPES.ERROR) {
      if (this.activeTransfer && controlMessage.transferId === this.activeTransfer.transferId) {
        this.failTransfer(controlMessage.message || 'Отправитель прервал передачу.');
      }
      return;
    }

    if (controlMessage) {
      return;
    }

    this.handleChunk(data);
  }
}
