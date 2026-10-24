import { createApiClient, createSocket, emitWithAck } from '../core/api.js';
import { loadRuntimeConfig } from '../core/config.js';
import { $, setDisabled, showNotice } from '../core/dom.js';
import { FileReceiver } from '../core/file-transfer.js';
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
import { buildSendUrl, formatBytes, sanitizeText } from '../core/utils.js';
import { WebRtcPeerSession } from '../core/webrtc-peer.js';

const HISTORY_STATUS = {
  receiving: { label: 'Принимается', tone: 'active' },
  completed: { label: 'Получено', tone: 'success' },
  canceled: { label: 'Отменено', tone: 'muted' },
  error: { label: 'Ошибка', tone: 'error' },
};

const ACTIVE_HISTORY_STATUSES = new Set(['receiving']);

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

function getCreateErrorMessage(error) {
  const code = error?.message || '';

  if (code === 'rate-limited') {
    return 'Слишком много попыток создания. Подождите минуту и попробуйте снова.';
  }

  if (code === 'room-unavailable') {
    return 'Сервер не смог создать комнату. Попробуйте ещё раз через несколько секунд.';
  }

  if (error?.name === 'AbortError') {
    return 'Сервер не ответил. Проверьте соединение и повторите попытку.';
  }

  return 'Не удалось создать комнату. Проверьте соединение и попробуйте снова.';
}

function getJoinErrorMessage(error) {
  const code = error?.message || '';

  if (code === 'room-not-found') {
    return 'Комната больше не существует. Создайте новую комнату, чтобы продолжить.';
  }

  if (code === 'room-full') {
    return 'Комната уже занята двумя устройствами. Создайте новую комнату.';
  }

  if (code === 'rate-limited') {
    return 'Слишком много попыток. Подождите минуту и повторите.';
  }

  if (['socket-timeout', 'socket-connect-error', 'request-timeout'].includes(code)) {
    return 'Сигнальный сервер не ответил. Проверьте соединение и повторите попытку.';
  }

  return 'Не удалось подключить комнату. Проверьте соединение и повторите попытку.';
}

