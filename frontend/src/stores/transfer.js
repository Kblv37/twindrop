import { computed, reactive } from 'vue';
import { FileReceiver, FileSender } from '../services/file-transfer.js';
import {
  formatEta,
  formatHistoryTime,
  formatSpeed,
  getFileKind,
} from '../services/room-ui.js';
import {
  buildArchiveName,
  createZipArchive,
} from '../services/zip-archive.js';
import { deleteOpfsFile } from '../services/receive-storage.js';
import { saveReceivedFile } from '../services/received-download.js';
import {
  fileCountLabel,
  formatBytes,
  sanitizeText,
} from '../services/utils.js';
import {
  askConfirmation,
  notify,
} from './ui.js';
import {
  configureQueueLimits,
  queue,
  queueFiles,
  queueLimits,
  removeQueueItems,
  replaceFiles,
} from './fileQueue.js';

const SENT_ACTIVE_STATUSES = new Set(['active', 'awaiting']);
const HISTORY_STATUS = {
  active: { label: 'Отправляется', tone: 'active' },
  awaiting: { label: 'Ожидает подтверждения', tone: 'pending' },
  receiving: { label: 'Принимается', tone: 'active' },
  completed: { label: 'Завершено', tone: 'success' },
  canceled: { label: 'Отменено', tone: 'muted' },
  error: { label: 'Ошибка', tone: 'error' },
};

export const transfer = reactive({
  history: [],
  historyFilter: 'all',
  currentRecordId: '',
  isSending: false,
  isReceiving: false,
  chunkSize: 128 * 1024,
  chunkSizeOptions: [16 * 1024, 64 * 1024, 128 * 1024, 256 * 1024, 512 * 1024],
});

export const zip = reactive({
  mode: '',
  prepFiles: [],
  zipEnabled: false,
  prepareFeedback: '',
  archiveFile: null,
  archiveInFlight: false,
  archiveName: '',
  archiveError: '',
  archiveProgress: {
    ratio: 0,
    preparedFiles: 0,
    totalFiles: 0,
    currentSize: 0,
    etaSeconds: null,
  },
  archiveState: {
    tone: 'working',
    title: 'Подготовка к архивации',
    text: '',
  },
  sourceCount: 0,
});

let sender = null;
let receiver = null;
let sendController = null;
let sendSnapshot = [];
let sendPeer = null;
let sentQueueItemByTransferId = new Map();
let sendStartedAt = 0;
let sendLastUiUpdate = 0;
let archiveController = null;
let archiveTimer = null;
let archiveGeneration = 0;
let completedTransfers = new Set();
let boundTransport = {
  getChannel: () => null,
  isActive: () => false,
  getPeer: () => null,
  waitForOpen: async () => {},
};

export const currentRecord = computed(() => (
  transfer.history.find((record) => record.id === transfer.currentRecordId) || null
));

export const filteredHistory = computed(() => (
  transfer.history.filter((record) => (
    transfer.historyFilter === 'all' || record.direction === transfer.historyFilter
  ))
));

export const isCurrentSentActive = computed(() => (
  currentRecord.value?.direction === 'sent'
  && currentRecord.value?.status === 'active'
  && transfer.isSending
));

export const currentPercent = computed(() => {
  const record = currentRecord.value;
  if (!record || !record.size) {
    return record?.status === 'completed' ? 100 : 0;
  }

  if (record.status === 'completed') {
    return 100;
  }

  return Math.min(100, Math.max(0, Math.round(((record.transferred || 0) / record.size) * 100)));
});

export function configureTransfer(config = {}) {
  if (Array.isArray(config.chunkSizeOptions) && config.chunkSizeOptions.length > 0) {
    transfer.chunkSizeOptions = [...config.chunkSizeOptions];
    const preferred = config.chunkSizeOptions[Math.min(2, config.chunkSizeOptions.length - 1)];
    transfer.chunkSize = preferred;
  }

  configureQueueLimits(config);
}

