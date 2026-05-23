import { createTransferId, formatBytes, sanitizeFileName, yieldToBrowser } from './utils.js';

const CONTROL_TYPES = {
  META: 'transfer-meta',
  COMPLETE: 'transfer-complete',
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

export class FileSender {
  constructor({
    getChannel,
    maxFileSizeBytes,
    maxFilesPerTransfer,
    onProgress,
  }) {
    this.getChannel = getChannel;
    this.maxFileSizeBytes = maxFileSizeBytes;
    this.maxFilesPerTransfer = maxFilesPerTransfer;
    this.onProgress = onProgress;
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

  async waitForWritable(channel) {
    if (channel.bufferedAmount <= channel.bufferedAmountLowThreshold) {
      return;
    }

    await new Promise((resolve) => {
      const handleLow = () => {
        channel.removeEventListener('bufferedamountlow', handleLow);
        resolve();
      };

      channel.addEventListener('bufferedamountlow', handleLow, { once: true });
    });
  }

  sendControlMessage(channel, payload) {
    channel.send(JSON.stringify(payload));
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

      for (let offset = 0; offset < file.size; offset += chunkSize) {
        const slice = file.slice(offset, offset + chunkSize);
        const buffer = await slice.arrayBuffer();

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

      this.sendControlMessage(channel, {
        type: CONTROL_TYPES.COMPLETE,
        transferId,
      });
    }
  }
}

export class FileReceiver {
  constructor({
    maxFileSizeBytes,
    onProgress,
    onTransferReady,
    onError,
  }) {
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
    };

    this.onProgress?.({
      fileName,
      receivedBytes: 0,
      totalBytes: fileSize,
    });
  }

  finalizeTransfer(message) {
    if (!this.activeTransfer || message.transferId !== this.activeTransfer.transferId) {
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

    this.handleChunk(data);
  }
}
