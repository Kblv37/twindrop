import { sanitizeFileName, yieldToBrowser } from './utils.js';

const READ_CHUNK_SIZE = 1024 * 1024;
const ZIP32_LIMIT = 0xffffffff;
const UTF8_FLAG = 0x0800;
const STORE_METHOD = 0;

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    table[index] = value >>> 0;
  }
  return table;
})();

function createAbortError() {
  return new DOMException('Архивация отменена.', 'AbortError');
}

function throwIfAborted(signal) {
  if (signal?.aborted) {
    throw createAbortError();
  }
}

function crc32Update(crc, bytes) {
  let value = crc;
  for (let index = 0; index < bytes.length; index += 1) {
    value = (value >>> 8) ^ CRC_TABLE[(value ^ bytes[index]) & 0xff];
  }
  return value;
}

function getDosDateTime(value) {
  const date = value instanceof Date && !Number.isNaN(value.getTime()) ? value : new Date();
  const year = Math.max(1980, date.getFullYear());
  const dosTime = (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2);
  const dosDate = ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate();
  return { dosTime, dosDate };
}

function writeUint16(view, offset, value) {
  view.setUint16(offset, value & 0xffff, true);
}

function writeUint32(view, offset, value) {
  view.setUint32(offset, value >>> 0, true);
}

function createLocalHeader({ fileNameBytes, crc, size, dosTime, dosDate }) {
  const header = new Uint8Array(30 + fileNameBytes.length);
  const view = new DataView(header.buffer);
  writeUint32(view, 0, 0x04034b50);
  writeUint16(view, 4, 20);
  writeUint16(view, 6, UTF8_FLAG);
  writeUint16(view, 8, STORE_METHOD);
  writeUint16(view, 10, dosTime);
  writeUint16(view, 12, dosDate);
  writeUint32(view, 14, crc);
  writeUint32(view, 18, size);
  writeUint32(view, 22, size);
  writeUint16(view, 26, fileNameBytes.length);
  writeUint16(view, 28, 0);
  header.set(fileNameBytes, 30);
  return header;
}

function createCentralHeader(entry) {
  const header = new Uint8Array(46 + entry.fileNameBytes.length);
  const view = new DataView(header.buffer);
  writeUint32(view, 0, 0x02014b50);
  writeUint16(view, 4, 20);
  writeUint16(view, 6, 20);
  writeUint16(view, 8, UTF8_FLAG);
  writeUint16(view, 10, STORE_METHOD);
  writeUint16(view, 12, entry.dosTime);
  writeUint16(view, 14, entry.dosDate);
  writeUint32(view, 16, entry.crc);
  writeUint32(view, 20, entry.size);
  writeUint32(view, 24, entry.size);
  writeUint16(view, 28, entry.fileNameBytes.length);
  writeUint16(view, 30, 0);
  writeUint16(view, 32, 0);
  writeUint16(view, 34, 0);
  writeUint16(view, 36, 0);
  writeUint32(view, 38, 0);
  writeUint32(view, 42, entry.localOffset);
  header.set(entry.fileNameBytes, 46);
  return header;
}

function createEndOfCentralDirectory(entries, centralSize, centralOffset) {
  const footer = new Uint8Array(22);
  const view = new DataView(footer.buffer);
  writeUint32(view, 0, 0x06054b50);
  writeUint16(view, 4, 0);
  writeUint16(view, 6, 0);
  writeUint16(view, 8, entries);
  writeUint16(view, 10, entries);
  writeUint32(view, 12, centralSize);
  writeUint32(view, 16, centralOffset);
  writeUint16(view, 20, 0);
  return footer;
}

function makeUniqueName(fileName, usedNames) {
  const safeName = sanitizeFileName(fileName) || 'file';
  if (!usedNames.has(safeName.toLowerCase())) {
    usedNames.add(safeName.toLowerCase());
    return safeName;
  }

  const dot = safeName.lastIndexOf('.');
  const base = dot > 0 ? safeName.slice(0, dot) : safeName;
  const extension = dot > 0 ? safeName.slice(dot) : '';
  let counter = 2;
  let candidate = `${base} (${counter})${extension}`;
  while (usedNames.has(candidate.toLowerCase())) {
    counter += 1;
    candidate = `${base} (${counter})${extension}`;
  }
  usedNames.add(candidate.toLowerCase());
  return candidate;
}

export function buildArchiveName(date = new Date()) {
  const pad = (value) => String(value).padStart(2, '0');
  return `twindrop ${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}-${pad(date.getMinutes())}.zip`;
}