function isRecordActive(record) {
  if (record.direction === 'received') {
    return record.status === 'receiving';
  }
  return SENT_ACTIVE_STATUSES.has(record.status);
}

function findRecord(transferId) {
  return transfer.history.find((record) => record.transferId === transferId) || null;
}

function addRecord(record) {
  transfer.history.unshift(record);
  return findRecord(record.transferId) || record;
}

async function releaseRecordResources(record) {
  if (!record) {
    return;
  }

  if (record.href) {
    try {
      URL.revokeObjectURL(record.href);
    } catch {}
    record.href = '';
  }

  if (record.opfsPath) {
    if (record.downloading) {
      // Deleting an OPFS entry while the browser is still reading it can
      // invalidate an in-progress download. The download finally block
      // performs the deferred cleanup.
      record.pendingDelete = true;
      return;
    }

    const path = record.opfsPath;

    try {
      await deleteOpfsFile(path);
      record.opfsPath = '';
    } catch (error) {
      console.warn('[transfer] Failed to delete received OPFS file:', error);
    }
  }

  record.memoryBlob = null;
}

function updateCurrentRecord(record, patch = {}) {
  Object.assign(record, patch, { updatedAt: Date.now() });
}

function syncReceivingState() {
  transfer.isReceiving = transfer.history.some((record) => record.status === 'receiving');
}

function historyPeerLabel(record) {
  if (!record.peer) {
    return 'Второе устройство';
  }

  return `${record.peer.typeLabel || 'Устройство'} · ${record.peer.os || 'ОС неизвестна'}`;
}

export function historyStatus(record) {
  if (record.direction === 'received' && record.status === 'completed') {
    return { label: 'Получено', tone: 'success' };
  }
  if (record.direction === 'sent' && record.status === 'completed') {
    return { label: 'Отправлено', tone: 'success' };
  }
  return HISTORY_STATUS[record.status] || HISTORY_STATUS.error;
}

export function historyDetail(record) {
  if (record.status === 'active') {
    return `${formatBytes(record.transferred || 0)} из ${formatBytes(record.size)}`;
  }
  if (record.status === 'awaiting') {
    return 'Получатель проверяет файл';
  }
  if (record.status === 'receiving') {
    return record.size
      ? `${formatBytes(record.transferred || 0)} из ${formatBytes(record.size)}`
      : 'Ожидаем данные файла';
  }
  if (record.status === 'completed') {
    return formatHistoryTime(record.completedAt || record.updatedAt || record.createdAt);
  }
  if (record.status === 'canceled') {
    return 'Передача отменена';
  }
  if (record.status === 'error') {
    return record.errorMessage || formatHistoryTime(record.updatedAt || record.createdAt);
  }
  return formatHistoryTime(record.createdAt);
}

export function historyPeer(record) {
  return historyPeerLabel(record);
}

export function historyMeta(record) {
  const storageNote = record.direction === 'received' && record.storage === 'memory'
    ? ' · временно в памяти'
    : '';
  return `${formatBytes(record.size)} · ${getFileKind(record.name, record.mimeType).label}${storageNote}`;
}

export async function downloadReceivedFile(record = currentRecord.value) {
  if (!record || record.status !== 'completed' || record.downloading) {
    return false;
  }

  if (!record.opfsPath && !record.memoryBlob) {
    notify('Полученный файл больше не доступен в хранилище браузера.', 'warning', 7000);
    return false;
  }

  record.downloading = true;

  try {
    const result = await saveReceivedFile(record);
    return result?.method !== 'canceled';
  } catch (error) {
    notify(
      `Не удалось скачать файл: ${sanitizeText(error?.message || 'неизвестная ошибка', 180)}.`,
      'error',
      8000,
    );
    return false;
  } finally {
    record.downloading = false;

    if (record.pendingDelete) {
      record.pendingDelete = false;
      await releaseRecordResources(record);
    }
  }
}

export function bindTransferTransport(transport = {}) {
  boundTransport = {
    ...boundTransport,
    ...transport,
  };
}

