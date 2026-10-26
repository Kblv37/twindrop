import { computed, reactive } from 'vue';
import {
  clearQueueRecords,
  deleteQueueRecord,
  deleteSharedFiles,
  getSharedFiles,
  isQuotaError,
  isSharedRecordUsable,
  loadQueueRecords,
  markSharedFilesRejected,
  putQueueRecord,
  replaceQueueRecords,
  sharedRecordToFile,
} from '../services/file-store.js';
import { createFileId, fileCountLabel, formatBytes } from '../services/utils.js';
import { askConfirmation, notify } from './ui.js';

export const queue = reactive({
  items: [],
  loading: false,
  loaded: false,
  persistenceError: '',
  writePending: false,
});

export const queueLimits = reactive({
  maxFileSizeBytes: 2 * 1024 * 1024 * 1024,
  maxFilesPerTransfer: 10,
});

let loadPromise = null;
let writeChain = Promise.resolve();
let pendingWrites = 0;
let quotaWarningShown = false;
let sharedFilesPromise = null;
let sharedFilesRerunRequested = false;
let lastAddedAt = 0;

export const queueFiles = computed(() => queue.items.map((item) => item.file));
export const queueCount = computed(() => queue.items.length);
export const queueTotalBytes = computed(() => (
  queue.items.reduce((sum, item) => sum + (Number(item.file.size) || 0), 0)
));
export const queueSummary = computed(() => (
  `${fileCountLabel(queueCount.value)} · ${formatBytes(queueTotalBytes.value)}`
));
export const queueHasFiles = computed(() => queueCount.value > 0);

export function configureQueueLimits(config = {}) {
  const maxFileSize = Number(config.maxFileSizeBytes);
  const maxFiles = Number(config.maxFilesPerTransfer);

  if (Number.isFinite(maxFileSize) && maxFileSize > 0) {
    queueLimits.maxFileSizeBytes = maxFileSize;
  }

  if (Number.isFinite(maxFiles) && maxFiles > 0) {
    queueLimits.maxFilesPerTransfer = maxFiles;
  }
}

function queueRecordFor(item) {
  return {
    id: item.id,
    name: item.file.name,
    type: item.file.type,
    size: item.file.size,
    lastModified: item.file.lastModified,
    blob: item.file.slice(0, item.file.size, item.file.type),
    addedAt: item.addedAt,
  };
}

function handlePersistenceError(error) {
  if (isQuotaError(error)) {
    queue.persistenceError = 'quota';
    if (!quotaWarningShown) {
      quotaWarningShown = true;
      notify(
        'В браузере недостаточно места для сохранения очереди. Файлы останутся доступны до перезагрузки страницы.',
        'warning',
        8000,
      );
    }
    return;
  }

  queue.persistenceError = error?.message || 'indexeddb-error';
  notify(
    'Не удалось сохранить очередь файлов в браузере. Файлы останутся доступны до перезагрузки страницы.',
    'warning',
    8000,
  );
}

function enqueueWrite(task) {
  pendingWrites += 1;
  queue.writePending = true;

  const operation = writeChain
    .catch(() => {})
    .then(task);

  // Keep the shared chain alive, but return the raw operation so callers that
  // must not lose data (Share Target import) can detect a failed write.
  writeChain = operation
    .then(() => {
      queue.persistenceError = '';
      quotaWarningShown = false;
    })
    .catch(handlePersistenceError)
    .finally(() => {
      pendingWrites = Math.max(0, pendingWrites - 1);
      queue.writePending = pendingWrites > 0;
    });

  return operation;
}

function nextAddedAt() {
  // Several files can be selected within the same millisecond. Keep the
  // timestamps unique so restoring the queue preserves the original order.
  lastAddedAt = Math.max(Date.now(), lastAddedAt + 1);
  return lastAddedAt;
}

function makeItem(file, id = createFileId(), addedAt = nextAddedAt()) {
  const normalizedAddedAt = Number(addedAt) || nextAddedAt();
  lastAddedAt = Math.max(lastAddedAt, normalizedAddedAt);

  return {
    id,
    file,
    addedAt: normalizedAddedAt,
  };
}

function isDuplicate(file) {
  return queue.items.some((item) => (
    item.file.name === file.name
    && item.file.size === file.size
    && Number(item.file.lastModified) === Number(file.lastModified)
  )) || queue.items.some((item) => (
    item.file.name === file.name && item.file.size === file.size
  ));
}

