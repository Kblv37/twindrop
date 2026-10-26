import { getOpfsFile } from './receive-storage.js';
import { sanitizeFileName } from './utils.js';

const DOWNLOAD_CHUNK_SIZE = 4 * 1024 * 1024;
const OBJECT_URL_TTL_MS = 60_000;

function isUnavailableStorageError(error) {
  return error?.name === 'NotFoundError'
    || error?.code === 'file-unavailable'
    || error?.code === 'opfs-unavailable'
    || error?.code === 'opfs-unsupported'
    || error?.code === 'invalid-opfs-path';
}

export async function resolveReceivedFile(record, { getDirectory } = {}) {
  if (record?.memoryBlob) {
    return record.memoryBlob;
  }

  if (record?.opfsPath) {
    try {
      return await getOpfsFile(record.opfsPath, { getDirectory });
    } catch (error) {
      if (isUnavailableStorageError(error)) {
        throw new Error('Полученный файл больше не доступен в хранилище браузера.');
      }

      throw error;
    }
  }

  throw new Error('Полученный файл больше не доступен.');
}

async function writeBlobToWritable(blob, writable) {
  if (typeof blob.stream === 'function' && typeof writable.getWriter === 'function') {
    // pipeTo streams the file in bounded chunks and closes the writable. It
    // never materializes the whole file as a single ArrayBuffer.
    await blob.stream().pipeTo(writable);
    return;
  }

  const writer = writable.getWriter();

  try {
    for (let offset = 0; offset < blob.size; offset += DOWNLOAD_CHUNK_SIZE) {
      const chunk = blob.slice(offset, Math.min(blob.size, offset + DOWNLOAD_CHUNK_SIZE));
      const buffer = await chunk.arrayBuffer();
      await writer.write(new Uint8Array(buffer));
    }
  } finally {
    await writer.close();
  }
}

function triggerAnchorDownload({
  url,
  fileName,
  documentRef,
  schedule,
  revokeObjectURL,
}) {
  const anchor = documentRef.createElement('a');
  anchor.href = url;
  anchor.download = fileName;
  anchor.rel = 'noopener';
  anchor.style.display = 'none';
  documentRef.body.appendChild(anchor);
  anchor.click();

  if (typeof anchor.remove === 'function') {
    anchor.remove();
  } else {
    documentRef.body.removeChild(anchor);
  }

  if (typeof revokeObjectURL === 'function') {
    schedule(() => {
      try {
        revokeObjectURL(url);
      } catch {}
    }, OBJECT_URL_TTL_MS);
  }
}

export async function saveReceivedFile(record, {
  resolveFile = resolveReceivedFile,
  showSaveFilePicker = globalThis.showSaveFilePicker,
  createObjectURL = globalThis.URL?.createObjectURL?.bind(globalThis.URL),
  revokeObjectURL = globalThis.URL?.revokeObjectURL?.bind(globalThis.URL),
  documentRef = globalThis.document,
  schedule = globalThis.setTimeout?.bind(globalThis),
} = {}) {
  const file = await resolveFile(record);

  if (!file) {
    throw new Error('Полученный файл больше не доступен.');
  }

  if (typeof showSaveFilePicker === 'function') {
    let handle;

    try {
      handle = await showSaveFilePicker({
        suggestedName: sanitizeFileName(record?.name || 'file'),
      });
    } catch (error) {
      if (error?.name === 'AbortError') {
        return { method: 'canceled' };
      }

      // SecurityError, NotAllowedError and missing implementation in an
      // embedding context fall back to a normal download link below.
    }

    if (handle) {
      let writable = null;

      try {
        writable = await handle.createWritable();
      } catch {
        // The picker can exist while the embedding context still denies
        // write access. No data has been written yet, so the anchor fallback
        // below is safe.
        writable = null;
      }

      if (writable) {
        try {
          await writeBlobToWritable(file, writable);
        } catch (error) {
          try {
            await writable.abort();
          } catch {}

          throw error;
        }

        return { method: 'file-system-access' };
      }
    }
  }

  if (typeof createObjectURL !== 'function' || !documentRef) {
    throw new Error('Браузер не поддерживает скачивание файлов.');
  }

  const url = createObjectURL(file);
  triggerAnchorDownload({
    url,
    fileName: sanitizeFileName(record?.name || 'file'),
    documentRef,
    schedule: typeof schedule === 'function' ? schedule : (callback) => callback(),
    revokeObjectURL,
  });

  return { method: 'object-url' };
}