export function initTransferAdapters() {
  if (sender || receiver) {
    return;
  }

  sender = new FileSender({
    getChannel: () => boundTransport.getChannel?.(),
    getMaxMessageSize: () => boundTransport.getMaxMessageSize?.(),
    maxFileSizeBytes: 2 * 1024 * 1024 * 1024,
    maxFilesPerTransfer: 10,
    onFileStart: ({ transferId, fileName, fileSize, fileIndex, fileCount }) => {
      if (!boundTransport.isActive?.()) {
        return;
      }

      const sourceItem = sendSnapshot[fileIndex] || null;
      sendStartedAt = performance.now();
      sendLastUiUpdate = 0;

      if (sourceItem?.id) {
        sentQueueItemByTransferId.set(transferId, sourceItem.id);
      }

      const record = addRecord({
        id: transferId,
        transferId,
        direction: 'sent',
        name: fileName,
        size: fileSize,
        mimeType: sourceItem?.file?.type || 'application/octet-stream',
        status: 'active',
        transferred: 0,
        speed: 0,
        etaSeconds: null,
        peer: sendPeer ? { ...sendPeer } : null,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        fileIndex,
        fileCount,
      });

      transfer.currentRecordId = record.id;
    },
    onProgress: ({ transferId, sentBytes, totalBytes }) => {
      if (!boundTransport.isActive?.()) {
        return;
      }

      const record = findRecord(transferId);
      if (!record) {
        return;
      }

      const elapsedSeconds = Math.max(0.15, (performance.now() - sendStartedAt) / 1000);
      const speed = sentBytes > 0 ? sentBytes / elapsedSeconds : 0;
      const now = performance.now();

      if (now - sendLastUiUpdate >= 65 || sentBytes >= totalBytes) {
        sendLastUiUpdate = now;
        record.transferred = sentBytes;
        record.speed = speed;
        record.etaSeconds = speed > 0 ? Math.max(0, (totalBytes - sentBytes) / speed) : null;
        record.updatedAt = Date.now();
      }
    },
    onFileComplete: ({ transferId }) => {
      const record = findRecord(transferId);
      if (record && record.status === 'active') {
        updateCurrentRecord(record, {
          status: 'awaiting',
          transferred: record.size,
        });
      }
    },
    onAllComplete: () => {
      if (!boundTransport.isActive?.()) {
        return;
      }
      notify('Все файлы отправлены и подтверждены получателем.', 'success', 6000);
    },
    onRemoteProgress: ({ stage, transferId, fileName, receivedBytes, totalBytes, integrity, message }) => {
      if (!boundTransport.isActive?.()) {
        return;
      }

      const record = findRecord(transferId);

      if (stage === 'complete' && transferId && !completedTransfers.has(transferId)) {
        if (!record || !SENT_ACTIVE_STATUSES.has(record.status) || integrity !== 'verified') {
          return;
        }

        completedTransfers.add(transferId);
        updateCurrentRecord(record, {
          status: 'completed',
          transferred: totalBytes || record.size,
          completedAt: Date.now(),
          integrity,
        });

        // Only a confirmed file leaves the persisted queue. Failed, canceled
        // and unconfirmed files stay available for a retry.
        const queueItemId = sentQueueItemByTransferId.get(transferId);
        sentQueueItemByTransferId.delete(transferId);

        if (queueItemId) {
          removeQueueItems([queueItemId]);
        }

        notify(`Получатель подтвердил файл: ${sanitizeText(fileName)}. Целостность проверена.`, 'success', 6500);
      }

      if (stage === 'error' && transferId) {
        if (!record || !SENT_ACTIVE_STATUSES.has(record.status)) {
          return;
        }

        sentQueueItemByTransferId.delete(transferId);
        const errorMessage = sanitizeText(message || 'Ошибка передачи', 200);
        updateCurrentRecord(record, { status: 'error', errorMessage });
        notify(`Передача завершена с ошибкой: ${errorMessage}.`, 'error', 7000);
      }

      if (stage === 'progress' && record && record.id === transfer.currentRecordId) {
        record.peerReceivedBytes = Number(receivedBytes) || 0;
        record.peerTotalBytes = Number(totalBytes) || record.size;
      }
    },
  });

  receiver = new FileReceiver({
    sendControl: (payload) => {
      try {
        boundTransport.sendControl?.(JSON.stringify(payload));
      } catch {
        // A closing channel must not hide the original receive error.
      }
    },
    maxFileSizeBytes: 2 * 1024 * 1024 * 1024,
    onTransferStart: ({ transferId, fileName, fileSize, mimeType }) => {
      if (!boundTransport.isActive?.()) {
        return;
      }

      const peer = boundTransport.getPeer?.();
      const record = addRecord({
        id: transferId,
        transferId,
        direction: 'received',
        name: fileName,
        size: fileSize,
        mimeType,
        status: 'receiving',
        transferred: 0,
        speed: 0,
        etaSeconds: null,
        peer: peer ? { ...peer } : null,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        href: '',
        storage: 'pending',
        opfsPath: '',
        memoryBlob: null,
      });

      sendStartedAt = performance.now();
      transfer.currentRecordId = record.id;
      transfer.isReceiving = true;
    },
    onProgress: ({ transferId, receivedBytes, totalBytes }) => {
      if (!boundTransport.isActive?.()) {
        return;
      }

      const record = findRecord(transferId);
      if (!record || record.status !== 'receiving') {
        return;
      }

      const elapsedSeconds = Math.max(0.15, (performance.now() - sendStartedAt) / 1000);
      const speed = receivedBytes > 0 ? receivedBytes / elapsedSeconds : 0;
      record.transferred = receivedBytes;
      record.speed = speed;
      record.etaSeconds = speed > 0 ? Math.max(0, (totalBytes - receivedBytes) / speed) : null;
      record.updatedAt = Date.now();
    },
    onTransferReady: ({ transferId, fileSize, storage, opfsPath, blob }) => {
      const record = findRecord(transferId);

      if (!boundTransport.isActive?.() || !record || record.status !== 'receiving') {
        // The receiver removes the stored file when the callback returns false.
        return false;
      }

      if (storage === 'opfs' && !opfsPath) {
        return false;
      }

      record.href = '';
      record.storage = storage || 'memory';
      record.opfsPath = storage === 'opfs' ? opfsPath : '';
      record.memoryBlob = storage === 'memory' ? blob : null;
      record.status = 'completed';
      record.transferred = fileSize;
      record.completedAt = Date.now();
      record.updatedAt = Date.now();
      syncReceivingState();

      if (storage === 'memory') {
        notify(
          `Файл ${sanitizeText(record.name)} сохранён во временной памяти браузера (OPFS недоступен) и будет доступен до выхода из комнаты.`,
          'warning',
          8000,
        );
      } else {
        notify(
          `Файл ${sanitizeText(record.name)} готов к скачиванию. Целостность проверена.`,
          'success',
          6500,
        );
      }

      return true;
    },
    onError: (error, details = {}) => {
      if (!boundTransport.isActive?.()) {
        return;
      }

      const message = sanitizeText(error?.message || 'Передача завершилась с ошибкой.', 200);
      const canceled = /отмен/i.test(message);
      const record = details.transferId ? findRecord(details.transferId) : null;

      if (record && record.status === 'receiving') {
        record.status = canceled ? 'canceled' : 'error';
        record.errorMessage = message;
        record.updatedAt = Date.now();
      }

      if (record && (record.opfsPath || record.memoryBlob)) {
        // The receiver normally aborts storage before reporting an error.
        // This is a safety net for an unexpected late error.
        releaseRecordResources(record).catch(() => {});
      }

      syncReceivingState();
      notify(message, canceled ? 'warning' : 'error', 7000);
    },
  });
}