export async function ensureQueueLoaded() {
  if (loadPromise) {
    return loadPromise;
  }

  queue.loading = true;
  loadPromise = (async () => {
    try {
      const records = await loadQueueRecords();
      const restored = [];

      for (const record of records) {
        if (!record?.blob || typeof record.name !== 'string') {
          continue;
        }

        const file = new File([record.blob], record.name, {
          type: record.type || record.blob.type || '',
          lastModified: Number(record.lastModified) || Date.now(),
        });

        if (file.size <= 0 || isDuplicate(file)) {
          continue;
        }

        restored.push(makeItem(file, record.id || createFileId(), Number(record.addedAt) || Date.now()));
      }

      restored.sort((left, right) => left.addedAt - right.addedAt);
      queue.items.push(...restored);

      if (restored.length > 0) {
        notify(`Восстановлено из локального хранилища: ${queueSummary.value}.`, 'info');
      }
    } catch (error) {
      queue.persistenceError = error?.message || 'indexeddb-error';
      console.warn('[queue] Failed to restore file queue:', error);
    } finally {
      queue.loading = false;
      queue.loaded = true;
    }
  })();

  return loadPromise;
}

export async function addFiles(files, { source = 'picker', notifyResult = true } = {}) {
  await ensureQueueLoaded();

  const accepted = [];
  const rejected = [];
  const rejectedItems = [];
  const persisted = [];
  const failed = [];
  const reject = (file, code, message) => {
    rejected.push(message);
    rejectedItems.push({ file, code, message });
  };

  for (const file of Array.from(files || [])) {
    if (!(file instanceof File)) {
      continue;
    }

    if (file.size <= 0) {
      reject(file, 'empty', `${file.name} — пустой файл`);
      continue;
    }

    if (file.size > queueLimits.maxFileSizeBytes) {
      reject(file, 'oversize', `${file.name} — больше ${formatBytes(queueLimits.maxFileSizeBytes)}`);
      continue;
    }

    if (isDuplicate(file)) {
      reject(file, 'duplicate', `${file.name} — уже добавлен`);
      continue;
    }

    if (queue.items.length + accepted.length >= queueLimits.maxFilesPerTransfer) {
      reject(file, 'limit', `${file.name} — превышен лимит ${queueLimits.maxFilesPerTransfer} файлов`);
      continue;
    }

    const item = makeItem(file);
    queue.items.push(item);
    accepted.push(item);
  }

  for (const item of accepted) {
    try {
      await enqueueWrite(() => putQueueRecord(queueRecordFor(item)));
      persisted.push(item);
    } catch {
      // The item stays in the in-memory queue for the current session. The
      // caller can decide whether its source record must be preserved.
      failed.push(item);
    }
  }

  if (notifyResult && rejected.length > 0) {
    const preview = rejected.slice(0, 3).join('; ');
    const suffix = rejected.length > 3 ? `; и ещё ${rejected.length - 3}` : '';
    notify(`Не добавлено: ${preview}${suffix}.`, 'warning', 7000);
  }

  if (notifyResult && source === 'share' && accepted.length > 0) {
    notify(`Файлы добавлены из меню «Поделиться»: ${fileCountLabel(accepted.length)}.`, 'info');
  }

  return {
    accepted,
    rejected,
    rejectedItems,
    persisted,
    failed,
  };
}

export function removeItem(id) {
  const index = queue.items.findIndex((item) => item.id === id);

  if (index < 0) {
    return;
  }

  queue.items.splice(index, 1);
  enqueueWrite(() => deleteQueueRecord(id));
}

export function removeQueueItems(ids) {
  const idSet = new Set(Array.isArray(ids) ? ids : [ids]);
  const removedIds = queue.items
    .filter((item) => idSet.has(item.id))
    .map((item) => item.id);

  if (removedIds.length === 0) {
    return 0;
  }

  queue.items.splice(
    0,
    queue.items.length,
    ...queue.items.filter((item) => !idSet.has(item.id)),
  );

  enqueueWrite(async () => {
    for (const id of removedIds) {
      await deleteQueueRecord(id);
    }
  });

  return removedIds.length;
}

export function clearQueue({ persist = true, notifyUser = false } = {}) {
  queue.items.splice(0, queue.items.length);

  if (persist) {
    enqueueWrite(() => clearQueueRecords());
  }

  if (notifyUser) {
    notify('Очередь файлов очищена.', 'info');
  }
}

export async function requestClearQueue() {
  if (queue.items.length === 0) {
    return false;
  }

  const accepted = await askConfirmation({
    title: 'Очистить очередь?',
    message: `Будут удалены ${queueCount.value} выбранных файлов (${formatBytes(queueTotalBytes.value)}). Комната и соединение останутся активными.`,
    confirmLabel: 'Очистить',
    cancelLabel: 'Отмена',
    tone: 'danger',
  });

  if (!accepted) {
    return false;
  }

  clearQueue({ persist: true, notifyUser: true });
  return true;
}

