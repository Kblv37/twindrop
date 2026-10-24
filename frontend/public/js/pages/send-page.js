import { createApiClient, createSocket, emitWithAck } from '../core/api.js';
import { loadRuntimeConfig } from '../core/config.js';
import { $, setDisabled, showNotice } from '../core/dom.js';
import { FileSender } from '../core/file-transfer.js';
import {
  closeDialog,
  copyText,
  createFileIcon,
  detectDevice,
  formatEta,
  formatHistoryTime,
  formatSpeed,
  getFileKind,
  openDialog,
  setDeviceIcon,
  setupDialogDismiss,
} from '../core/room-ui.js';
import { buildSendUrl, formatBytes, getRoomCodeFromQuery, normalizeRoomCode, parseQuery, sanitizeText } from '../core/utils.js';
import { WebRtcPeerSession } from '../core/webrtc-peer.js';
import { buildArchiveName, createZipArchive } from '../core/zip-archive.js';

const SHARE_TARGET_DB = 'twindrop-share-target';
const SHARE_TARGET_STORE = 'files';
const SHARE_TARGET_KEY = 'shared-files';

const HISTORY_STATUS = {
  active: { label: 'Отправляется', tone: 'active' },
  awaiting: { label: 'Ожидает подтверждения', tone: 'pending' },
  completed: { label: 'Отправлено', tone: 'success' },
  canceled: { label: 'Отменено', tone: 'muted' },
  error: { label: 'Ошибка', tone: 'error' },
};

const ACTIVE_HISTORY_STATUSES = new Set(['active', 'awaiting']);

function pluralize(count, one, few, many) {
  const value = Math.abs(count) % 100;
  const last = value % 10;
  if (value > 10 && value < 20) {
    return many;
  }
  if (last === 1) {
    return one;
  }
  if (last > 1 && last < 5) {
    return few;
  }
  return many;
}

function fileCountLabel(count) {
  return `${count} ${pluralize(count, 'файл', 'файла', 'файлов')}`;
}

function delay(milliseconds) {
  return new Promise((resolve) => {
    window.setTimeout(resolve, milliseconds);
  });
}

async function openShareDB() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(SHARE_TARGET_DB, 1);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(SHARE_TARGET_STORE)) {
        db.createObjectStore(SHARE_TARGET_STORE);
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function getSharedFiles() {
  const db = await openShareDB();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(SHARE_TARGET_STORE, 'readonly');
    const store = transaction.objectStore(SHARE_TARGET_STORE);
    const request = store.get(SHARE_TARGET_KEY);
    request.onsuccess = () => resolve(request.result || []);
    request.onerror = () => reject(request.error);
  });
}

async function clearSharedFiles() {
  const db = await openShareDB();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(SHARE_TARGET_STORE, 'readwrite');
    const store = transaction.objectStore(SHARE_TARGET_STORE);
    const request = store.delete(SHARE_TARGET_KEY);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
  });
}

function registerServiceWorker(elements, state, addFiles) {
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/service-worker.js', { scope: '/' })
      .then((registration) => {
        if (navigator.serviceWorker.controller) {
          processSharedFiles(elements, state, addFiles);
        }

        navigator.serviceWorker.addEventListener('controllerchange', () => {
          processSharedFiles(elements, state, addFiles);
        });

        registration.addEventListener('updatefound', () => {
          const newWorker = registration.installing;
          if (newWorker) {
            newWorker.addEventListener('statechange', () => {
              if (newWorker.state === 'activated' && navigator.serviceWorker.controller) {
                processSharedFiles(elements, state, addFiles);
              }
            });
          }
        });
      })
      .catch((error) => {
        console.warn('Service worker registration failed:', error);
      });

    navigator.serviceWorker.addEventListener('message', (event) => {
      if (event.data && event.data.type === 'SHARED_FILES_AVAILABLE') {
        processSharedFiles(elements, state, addFiles);
      }
    });
  } else {
    processSharedFiles(elements, state, addFiles);
  }
}

async function getAndConvertSharedFiles() {
  try {
    const sharedFiles = await getSharedFiles();
    if (sharedFiles.length > 0) {
      return sharedFiles.map((file) => new File([file.data], file.name, {
        type: file.type,
        lastModified: file.lastModified,
      }));
    }
  } catch (error) {
    console.warn('Failed to load shared files:', error);
  }
  return [];
}

async function processSharedFiles(elements, state, addFiles) {
  const files = await getAndConvertSharedFiles();
  if (files.length === 0) {
    return;
  }

  const beforeCount = state.selectedFiles.length;
  addFiles(files, { openPreparation: false });
  if (state.selectedFiles.length > beforeCount) {
    showNotice(elements.status, { type: 'info', message: 'Файлы добавлены из меню «Поделиться».' });
    await clearSharedFiles();
    if (state.joined) {
      window.setTimeout(() => openPreparation(state.selectedFiles), 250);
    }
  } else if (state.isTransferring) {
    showNotice(elements.status, { type: 'warning', message: 'Передача в процессе, файлы будут добавлены после завершения.' });
  }
}