export function updateTransferLimits(config) {
  if (sender) {
    sender.maxFileSizeBytes = Number(config.maxFileSizeBytes) || sender.maxFileSizeBytes;
    sender.maxFilesPerTransfer = Number(config.maxFilesPerTransfer) || sender.maxFilesPerTransfer;
  }

  if (receiver) {
    receiver.maxFileSizeBytes = Number(config.maxFileSizeBytes) || receiver.maxFileSizeBytes;
  }
}

export function handleData(data) {
  sender?.handleData(data);
  receiver?.handleData(data);
}

export async function sendQueuedFiles() {
  if (transfer.isSending) {
    return false;
  }

  if (!boundTransport.isActive?.()) {
    notify('Сначала создайте или подключитесь к комнате.', 'warning');
    return false;
  }

  const items = [...queue.items];
  const files = items.map((item) => item.file);

  if (files.length === 0) {
    notify('Выберите хотя бы один файл.', 'warning');
    return false;
  }

  try {
    sender.validateFiles(files);
  } catch (error) {
    notify(error.message, 'warning', 7000);
    return false;
  }

  const channel = boundTransport.getChannel?.();
  if (!channel || channel.readyState !== 'open') {
    notify('P2P-канал ещё не готов.', 'warning');
    return false;
  }

  transfer.isSending = true;
  transfer.currentRecordId = '';
  sendSnapshot = items;
  sendPeer = boundTransport.getPeer?.() || null;
  sendController = new AbortController();
  completedTransfers = new Set();
  sentQueueItemByTransferId = new Map();

  try {
    await boundTransport.waitForOpen?.();
    await sender.sendFiles(files, transfer.chunkSize, { signal: sendController.signal });

    if (!boundTransport.isActive?.()) {
      return false;
    }

    return true;
  } catch (error) {
    if (!boundTransport.isActive?.()) {
      return false;
    }

    const activeRecord = currentRecord.value;
    if (error?.name === 'AbortError') {
      if (activeRecord && SENT_ACTIVE_STATUSES.has(activeRecord.status)) {
        updateCurrentRecord(activeRecord, { status: 'canceled', errorMessage: 'Отменено отправителем' });
      }
      notify('Передача отменена.', 'warning');
    } else {
      if (activeRecord && SENT_ACTIVE_STATUSES.has(activeRecord.status)) {
        updateCurrentRecord(activeRecord, {
          status: 'error',
          errorMessage: error?.message || 'Ошибка передачи',
        });
      }
      notify(error?.message || 'Передача не удалась.', 'error', 7000);
    }
    return false;
  } finally {
    sendController = null;
    sendSnapshot = [];
    sentQueueItemByTransferId = new Map();
    transfer.isSending = false;
  }
}