async function init() {
  const createButton = $('#createRoomBtn');
  if (createButton) {
    createButton.disabled = true;
  }

  const config = await loadRuntimeConfig();
  const api = createApiClient(config);
  const socket = createSocket(config);
  const localDevice = detectDevice();

  const elements = {
    prejoinView: $('#prejoinView'),
    roomPage: document.querySelector('.room-page'),
    createLanding: $('#createLanding'),
    createPanel: $('#createPanel'),
    createButton,
    createButtonLabel: createButton?.querySelector('.btn-label'),
    createLoading: $('#createLoading'),
    createError: $('#createError'),
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
    incomingBadge: $('#incomingBadge'),
    incomingBadgeText: $('#incomingBadgeText'),
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
    historyList: $('#historyList'),
    historyEmpty: $('#historyEmpty'),
    historyTabs: Array.from(document.querySelectorAll('.history-tab')),
    clearHistoryBtn: $('#clearHistoryBtn'),
    status: $('#status'),
    copyLinkStatus: $('#copyLinkStatus'),
    confirmDialog: $('#confirmDialog'),
    confirmTitle: $('#confirmTitle'),
    confirmMessage: $('#confirmMessage'),
    confirmCancelBtn: $('#confirmCancelBtn'),
    confirmAcceptBtn: $('#confirmAcceptBtn'),
    infoDialog: $('#infoDialog'),
    infoRoomCode: $('#infoRoomCode'),
    infoConnection: $('#infoConnection'),
    infoPeer: $('#infoPeer'),
  };

  const state = {
    code: '',
    roomCreated: false,
    roomLost: false,
    creating: false,
    createFailed: false,
    joined: false,
    joinInFlight: false,
    shouldJoin: false,
    peerId: '',
    peerInfo: null,
    pendingSignals: [],
    session: null,
    sessionPeerId: '',
    keepAliveTimer: null,
    history: [],
    historyFilter: 'all',
    historyRenderTimer: null,
    currentRecordId: '',
    isReceiving: false,
    transferStartedAt: 0,
    confirmAction: null,
    copyCodeTimer: null,
    copyLinkTimer: null,
  };

  function setRoomStatus(tone, title, text) {
    elements.roomToolbar.dataset.state = tone;
    elements.roomStatusTitle.textContent = title;
    elements.roomStatusText.textContent = text;
    if (elements.infoConnection && elements.infoDialog.open) {
      elements.infoConnection.textContent = title;
    }
  }

  function updateIncomingBadge() {
    if (state.isReceiving) {
      elements.incomingBadge.dataset.state = 'active';
      elements.incomingBadgeText.textContent = 'Приём файла';
      return;
    }
    if (!state.joined) {
      elements.incomingBadge.dataset.state = 'waiting';
      elements.incomingBadgeText.textContent = 'Ожидаем отправителя';
      return;
    }
    if (!state.peerId) {
      elements.incomingBadge.dataset.state = 'waiting';
      elements.incomingBadgeText.textContent = 'Ожидаем отправителя';
      return;
    }
    if (!state.session?.isReady()) {
      elements.incomingBadge.dataset.state = 'connecting';
      elements.incomingBadgeText.textContent = 'Соединяемся';
      return;
    }
    elements.incomingBadge.dataset.state = 'ready';
    elements.incomingBadgeText.textContent = 'Готов принимать файлы';
  }

  function updateRoomStatusFromState() {
    if (!state.roomCreated) {
      return;
    }
    if (!socket.connected) {
      setRoomStatus('reconnecting', 'Переподключение', 'Сигнальный сервер временно недоступен. Восстанавливаем комнату…');
    } else if (!state.peerId) {
      setRoomStatus('waiting', 'Комната создана', 'Ожидаем подключение второго устройства.');
    } else if (!state.session) {
      setRoomStatus('connecting', 'Соединение', 'Второе устройство подключено. Устанавливаем P2P-соединение…');
    } else if (!state.session.isReady()) {
      setRoomStatus('connecting', 'Соединение', 'Подключаем защищённый канал передачи…');
    } else if (state.isReceiving) {
      setRoomStatus('connected', 'Комната подключена', 'Идёт приём файла по защищённому P2P-каналу.');
    } else {
      setRoomStatus('connected', 'Комната подключена', 'Защищённый P2P-канал открыт. Можно принимать файлы.');
    }
    updateIncomingBadge();
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
    updateIncomingBadge();
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
      // Device metadata is optional and must not block receiving files.
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

    receiver.handleData(data);
  }

  function historyStatus(record) {
    if (record.direction === 'received' && record.status === 'completed') {
      return { label: 'Получено', tone: 'success' };
    }
    return HISTORY_STATUS[record.status] || HISTORY_STATUS.error;
  }

  function historyDetail(record) {
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
        strong.textContent = state.historyFilter === 'sent'
          ? 'Отправленных файлов пока нет'
          : (state.historyFilter === 'received' ? 'Полученных файлов пока нет' : 'История пока пуста');
      }
      if (text) {
        text.textContent = state.historyFilter === 'received'
          ? 'После завершения приёма файлы появятся здесь вместе с кнопкой скачивания.'
          : (state.historyFilter === 'sent'
            ? 'Эта страница принимает файлы. Отправленные файлы появятся в журнале на устройстве-отправителе.'
            : 'Полученные файлы появятся здесь вместе со статусом и возможностью скачать.');
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
      peerLabel.textContent = 'От кого';
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

  function findHistoryRecordByTransferId(transferId) {
    return state.history.find((record) => record.transferId === transferId);
  }

  function syncReceivingState() {
    state.isReceiving = state.history.some((record) => record.status === 'receiving');
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
  }

  function resetHistoryFilter() {
    state.historyFilter = 'all';
    elements.historyTabs.forEach((tab) => {
      const active = (tab.dataset.filter || 'all') === 'all';
      tab.classList.toggle('is-active', active);
      tab.setAttribute('aria-selected', String(active));
    });
  }

  function startCurrentTransfer(record) {
    elements.currentTransfer.hidden = false;
    elements.currentTransfer.dataset.state = 'active';
    elements.currentFileIcon.replaceChildren(createFileIcon(record.name, record.mimeType));
    elements.currentTransferKind.textContent = 'Приём файла';
    elements.currentTransferTitle.textContent = record.name;
    elements.currentTransferMeta.textContent = `${formatBytes(record.size)} · ${getFileKind(record.name, record.mimeType).label}`;
    elements.currentTransferPercent.textContent = '0%';
    elements.currentTransferProgress.setAttribute('aria-valuenow', '0');
    elements.currentTransferBar.style.width = '0%';
    elements.currentTransferred.textContent = `0 B из ${formatBytes(record.size)}`;
    elements.currentSpeed.textContent = '—';
    elements.currentEta.textContent = '—';
    state.currentRecordId = record.id;
    state.transferStartedAt = performance.now();
  }

  function updateCurrentTransfer(record, receivedBytes, options = {}) {
    if (state.currentRecordId !== record.id) {
      return;
    }

    const totalBytes = Math.max(1, record.size || 0);
    const ratio = Math.min(1, Math.max(0, receivedBytes / totalBytes));
    const percent = Math.round(ratio * 100);
    const elapsedSeconds = Math.max(0.15, (performance.now() - state.transferStartedAt) / 1000);
    const speed = Number(options.speed) || (receivedBytes > 0 ? receivedBytes / elapsedSeconds : 0);
    const etaSeconds = Number.isFinite(options.etaSeconds)
      ? options.etaSeconds
      : (speed > 0 ? (record.size - receivedBytes) / speed : null);

    elements.currentTransfer.dataset.state = 'active';
    elements.currentTransferPercent.textContent = `${percent}%`;
    elements.currentTransferProgress.setAttribute('aria-valuenow', String(percent));
    elements.currentTransferBar.style.width = `${percent}%`;
    elements.currentTransferred.textContent = `${formatBytes(receivedBytes)} из ${formatBytes(record.size)}`;
    elements.currentSpeed.textContent = formatSpeed(speed);
    elements.currentEta.textContent = formatEta(etaSeconds);
  }

  function completeCurrentTransfer(record) {
    if (state.currentRecordId !== record.id) {
      return;
    }

    elements.currentTransfer.dataset.state = 'success';
    elements.currentTransferPercent.textContent = '100%';
    elements.currentTransferProgress.setAttribute('aria-valuenow', '100');
    elements.currentTransferBar.style.width = '100%';
    elements.currentTransferred.textContent = `${formatBytes(record.size)} из ${formatBytes(record.size)}`;
    elements.currentTransferMeta.textContent = 'Файл получен и проверен. Доступен в истории передачи.';
    elements.currentEta.textContent = 'Готово';
  }

  function failCurrentTransfer(record, message) {
    if (state.currentRecordId !== record.id) {
      return;
    }

    elements.currentTransfer.dataset.state = 'error';
    elements.currentTransferMeta.textContent = message;
    elements.currentEta.textContent = '—';
  }

  const receiver = new FileReceiver({
    sendControl: (payload) => {
      try {
        state.session?.sendMessage(JSON.stringify(payload));
      } catch {}
    },
    maxFileSizeBytes: config.maxFileSizeBytes,
    onTransferStart: ({ transferId, fileName, fileSize, mimeType }) => {
      if (!state.roomCreated) {
        return;
      }

      const record = {
        id: transferId,
        transferId,
        direction: 'received',
        name: fileName,
        size: fileSize,
        mimeType,
        status: 'receiving',
        transferred: 0,
        peer: state.peerInfo ? { ...state.peerInfo } : null,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        href: '',
      };
      state.history.unshift(record);
      state.isReceiving = true;
      state.currentRecordId = record.id;
      renderHistory();
      startCurrentTransfer(record);
      updateRoomStatusFromState();
    },
    onProgress: ({ transferId, receivedBytes }) => {
      if (!state.roomCreated) {
        return;
      }

      const record = findHistoryRecordByTransferId(transferId);
      if (!record) {
        return;
      }
      record.transferred = receivedBytes;
      const elapsed = Math.max(0.15, (performance.now() - state.transferStartedAt) / 1000);
      record.averageSpeed = receivedBytes / elapsed;
      updateCurrentTransfer(record, receivedBytes);
      scheduleHistoryRender();
    },
    onTransferReady: ({ transferId, fileName, fileSize, mimeType, href }) => {
      if (!state.roomCreated) {
        try {
          URL.revokeObjectURL(href);
        } catch {}
        return;
      }

      const record = findHistoryRecordByTransferId(transferId);
      if (!record || record.status !== 'receiving') {
        try {
          URL.revokeObjectURL(href);
        } catch {}
        return;
      }
      record.href = href;
      record.status = 'completed';
      record.transferred = fileSize;
      record.completedAt = Date.now();
      record.updatedAt = Date.now();
      syncReceivingState();
      renderHistory();
      completeCurrentTransfer(record);
      updateRoomStatusFromState();
      showNotice(elements.status, {
        type: 'success',
        message: `Файл ${sanitizeText(fileName)} готов к скачиванию. Целостность проверена.`,
      });
    },
    onError: (error, details = {}) => {
      if (!state.roomCreated) {
        return;
      }

      const message = sanitizeText(error?.message || 'Передача завершилась с ошибкой.', 200);
      const canceled = /отмен/i.test(message);
      const record = details.transferId
        ? findHistoryRecordByTransferId(details.transferId)
        : null;
      if (!record && details.transferId) {
        // A late error from a previous room must not touch the current history.
        syncReceivingState();
        updateRoomStatusFromState();
        return;
      }
      if (record) {
        if (record.status !== 'receiving') {
          syncReceivingState();
          updateRoomStatusFromState();
          return;
        }
        record.status = canceled ? 'canceled' : 'error';
        record.errorMessage = message;
        record.updatedAt = Date.now();
        syncReceivingState();
        renderHistory();
        failCurrentTransfer(record, message);
      } else {
        syncReceivingState();
      }
      updateRoomStatusFromState();
      showNotice(elements.status, {
        type: canceled ? 'warning' : 'error',
        message,
      });
    },
  });

  function renderQr(url) {
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

  function setCreateBusy(busy) {
    state.creating = busy;
    setDisabled(elements.createButton, busy);
    elements.createButton.setAttribute('aria-busy', String(busy));
    elements.createButton.classList.toggle('is-loading', busy);
    elements.createLoading.hidden = !busy;

    if (elements.createButtonLabel) {
      elements.createButtonLabel.textContent = busy
        ? 'Создаём комнату…'
        : (state.createFailed ? 'Повторить создание' : 'Создать комнату');
    }
  }

  function showCreateError(message) {
    elements.createError.textContent = message;
    elements.createError.hidden = false;
  }

  function clearCreateError() {
    elements.createError.textContent = '';
    elements.createError.hidden = true;
  }

  function renderRoom(code) {
    state.code = code;
    elements.joinedCode.textContent = code;
    elements.roomQr.setAttribute('aria-label', `QR-код для подключения к комнате ${code}`);

    const sendLink = buildSendUrl(config.frontendUrl, code);
    elements.roomLink.value = sendLink;
    elements.roomLink.setAttribute('aria-label', `Ссылка для подключения к комнате ${code}`);
    renderQr(sendLink);

    elements.prejoinView.hidden = true;
    elements.workspace.hidden = false;
    elements.roomPage.classList.add('is-in-room');
    clearTransferDisplay();
    renderHistory();
    updateDevices();
    setRoomStatus('waiting', 'Комната создана', 'Ожидаем подключение второго устройства…');
    updateIncomingBadge();

    window.scrollTo({
      top: 0,
      behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth',
    });
  }

  function destroySession() {
    state.session?.destroy();
    state.session = null;
    state.sessionPeerId = '';
    state.pendingSignals = [];
    receiver.resetActiveTransfer();
    state.isReceiving = false;
  }

  function releaseRoom() {
    destroySession();

    if (state.joined && state.code) {
      socket.emit('leave-room', { code: state.code });
    }

    revokeHistoryUrls(state.history);
    state.code = '';
    state.roomCreated = false;
    state.roomLost = false;
    state.joined = false;
    state.shouldJoin = false;
    state.peerId = '';
    state.peerInfo = null;
    state.history = [];
    state.historyFilter = 'all';
    state.currentRecordId = '';
    state.isReceiving = false;
    state.joinInFlight = false;
    state.createFailed = false;

    window.clearTimeout(state.copyCodeTimer);
    window.clearTimeout(state.copyLinkTimer);
    state.copyCodeTimer = null;
    state.copyLinkTimer = null;

    closeDialog(elements.confirmDialog);
    closeDialog(elements.infoDialog);
    elements.workspace.hidden = true;
    elements.prejoinView.hidden = false;
    elements.roomPage.classList.remove('is-in-room');
    elements.createLanding.hidden = false;
    elements.joinedCode.textContent = '';
    elements.roomLink.value = '';
    elements.roomQr.replaceChildren();
    elements.historyList.replaceChildren();
    elements.historyEmpty.hidden = false;
    clearTransferDisplay();
    resetHistoryFilter();
    renderHistory();
    clearCreateError();
    setCreateBusy(false);
    showNotice(elements.status, { message: '' });
    if (elements.copyLinkStatus) {
      elements.copyLinkStatus.textContent = '';
    }
    elements.copyCodeBtn.classList.remove('is-copied');
    elements.copyLinkBtn.classList.remove('is-copied');
    if (elements.copyLinkLabel) {
      elements.copyLinkLabel.textContent = 'Копировать';
    }
    elements.createButton.focus({ preventScroll: true });
  }

  function flushPendingSignals() {
    if (!state.session || state.pendingSignals.length === 0) {
      return;
    }

    const signals = [...state.pendingSignals];
    state.pendingSignals = [];
    signals.forEach(({ signal }) => state.session.handleSignal(signal));
  }

  function createSession() {
    if (state.session || !state.peerId) {
      return;
    }

    state.session = new WebRtcPeerSession({
      initiator: false,
      iceServers: config.iceServers,
      onSignal: async (signal) => {
        try {
          await emitWithAck(socket, 'signal', {
            code: state.code,
            to: state.peerId,
            signal,
          });
        } catch {
          showNotice(elements.status, {
            type: 'error',
            message: 'Не удалось отправить ответ сигнальному серверу.',
          });
        }
      },
      onMessage: handleIncomingMessage,
      onStateChange: ({ connectionState }) => {
        if (connectionState === 'connected') {
          setRoomStatus('connecting', 'Соединение', 'P2P-соединение установлено. Открываем канал передачи…');
          updateDevices();
        } else if (connectionState === 'connecting') {
          setRoomStatus('connecting', 'Соединение', 'Подключаем защищённый P2P-канал…');
          updateDevices();
        } else if (connectionState === 'failed') {
          setRoomStatus('reconnecting', 'Восстановление', 'P2P-соединение прервалось. Ждём восстановления канала…');
          updateDevices();
        } else if (connectionState === 'disconnected') {
          setRoomStatus('reconnecting', 'Восстановление', 'Соединение временно прервано. Восстанавливаем канал…');
          updateDevices();
        }
      },
      onChannelOpen: () => {
        setRoomStatus('connected', 'Комната подключена', 'Защищённый P2P-канал открыт. Можно принимать файлы.');
        updateDevices();
        sendPeerInfo();
        showNotice(elements.status, {
          type: 'success',
          message: 'Канал открыт. Можно принимать файлы.',
        });
        syncInfoDialog();
      },
      onChannelClose: () => {
        updateDevices();
        if (state.roomCreated) {
          setRoomStatus('reconnecting', 'Восстановление', 'Канал передачи закрыт. Ждём восстановления соединения…');
        }
      },
      onError: () => {
        showNotice(elements.status, {
          type: 'error',
          message: 'WebRTC-соединение завершилось с ошибкой.',
        });
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
      destroySession();
    }

    if (!state.session) {
      createSession();
    }
  }

  function ensureSocketConnected() {
    if (socket.connected) {
      return Promise.resolve();
    }

    if (socket.disconnected) {
      socket.connect();
    }

    return new Promise((resolve, reject) => {
      let settled = false;
      const timer = window.setTimeout(() => finish(new Error('socket-timeout')), 10000);

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

  async function joinCreatedRoom({ automatic = false } = {}) {
    if (!state.roomCreated || state.roomLost || state.joinInFlight) {
      return false;
    }

    state.joinInFlight = true;
    state.shouldJoin = true;

    if (!automatic) {
      setRoomStatus('connecting', 'Подключение', 'Регистрируем комнату на сигнальном сервере…');
    }

    try {
      await ensureSocketConnected();
      const response = await emitWithAck(socket, 'join-room', { code: state.code });

      state.joined = true;
      state.peerId = (response.room?.peerIds || []).find((peerId) => peerId !== socket.id) || '';

      if (state.session && (!state.peerId || !state.session.isReady())) {
        destroySession();
      }

      if (state.peerId) {
        state.peerInfo = state.peerInfo && state.peerId === state.sessionPeerId ? state.peerInfo : null;
        setRoomStatus('connecting', 'Соединение', 'Второе устройство подключено. Устанавливаем P2P-соединение…');
        ensureSessionForPeer(state.peerId);
      } else {
        setRoomStatus('waiting', 'Комната создана', 'Ожидаем подключение второго устройства.');
      }
      updateDevices();
      return true;
    } catch (error) {
      state.joined = false;

      if (error?.message === 'room-not-found' || error?.message === 'room-full') {
        state.roomLost = true;
        state.shouldJoin = false;
        setRoomStatus(
          'error',
          error.message === 'room-full' ? 'Комната занята' : 'Комната недоступна',
          getJoinErrorMessage(error),
        );
      } else {
        setRoomStatus('error', 'Ошибка соединения', getJoinErrorMessage(error));
      }
      updateDevices();

      showNotice(elements.status, {
        type: 'error',
        message: getJoinErrorMessage(error),
      });
      return false;
    } finally {
      state.joinInFlight = false;
    }
  }

  async function requestRoom() {
    if (state.creating || state.joinInFlight) {
      return;
    }

    clearCreateError();
    setCreateBusy(true);

    try {
      const code = await api.createRoom();
      const expectedLength = Number(config.roomCodeLength) || 6;

      if (typeof code !== 'string' || !new RegExp(`^\\d{${expectedLength}}$`).test(code)) {
        throw new Error('invalid-room-code');
      }

      state.roomCreated = true;
      state.roomLost = false;
      state.shouldJoin = true;
      state.createFailed = false;
      renderRoom(code);
      await joinCreatedRoom();
    } catch (error) {
      state.roomCreated = false;
      state.shouldJoin = false;
      state.createFailed = true;
      elements.workspace.hidden = true;
      elements.prejoinView.hidden = false;
      elements.roomPage.classList.remove('is-in-room');
      elements.createLanding.hidden = false;
      showCreateError(getCreateErrorMessage(error));
    } finally {
      setCreateBusy(false);
    }
  }

  function requestCloseRoom() {
    if (!state.roomCreated) {
      return;
    }

    if (state.isReceiving) {
      openConfirm({
        title: 'Закрыть комнату?',
        message: 'Текущий приём файла будет прерван, а комната закроется для этого устройства. Отправитель не сможет завершить передачу.',
        confirmLabel: 'Да, закрыть',
        cancelLabel: 'Нет, остаться',
        onConfirm: releaseRoom,
      });
      return;
    }

    releaseRoom();
  }

  async function refreshConnection() {
    if (!state.roomCreated || state.isReceiving) {
      if (state.isReceiving) {
        showNotice(elements.status, { type: 'warning', message: 'Дождитесь завершения приёма, чтобы обновить соединение.' });
      }
      return;
    }

    setDisabled(elements.refreshBtn, true);
    elements.refreshBtn.classList.add('is-loading');
    setRoomStatus('reconnecting', 'Обновление соединения', 'Проверяем комнату и восстанавливаем канал передачи…');

    try {
      await ensureSocketConnected();
      const response = await emitWithAck(socket, 'join-room', { code: state.code });
      state.joined = true;
      state.peerId = (response.room?.peerIds || []).find((peerId) => peerId !== socket.id) || '';

      if (state.session && (!state.peerId || !state.session.isReady())) {
        destroySession();
      }

      if (state.peerId) {
        ensureSessionForPeer(state.peerId);
      }
      updateRoomStatusFromState();
      updateDevices();
      showNotice(elements.status, {
        type: 'success',
        message: state.peerId ? 'Соединение проверено и обновлено.' : 'Комната активна. Ожидаем второе устройство.',
      });
    } catch (error) {
      setRoomStatus('error', 'Ошибка соединения', getJoinErrorMessage(error));
      updateDevices();
      showNotice(elements.status, { type: 'error', message: getJoinErrorMessage(error) });
    } finally {
      setDisabled(elements.refreshBtn, false);
      elements.refreshBtn.classList.remove('is-loading');
    }
  }

  function openConfirm({ title, message, confirmLabel = 'Да, закрыть', cancelLabel = 'Нет, остаться', onConfirm }) {
    elements.confirmTitle.textContent = title;
    elements.confirmMessage.textContent = message;
    elements.confirmAcceptBtn.textContent = confirmLabel;
    elements.confirmCancelBtn.textContent = cancelLabel;
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

  function requestClearHistory() {
    if (state.history.length === 0) {
      return;
    }

    openConfirm({
      title: 'Очистить историю?',
      message: 'Записи о полученных и отменённых файлах будут удалены. Скачать их после очистки будет нельзя. Активный приём останется в журнале.',
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

  function startKeepAlive() {
    window.clearInterval(state.keepAliveTimer);
    state.keepAliveTimer = window.setInterval(() => {
      api.ping().catch(() => {});
    }, 140000);
  }

  elements.createButton.addEventListener('click', () => {
    requestRoom();
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
    elements.copyCodeBtn.setAttribute('aria-label', 'Код комнаты скопирован');
    if (elements.copyLinkStatus) {
      elements.copyLinkStatus.textContent = 'Код комнаты скопирован.';
    }
    showNotice(elements.status, { type: 'success', message: 'Код комнаты скопирован.' });
    window.clearTimeout(state.copyCodeTimer);
    state.copyCodeTimer = window.setTimeout(() => {
      elements.copyCodeBtn.classList.remove('is-copied');
      elements.copyCodeBtn.setAttribute('aria-label', 'Скопировать код комнаты');
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
    elements.copyLinkBtn.setAttribute('aria-label', 'Ссылка скопирована');
    if (elements.copyLinkLabel) {
      elements.copyLinkLabel.textContent = 'Скопировано';
    }
    if (elements.copyLinkStatus) {
      elements.copyLinkStatus.textContent = 'Ссылка скопирована.';
    }
    showNotice(elements.status, { type: 'success', message: 'Ссылка на комнату скопирована.' });
    window.clearTimeout(state.copyLinkTimer);
    state.copyLinkTimer = window.setTimeout(() => {
      elements.copyLinkBtn.classList.remove('is-copied');
      elements.copyLinkBtn.setAttribute('aria-label', 'Скопировать ссылку на комнату');
      if (elements.copyLinkLabel) {
        elements.copyLinkLabel.textContent = 'Копировать';
      }
      if (elements.copyLinkStatus) {
        elements.copyLinkStatus.textContent = '';
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

  elements.leaveRoomBtn.addEventListener('click', requestCloseRoom);
  elements.refreshBtn.addEventListener('click', refreshConnection);
  elements.clearHistoryBtn.addEventListener('click', requestClearHistory);
  elements.roomInfoBtn.addEventListener('click', () => {
    syncInfoDialog();
    openDialog(elements.infoDialog);
  });

  elements.confirmAcceptBtn.addEventListener('click', () => {
    const action = state.confirmAction;
    state.confirmAction = null;
    closeDialog(elements.confirmDialog);
    if (typeof action === 'function') {
      action();
    }
  });
  elements.confirmCancelBtn.addEventListener('click', closeConfirmDialog);

  setupDialogDismiss(elements.confirmDialog, { onDismiss: closeConfirmDialog });
  setupDialogDismiss(elements.infoDialog, { onDismiss: () => closeDialog(elements.infoDialog) });

  socket.on('connect', () => {
    if (
      state.roomCreated
      && state.shouldJoin
      && !state.roomLost
      && !state.joined
      && !state.joinInFlight
    ) {
      joinCreatedRoom({ automatic: true });
    }
  });

  socket.on('disconnect', () => {
    if (!state.roomCreated || state.roomLost) {
      return;
    }

    state.joined = false;
    setRoomStatus('reconnecting', 'Переподключение', 'Комната сохраняется. Ждём восстановления соединения…');
    updateIncomingBadge();
    showNotice(elements.status, {
      type: 'warning',
      message: 'Сигнальный сервер временно недоступен. Пробуем переподключиться…',
    });
  });

  socket.on('peer-joined', ({ peerId }) => {
    if (!state.roomCreated || state.roomLost) {
      return;
    }

    state.peerId = peerId || '';
    state.peerInfo = null;
    setRoomStatus('connecting', 'Соединение', 'Второе устройство подключено. Устанавливаем P2P-соединение…');
    ensureSessionForPeer(state.peerId);
    updateDevices();
  });

  socket.on('peer-left', () => {
    if (!state.roomCreated || state.roomLost) {
      return;
    }

    const receivingRecords = state.history.filter((record) => record.status === 'receiving');
    if (receivingRecords.length > 0) {
      receivingRecords.forEach((record) => {
        record.status = 'canceled';
        record.errorMessage = 'Отправитель отключился';
        record.updatedAt = Date.now();
        failCurrentTransfer(record, 'Отправитель отключился. Приём прерван.');
      });
      syncReceivingState();
      renderHistory();
    }

    state.peerId = '';
    state.peerInfo = null;
    destroySession();
    updateDevices();
    setRoomStatus('waiting', 'Комната создана', 'Второе устройство вышло из комнаты. Ожидаем новое подключение.');
    showNotice(elements.status, {
      type: 'warning',
      message: 'Второе устройство вышло из комнаты.',
    });
  });

  socket.on('room-state', ({ size, peerIds }) => {
    if (!state.roomCreated || state.roomLost) {
      return;
    }

    const otherPeerId = (peerIds || []).find((peerId) => peerId !== socket.id) || '';
    if (state.peerId !== otherPeerId) {
      state.peerInfo = null;
    }
    state.peerId = otherPeerId;

    if (size < 2 || !otherPeerId) {
      if (state.session) {
        destroySession();
      }
      updateDevices();
      if (!state.isReceiving) {
        setRoomStatus('waiting', 'Комната создана', 'Ожидаем подключение второго устройства.');
      }
      return;
    }

    if (!state.session) {
      setRoomStatus('connecting', 'Соединение', 'Второе устройство найдено. Устанавливаем P2P-соединение…');
    }
    ensureSessionForPeer(state.peerId);
    updateDevices();
  });

  socket.on('signal', (payload) => {
    if (!payload?.signal) {
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
    if (state.joined && state.code) {
      socket.emit('leave-room', { code: state.code });
    }
    revokeHistoryUrls(state.history);
    destroySession();
  });

  setCreateBusy(false);
  updateDevices();
  renderHistory();
  startKeepAlive();
}

init().catch((error) => {
  showNotice(document.querySelector('#status'), {
    type: 'error',
    message: `Не удалось инициализировать страницу создания комнаты: ${error?.message || 'неизвестная ошибка'}.`,
  });
});