export async function createZipArchive(files, { onProgress, signal, name } = {}) {
  if (!Array.isArray(files) || files.length === 0) {
    throw new Error('Нет файлов для архивации.');
  }

  const totalBytes = files.reduce((sum, file) => sum + (Number(file.size) || 0), 0);
  if (totalBytes <= 0) {
    throw new Error('Выбранные файлы пусты.');
  }

  if (totalBytes > ZIP32_LIMIT - 1024 * 1024) {
    throw new Error('ZIP-архив больше 4 ГБ не поддерживается браузером.');
  }

  const startedAt = performance.now();
  const parts = [];
  const entries = [];
  const usedNames = new Set();
  let processedBytes = 0;
  let completedOffset = 0;
  let centralSize = 0;
  let lastYield = startedAt;

  const emitProgress = ({ fileIndex, fileCount, fileName, currentSize }) => {
    const elapsedSeconds = Math.max(0.05, (performance.now() - startedAt) / 1000);
    const speed = processedBytes / elapsedSeconds;
    const remaining = Math.max(0, totalBytes - processedBytes);
    const etaSeconds = processedBytes > 0 ? remaining / Math.max(1, speed) : null;

    onProgress?.({
      processedBytes,
      totalBytes,
      ratio: totalBytes > 0 ? Math.min(1, processedBytes / totalBytes) : 0,
      preparedFiles: fileIndex,
      totalFiles: fileCount,
      fileName,
      currentSize,
      speed,
      etaSeconds,
    });
  };

  emitProgress({
    fileIndex: 0,
    fileCount: files.length,
    fileName: files[0]?.name || '',
    currentSize: 0,
  });

  for (let index = 0; index < files.length; index += 1) {
    throwIfAborted(signal);

    const file = files[index];
    const entryName = makeUniqueName(file.name, usedNames);
    const fileNameBytes = new TextEncoder().encode(entryName);
    const { dosTime, dosDate } = getDosDateTime(new Date(file.lastModified || Date.now()));
    let crc = 0xffffffff;
    let fileReadBytes = 0;

    for (let offset = 0; offset < file.size; offset += READ_CHUNK_SIZE) {
      throwIfAborted(signal);
      const chunk = file.slice(offset, Math.min(file.size, offset + READ_CHUNK_SIZE));
      const buffer = await chunk.arrayBuffer();
      throwIfAborted(signal);

      crc = crc32Update(crc, new Uint8Array(buffer));
      fileReadBytes += buffer.byteLength;
      processedBytes += buffer.byteLength;

      emitProgress({
        fileIndex: index,
        fileCount: files.length,
        fileName: file.name,
        currentSize: completedOffset + fileReadBytes + centralSize,
      });

      if (performance.now() - lastYield > 30) {
        await yieldToBrowser();
        lastYield = performance.now();
      }
    }

    crc = (crc ^ 0xffffffff) >>> 0;

    const localHeader = createLocalHeader({
      fileNameBytes,
      crc,
      size: file.size,
      dosTime,
      dosDate,
    });

    parts.push(localHeader, file);

    const entry = {
      fileNameBytes,
      crc,
      size: file.size,
      dosTime,
      dosDate,
      localOffset: completedOffset,
    };
    entries.push(entry);
    completedOffset += localHeader.length + file.size;
    centralSize += 46 + fileNameBytes.length;

    emitProgress({
      fileIndex: index + 1,
      fileCount: files.length,
      fileName: file.name,
      currentSize: completedOffset + centralSize,
    });

    await yieldToBrowser();
  }

  throwIfAborted(signal);

  for (const entry of entries) {
    parts.push(createCentralHeader(entry));
  }

  const centralOffset = completedOffset;
  const footer = createEndOfCentralDirectory(entries.length, centralSize, centralOffset);
  parts.push(footer);

  const totalSize = centralOffset + centralSize + footer.length;
  if (totalSize > ZIP32_LIMIT) {
    throw new Error('ZIP-архив больше 4 ГБ не поддерживается браузером.');
  }

  const archiveName = sanitizeFileName(name || buildArchiveName());
  const archiveBlob = new Blob(parts, { type: 'application/zip' });
  const archiveFile = new File([archiveBlob], archiveName, {
    type: 'application/zip',
    lastModified: Date.now(),
  });

  onProgress?.({
    processedBytes: totalBytes,
    totalBytes,
    ratio: 1,
    preparedFiles: files.length,
    totalFiles: files.length,
    fileName: files[files.length - 1]?.name || '',
    currentSize: archiveFile.size,
    speed: totalBytes / Math.max(0.05, (performance.now() - startedAt) / 1000),
    etaSeconds: 0,
  });

  return archiveFile;
}