export async function requestCancelTransfer(record = null) {
  if (!transfer.isSending || !sendController) {
    return false;
  }

  const target = record || currentRecord.value;
  if (!target) {
    return false;
  }

  const confirmed = await askConfirmation({
    title: 'Отменить отправку?',
    message: `Текущая передача «${target.name}» будет прекращена. Уже переданные данные могут быть неполными, и файл не будет получен получателем.`,
    confirmLabel: 'Да, отменить',
    cancelLabel: 'Нет, продолжить',
    tone: 'danger',
  });

  if (confirmed) {
    sendController?.abort();
    // Update the visible state immediately. Hashing a large file is not
    // interruptible, but the canceled transfer must not look active while the
    // browser is still finishing that read.
    markSendingCanceled('Отменено отправителем');
  }

  return confirmed;
}

export function abortActiveSend() {
  sendController?.abort();
}

export function cancelActiveTransfer(reason = 'Соединение потеряно') {
  // Abort sender hashing/chunks/ACK waiting and stop receiver hashing even if
  // the UI flag is already stale. This is the single cleanup path used by
  // connection loss, peer-left, room-state and session reset.
  sendController?.abort();
  receiver?.cancelAll();

  const sendingChanged = markSendingCanceled(reason);
  const receivingChanged = markReceivingCanceled(reason);

  return sendingChanged || receivingChanged;
}