export async function replaceFiles(files) {
  await ensureQueueLoaded();

  const items = Array.from(files || [])
    .filter((file) => file instanceof File && file.size > 0)
    .map((file) => makeItem(file));

  queue.items.splice(0, queue.items.length, ...items);
  enqueueWrite(() => replaceQueueRecords(items.map(queueRecordFor)));
  return items;
}

async function runShareImportTestHook() {
  const hook = globalThis.__TWINDROP_TEST_HOOKS__?.beforeShareImport;

  if (typeof hook === 'function') {
    await hook();
  }
}

async function importSharedFilesOnce() {
  await ensureQueueLoaded();
  const records = await getSharedFiles();

  if (records.length === 0) {
    return [];
  }

  const pendingRecords = records.filter((record) => !record.rejectedAt);

  if (pendingRecords.length === 0) {
    return [];
  }

  const entries = [];
  const unreadableRecords = [];

  for (const record of pendingRecords) {
    if (isSharedRecordUsable(record)) {
      entries.push({ record, file: sharedRecordToFile(record) });
    } else {
      unreadableRecords.push(record);
    }
  }

  if (unreadableRecords.length > 0) {
    // Keep the unreadable records, but mark them so they are not retried on
    // every application start and cannot create an infinite import loop.
    await markSharedFilesRejected(unreadableRecords, 'unreadable');
    notify(
      'Не удалось прочитать файлы, полученные через «Поделиться». Они сохранены как отклонённые и не будут обрабатываться повторно автоматически.',
      'warning',
      8000,
    );
  }

  if (entries.length === 0) {
    return [];
  }

  await runShareImportTestHook();

  const {
    accepted,
    persisted,
    failed,
    rejectedItems = [],
  } = await addFiles(entries.map((entry) => entry.file), {
    source: 'share',
    notifyResult: true,
  });

  const persistedFiles = new Set(persisted.map((item) => item.file));
  const failedFiles = new Set(failed.map((item) => item.file));
  const rejectedByFile = new Map(rejectedItems.map((item) => [item.file, item.code]));
  const importedIds = [];
  const rejectedRecords = [];
  const rejectedReasons = new Set();

  for (const { record, file } of entries) {
    if (persistedFiles.has(file)) {
      importedIds.push(record.id);
      continue;
    }

    const rejectionCode = rejectedByFile.get(file);

    if (rejectionCode) {
      if (rejectionCode === 'limit') {
        // The queue limit is transient: keep the record pending so it can be
        // imported after the user clears or reduces the queue.
        continue;
      }

      rejectedRecords.push(record);
      rejectedReasons.add(rejectionCode);
      continue;
    }

    if (failedFiles.has(file)) {
      // The queue write failed. Keep the source record for a later retry.
      continue;
    }

    // An accepted file that was not persisted for an unknown reason must stay
    // pending rather than being silently discarded.
  }

  if (importedIds.length > 0) {
    // Delete only the ids that were actually persisted. Records added by a
    // concurrent share POST have different ids and remain untouched.
    await deleteSharedFiles(importedIds);
  }

  if (rejectedRecords.length > 0) {
    // Terminal rejections (empty, oversized, duplicate) are kept for
    // inspection, but marked so they are not retried forever.
    await markSharedFilesRejected(rejectedRecords, [...rejectedReasons].join(','));
  }

  return accepted.map((item) => item.file);
}

export function consumeSharedFiles() {
  if (sharedFilesPromise) {
    // A new share can arrive while the current import is waiting on queue
    // writes. Remember it and process it after the current pass finishes.
    sharedFilesRerunRequested = true;
    return sharedFilesPromise;
  }

  const run = async () => {
    const imported = [];

    do {
      sharedFilesRerunRequested = false;
      const batch = await importSharedFilesOnce();
      imported.push(...batch);
    } while (sharedFilesRerunRequested);

    return imported;
  };

  sharedFilesPromise = run()
    .catch((error) => {
      // Never clear the share-target store on an unexpected error: the same
      // records are the only copy available after a failed import.
      console.warn('[queue] Failed to import files from the share target:', error);
      notify(
        'Не удалось добавить файлы из меню «Поделиться» в очередь. Они сохранены и будут доступны при следующем открытии.',
        'warning',
        8000,
      );
      return [];
    })
    .finally(() => {
      sharedFilesPromise = null;

      if (sharedFilesRerunRequested) {
        sharedFilesRerunRequested = false;
        consumeSharedFiles().catch(() => {});
      }
    });

  return sharedFilesPromise;
}