async function init() {
  const elements = {
    prejoinView: $('#prejoinView'),
    roomPage: document.querySelector('.room-page'),
    workspace: $('#roomWorkspace'),
    roomToolbar: $('#roomToolbar'),
    roomStatusTitle: $('#roomStatusTitle'),
    roomStatusText: $('#roomStatusText'),
    refreshBtn: $('#refreshBtn'),
    leaveRoomBtn: $('#leaveRoomBtn'),
    roomInfoBtn: $('#roomInfoBtn'),
    roomQr: $('#roomQr'),
    joinedCode: $('#joinedCode'),
    copyCodeBtn: $('#copyCodeBtn'),
    copyLinkBtn: $('#copyLinkBtn'),
    copyLinkLabel: document.querySelector('#copyLinkBtn .copy-link-label'),
    roomLink: $('#roomLink'),
    deviceCounter: $('#deviceCounter'),
    selfDeviceIcon: $('#selfDeviceIcon'),
    selfDeviceType: $('#selfDeviceType'),
    selfDeviceMeta: $('#selfDeviceMeta'),
    remoteDeviceCard: $('#remoteDeviceCard'),
    remoteDeviceIcon: $('#remoteDeviceIcon'),
    remoteDeviceName: $('#remoteDeviceName'),
    remoteDeviceType: $('#remoteDeviceType'),
    remoteDeviceMeta: $('#remoteDeviceMeta'),
    remoteDeviceStatus: $('#remoteDeviceStatus'),
    remoteDeviceStatusText: $('#remoteDeviceStatusText'),
    codeInput: $('#codeInput'),
    roomHint: $('#roomHint'),
    joinForm: $('#joinForm'),
    joinButton: $('#joinBtn'),
    joinButtonLabel: document.querySelector('#joinBtn .btn-label'),
    joinFeedback: $('#joinFeedback'),
    joinFeedbackText: $('#joinFeedbackText'),
    fileInput: $('#fileInput'),
    dropzone: $('#dropzone'),
    sendButton: $('#sendBtn'),
    sendHint: $('#sendHint'),
    status: $('#status'),
    chunkSizeSelect: $('#chunkSize'),
    fileList: $('#fileList'),
    currentTransfer: $('#currentTransfer'),
    currentFileIcon: $('#currentFileIcon'),
    currentTransferKind: $('#currentTransferKind'),
    currentTransferTitle: $('#currentTransferTitle'),
    currentTransferMeta: $('#currentTransferMeta'),
    currentTransferPercent: $('#currentTransferPercent'),
    currentTransferProgress: $('#currentTransferProgress'),
    currentTransferBar: $('#currentTransferBar'),
    currentTransferred: $('#currentTransferred'),
    currentSpeed: $('#currentSpeed'),
    currentEta: $('#currentEta'),
    cancelTransferBtn: $('#cancelTransferBtn'),
    historyList: $('#historyList'),
    historyEmpty: $('#historyEmpty'),
    historyTabs: Array.from(document.querySelectorAll('.history-tab')),
    clearHistoryBtn: $('#clearHistoryBtn'),
    prepareDialog: $('#prepareDialog'),
    prepareSummary: $('#prepareSummary'),
    prepareFileList: $('#prepareFileList'),
    prepareFeedback: $('#prepareFeedback'),
    prepareFileInput: $('#prepareFileInput'),
    prepareAddBtn: $('#prepareAddBtn'),
    prepareContinueBtn: $('#prepareContinueBtn'),
    zipToggle: $('#zipToggle'),
    zipNote: $('#zipNote'),
    archiveDialog: $('#archiveDialog'),
    archiveCloseBtn: $('#archiveCloseBtn'),
    archiveSubtitle: $('#archiveSubtitle'),
    archiveHero: $('#archiveHero'),
    archiveStateTitle: $('#archiveStateTitle'),
    archiveStateText: $('#archiveStateText'),
    archiveName: $('#archiveName'),
    archiveProgress: $('#archiveProgress'),
    archiveBar: $('#archiveBar'),
    archivePercent: $('#archivePercent'),
    archiveFiles: $('#archiveFiles'),
    archiveSize: $('#archiveSize'),
    archiveEta: $('#archiveEta'),
    archiveError: $('#archiveError'),
    archiveRetryBtn: $('#archiveRetryBtn'),
    archiveCancelBtn: $('#archiveCancelBtn'),
    readyDialog: $('#readyDialog'),
    readyName: $('#readyName'),
    readySize: $('#readySize'),
    readyCount: $('#readyCount'),
    readyAgainBtn: $('#readyAgainBtn'),
    readyContinueBtn: $('#readyContinueBtn'),
    confirmDialog: $('#confirmDialog'),
    confirmTitle: $('#confirmTitle'),
    confirmMessage: $('#confirmMessage'),
    confirmCancelBtn: $('#confirmCancelBtn'),
    confirmAcceptBtn: $('#confirmAcceptBtn'),
    confirmIcon: $('#confirmIcon'),
    infoDialog: $('#infoDialog'),
    infoRoomCode: $('#infoRoomCode'),
    infoConnection: $('#infoConnection'),
    infoPeer: $('#infoPeer'),
  };

  const config = await loadRuntimeConfig();
  const api = createApiClient(config);
  const socket = createSocket(config);
  const localDevice = detectDevice();

  const state = {
    code: '',
    joined: false,
    joining: false,
    peerId: '',
    peerInfo: null,
    pendingSignals: [],
    session: null,
    sessionPeerId: '',
    keepAliveTimer: null,
    completedTransfers: new Set(),
    selectedFiles: [],
    prepFiles: [],
    isTransferring: false,
    abortController: null,
    currentRecordId: '',
    transferStartedAt: 0,
    history: [],
    historyFilter: 'all',
    historyRenderTimer: null,
    archiveFile: null,
    archiveInFlight: false,
    archiveAbortController: null,
    archiveTransitionTimer: null,
    confirmAction: null,
    copyCodeTimer: null,
    copyLinkTimer: null,
  };

  registerServiceWorker(elements, state, addFiles);

  function setRoomStatus(tone, title, text) {
    elements.roomToolbar.dataset.state = tone;
    elements.roomStatusTitle.textContent = title;
    elements.roomStatusText.textContent = text;
    if (elements.infoConnection && elements.infoDialog.open) {
      elements.infoConnection.textContent = title;
    }
  }

  function updateRoomStatusFromState() {
    if (!state.joined) {
      return;
    }

    if (!socket.connected) {
      setRoomStatus('reconnecting', 'Переподключение', 'Сигнальный сервер временно недоступен. Пробуем восстановить соединение…');
      return;
    }

    if (!state.peerId) {
      setRoomStatus('waiting', 'Комната активна', 'Ожидаем подключение второго устройства.');
      return;
    }

    if (!state.session) {
      setRoomStatus('connecting', 'Соединение', 'Второе устройство найдено. Устанавливаем P2P-соединение…');
      return;
    }

    if (!state.session.isReady()) {
      setRoomStatus('connecting', 'Соединение', 'Подключаем защищённый канал передачи…');
      return;
    }

    setRoomStatus('connected', 'Комната подключена', 'Защищённый P2P-канал открыт. Можно отправлять файлы.');
  }

  function updateDevices() {
    const peerInfo = state.peerInfo;
    const online = Boolean(state.session?.isReady());
    const hasPeer = Boolean(state.peerId);

    setDeviceIcon(elements.selfDeviceIcon, localDevice.type);
    elements.selfDeviceType.textContent = localDevice.typeLabel;
    elements.selfDeviceMeta.textContent = `${localDevice.os} · ${localDevice.browser}`;

    elements.deviceCounter.textContent = hasPeer ? '2 из 2' : '1 из 2';
    elements.remoteDeviceCard.dataset.state = online ? 'online' : (hasPeer ? 'connecting' : 'waiting');
    setDeviceIcon(elements.remoteDeviceIcon, peerInfo?.type || 'unknown');

    if (peerInfo) {
      elements.remoteDeviceName.textContent = peerInfo.typeLabel || 'Второе устройство';
      elements.remoteDeviceType.textContent = `${peerInfo.os || 'ОС неизвестна'} · ${peerInfo.browser || 'браузер неизвестен'}`;
      elements.remoteDeviceMeta.textContent = online ? 'Подключено напрямую по WebRTC' : 'Данные устройства получены';
    } else {
      elements.remoteDeviceName.textContent = 'Второе устройство';
      elements.remoteDeviceType.textContent = hasPeer ? 'Определяем устройство' : 'Ожидаем подключение';
      elements.remoteDeviceMeta.textContent = hasPeer ? 'Данные появятся после соединения' : 'Передайте код комнаты на другое устройство';
    }

    elements.remoteDeviceStatusText.textContent = online ? 'В сети' : (hasPeer ? 'Соединение' : 'Не в сети');
    elements.remoteDeviceStatus.dataset.state = online ? 'online' : (hasPeer ? 'connecting' : 'offline');
  }

  function setPeerState(type, badge, message) {
    setRoomStatus(type, badge, message);
    updateDevices();
  }

  function sendPeerInfo() {
    if (!state.session?.isReady()) {
      return;
    }

    try {
      state.session.sendMessage(JSON.stringify({
        type: 'twindrop-peer-info',
        info: {
          type: localDevice.type,
          typeLabel: localDevice.typeLabel,
          os: localDevice.os,
          browser: localDevice.browser,
        },
      }));
    } catch {
      // Device metadata is an enhancement and must never block file transfer.
    }
  }

  function handleIncomingMessage(data) {
    if (typeof data === 'string') {
      try {
        const message = JSON.parse(data);
        if (message?.type === 'twindrop-peer-info' && message.info) {
          state.peerInfo = {
            type: ['desktop', 'phone', 'tablet'].includes(message.info.type) ? message.info.type : 'unknown',
            typeLabel: sanitizeText(message.info.typeLabel, 40) || 'Устройство',
            os: sanitizeText(message.info.os, 40) || 'ОС неизвестна',
            browser: sanitizeText(message.info.browser, 40) || 'браузер неизвестен',
          };
          updateDevices();
          syncInfoDialog();
          return;
        }
      } catch {
        // Binary chunks and unrelated payloads continue to the transfer layer.
      }
    }

    sender.handleData(data);
  }

  function historyStatus(record) {
    const meta = HISTORY_STATUS[record.status] || HISTORY_STATUS.error;
    if (record.direction === 'received' && record.status === 'completed') {
      return { ...meta, label: 'Получено' };
    }
    return meta;
  }

  function historyDetail(record) {
    if (record.status === 'active') {
      return `${formatBytes(record.transferred || 0)} из ${formatBytes(record.size)}`;
    }
    if (record.status === 'awaiting') {
      return 'Получатель проверяет файл';
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

  function getFilteredHistory() {
    return state.history.filter((record) => (
      state.historyFilter === 'all' || record.direction === state.historyFilter
    ));
  }

  function renderHistory() {
    if (state.historyRenderTimer) {
      window.clearTimeout(state.historyRenderTimer);
      state.historyRenderTimer = null;
    }

    const records = getFilteredHistory();
    elements.historyList.replaceChildren();
    elements.historyEmpty.hidden = records.length > 0;

    if (records.length === 0) {
      const strong = elements.historyEmpty.querySelector('strong');
      const text = elements.historyEmpty.querySelector('p');
      if (strong) {
        strong.textContent = state.historyFilter === 'received'
          ? 'Полученных файлов пока нет'
          : (state.historyFilter === 'sent' ? 'Отправленных файлов пока нет' : 'История пока пуста');
      }
      if (text) {
        text.textContent = state.historyFilter === 'sent'
          ? 'После отправки файлы появятся здесь вместе со статусом и прогрессом.'
          : (state.historyFilter === 'received'
            ? 'Эта страница отправляет файлы. Полученные файлы появятся в журнале на устройстве-получателе.'
            : 'Отправленные файлы появятся здесь вместе со статусом и прогрессом.');
      }
      return;
    }

    for (const record of records) {
      const item = document.createElement('article');
      item.className = 'history-item';
      item.dataset.status = record.status;
      item.dataset.direction = record.direction;
      item.setAttribute('role', 'listitem');

      const fileCell = document.createElement('div');
      fileCell.className = 'history-file-cell';
      fileCell.appendChild(createFileIcon(record.name, record.mimeType));

      const fileCopy = document.createElement('div');
      fileCopy.className = 'history-file-copy';
      const fileName = document.createElement('strong');
      fileName.className = 'history-file-name';
      fileName.textContent = record.name;
      fileName.title = record.name;
      const fileMeta = document.createElement('span');
      fileMeta.className = 'history-file-meta';
      fileMeta.textContent = `${formatBytes(record.size)} · ${getFileKind(record.name, record.mimeType).label}`;
      fileCopy.append(fileName, fileMeta);
      fileCell.appendChild(fileCopy);

      const statusCell = document.createElement('div');
      statusCell.className = 'history-status-cell';
      const statusMeta = historyStatus(record);
      const pill = document.createElement('span');
      pill.className = 'history-status-pill';
      pill.dataset.tone = statusMeta.tone;
      const dot = document.createElement('span');
      dot.className = 'history-status-dot';
      dot.setAttribute('aria-hidden', 'true');
      const statusLabel = document.createElement('span');
      statusLabel.textContent = statusMeta.label;
      pill.append(dot, statusLabel);
      const detail = document.createElement('span');
      detail.className = 'history-status-detail';
      detail.textContent = historyDetail(record);
      statusCell.append(pill, detail);

      const peerCell = document.createElement('div');
      peerCell.className = 'history-peer-cell';
      const peerLabel = document.createElement('span');
      peerLabel.className = 'history-peer-label';
      peerLabel.textContent = record.direction === 'sent' ? 'Кому' : 'От кого';
      const peerLine = document.createElement('span');
      peerLine.className = 'history-peer-value';
      const peerIcon = document.createElement('span');
      peerIcon.className = 'history-peer-icon';
      setDeviceIcon(peerIcon, record.peer?.type || 'unknown');
      const peerText = document.createElement('span');
      peerText.textContent = record.peer
        ? `${record.peer.typeLabel || 'Устройство'} · ${record.peer.os || 'ОС неизвестна'}`
        : 'Второе устройство';
      peerLine.append(peerIcon, peerText);
      peerCell.append(peerLabel, peerLine);

      const actions = document.createElement('div');
      actions.className = 'history-actions';

      if (record.status === 'completed' && record.href) {
        const download = document.createElement('a');
        download.className = 'history-icon-action';
        download.href = record.href;
        download.download = record.name;
        download.setAttribute('aria-label', `Скачать ${record.name}`);
        download.title = 'Скачать файл';
        download.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path><polyline points="7 10 12 15 17 10"></polyline><line x1="12" y1="15" x2="12" y2="3"></line></svg>';
        actions.appendChild(download);
      }

      if (record.status === 'active' && record.direction === 'sent') {
        const cancel = document.createElement('button');
        cancel.type = 'button';
        cancel.className = 'history-icon-action history-icon-action--cancel';
        cancel.setAttribute('aria-label', `Отменить передачу ${record.name}`);
        cancel.title = 'Отменить передачу';
        cancel.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>';
        cancel.addEventListener('click', () => requestCancelTransfer(record));
        actions.appendChild(cancel);
      }

      item.append(fileCell, statusCell, peerCell, actions);
      elements.historyList.appendChild(item);
    }
  }

  function scheduleHistoryRender() {
    if (state.historyRenderTimer) {
      return;
    }
    state.historyRenderTimer = window.setTimeout(() => {
      state.historyRenderTimer = null;
      renderHistory();
    }, 180);
  }

  function resetHistoryFilter() {
    state.historyFilter = 'all';
    elements.historyTabs.forEach((tab) => {
      const active = (tab.dataset.filter || 'all') === 'all';
      tab.classList.toggle('is-active', active);
      tab.setAttribute('aria-selected', String(active));
    });
  }

  function addHistoryRecord(record) {
    state.history.unshift(record);
    renderHistory();
  }

  function updateHistoryRecord(recordOrId, patch = {}) {
    const record = typeof recordOrId === 'string'
      ? state.history.find((entry) => entry.id === recordOrId)
      : recordOrId;
    if (!record) {
      return null;
    }

    Object.assign(record, patch, { updatedAt: Date.now() });
    scheduleHistoryRender();
    return record;
  }

  function findHistoryRecordByTransferId(transferId) {
    return state.history.find((record) => record.transferId === transferId);
  }

  function revokeHistoryUrls(records) {
    for (const record of records) {
      if (record.href) {
        try {
          URL.revokeObjectURL(record.href);
        } catch {}
        record.href = '';
      }
    }
  }

  function clearTransferDisplay() {
    elements.currentTransfer.hidden = true;
    elements.currentTransfer.dataset.state = 'active';
    elements.currentTransferPercent.textContent = '0%';
    elements.currentTransferProgress.setAttribute('aria-valuenow', '0');
    elements.currentTransferBar.style.width = '0%';
    elements.currentTransferred.textContent = '0 B';
    elements.currentSpeed.textContent = '—';
    elements.currentEta.textContent = '—';
    elements.cancelTransferBtn.hidden = false;
    setDisabled(elements.cancelTransferBtn, true);
  }

  function startCurrentTransfer(record) {
    const isArchive = record.mimeType === 'application/zip' || getFileKind(record.name, record.mimeType).kind === 'archive';
    elements.currentTransfer.hidden = false;
    elements.currentTransfer.dataset.state = 'active';
    elements.currentFileIcon.replaceChildren(createFileIcon(record.name, record.mimeType));
    elements.currentTransferKind.textContent = isArchive ? 'Отправка архива' : 'Отправка файла';
    elements.currentTransferTitle.textContent = record.name;
    elements.currentTransferMeta.textContent = `${formatBytes(record.size)} · ${getFileKind(record.name, record.mimeType).label}`;
    elements.currentTransferPercent.textContent = '0%';
    elements.currentTransferProgress.setAttribute('aria-valuenow', '0');
    elements.currentTransferBar.style.width = '0%';
    elements.currentTransferred.textContent = `0 B из ${formatBytes(record.size)}`;
    elements.currentSpeed.textContent = '—';
    elements.currentEta.textContent = '—';
    elements.cancelTransferBtn.hidden = false;
    setDisabled(elements.cancelTransferBtn, false);
    state.currentRecordId = record.id;
    state.transferStartedAt = performance.now();
  }

  function updateCurrentTransfer(record, sentBytes, options = {}) {
    if (state.currentRecordId !== record.id) {
      return;
    }

    const totalBytes = Math.max(1, record.size || 0);
    const ratio = Math.min(1, Math.max(0, sentBytes / totalBytes));
    const percent = Math.round(ratio * 100);
    const elapsedSeconds = Math.max(0.15, (performance.now() - state.transferStartedAt) / 1000);
    const speed = Number(options.speed) || (sentBytes > 0 ? sentBytes / elapsedSeconds : 0);
    const etaSeconds = Number.isFinite(options.etaSeconds)
      ? options.etaSeconds
      : (speed > 0 ? (record.size - sentBytes) / speed : null);

    elements.currentTransfer.dataset.state = 'active';
    elements.currentTransferPercent.textContent = `${percent}%`;
    elements.currentTransferProgress.setAttribute('aria-valuenow', String(percent));
    elements.currentTransferBar.style.width = `${percent}%`;
    elements.currentTransferred.textContent = `${formatBytes(sentBytes)} из ${formatBytes(record.size)}`;
    elements.currentSpeed.textContent = formatSpeed(speed);
    elements.currentEta.textContent = formatEta(etaSeconds);
    elements.currentTransferMeta.textContent = `${formatBytes(record.size)} · ${getFileKind(record.name, record.mimeType).label}`;
    setDisabled(elements.cancelTransferBtn, ratio >= 1);
  }

  function completeCurrentTransfer(record, { tone = 'success', message = 'Передача завершена' } = {}) {
    if (state.currentRecordId !== record.id) {
      return;
    }

    elements.currentTransfer.dataset.state = tone;
    elements.currentTransferPercent.textContent = '100%';
    elements.currentTransferProgress.setAttribute('aria-valuenow', '100');
    elements.currentTransferBar.style.width = '100%';
    elements.currentTransferred.textContent = `${formatBytes(record.size)} из ${formatBytes(record.size)}`;
    elements.currentSpeed.textContent = formatSpeed(record.averageSpeed || 0);
    elements.currentEta.textContent = 'Готово';
    elements.currentTransferMeta.textContent = message;
    elements.cancelTransferBtn.hidden = true;
  }

  function failCurrentTransfer(record, message = 'Передача не удалась') {
    if (state.currentRecordId !== record.id) {
      return;
    }

    elements.currentTransfer.dataset.state = 'error';
    elements.currentTransferMeta.textContent = message;
    elements.currentEta.textContent = '—';
    elements.cancelTransferBtn.hidden = true;
  }

  function sanitizePeerInfo(info) {
    if (!info) {
      return null;
    }

    return {
      type: ['desktop', 'phone', 'tablet'].includes(info.type) ? info.type : 'unknown',
      typeLabel: sanitizeText(info.typeLabel, 40) || 'Устройство',
      os: sanitizeText(info.os, 40) || 'ОС неизвестна',
      browser: sanitizeText(info.browser, 40) || 'браузер неизвестен',
    };
  }

  const sender = new FileSender({
    getChannel: () => state.session?.getDataChannel(),
    maxFileSizeBytes: config.maxFileSizeBytes,
    maxFilesPerTransfer: config.maxFilesPerTransfer,
    onFileStart: ({ transferId, fileName, fileSize, fileIndex, fileCount }) => {
      if (!state.joined) {
        return;
      }

      const file = state.selectedFiles[fileIndex] || null;
      const href = file ? URL.createObjectURL(file) : '';
      const record = {
        id: transferId,
        transferId,
        direction: 'sent',
        name: fileName,
        size: fileSize,
        mimeType: file?.type || 'application/octet-stream',
        file,
        href,
        status: 'active',
        transferred: 0,
        peer: state.peerInfo ? { ...state.peerInfo } : null,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        fileIndex,
        fileCount,
      };
      addHistoryRecord(record);
      startCurrentTransfer(record);
      updateRoomStatusFromState();
    },
    onProgress: ({ transferId, sentBytes, totalBytes }) => {
      if (!state.joined) {
        return;
      }

      const record = findHistoryRecordByTransferId(transferId);
      if (!record) {
        return;
      }
      record.transferred = sentBytes;
      record.averageSpeed = sentBytes / Math.max(0.15, (performance.now() - state.transferStartedAt) / 1000);
      updateCurrentTransfer(record, sentBytes);
      scheduleHistoryRender();
    },
    onFileComplete: ({ transferId }) => {
      if (!state.joined) {
        return;
      }

      const record = findHistoryRecordByTransferId(transferId);
      if (!record || record.status !== 'active') {
        return;
      }
      updateHistoryRecord(record, { status: 'awaiting', transferred: record.size });
      if (state.currentRecordId === record.id) {
        elements.currentTransferMeta.textContent = 'Файл передан. Ожидаем подтверждение получателя…';
        setDisabled(elements.cancelTransferBtn, true);
      }
    },
    onAllComplete: () => {
      if (!state.joined) {
        return;
      }
      showNotice(elements.status, { type: 'info', message: 'Все файлы отправлены. Ожидаем подтверждение получения…' });
    },
    onRemoteProgress: ({ stage, transferId, fileName, receivedBytes, totalBytes, integrity, message }) => {
      if (!state.joined) {
        return;
      }

      const record = findHistoryRecordByTransferId(transferId);
      if (stage === 'complete' && transferId && !state.completedTransfers.has(transferId)) {
        if (!record || !ACTIVE_HISTORY_STATUSES.has(record.status)) {
          return;
        }
        state.completedTransfers.add(transferId);
        updateHistoryRecord(record, {
          status: 'completed',
          transferred: totalBytes || record.size,
          completedAt: Date.now(),
        });
        if (state.currentRecordId === record.id) {
          elements.currentTransferMeta.textContent = 'Передача подтверждена получателем.';
          completeCurrentTransfer(record, {
            message: integrity === 'verified'
              ? 'Передача завершена. Целостность проверена.'
              : 'Передача завершена.',
          });
        }
        const integrityMsg = integrity === 'verified' ? ' Целостность проверена.' : '';
        showNotice(elements.status, {
          type: 'success',
          message: `Получатель подтвердил файл: ${sanitizeText(fileName)}.${integrityMsg}`,
        });
      }

      if (stage === 'error' && transferId) {
        if (!record || !ACTIVE_HISTORY_STATUSES.has(record.status)) {
          return;
        }
        const errorMessage = sanitizeText(message || 'Ошибка передачи', 200);
        updateHistoryRecord(record, { status: 'error', errorMessage });
        failCurrentTransfer(record, `Передача не удалась: ${errorMessage}`);
        showNotice(elements.status, {
          type: 'error',
          message: `Передача завершена с ошибкой: ${errorMessage}.`,
        });
      }

      if (stage === 'progress' && record && state.currentRecordId === record.id) {
        elements.currentTransferMeta.textContent = `Получатель принял ${formatBytes(receivedBytes)} из ${formatBytes(totalBytes)}`;
      }
    },
  });

  await processSharedFiles(elements, state, addFiles);

  function resetSession() {
    state.session?.destroy();
    state.session = null;
    state.sessionPeerId = '';
    setTransferring(false);
    setDisabled(elements.sendButton, true);
  }

  function setRoomHint(message) {
    if (elements.roomHint) {
      elements.roomHint.textContent = message;
    }
  }

  function setJoinFeedback(type, message = '') {
    if (!elements.joinFeedback) {
      return;
    }

    if (!message) {
      elements.joinFeedback.hidden = true;
      elements.joinFeedbackText.textContent = '';
      return;
    }

    elements.joinFeedback.hidden = false;
    elements.joinFeedback.dataset.state = type;
    elements.joinFeedbackText.textContent = message;
  }

  function updateJoinButton() {
    const code = normalizeRoomCode(elements.codeInput.value, config.roomCodeLength);
    setDisabled(
      elements.joinButton,
      state.joining || state.joined || code.length !== config.roomCodeLength,
    );
  }

  function setJoinBusy(phase) {
    const busy = phase === 'checking' || phase === 'joining';
    state.joining = busy;
    elements.codeInput.disabled = busy;

    if (phase === 'checking') {
      setJoinFeedback('checking', 'Проверяем код комнаты…');
    } else if (phase === 'joining') {
      setJoinFeedback('joining', 'Комната найдена. Подключаемся…');
    }

    if (elements.joinButtonLabel) {
      elements.joinButtonLabel.textContent = phase === 'checking'
        ? 'Проверяем код…'
        : (phase === 'joining' ? 'Подключаемся…' : 'Подключиться');
    }

    elements.joinButton.classList.toggle('is-loading', busy);
    elements.joinButton.setAttribute('aria-busy', String(busy));
    updateJoinButton();
  }

  function showJoinForm() {
    elements.prejoinView.hidden = false;
    elements.workspace.hidden = true;
    elements.roomPage.classList.remove('is-in-room');
    elements.codeInput.disabled = false;
    elements.joinButton.classList.remove('is-loading');
    elements.joinButton.setAttribute('aria-busy', 'false');
    if (elements.joinButtonLabel) {
      elements.joinButtonLabel.textContent = 'Подключиться';
    }
    setJoinFeedback(null);
    updateJoinButton();
  }

  function renderRoomQr(url) {
    if (!elements.roomQr) {
      return;
    }

    elements.roomQr.replaceChildren();
    if (typeof window.QRCode !== 'function') {
      const fallback = document.createElement('span');
      fallback.className = 'invite-qr-fallback';
      fallback.textContent = 'QR временно недоступен';
      elements.roomQr.appendChild(fallback);
      return;
    }

    try {
      new window.QRCode(elements.roomQr, {
        text: url,
        width: 160,
        height: 160,
        colorDark: '#0b1220',
        colorLight: '#ffffff',
        correctLevel: window.QRCode.CorrectLevel?.M,
      });
    } catch {
      const fallback = document.createElement('span');
      fallback.className = 'invite-qr-fallback';
      fallback.textContent = 'Не удалось построить QR';
      elements.roomQr.appendChild(fallback);
    }
  }

  function showActiveRoom(code) {
    elements.prejoinView.hidden = true;
    elements.workspace.hidden = false;
    elements.roomPage.classList.add('is-in-room');
    elements.joinedCode.textContent = code;
    elements.roomQr.setAttribute('aria-label', `QR-код для подключения к комнате ${code}`);

    const sendUrl = buildSendUrl(config.frontendUrl, code);
    elements.roomLink.value = sendUrl;
    elements.roomLink.setAttribute('aria-label', `Ссылка для подключения к комнате ${code}`);
    renderRoomQr(sendUrl);
    updateDevices();
    renderHistory();
    resetTransferDisplay();
  }

  function getJoinErrorMessage(error) {
    switch (error?.message) {
      case 'room-not-found':
        return 'Комната с таким кодом не найдена. Проверьте код на другом устройстве.';
      case 'room-full':
        return 'Комната уже заполнена двумя устройствами.';
      case 'rate-limited':
        return 'Слишком много попыток. Подождите минуту и повторите.';
      case 'socket-timeout':
      case 'socket-connect-error':
      case 'request-timeout':
        return 'Сигнальный сервер не ответил. Проверьте соединение и повторите попытку.';
      default:
        if (error?.name === 'AbortError') {
          return 'Сервер не ответил. Проверьте соединение и повторите попытку.';
        }
        return 'Не удалось подключиться к комнате. Проверьте соединение и повторите попытку.';
    }
  }

  function waitForSocketConnection(timeoutMs = 10000) {
    if (socket.connected) {
      return Promise.resolve();
    }

    if (socket.disconnected) {
      socket.connect();
    }

    return new Promise((resolve, reject) => {
      let settled = false;
      const timer = window.setTimeout(() => finish(new Error('socket-timeout')), timeoutMs);

      const finish = (error) => {
        if (settled) {
          return;
        }
        settled = true;
        window.clearTimeout(timer);
        socket.off('connect', handleConnect);
        socket.off('connect_error', handleError);
        if (error) {
          reject(error);
        } else {
          resolve();
        }
      };

      const handleConnect = () => finish();
      const handleError = () => finish(new Error('socket-connect-error'));

      socket.once('connect', handleConnect);
      socket.once('connect_error', handleError);

      if (socket.connected) {
        finish();
      }
    });
  }

  function updateSendButton() {
    const canSend = state.session?.isReady()
      && state.selectedFiles.length > 0
      && !state.isTransferring;
    setDisabled(elements.sendButton, !canSend);
    if (elements.sendHint) {
      if (state.isTransferring) {
        elements.sendHint.textContent = 'Дождитесь завершения текущей передачи.';
      } else if (state.selectedFiles.length === 0) {
        elements.sendHint.textContent = 'Сначала подготовьте файлы, затем отправьте их в комнату.';
      } else if (!state.session?.isReady()) {
        elements.sendHint.textContent = 'Ожидаем готовность защищённого канала передачи.';
      } else {
        elements.sendHint.textContent = `Подготовлено: ${fileCountLabel(state.selectedFiles.length)}. Можно отправлять.`;
      }
    }
  }

  function setTransferring(active) {
    state.isTransferring = active;
    elements.dropzone.classList.toggle('is-transferring', active);
    elements.fileInput.disabled = active;
    elements.refreshBtn.disabled = active;
    updateSendButton();
  }

  function flushPendingSignals() {
    if (!state.session || state.pendingSignals.length === 0) {
      return;
    }

    const signals = [...state.pendingSignals];
    state.pendingSignals = [];

    signals.forEach(({ signal }) => {
      state.session.handleSignal(signal);
    });
  }

  function createSession() {
    if (state.session || !state.peerId) {
      return;
    }

    state.session = new WebRtcPeerSession({
      initiator: true,
      iceServers: config.iceServers,
      onSignal: async (signal) => {
        try {
          await emitWithAck(socket, 'signal', {
            code: state.code,
            to: state.peerId,
            signal,
          });
        } catch {
          showNotice(elements.status, { type: 'error', message: 'Не удалось отправить сигнал соединения.' });
        }
      },
      onMessage: handleIncomingMessage,
      onStateChange: ({ connectionState }) => {
        if (connectionState === 'connected') {
          setRoomStatus('connecting', 'Соединение', 'P2P-соединение установлено. Открываем канал передачи…');
          updateDevices();
        } else if (connectionState === 'connecting') {
          setRoomStatus('connecting', 'Соединение', 'Подключаем P2P-канал…');
          updateDevices();
        } else if (connectionState === 'failed') {
          setRoomStatus('reconnecting', 'Восстановление', 'P2P-соединение прервалось. Пробуем восстановить канал…');
          updateDevices();
          showNotice(elements.status, { type: 'warning', message: 'Соединение просело. Пробуем восстановить…' });
        } else if (connectionState === 'disconnected') {
          setRoomStatus('reconnecting', 'Восстановление', 'Соединение временно прервано. Восстанавливаем канал…');
          updateDevices();
        }
      },
      onChannelOpen: () => {
        updateSendButton();
        setPeerState('connected', 'Комната подключена', 'Защищённый канал открыт. Выберите файлы и отправьте их.');
        sendPeerInfo();
        showNotice(elements.status, { type: 'success', message: 'Канал открыт. Передача доступна.' });
        syncInfoDialog();
      },
      onChannelClose: () => {
        setDisabled(elements.sendButton, true);
        updateDevices();
        if (state.joined) {
          setPeerState('reconnecting', 'Восстановление', 'Канал передачи закрыт. Ждём восстановления соединения…');
        }
      },
      onError: () => {
        showNotice(elements.status, { type: 'error', message: 'WebRTC-соединение завершилось с ошибкой.' });
      },
    });

    state.sessionPeerId = state.peerId;
    flushPendingSignals();
    updateDevices();
  }

  function ensureSessionForPeer(peerId) {
    if (!peerId) {
      return;
    }

    if (state.session && state.sessionPeerId !== peerId) {
      resetSession();
    }

    if (!state.session) {
      createSession();
    }
  }

  async function joinRoom() {
    if (state.joining || state.joined) {
      return;
    }

    const code = normalizeRoomCode(elements.codeInput.value, config.roomCodeLength);
    elements.codeInput.value = code;

    if (code.length !== config.roomCodeLength) {
      elements.codeInput.setAttribute('aria-invalid', 'true');
      setJoinFeedback('error', `Введите код из ${config.roomCodeLength} цифр.`);
      elements.codeInput.focus({ preventScroll: true });
      return;
    }

    elements.codeInput.removeAttribute('aria-invalid');
    showNotice(elements.status, { message: '' });
    setJoinBusy('checking');

    try {
      const roomInfo = await api.getRoom(code);

      if (!roomInfo.exists) {
        throw new Error('room-not-found');
      }

      if (Number(roomInfo.size) >= Number(roomInfo.capacity || 2)) {
        throw new Error('room-full');
      }

      setJoinBusy('joining');
      await waitForSocketConnection();

      const response = await emitWithAck(socket, 'join-room', { code });
      state.code = code;
      state.joined = true;
      state.peerId = (response.room?.peerIds || []).find((peerId) => peerId !== socket.id) || '';
      state.peerInfo = null;

      showActiveRoom(code);

      if (state.peerId) {
        setRoomStatus(
          'connecting',
          'Соединение',
          'Второе устройство найдено. Устанавливаем P2P-соединение…',
        );
        ensureSessionForPeer(state.peerId);
      } else {
        setRoomStatus(
          'waiting',
          'Комната активна',
          'Вы в комнате. Ожидаем подключение второго устройства.',
        );
      }
      updateDevices();

      showNotice(elements.status, {
        type: 'success',
        message: `Подключение к комнате ${code} установлено.`,
      });

      if (state.selectedFiles.length > 0) {
        window.setTimeout(() => openPreparation(state.selectedFiles), 300);
      }
    } catch (error) {
      state.joining = false;
      elements.codeInput.disabled = false;
      elements.codeInput.setAttribute('aria-invalid', 'true');
      setJoinFeedback('error', getJoinErrorMessage(error));
      showNotice(elements.status, {
        type: 'error',
        message: getJoinErrorMessage(error),
      });
      elements.codeInput.focus({ preventScroll: true });
    } finally {
      state.joining = false;
      elements.codeInput.disabled = state.joined;
      if (state.joined) {
        updateJoinButton();
      } else {
        setJoinBusy('idle');
      }
    }
  }

  async function sendFiles() {
    if (!state.session) {
      showNotice(elements.status, { type: 'warning', message: 'P2P-канал ещё не готов.' });
      return;
    }
    if (state.selectedFiles.length === 0) {
      showNotice(elements.status, { type: 'warning', message: 'Выберите хотя бы один файл.' });
      return;
    }
    if (state.isTransferring) {
      return;
    }

    setTransferring(true);
    clearTransferDisplay();
    showNotice(elements.status, { clear: true, message: '' });

    const abortController = new AbortController();
    state.abortController = abortController;

    try {
      await state.session.waitForOpen();
      if (!state.joined) {
        return;
      }
      setRoomStatus('connected', 'Идёт передача', 'Файлы передаются напрямую в защищённом P2P-канале.');

      const chunkSize = Number(elements.chunkSizeSelect.value);
      const files = [...state.selectedFiles];
      await sender.sendFiles(files, chunkSize, { signal: abortController.signal });
      if (!state.joined) {
        return;
      }
      state.selectedFiles = [];
      state.prepFiles = [];
      state.archiveFile = null;
      renderFileList();
      showNotice(elements.status, { type: 'info', message: 'Файлы отправлены. Ожидаем подтверждение получения…' });
    } catch (error) {
      if (!state.joined) {
        return;
      }

      const activeRecord = state.history.find((record) => record.id === state.currentRecordId);
      if (error?.name === 'AbortError') {
        if (activeRecord) {
          updateHistoryRecord(activeRecord, { status: 'canceled', errorMessage: 'Отменено отправителем' });
          failCurrentTransfer(activeRecord, 'Передача отменена.');
        }
        showNotice(elements.status, { type: 'warning', message: 'Передача отменена.' });
      } else {
        if (activeRecord && ACTIVE_HISTORY_STATUSES.has(activeRecord.status)) {
          updateHistoryRecord(activeRecord, { status: 'error', errorMessage: error?.message || 'Ошибка передачи' });
          failCurrentTransfer(activeRecord, error?.message || 'Передача не удалась.');
        }
        showNotice(elements.status, {
          type: 'error',
          message: error?.message || 'Передача не удалась.',
        });
      }
    } finally {
      state.abortController = null;
      setTransferring(false);
      updateRoomStatusFromState();
      updateDevices();
    }
  }

  function requestCancelTransfer(record = null) {
    if (!state.isTransferring || !state.abortController) {
      return;
    }

    const activeRecord = record || state.history.find((entry) => entry.id === state.currentRecordId);
    if (!activeRecord) {
      return;
    }

    openConfirm({
      title: 'Отменить отправку?',
      message: `Текущая передача «${activeRecord.name}» будет прекращена. Уже переданные данные могут быть неполными, и файл не будет получен получателем.`,
      confirmLabel: 'Да, отменить',
      cancelLabel: 'Нет, продолжить',
      onConfirm: () => {
        elements.cancelTransferBtn.disabled = true;
        state.abortController?.abort();
      },
    });
  }

  function openConfirm({ title, message, confirmLabel = 'Да, отменить', cancelLabel = 'Нет, продолжить', tone = 'danger', onConfirm }) {
    elements.confirmTitle.textContent = title;
    elements.confirmMessage.textContent = message;
    elements.confirmAcceptBtn.textContent = confirmLabel;
    elements.confirmCancelBtn.textContent = cancelLabel;
    elements.confirmAcceptBtn.classList.toggle('btn-danger', tone === 'danger');
    elements.confirmAcceptBtn.classList.toggle('btn-primary', tone !== 'danger');
    elements.confirmIcon.dataset.tone = tone;
    state.confirmAction = onConfirm;
    openDialog(elements.confirmDialog);
  }

  function closeConfirmDialog() {
    state.confirmAction = null;
    closeDialog(elements.confirmDialog);
  }

  function syncInfoDialog() {
    elements.infoRoomCode.textContent = state.code || '—';
    elements.infoConnection.textContent = elements.roomStatusTitle.textContent || '—';
    elements.infoPeer.textContent = state.peerInfo
      ? `${state.peerInfo.typeLabel} · ${state.peerInfo.os} · ${state.peerInfo.browser}`
      : (state.peerId ? 'Устройство подключено, определяем данные' : 'Ожидаем подключение');
  }

  function requestLeaveRoom() {
    if (!state.joined) {
      return;
    }

    if (state.isTransferring) {
      openConfirm({
        title: 'Выйти из комнаты?',
        message: 'Текущая передача будет прервана, а комната закроется для этого устройства. Вы сможете подключиться снова по тому же коду.',
        confirmLabel: 'Да, выйти',
        cancelLabel: 'Нет, остаться',
        onConfirm: () => {
          state.abortController?.abort();
          performLeaveRoom();
        },
      });
      return;
    }

    performLeaveRoom();
  }

  function performLeaveRoom() {
    window.clearTimeout(state.archiveTransitionTimer);
    window.clearTimeout(state.historyRenderTimer);
    state.historyRenderTimer = null;
    state.archiveAbortController?.abort();
    state.archiveAbortController = null;
    state.archiveInFlight = false;

    if (socket.connected && state.joined && state.code) {
      socket.emit('leave-room', { code: state.code });
    }

    closeDialog(elements.prepareDialog);
    closeDialog(elements.archiveDialog);
    closeDialog(elements.readyDialog);
    closeDialog(elements.confirmDialog);
    closeDialog(elements.infoDialog);

    resetSession();
    revokeHistoryUrls(state.history);
    state.joined = false;
    state.joining = false;
    state.peerId = '';
    state.peerInfo = null;
    state.code = '';
    state.pendingSignals = [];
    state.selectedFiles = [];
    state.prepFiles = [];
    state.archiveFile = null;
    state.history = [];
    state.historyFilter = 'all';
    state.completedTransfers.clear();
    state.currentRecordId = '';
    window.clearTimeout(state.copyCodeTimer);
    window.clearTimeout(state.copyLinkTimer);
    state.copyCodeTimer = null;
    state.copyLinkTimer = null;
    elements.copyCodeBtn.classList.remove('is-copied');
    elements.copyLinkBtn.classList.remove('is-copied');
    if (elements.copyLinkLabel) {
      elements.copyLinkLabel.textContent = 'Копировать';
    }
    elements.codeInput.value = '';
    elements.roomLink.value = '';
    elements.roomQr.replaceChildren();
    elements.fileList.replaceChildren();
    elements.fileInput.value = '';
    elements.prepareFileInput.value = '';
    clearTransferDisplay();
    resetHistoryFilter();
    renderHistory();
    showJoinForm();
    setRoomHint(`Введите код из ${config.roomCodeLength} цифр.`);
    setJoinFeedback('info', 'Вы вышли из комнаты. Можно подключиться к другой комнате.');
    showNotice(elements.status, { type: 'info', message: 'Вы вышли из комнаты.' });
    elements.codeInput.focus({ preventScroll: true });
  }

  async function refreshConnection() {
    if (!state.joined || state.isTransferring) {
      if (state.isTransferring) {
        showNotice(elements.status, { type: 'warning', message: 'Дождитесь завершения передачи, чтобы обновить соединение.' });
      }
      return;
    }

    setDisabled(elements.refreshBtn, true);
    elements.refreshBtn.classList.add('is-loading');
    setRoomStatus('reconnecting', 'Обновление соединения', 'Проверяем комнату и восстанавливаем канал передачи…');

    try {
      await waitForSocketConnection();
      const response = await emitWithAck(socket, 'join-room', { code: state.code });
      state.peerId = (response.room?.peerIds || []).find((peerId) => peerId !== socket.id) || '';

      if (state.session && (!state.peerId || !state.session.isReady())) {
        resetSession();
      }

      if (state.peerId) {
        ensureSessionForPeer(state.peerId);
      }

      updateDevices();
      updateRoomStatusFromState();
      showNotice(elements.status, {
        type: 'success',
        message: state.peerId ? 'Соединение проверено и обновлено.' : 'Комната активна. Ожидаем второе устройство.',
      });
    } catch (error) {
      setRoomStatus('error', 'Ошибка соединения', getJoinErrorMessage(error));
      showNotice(elements.status, { type: 'error', message: getJoinErrorMessage(error) });
    } finally {
      setDisabled(elements.refreshBtn, false);
      elements.refreshBtn.classList.remove('is-loading');
    }
  }

  function setArchiveProgress({ ratio = 0, preparedFiles = 0, totalFiles = 0, currentSize = 0, etaSeconds = null }) {
    const percent = Math.max(0, Math.min(100, Math.round(ratio * 100)));
    elements.archiveBar.style.width = `${percent}%`;
    elements.archiveProgress.setAttribute('aria-valuenow', String(percent));
    elements.archivePercent.textContent = `${percent}%`;
    elements.archiveFiles.textContent = `${preparedFiles} из ${totalFiles}`;
    elements.archiveSize.textContent = formatBytes(currentSize);
    elements.archiveEta.textContent = formatEta(etaSeconds);
  }

  function setArchiveState(stateName, title, text) {
    elements.archiveHero.dataset.state = stateName;
    elements.archiveStateTitle.textContent = title;
    elements.archiveStateText.textContent = text;
    elements.archiveError.hidden = true;
    elements.archiveRetryBtn.hidden = true;

    const cancelLabel = elements.archiveCancelBtn.querySelector('span');
    if (stateName === 'success') {
      cancelLabel.textContent = 'Архив готов';
      setDisabled(elements.archiveCancelBtn, true);
    } else if (stateName === 'error') {
      cancelLabel.textContent = 'Вернуться к файлам';
      setDisabled(elements.archiveCancelBtn, false);
    } else {
      cancelLabel.textContent = 'Отменить архивацию';
      setDisabled(elements.archiveCancelBtn, false);
    }
  }

  function showPreparation(files = state.selectedFiles) {
    if (files.length === 0) {
      showNotice(elements.status, { type: 'warning', message: 'Сначала выберите файлы.' });
      return;
    }

    closeDialog(elements.readyDialog);
    closeDialog(elements.archiveDialog);
    state.prepFiles = [...files];
    elements.zipToggle.checked = files.length > 1;
    elements.prepareFeedback.hidden = true;
    elements.prepareFeedback.textContent = '';
    renderPreparation();
    openDialog(elements.prepareDialog);
  }

  function renderPreparation() {
    const totalBytes = state.prepFiles.reduce((sum, file) => sum + file.size, 0);
    elements.prepareSummary.textContent = `Выбрано ${fileCountLabel(state.prepFiles.length)} · ${formatBytes(totalBytes)}`;
    elements.prepareFileList.replaceChildren();
    elements.prepareContinueBtn.disabled = state.prepFiles.length === 0;

    if (state.prepFiles.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'prep-empty';
      empty.innerHTML = '<strong>Файлы не выбраны</strong><span>Добавьте файлы, чтобы продолжить.</span>';
      elements.prepareFileList.appendChild(empty);
      updateZipNote();
      return;
    }

    state.prepFiles.forEach((file, index) => {
      const row = document.createElement('div');
      row.className = 'prep-file-row';
      row.setAttribute('role', 'listitem');
      row.appendChild(createFileIcon(file.name, file.type));

      const copy = document.createElement('div');
      copy.className = 'prep-file-copy';
      const name = document.createElement('strong');
      name.className = 'prep-file-name';
      name.textContent = file.name;
      name.title = file.name;
      const meta = document.createElement('span');
      meta.className = 'prep-file-meta';
      meta.textContent = `${formatBytes(file.size)} · ${getFileKind(file.name, file.type).label}`;
      copy.append(name, meta);

      const remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'prep-file-remove';
      remove.setAttribute('aria-label', `Удалить ${file.name} из подготовки`);
      remove.title = 'Удалить файл';
      remove.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>';
      remove.addEventListener('click', () => {
        state.prepFiles.splice(index, 1);
        if (state.prepFiles.length < 2) {
          elements.zipToggle.checked = false;
        }
        renderPreparation();
      });

      row.append(copy, remove);
      elements.prepareFileList.appendChild(row);
    });

    updateZipNote();
  }

  function updateZipNote() {
    const count = state.prepFiles.length;
    const totalSize = state.prepFiles.reduce((sum, file) => sum + file.size, 0);

    if (count === 0) {
      elements.zipNote.textContent = 'Выберите файлы, чтобы настроить отправку.';
      return;
    }

    if (elements.zipToggle.checked) {
      if (count > 1) {
        elements.zipNote.textContent = `ZIP включён автоматически, так как выбрано ${fileCountLabel(count)} (${formatBytes(totalSize)}). Архив создаётся прямо в браузере.`;
      } else {
        elements.zipNote.textContent = 'Файл будет упакован в ZIP-архив перед отправкой. Архивация выполняется прямо в браузере.';
      }
    } else {
      elements.zipNote.textContent = count > 1
        ? 'Файлы будут отправлены по отдельности. Получатель увидит их как несколько входящих файлов.'
        : 'Файл будет отправлен напрямую, без создания архива.';
    }
  }

  function addPreparedFiles(newFiles) {
    const accepted = [];
    const rejected = [];

    for (const file of newFiles) {
      const duplicate = state.prepFiles.some(
        (item) => item.name === file.name && item.size === file.size,
      );
      if (duplicate) {
        rejected.push(`${file.name} — уже добавлен`);
        continue;
      }
      if (file.size <= 0) {
        rejected.push(`${file.name} — пустой файл`);
        continue;
      }
      if (file.size > config.maxFileSizeBytes) {
        rejected.push(`${file.name} — больше ${formatBytes(config.maxFileSizeBytes)}`);
        continue;
      }
      if (state.prepFiles.length + accepted.length >= config.maxFilesPerTransfer) {
        rejected.push(`${file.name} — превышен лимит ${config.maxFilesPerTransfer} файлов`);
        continue;
      }
      accepted.push(file);
    }

    if (accepted.length > 0) {
      state.prepFiles.push(...accepted);
      if (state.prepFiles.length > 1) {
        elements.zipToggle.checked = true;
      }
    }

    if (rejected.length > 0) {
      const preview = rejected.slice(0, 3).join('; ');
      const suffix = rejected.length > 3 ? `; и ещё ${rejected.length - 3}` : '';
      const rejectedText = `Не добавлено: ${preview}${suffix}.`;
      elements.prepareFeedback.textContent = accepted.length > 0
        ? `Добавлено: ${fileCountLabel(accepted.length)}. ${rejectedText}`
        : rejectedText;
      elements.prepareFeedback.hidden = false;
    } else {
      elements.prepareFeedback.textContent = '';
      elements.prepareFeedback.hidden = true;
    }

    renderPreparation();
    if (!elements.prepareFeedback.hidden) {
      elements.prepareFeedback.scrollIntoView({ block: 'nearest' });
    }
  }

  function applyPreparedFiles(files) {
    state.archiveFile = null;
    state.selectedFiles = [...files];
    state.prepFiles = [];
    renderFileList();
    updateSendButton();
    closeDialog(elements.prepareDialog);
    showNotice(elements.status, {
      type: 'info',
      message: `Файлы подготовлены: ${fileCountLabel(files.length)}. Нажмите «Отправить».`,
    });
    elements.sendButton.focus({ preventScroll: true });
  }

  async function startArchive() {
    if (!state.joined || state.archiveInFlight || state.prepFiles.length === 0) {
      return;
    }

    closeDialog(elements.prepareDialog);
    state.archiveFile = null;
    state.archiveInFlight = true;
    state.archiveAbortController = new AbortController();
    const archiveName = buildArchiveName();
    elements.archiveName.textContent = archiveName;
    setArchiveState('waiting', 'Подготовка к архивации', `Проверяем ${fileCountLabel(state.prepFiles.length)} перед упаковкой.`);
    elements.archiveSubtitle.textContent = 'ZIP-архив создаётся прямо в браузере. Пожалуйста, подождите…';
    elements.archiveCloseBtn.disabled = true;
    setDisabled(elements.archiveCancelBtn, false);
    elements.archiveCancelBtn.querySelector('span').textContent = 'Отменить архивацию';
    setArchiveProgress({
      ratio: 0,
      preparedFiles: 0,
      totalFiles: state.prepFiles.length,
      currentSize: 0,
      etaSeconds: null,
    });
    openDialog(elements.archiveDialog);

    const files = [...state.prepFiles];

    try {
      await new Promise((resolve) => window.requestAnimationFrame(resolve));
      if (!state.joined) {
        return;
      }
      setArchiveState('working', 'Собираем архив', `Объединяем ${fileCountLabel(files.length)} в один ZIP-архив.`);

      const archiveFile = await createZipArchive(files, {
        name: archiveName,
        signal: state.archiveAbortController.signal,
        onProgress: ({ ratio, preparedFiles, totalFiles, currentSize, etaSeconds }) => {
          setArchiveProgress({ ratio, preparedFiles, totalFiles, currentSize, etaSeconds });
        },
      });

      if (!state.joined) {
        state.archiveFile = null;
        return;
      }

      if (archiveFile.size > config.maxFileSizeBytes) {
        throw new Error(`Архив превышает лимит ${formatBytes(config.maxFileSizeBytes)}. Отключите ZIP и отправьте файлы по отдельности.`);
      }

      state.archiveFile = archiveFile;
      setArchiveProgress({
        ratio: 1,
        preparedFiles: files.length,
        totalFiles: files.length,
        currentSize: archiveFile.size,
        etaSeconds: 0,
      });
      setArchiveState('success', 'Архив создан', `${formatBytes(archiveFile.size)} · ${fileCountLabel(files.length)}`);
      elements.archivePercent.textContent = '100%';
      elements.archiveSubtitle.textContent = 'ZIP-архив успешно создан на вашем устройстве.';

      await delay(550);
      closeDialog(elements.archiveDialog);
      if (!state.joined) {
        return;
      }
      showReadyDialog(archiveFile, files.length);
    } catch (error) {
      if (!state.joined) {
        state.archiveFile = null;
        return;
      }

      if (error?.name === 'AbortError') {
        state.archiveFile = null;
        closeDialog(elements.archiveDialog);
        if (state.prepFiles.length > 0) {
          renderPreparation();
          openDialog(elements.prepareDialog);
        }
        showNotice(elements.status, { type: 'info', message: 'Создание архива отменено.' });
      } else {
        setArchiveState('error', 'Не удалось создать архив', 'Файлы остались на вашем устройстве. Попробуйте ещё раз или вернитесь к подготовке.');
        elements.archiveError.hidden = false;
        elements.archiveError.textContent = error?.message || 'Неизвестная ошибка при создании архива.';
        elements.archiveRetryBtn.hidden = false;
        elements.archiveCloseBtn.disabled = false;
        elements.archiveSubtitle.textContent = 'Архивация остановлена.';
        showNotice(elements.status, { type: 'error', message: error?.message || 'Не удалось создать архив.' });
      }
    } finally {
      state.archiveInFlight = false;
      state.archiveAbortController = null;
      if (state.archiveFile) {
        elements.archiveCloseBtn.disabled = true;
      }
    }
  }

  function showReadyDialog(archiveFile, sourceFileCount) {
    if (!state.joined) {
      return;
    }
    elements.readyName.textContent = archiveFile.name;
    elements.readySize.textContent = formatBytes(archiveFile.size);
    elements.readyCount.textContent = `В архив добавлено ${fileCountLabel(sourceFileCount)}.`;
    openDialog(elements.readyDialog);
  }

  function applyArchiveToSend() {
    if (!state.archiveFile) {
      closeDialog(elements.readyDialog);
      return;
    }

    state.selectedFiles = [state.archiveFile];
    state.prepFiles = [];
    renderFileList();
    updateSendButton();
    closeDialog(elements.readyDialog);
    showNotice(elements.status, {
      type: 'success',
      message: 'ZIP-архив готов. Нажмите «Отправить», чтобы передать его получателю.',
    });
    elements.sendButton.focus({ preventScroll: true });
  }

  function redoArchive() {
    const files = [...state.prepFiles];
    state.archiveFile = null;
    closeDialog(elements.readyDialog);
    if (files.length > 1) {
      elements.zipToggle.checked = true;
    }
    renderPreparation();
    openDialog(elements.prepareDialog);
  }

  function requestClearHistory() {
    if (state.history.length === 0) {
      return;
    }

    openConfirm({
      title: 'Очистить историю?',
      message: 'Записи о завершённых и отменённых передачах будут удалены. Активная передача останется в журнале.',
      confirmLabel: 'Очистить',
      cancelLabel: 'Отмена',
      onConfirm: () => {
        const removed = state.history.filter((record) => !ACTIVE_HISTORY_STATUSES.has(record.status));
        revokeHistoryUrls(removed);
        state.history = state.history.filter((record) => ACTIVE_HISTORY_STATUSES.has(record.status));
        if (!state.history.some((record) => record.id === state.currentRecordId)) {
          state.currentRecordId = '';
          clearTransferDisplay();
        }
        renderHistory();
        showNotice(elements.status, { type: 'info', message: 'История передач очищена.' });
      },
    });
  }

  // ── File management ──────────────────────────────────────────

  function renderFileList() {
    elements.fileList.replaceChildren();
    if (state.selectedFiles.length === 0) {
      return;
    }

    const header = document.createElement('div');
    header.className = 'file-list-header';
    const totalBytes = state.selectedFiles.reduce((sum, file) => sum + file.size, 0);
    const label = document.createElement('span');
    label.className = 'file-list-label';
    label.textContent = `${fileCountLabel(state.selectedFiles.length)} · ${formatBytes(totalBytes)}`;
    const clearBtn = document.createElement('button');
    clearBtn.className = 'file-list-clear';
    clearBtn.type = 'button';
    clearBtn.textContent = 'Очистить всё';
    clearBtn.addEventListener('click', () => {
      if (state.isTransferring) {
        return;
      }
      state.archiveFile = null;
      state.selectedFiles = [];
      renderFileList();
      updateSendButton();
    });
    header.append(label, clearBtn);
    elements.fileList.appendChild(header);

    state.selectedFiles.forEach((file, index) => {
      const item = document.createElement('div');
      item.className = 'file-list-item';
      item.appendChild(createFileIcon(file.name, file.type));

      const name = document.createElement('span');
      name.className = 'file-list-name';
      name.textContent = file.name;
      name.title = file.name;

      const size = document.createElement('span');
      size.className = 'file-list-size';
      size.textContent = `${formatBytes(file.size)} · ${getFileKind(file.name, file.type).extension || 'FILE'}`;

      const removeBtn = document.createElement('button');
      removeBtn.className = 'file-list-remove';
      removeBtn.type = 'button';
      removeBtn.setAttribute('aria-label', `Удалить ${file.name}`);
      removeBtn.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>';
      removeBtn.addEventListener('click', (event) => {
        event.stopPropagation();
        if (state.isTransferring) {
          return;
        }
        state.archiveFile = null;
        state.selectedFiles.splice(index, 1);
        renderFileList();
        updateSendButton();
      });

      item.append(name, size, removeBtn);
      elements.fileList.appendChild(item);
    });
  }

  function addFiles(newFiles, { openPreparation: shouldOpenPreparation = true } = {}) {
    if (state.isTransferring) {
      return;
    }

    const accepted = [];
    const rejected = [];

    for (const file of newFiles) {
      const duplicate = state.selectedFiles.some(
        (existing) => existing.name === file.name && existing.size === file.size,
      );
      if (duplicate) {
        continue;
      }
      if (file.size <= 0) {
        rejected.push(`${file.name} — пустой файл`);
        continue;
      }
      if (file.size > config.maxFileSizeBytes) {
        rejected.push(`${file.name} — больше ${formatBytes(config.maxFileSizeBytes)}`);
        continue;
      }
      if (state.selectedFiles.length + accepted.length >= config.maxFilesPerTransfer) {
        rejected.push(`${file.name} — превышен лимит ${config.maxFilesPerTransfer} файлов`);
        continue;
      }
      accepted.push(file);
    }

    if (accepted.length > 0) {
      state.archiveFile = null;
      state.selectedFiles.push(...accepted);
      renderFileList();
      updateSendButton();
      closeTransferDisplay();
      if (shouldOpenPreparation) {
        showPreparation(state.selectedFiles);
      }
    }

    if (rejected.length > 0) {
      showNotice(elements.status, {
        type: 'warning',
        message: `Не добавлено: ${rejected.join('; ')}.`,
      });
    }
  }

  function closeTransferDisplay() {
    if (!state.isTransferring) {
      elements.currentTransfer.hidden = true;
    }
  }

  elements.fileInput.addEventListener('change', () => {
    const files = Array.from(elements.fileInput.files || []);
    if (files.length > 0) {
      addFiles(files);
    }
    elements.fileInput.value = '';
  });

  elements.dropzone.addEventListener('dragover', (event) => {
    if (state.isTransferring) {
      return;
    }
    event.preventDefault();
    elements.dropzone.classList.add('drag-over');
  });

  elements.dropzone.addEventListener('dragleave', () => {
    elements.dropzone.classList.remove('drag-over');
  });

  elements.dropzone.addEventListener('drop', (event) => {
    event.preventDefault();
    elements.dropzone.classList.remove('drag-over');
    if (state.isTransferring) {
      return;
    }
    const files = Array.from(event.dataTransfer?.files || []);
    if (files.length > 0) {
      addFiles(files);
    }
  });

  elements.prepareAddBtn.addEventListener('click', () => {
    elements.prepareFileInput.click();
  });

  elements.prepareFileInput.addEventListener('change', () => {
    const files = Array.from(elements.prepareFileInput.files || []);
    if (files.length > 0) {
      addPreparedFiles(files);
    }
    elements.prepareFileInput.value = '';
  });

  elements.zipToggle.addEventListener('change', updateZipNote);

  elements.prepareContinueBtn.addEventListener('click', () => {
    if (state.prepFiles.length === 0) {
      return;
    }
    if (elements.zipToggle.checked) {
      startArchive();
    } else {
      applyPreparedFiles(state.prepFiles);
    }
  });

  elements.archiveCancelBtn.addEventListener('click', () => {
    if (state.archiveInFlight) {
      elements.archiveCancelBtn.querySelector('span').textContent = 'Отменяем…';
      setDisabled(elements.archiveCancelBtn, true);
      state.archiveAbortController?.abort();
      return;
    }

    if (state.archiveFile) {
      closeDialog(elements.archiveDialog);
      showReadyDialog(state.archiveFile, state.prepFiles.length);
      return;
    }

    closeDialog(elements.archiveDialog);
    renderPreparation();
    openDialog(elements.prepareDialog);
  });

  elements.archiveRetryBtn.addEventListener('click', () => {
    startArchive();
  });

  elements.readyContinueBtn.addEventListener('click', applyArchiveToSend);
  elements.readyAgainBtn.addEventListener('click', redoArchive);

  elements.confirmAcceptBtn.addEventListener('click', () => {
    const action = state.confirmAction;
    state.confirmAction = null;
    closeDialog(elements.confirmDialog);
    if (typeof action === 'function') {
      action();
    }
  });
  elements.confirmCancelBtn.addEventListener('click', closeConfirmDialog);
  elements.roomInfoBtn.addEventListener('click', () => {
    syncInfoDialog();
    openDialog(elements.infoDialog);
  });
  elements.refreshBtn.addEventListener('click', refreshConnection);
  elements.leaveRoomBtn.addEventListener('click', requestLeaveRoom);
  elements.clearHistoryBtn.addEventListener('click', requestClearHistory);
  elements.cancelTransferBtn.addEventListener('click', () => requestCancelTransfer());
  elements.sendButton.addEventListener('click', sendFiles);
  elements.joinForm.addEventListener('submit', (event) => {
    event.preventDefault();
    joinRoom();
  });

  elements.codeInput.addEventListener('input', () => {
    const code = normalizeRoomCode(elements.codeInput.value, config.roomCodeLength);
    elements.codeInput.value = code;
    elements.codeInput.removeAttribute('aria-invalid');
    setJoinFeedback(null);

    if (code.length < config.roomCodeLength) {
      setRoomHint(`Введите код из ${config.roomCodeLength} цифр.`);
    } else {
      setRoomHint('Код введён. Нажмите «Подключиться».');
    }

    updateJoinButton();
  });

  elements.copyCodeBtn.addEventListener('click', async () => {
    if (!state.code) {
      return;
    }
    const copied = await copyText(state.code);
    if (!copied) {
      showNotice(elements.status, { type: 'warning', message: 'Не удалось скопировать код комнаты.' });
      return;
    }
    elements.copyCodeBtn.classList.add('is-copied');
    showNotice(elements.status, { type: 'success', message: 'Код комнаты скопирован.' });
    window.clearTimeout(state.copyCodeTimer);
    state.copyCodeTimer = window.setTimeout(() => {
      elements.copyCodeBtn.classList.remove('is-copied');
    }, 1800);
  });

  elements.copyLinkBtn.addEventListener('click', async () => {
    if (!elements.roomLink.value) {
      return;
    }
    const copied = await copyText(elements.roomLink.value);
    if (!copied) {
      showNotice(elements.status, { type: 'warning', message: 'Не удалось скопировать ссылку.' });
      return;
    }
    elements.copyLinkBtn.classList.add('is-copied');
    if (elements.copyLinkLabel) {
      elements.copyLinkLabel.textContent = 'Скопировано';
    }
    showNotice(elements.status, { type: 'success', message: 'Ссылка на комнату скопирована.' });
    window.clearTimeout(state.copyLinkTimer);
    state.copyLinkTimer = window.setTimeout(() => {
      elements.copyLinkBtn.classList.remove('is-copied');
      if (elements.copyLinkLabel) {
        elements.copyLinkLabel.textContent = 'Копировать';
      }
    }, 1800);
  });

  elements.historyTabs.forEach((tab) => {
    tab.addEventListener('click', () => {
      state.historyFilter = tab.dataset.filter || 'all';
      elements.historyTabs.forEach((item) => {
        const active = item === tab;
        item.classList.toggle('is-active', active);
        item.setAttribute('aria-selected', String(active));
      });
      renderHistory();
    });
  });

  setupDialogDismiss(elements.prepareDialog, {
    onDismiss: () => closeDialog(elements.prepareDialog),
  });
  setupDialogDismiss(elements.archiveDialog, {
    canDismiss: () => !state.archiveInFlight,
    onDismiss: () => {
      closeDialog(elements.archiveDialog);
      if (state.archiveFile) {
        showReadyDialog(state.archiveFile, state.prepFiles.length);
      } else {
        renderPreparation();
        openDialog(elements.prepareDialog);
      }
    },
  });
  setupDialogDismiss(elements.readyDialog, {
    onDismiss: applyArchiveToSend,
  });
  setupDialogDismiss(elements.confirmDialog, {
    onDismiss: closeConfirmDialog,
  });
  setupDialogDismiss(elements.infoDialog, {
    onDismiss: () => closeDialog(elements.infoDialog),
  });

  function startKeepAlive() {
    window.clearInterval(state.keepAliveTimer);
    state.keepAliveTimer = window.setInterval(() => {
      api.ping().catch(() => {});
    }, 140000);
  }

  socket.on('connect', async () => {
    if (!state.joined || !state.code) {
      return;
    }

    setRoomStatus('reconnecting', 'Переподключение', 'Сигнальный сервер снова доступен. Восстанавливаем комнату…');

    try {
      const response = await emitWithAck(socket, 'join-room', { code: state.code });
      state.peerId = (response.room?.peerIds || []).find((peerId) => peerId !== socket.id) || '';

      if (state.session && (!state.peerId || !state.session.isReady())) {
        resetSession();
      }

      if (state.peerId) {
        ensureSessionForPeer(state.peerId);
      }
      updateDevices();
      updateRoomStatusFromState();

      showNotice(elements.status, {
        type: 'success',
        message: 'Подключение к комнате восстановлено.',
      });
    } catch (error) {
      setRoomStatus('error', 'Ошибка', 'Не удалось восстановить подключение к комнате.');
      showNotice(elements.status, { type: 'error', message: getJoinErrorMessage(error) });
    }
  });

  socket.on('disconnect', () => {
    if (!state.joined) {
      return;
    }

    setRoomStatus('reconnecting', 'Переподключение', 'Сигнальный сервер временно недоступен. Пробуем восстановить соединение…');
    updateDevices();
    showNotice(elements.status, {
      type: 'warning',
      message: 'Сигнальный сервер временно недоступен. Пробуем переподключиться…',
    });
  });

  socket.on('peer-joined', ({ peerId }) => {
    if (!state.joined) {
      return;
    }

    state.peerId = peerId || '';
    state.peerInfo = null;
    setRoomStatus('connecting', 'Соединение', 'Второе устройство подключено. Устанавливаем P2P-соединение…');
    ensureSessionForPeer(state.peerId);
    updateDevices();
  });

  socket.on('peer-left', () => {
    if (!state.joined) {
      return;
    }

    const activeRecord = state.history.find((record) => record.id === state.currentRecordId);
    if (state.isTransferring) {
      state.abortController?.abort();
      if (activeRecord && ACTIVE_HISTORY_STATUSES.has(activeRecord.status)) {
        updateHistoryRecord(activeRecord, { status: 'canceled', errorMessage: 'Второе устройство отключилось' });
        failCurrentTransfer(activeRecord, 'Второе устройство отключилось.');
      }
    }

    resetSession();
    state.peerId = '';
    state.peerInfo = null;
    updateDevices();
    setRoomStatus('waiting', 'Комната активна', 'Второе устройство вышло из комнаты. Ожидаем новое подключение.');
    showNotice(elements.status, {
      type: 'warning',
      message: 'Второе устройство вышло из комнаты.',
    });
  });

  socket.on('room-state', ({ size, peerIds }) => {
    if (!state.joined) {
      return;
    }

    const otherPeerId = (peerIds || []).find((peerId) => peerId !== socket.id) || '';

    if (size < 2 || !otherPeerId) {
      state.peerId = '';
      if (state.session) {
        resetSession();
      }
      updateDevices();
      if (!state.isTransferring) {
        setRoomStatus('waiting', 'Комната активна', 'Вы в комнате. Ожидаем подключение второго устройства.');
      }
      return;
    }

    if (state.peerId !== otherPeerId) {
      state.peerInfo = null;
    }
    state.peerId = otherPeerId;

    if (!state.session) {
      setRoomStatus('connecting', 'Соединение', 'Второе устройство найдено. Устанавливаем P2P-соединение…');
    }

    ensureSessionForPeer(state.peerId);
    updateDevices();
  });

  socket.on('signal', (payload) => {
    if (!state.joined || !payload?.signal) {
      return;
    }

    if (payload.from) {
      state.peerId = payload.from;
    }

    ensureSessionForPeer(state.peerId);

    if (!state.session) {
      state.pendingSignals.push(payload);
      return;
    }

    state.session.handleSignal(payload.signal);
  });

  window.addEventListener('beforeunload', () => {
    window.clearInterval(state.keepAliveTimer);
    window.clearTimeout(state.historyRenderTimer);
    window.clearTimeout(state.archiveTransitionTimer);
    state.archiveAbortController?.abort();
    if (state.joined) {
      socket.emit('leave-room', { code: state.code });
    }
    revokeHistoryUrls(state.history);
    resetSession();
  });

  const query = parseQuery();
  const prefilledRoom = normalizeRoomCode(getRoomCodeFromQuery(query), config.roomCodeLength);

  elements.codeInput.maxLength = config.roomCodeLength;
  elements.codeInput.placeholder = '0'.repeat(config.roomCodeLength);

  elements.chunkSizeSelect.innerHTML = '';
  config.chunkSizeOptions.forEach((size, index) => {
    const option = document.createElement('option');
    option.value = size;
    option.textContent = `${Math.round(size / 1024)} KB`;
    if (index === Math.min(2, config.chunkSizeOptions.length - 1)) {
      option.selected = true;
    }
    elements.chunkSizeSelect.appendChild(option);
  });

  if (prefilledRoom) {
    elements.codeInput.value = prefilledRoom;
    setRoomHint('Код подставлен из ссылки. Нажмите «Подключиться».');
  } else {
    setRoomHint(`Введите код из ${config.roomCodeLength} цифр.`);
  }

  updateJoinButton();
  clearTransferDisplay();
  updateDevices();
  renderHistory();
  startKeepAlive();
}

init().catch((error) => {
  showNotice(document.querySelector('#status'), {
    type: 'error',
    message: `Не удалось инициализировать страницу отправки: ${error?.message || 'неизвестная ошибка'}.`,
  });
});