export function markReceivingCanceled(errorMessage = 'Отправитель отключился') {
  receiver?.cancelAll();
  let changed = false;

  for (const record of transfer.history) {
    if (record.status === 'receiving') {
      record.status = 'canceled';
      record.errorMessage = errorMessage;
      record.updatedAt = Date.now();
      changed = true;
    }
  }

  syncReceivingState();
  return changed;
}

export function markSendingCanceled(errorMessage = 'Соединение потеряно') {
  let changed = false;

  for (const record of transfer.history) {
    if (record.direction === 'sent' && SENT_ACTIVE_STATUSES.has(record.status)) {
      record.status = 'canceled';
      record.errorMessage = errorMessage;
      record.updatedAt = Date.now();
      changed = true;
    }
  }

  return changed;
}

export async function requestClearHistory() {
  if (transfer.history.length === 0) {
    return;
  }

  const confirmed = await askConfirmation({
    title: 'Очистить историю?',
    message: 'Записи о завершённых и отменённых передачах будут удалены. Активная передача останется в журнале, а сохранённые полученные файлы будут удалены из хранилища браузера.',
    confirmLabel: 'Очистить',
    cancelLabel: 'Отмена',
    tone: 'danger',
  });

  if (!confirmed) {
    return;
  }

  const removed = transfer.history.filter((record) => !isRecordActive(record));
  transfer.history.splice(0, transfer.history.length, ...transfer.history.filter(isRecordActive));

  if (!transfer.history.some((record) => record.id === transfer.currentRecordId)) {
    transfer.currentRecordId = '';
  }

  await Promise.allSettled(removed.map(releaseRecordResources));
  notify('История передач очищена.', 'info');
}

export function setHistoryFilter(filter) {
  transfer.historyFilter = ['all', 'sent', 'received'].includes(filter) ? filter : 'all';
}

export function resetTransferState() {
  sendController?.abort();
  sendController = null;
  sendSnapshot = [];
  sendPeer = null;
  sentQueueItemByTransferId = new Map();
  transfer.isSending = false;
  transfer.isReceiving = false;
  transfer.currentRecordId = '';

  const records = [...transfer.history];
  transfer.history.splice(0, transfer.history.length);
  transfer.historyFilter = 'all';
  completedTransfers = new Set();
  receiver?.cancelAll();
  resetZipState();

  return Promise.allSettled(records.map(releaseRecordResources));
}

export function cleanupTransferUrls() {
  return Promise.allSettled([...transfer.history].map(releaseRecordResources));
}

// ── ZIP preparation ───────────────────────────────────────────

function delay(milliseconds) {
  return new Promise((resolve) => {
    window.setTimeout(resolve, milliseconds);
  });
}

function setArchiveProgress(progress = {}) {
  zip.archiveProgress = {
    ratio: Number(progress.ratio) || 0,
    preparedFiles: Number(progress.preparedFiles) || 0,
    totalFiles: Number(progress.totalFiles) || zip.prepFiles.length,
    currentSize: Number(progress.currentSize) || 0,
    etaSeconds: Number.isFinite(progress.etaSeconds) ? progress.etaSeconds : null,
  };
}

function setArchiveState(tone, title, text) {
  zip.archiveState = { tone, title, text };
}

export function showPreparation(files = queueFiles.value) {
  const sourceFiles = Array.from(files || []).filter((file) => file instanceof File && file.size > 0);

  if (sourceFiles.length === 0) {
    notify('Сначала выберите файлы.', 'warning');
    return false;
  }

  zip.prepFiles = sourceFiles;
  zip.zipEnabled = sourceFiles.length > 1;
  zip.prepareFeedback = '';
  zip.mode = 'prepare';
  return true;
}

export function closePreparation() {
  zip.mode = '';
  zip.prepFiles = [];
  zip.prepareFeedback = '';
}

