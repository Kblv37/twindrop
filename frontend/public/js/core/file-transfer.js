import { createTransferId, formatBytes, sanitizeFileName, yieldToBrowser } from './utils.js';

const CONTROL_TYPES = {
  META: 'transfer-meta',
  PROGRESS: 'transfer-progress',
  COMPLETE: 'transfer-complete',
  COMPLETE_ACK: 'transfer-complete-ack',
  ERROR: 'transfer-error',
};

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

export class FileSender {
  constructor({
    getChannel,
    maxFileSizeBytes,
    maxFilesPerTransfer,
    onProgress,
    onRemoteProgress,
  }) {
    this.getChannel = getChannel;
    this.maxFileSizeBytes = maxFileSizeBytes;
    this.maxFilesPerTransfer = maxFilesPerTransfer;
    this.onProgress = onProgress;
    this.onRemoteProgress = onRemoteProgress;
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

  async waitForWritable(channel, timeoutMs = 15000) {
    if (channel.bufferedAmount <= channel.bufferedAmountLowThreshold) {
      return;
    }

    await new Promise((resolve, reject) => {
      const timer = window.setTimeout(() => {
        channel.removeEventListener('bufferedamountlow', handleLow);
        reject(new Error('data-channel-backpressure-timeout'));
      }, timeoutMs);

      const handleLow = () => {
        window.clearTimeout(timer);
        channel.removeEventListener('bufferedamountlow', handleLow);
        resolve();
      };

      channel.addEventListener('bufferedamountlow', handleLow, { once: true });
    });
  }

  sendControlMessage(channel, payload) {
    channel.send(JSON.stringify(payload));
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
        transferId: controlMessage.transferId,
        fileName: sanitizeFileName(controlMessage.fileName || ''),
        receivedBytes,
        totalBytes,
      });
      return;
    }

    if (controlMessage.type === CONTROL_TYPES.COMPLETE_ACK) {
      this.onRemoteProgress?.({
        transferId: controlMessage.transferId,
        fileName: sanitizeFileName(controlMessage.fileName || ''),
        receivedBytes: Number(controlMessage.totalBytes) || 0,
        totalBytes: Number(controlMessage.totalBytes) || 0,
      });
    }
  }

  async sendFiles(files, chunkSize) {
    this.validateFiles(files);

    const channel = this.getChannel();

    if (!channel || channel.readyState !== 'open') {
      throw new Error('Канал передачи ещё не готов.');
    }

    channel.bufferedAmountLowThreshold = Math.max(256 * 1024, chunkSize * 2);

    for (const file of files) {
      const transferId = createTransferId();
      const fileName = sanitizeFileName(file.name);
      let sentBytes = 0;

      this.sendControlMessage(channel, {
        type: CONTROL_TYPES.META,
        transferId,
        fileName,
        fileSize: file.size,
        mimeType: file.type || 'application/octet-stream',
        chunkSize,
      });

      try {
        for (let offset = 0; offset < file.size; offset += chunkSize) {
          const slice = file.slice(offset, offset + chunkSize);
          const buffer = await slice.arrayBuffer();

          if (channel.readyState !== 'open') {
            throw new Error('data-channel-closed');
          }

          await this.waitForWritable(channel);
          channel.send(buffer);
          sentBytes += buffer.byteLength;

          this.onProgress?.({
            fileName,
            sentBytes,
            totalBytes: file.size,
          });

          if ((offset / chunkSize) % 8 === 0) {
            await yieldToBrowser();
          }
        }
      } catch (error) {
        this.sendControlMessage(channel, {
          type: CONTROL_TYPES.ERROR,
          transferId,
          message: 'Передача файла была прервана.',
        });
        throw error;
      }

      this.sendControlMessage(channel, {
        type: CONTROL_TYPES.COMPLETE,
        transferId,
      });
    }
  }
}

export class FileReceiver {
  constructor({
    sendControl,
    maxFileSizeBytes,
    onProgress,
    onTransferReady,
    onError,
  }) {
    this.sendControl = sendControl;
    this.maxFileSizeBytes = maxFileSizeBytes;
    this.onProgress = onProgress;
    this.onTransferReady = onTransferReady;
    this.onError = onError;
    this.activeTransfer = null;
  }

  resetActiveTransfer() {
    this.activeTransfer = null;
  }

  failTransfer(message) {
    this.resetActiveTransfer();
    this.onError?.(new Error(message));
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

    this.activeTransfer = {
      transferId: message.transferId,
      fileName,
      fileSize,
      mimeType: typeof message.mimeType === 'string' ? message.mimeType : 'application/octet-stream',
      receivedBytes: 0,
      chunks: [],
      nextProgressThreshold: 256 * 1024,
    };

    this.onProgress?.({
      fileName,
      receivedBytes: 0,
      totalBytes: fileSize,
    });
  }

  finalizeTransfer(message) {
    if (!this.activeTransfer || !isValidTransferId(message.transferId) || message.transferId !== this.activeTransfer.transferId) {
      return;
    }

    if (this.activeTransfer.receivedBytes !== this.activeTransfer.fileSize) {
      this.failTransfer('Передача завершилась раньше, чем файл был получен полностью.');
      return;
    }

    const blob = new Blob(this.activeTransfer.chunks, { type: this.activeTransfer.mimeType });

    this.onTransferReady?.({
      fileName: this.activeTransfer.fileName,
      fileSize: this.activeTransfer.fileSize,
      blob,
      href: URL.createObjectURL(blob),
    });

    this.sendControl?.({
      type: CONTROL_TYPES.COMPLETE_ACK,
      transferId: this.activeTransfer.transferId,
      fileName: this.activeTransfer.fileName,
      totalBytes: this.activeTransfer.fileSize,
    });

    this.resetActiveTransfer();
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
      fileName: this.activeTransfer.fileName,
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
      this.finalizeTransfer(controlMessage);
      return;
    }

    if (controlMessage?.type === CONTROL_TYPES.ERROR) {
      this.failTransfer(controlMessage.message || 'Отправитель прервал передачу.');
      return;
    }

    if (controlMessage) {
      return;
    }

    this.handleChunk(data);
  }
}