export function addPreparedFiles(files) {
  const rejected = [];
  const accepted = [];

  for (const file of Array.from(files || [])) {
    if (!(file instanceof File)) {
      continue;
    }

    const duplicate = zip.prepFiles.some((item) => item.name === file.name && item.size === file.size);
    if (duplicate) {
      rejected.push(`${file.name} — уже добавлен`);
      continue;
    }
    if (file.size <= 0) {
      rejected.push(`${file.name} — пустой файл`);
      continue;
    }
    if (file.size > queueLimits.maxFileSizeBytes) {
      rejected.push(`${file.name} — больше ${formatBytes(queueLimits.maxFileSizeBytes)}`);
      continue;
    }
    if (zip.prepFiles.length + accepted.length >= queueLimits.maxFilesPerTransfer) {
      rejected.push(`${file.name} — превышен лимит ${queueLimits.maxFilesPerTransfer} файлов`);
      continue;
    }
    accepted.push(file);
  }

  if (accepted.length > 0) {
    zip.prepFiles.push(...accepted);
    if (zip.prepFiles.length > 1) {
      zip.zipEnabled = true;
    }
  }

  if (rejected.length > 0) {
    const preview = rejected.slice(0, 3).join('; ');
    const suffix = rejected.length > 3 ? `; и ещё ${rejected.length - 3}` : '';
    zip.prepareFeedback = accepted.length > 0
      ? `Добавлено: ${fileCountLabel(accepted.length)}. Не добавлено: ${preview}${suffix}.`
      : `Не добавлено: ${preview}${suffix}.`;
  } else {
    zip.prepareFeedback = '';
  }

  return { accepted, rejected };
}

export function removePreparedFile(index) {
  zip.prepFiles.splice(index, 1);

  if (zip.prepFiles.length < 2) {
    zip.zipEnabled = false;
  }
}

export function updateZipEnabled(value) {
  zip.zipEnabled = Boolean(value);
}

export async function continuePreparation() {
  if (zip.prepFiles.length === 0) {
    return;
  }

  if (zip.zipEnabled) {
    await startArchive();
    return;
  }

  await applyPreparedFiles();
}

async function applyPreparedFiles() {
  const files = [...zip.prepFiles];
  await replaceFiles(files);
  zip.mode = '';
  zip.prepFiles = [];
  zip.prepareFeedback = '';
  notify(`Файлы подготовлены: ${fileCountLabel(files.length)}. Можно отправлять.`, 'info');
}

export async function startArchive() {
  if (zip.archiveInFlight || zip.prepFiles.length === 0) {
    return;
  }

  zip.mode = 'archive';
  archiveGeneration += 1;
  const generation = archiveGeneration;
  zip.archiveFile = null;
  zip.archiveInFlight = true;
  zip.archiveError = '';
  zip.archiveName = buildArchiveName();
  zip.sourceCount = zip.prepFiles.length;
  archiveController = new AbortController();
  setArchiveState(
    'waiting',
    'Подготовка к архивации',
    `Проверяем ${fileCountLabel(zip.prepFiles.length)} перед упаковкой.`,
  );
  setArchiveProgress({ ratio: 0, preparedFiles: 0, totalFiles: zip.prepFiles.length });

  try {
    await new Promise((resolve) => window.requestAnimationFrame(resolve));

    if (generation !== archiveGeneration) {
      return;
    }

    setArchiveState(
      'working',
      'Собираем архив',
      `Объединяем ${fileCountLabel(zip.prepFiles.length)} в один ZIP-архив.`,
    );

    const archiveFile = await createZipArchive([...zip.prepFiles], {
      name: zip.archiveName,
      signal: archiveController.signal,
      onProgress: (progress) => {
        if (generation === archiveGeneration) {
          setArchiveProgress(progress);
        }
      },
    });

    if (generation !== archiveGeneration) {
      return;
    }

    if (archiveFile.size > queueLimits.maxFileSizeBytes) {
      throw new Error(
        `Архив превышает лимит ${formatBytes(queueLimits.maxFileSizeBytes)}. Отключите ZIP и отправьте файлы по отдельности.`,
      );
    }

    zip.archiveFile = archiveFile;
    setArchiveProgress({
      ratio: 1,
      preparedFiles: zip.sourceCount,
      totalFiles: zip.sourceCount,
      currentSize: archiveFile.size,
      etaSeconds: 0,
    });
    setArchiveState(
      'success',
      'Архив создан',
      `${formatBytes(archiveFile.size)} · ${fileCountLabel(zip.sourceCount)}`,
    );
    zip.archiveInFlight = false;

    await new Promise((resolve) => {
      archiveTimer = window.setTimeout(resolve, 550);
    });

    if (generation !== archiveGeneration || !zip.archiveFile) {
      return;
    }

    zip.mode = 'ready';
  } catch (error) {
    if (generation !== archiveGeneration) {
      return;
    }

    zip.archiveInFlight = false;

    if (error?.name === 'AbortError') {
      zip.archiveFile = null;
      zip.mode = zip.prepFiles.length > 0 ? 'prepare' : '';
      notify('Создание архива отменено.', 'info');
      return;
    }

    zip.archiveError = error?.message || 'Неизвестная ошибка при создании архива.';
    setArchiveState(
      'error',
      'Не удалось создать архив',
      'Файлы остались на вашем устройстве. Попробуйте ещё раз или вернитесь к подготовке.',
    );
    notify(error?.message || 'Не удалось создать архив.', 'error', 7000);
  } finally {
    zip.archiveInFlight = false;
    archiveController = null;
  }
}

export function cancelArchive() {
  if (zip.archiveInFlight) {
    archiveController?.abort();
    return;
  }

  if (zip.archiveFile) {
    zip.mode = 'ready';
    return;
  }

  zip.mode = zip.prepFiles.length > 0 ? 'prepare' : '';
}

export function retryArchive() {
  zip.archiveError = '';
  startArchive();
}

export async function applyArchiveToQueue() {
  const archiveFile = zip.archiveFile;

  if (!archiveFile) {
    zip.mode = '';
    return;
  }

  await replaceFiles([archiveFile]);
  zip.mode = '';
  zip.prepFiles = [];
  zip.prepareFeedback = '';
  zip.archiveFile = null;
  notify('ZIP-архив готов. Нажмите «Отправить», чтобы передать его получателю.', 'success', 6500);
}

export function redoArchive() {
  window.clearTimeout(archiveTimer);
  zip.mode = 'prepare';
  zip.archiveFile = null;
  zip.archiveError = '';
  if (zip.prepFiles.length > 1) {
    zip.zipEnabled = true;
  }
}

export function dismissReadyArchive() {
  applyArchiveToQueue();
}

export function handleArchiveDismiss() {
  if (zip.archiveInFlight) {
    return;
  }

  if (zip.archiveFile) {
    zip.mode = 'ready';
    return;
  }

  zip.mode = zip.prepFiles.length > 0 ? 'prepare' : '';
}

export function resetZipState() {
  archiveGeneration += 1;
  archiveController?.abort();
  archiveController = null;
  window.clearTimeout(archiveTimer);
  archiveTimer = null;
  zip.mode = '';
  zip.prepFiles = [];
  zip.zipEnabled = false;
  zip.prepareFeedback = '';
  zip.archiveFile = null;
  zip.archiveInFlight = false;
  zip.archiveName = '';
  zip.archiveError = '';
  zip.sourceCount = 0;
  zip.archiveProgress = {
    ratio: 0,
    preparedFiles: 0,
    totalFiles: 0,
    currentSize: 0,
    etaSeconds: null,
  };
  zip.archiveState = { tone: 'working', title: 'Подготовка к архивации', text: '' };
}

export function transferProgressStats(record) {
  if (!record) {
    return { transferred: '0 B', speed: '—', eta: '—' };
  }

  return {
    transferred: `${formatBytes(record.transferred || 0)} из ${formatBytes(record.size || 0)}`,
    speed: formatSpeed(record.speed || 0),
    eta: record.status === 'completed'
      ? 'Готово'
      : formatEta(record.etaSeconds),
  };
}
