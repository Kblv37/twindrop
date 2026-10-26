import { computed, reactive } from 'vue';
import { createApiClient, createSocket, emitWithAck } from '../services/api.js';
import { loadRuntimeConfig } from '../services/config.js';
import {
  buildSendUrl,
  normalizeRoomCode,
  sanitizeText,
} from '../services/utils.js';
import { detectDevice } from '../services/room-ui.js';
import { WebRtcPeerSession } from '../services/webrtc-peer.js';
import {
  bindTransferTransport,
  cancelActiveTransfer,
  cleanupTransferUrls,
  configureTransfer,
  handleData,
  initTransferAdapters,
  resetTransferState,
  transfer,
  updateTransferLimits,
} from './transfer.js';
import { notify } from './ui.js';

const KEEPALIVE_INTERVAL_MS = 140000;
const PARTICIPANT_STORAGE_KEY = 'twindrop.participant-id';
const ROOM_SESSION_STORAGE_KEY = 'twindrop.room-session';
const PARTICIPANT_ID_PATTERN = /^[A-Za-z0-9_-]{8,64}$/;

export const room = reactive({
  initialized: false,
  initializing: false,
  initError: '',
  config: null,
  localDevice: null,
  socketConnected: false,
  socketId: '',
  code: '',
  role: '',
  joined: false,
  creating: false,
  joining: false,
  refreshing: false,
  peerId: '',
  peerInfo: null,
  sessionReady: false,
  connectionState: 'idle',
  connectionPath: 'unknown',
  localCandidateType: '',
  remoteCandidateType: '',
  keepAliveActive: false,
  actionError: '',
});

let api = null;
let socket = null;
let session = null;
let sessionPeerId = '';
let pendingSignals = [];
let joinInFlight = false;
let keepAliveTimer = null;
let initializationPromise = null;
let beforeUnloadBound = false;
let lastWebrtcNotice = '';
let sessionGeneration = 0;
let participantId = '';
let socketWasDisconnected = false;

function createParticipantId() {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }

  if (typeof crypto !== 'undefined' && typeof crypto.getRandomValues === 'function') {
    const bytes = crypto.getRandomValues(new Uint8Array(16));
    return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
  }

  return `tab-${Date.now()}-${Math.random().toString(36).slice(2, 12)}`;
}

function getParticipantId() {
  if (participantId) {
    return participantId;
  }

  try {
    const stored = window.sessionStorage.getItem(PARTICIPANT_STORAGE_KEY);

    if (stored && PARTICIPANT_ID_PATTERN.test(stored)) {
      participantId = stored;
      return participantId;
    }
  } catch {
    // sessionStorage can be unavailable in hardened browser modes.
  }

  participantId = createParticipantId();

  try {
    window.sessionStorage.setItem(PARTICIPANT_STORAGE_KEY, participantId);
  } catch {
    // The in-memory ID still keeps reconnects working for this tab.
  }

  return participantId;
}

function saveRoomSession() {
  if (!room.code || !room.role) {
    return;
  }

  try {
    window.sessionStorage.setItem(ROOM_SESSION_STORAGE_KEY, JSON.stringify({
      code: room.code,
      role: room.role,
    }));
  } catch {
    // Restoring the room after reload is best-effort when storage is blocked.
  }
}

function clearRoomSession() {
  try {
    window.sessionStorage.removeItem(ROOM_SESSION_STORAGE_KEY);
  } catch {
    // Nothing to clear when storage is unavailable.
  }
}

function readRoomSession() {
  try {
    const raw = window.sessionStorage.getItem(ROOM_SESSION_STORAGE_KEY);

    if (!raw) {
      return null;
    }

    const parsed = JSON.parse(raw);
    const length = Number(room.config?.roomCodeLength) || 6;
    const code = normalizeRoomCode(parsed?.code, length);
    const role = parsed?.role === 'creator'
      ? 'creator'
      : (parsed?.role === 'joiner' ? 'joiner' : '');

    if (!code || !role) {
      clearRoomSession();
      return null;
    }

    return { code, role };
  } catch {
    clearRoomSession();
    return null;
  }
}

function restoreRoomSession() {
  const stored = readRoomSession();

  if (!stored) {
    return false;
  }

  room.code = stored.code;
  room.role = stored.role;
  room.joined = true;
  return true;
}

export function hasStoredRoomSession() {
  return Boolean(readRoomSession());
}

export const roomStatus = computed(() => {
  if (room.initError) {
    return {
      state: 'error',
      title: 'Нет связи с сервером',
      text: room.initError,
    };
  }

  if (room.creating) {
    return {
      state: 'connecting',
      title: 'Создаём комнату',
      text: 'Регистрируем комнату на сигнальном сервере…',
    };
  }

  if (room.joining) {
    return {
      state: 'connecting',
      title: 'Подключение',
      text: 'Проверяем комнату и устанавливаем соединение…',
    };
  }

  if (!room.joined) {
    return {
      state: room.actionError ? 'error' : 'idle',
      title: room.actionError ? 'Не удалось подключиться' : 'Комната не выбрана',
      text: room.actionError || 'Создайте комнату или подключитесь по коду.',
    };
  }

  if (room.sessionReady) {
    if (!room.socketConnected) {
      return {
        state: 'connected',
        title: 'P2P-канал активен',
        text: 'Сигнальный сервер недоступен, но текущее соединение продолжает работать.',
      };
    }

    return {
      state: 'connected',
      title: 'Комната подключена',
      text: 'Защищённый P2P-канал открыт. Можно отправлять и принимать файлы.',
    };
  }

  if (!room.socketConnected) {
    return {
      state: 'reconnecting',
      title: 'Переподключение',
      text: 'Сигнальный сервер временно недоступен. Пробуем восстановить соединение…',
    };
  }

  if (!room.peerId) {
    return {
      state: 'waiting',
      title: room.role === 'creator' ? 'Комната создана' : 'Комната активна',
      text: 'Ожидаем подключение второго устройства.',
    };
  }

  if (!session) {
    return {
      state: 'connecting',
      title: 'Соединение',
      text: 'Второе устройство найдено. Устанавливаем P2P-соединение…',
    };
  }

  if (room.connectionState === 'failed' || room.connectionState === 'disconnected') {
    return {
      state: 'reconnecting',
      title: 'Восстановление',
      text: 'P2P-соединение прервалось. Пробуем восстановить канал…',
    };
  }

  if (room.connectionState === 'connected') {
    return {
      state: 'connecting',
      title: 'Соединение',
      text: 'P2P-соединение установлено. Открываем канал передачи…',
    };
  }

  return {
    state: 'connecting',
    title: 'Соединение',
    text: 'Подключаем защищённый P2P-канал…',
  };
});

export const roomShareLink = computed(() => {
  if (!room.code) {
    return '';
  }

  return buildSendUrl(room.config?.frontendUrl || window.location.origin, room.code);
});

export const roleLabel = computed(() => (
  room.role === 'creator' ? 'Создатель комнаты' : 'Подключившийся участник'
));

export const peerOnline = computed(() => Boolean(room.peerId && room.sessionReady));

export const connectionModeLabel = computed(() => {
  if (room.connectionPath === 'relay') {
    return 'WebRTC через TURN-ретранслятор';
  }
  if (room.connectionPath === 'direct') {
    return 'Прямое P2P-соединение WebRTC';
  }
  return 'WebRTC-соединение';
});

export const connectionNote = computed(() => {
  if (room.connectionPath === 'relay') {
    return 'Содержимое файлов передаётся по зашифрованному WebRTC-каналу через TURN-ретранслятор и не сохраняется на сервере.';
  }
  if (room.connectionPath === 'direct') {
    return 'Сервер используется только для установления соединения. Содержимое файлов передаётся напрямую между браузерами и не сохраняется на сервере.';
  }
  return 'Сервер используется только для установления соединения. Содержимое файлов передаётся по зашифрованному WebRTC-каналу и не сохраняется на сервере.';
});

function setActionError(message) {
  room.actionError = message || '';
}

export function formatRoomError(error) {
  switch (error?.message) {
    case 'room-not-found':
      return 'Комната с таким кодом не найдена. Проверьте код на другом устройстве.';
    case 'room-full':
      return 'Комната уже заполнена двумя устройствами.';
    case 'rate-limited':
      return 'Слишком много попыток. Подождите минуту и повторите.';
    case 'invalid-code':
      return `Введите код из ${room.config?.roomCodeLength || 6} цифр.`;
    case 'invalid-room-code':
      return 'Сервер вернул некорректный код комнаты. Попробуйте ещё раз.';
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
  if (socket?.connected) {
    return Promise.resolve();
  }

  if (!socket) {
    return Promise.reject(new Error('socket-connect-error'));
  }

  if (socket.disconnected && !socket.active) {
    socket.connect();
  }

  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = window.setTimeout(() => finish(new Error('socket-timeout')), timeoutMs);

    function finish(error) {
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
    }

    function handleConnect() {
      finish();
    }

    function handleError() {
      finish(new Error('socket-connect-error'));
    }

    socket.once('connect', handleConnect);
    socket.once('connect_error', handleError);

    if (socket.connected) {
      finish();
    }
  });
}

function flushPendingSignals() {
  if (!session || pendingSignals.length === 0) {
    return;
  }

  const signals = [...pendingSignals];
  pendingSignals = [];
  signals.forEach(({ signal }) => session.handleSignal(signal));
}

function sendPeerInfo() {
  if (!session?.isReady() || !room.localDevice) {
    return;
  }

  try {
    session.sendMessage(JSON.stringify({
      type: 'twindrop-peer-info',
      info: {
        type: room.localDevice.type,
        typeLabel: room.localDevice.typeLabel,
        os: room.localDevice.os,
        browser: room.localDevice.browser,
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
        room.peerInfo = {
          type: ['desktop', 'phone', 'tablet'].includes(message.info.type)
            ? message.info.type
            : 'unknown',
          typeLabel: sanitizeText(message.info.typeLabel, 40) || 'Устройство',
          os: sanitizeText(message.info.os, 40) || 'ОС неизвестна',
          browser: sanitizeText(message.info.browser, 40) || 'браузер неизвестен',
        };
        return;
      }
    } catch {
      // Binary chunks and unrelated payloads continue to the transfer layer.
    }
  }

  handleData(data);
}

function resetSession() {
  sessionGeneration += 1;

  // Every session teardown is also a transfer teardown. This covers
  // peer-left, room-state without a peer, session replacement, room errors and
  // page unload, so the UI cannot stay in "Принимается" with orphaned chunks.
  cancelActiveTransfer('Соединение потеряно');

  if (session) {
    session.destroy();
  }

  session = null;
  sessionPeerId = '';
  pendingSignals = [];
  room.sessionReady = false;
  room.connectionState = 'idle';
  room.connectionPath = 'unknown';
  room.localCandidateType = '';
  room.remoteCandidateType = '';
  room.peerInfo = null;
  lastWebrtcNotice = '';
}

function createSession() {
  if (session || !room.peerId || !room.config) {
    return;
  }

  const targetPeerId = room.peerId;
  const generation = ++sessionGeneration;
  const isCurrentGeneration = () => generation === sessionGeneration && session !== null;
  lastWebrtcNotice = '';
  room.connectionPath = 'unknown';
  room.localCandidateType = '';
  room.remoteCandidateType = '';

  session = new WebRtcPeerSession({
    initiator: room.role !== 'creator',
    iceServers: room.config.iceServers,
    onSignal: async (signal) => {
      if (!isCurrentGeneration()) {
        return;
      }

      try {
        await emitWithAck(socket, 'signal', {
          code: room.code,
          to: sessionPeerId || targetPeerId,
          signal,
        });
      } catch (error) {
        if (room.joined) {
          notify(
            `Не удалось отправить сигнал соединения: ${sanitizeText(error?.message || 'ошибка', 100)}.`,
            'error',
          );
        }
      }
    },
    onMessage: (data) => {
      if (isCurrentGeneration()) {
        handleIncomingMessage(data);
      }
    },
    onConnectionPath: (info) => {
      if (!isCurrentGeneration()) {
        return;
      }

      room.connectionPath = info.path || 'unknown';
      room.localCandidateType = info.localCandidateType || '';
      room.remoteCandidateType = info.remoteCandidateType || '';
    },
    onStateChange: ({ connectionState }) => {
      if (!isCurrentGeneration()) {
        return;
      }

      room.connectionState = connectionState || 'unknown';

      if (connectionState === 'failed') {
        // A failed transport is terminal for the current transfer. A plain
        // "disconnected" state can recover through ICE restart, so active
        // transfers must not be canceled on that transient event.
        cancelActiveTransfer('P2P-соединение завершилось с ошибкой.');
      }

      if (['failed', 'disconnected'].includes(connectionState)) {
        room.sessionReady = false;

        if (room.joined && lastWebrtcNotice !== connectionState) {
          lastWebrtcNotice = connectionState;
          notify('P2P-соединение прервалось. Пробуем восстановить канал…', 'warning');
        }
      }
    },
    onChannelOpen: () => {
      if (!isCurrentGeneration()) {
        return;
      }

      room.sessionReady = true;
      room.connectionState = 'connected';
      sendPeerInfo();

      if (room.joined) {
        notify('Защищённый P2P-канал открыт.', 'success', 4500);
      }
    },
    onChannelClose: () => {
      if (!isCurrentGeneration()) {
        return;
      }

      room.sessionReady = false;
      cancelActiveTransfer('Соединение прервалось. Передача отменена.');

      if (room.joined) {
        room.connectionState = 'disconnected';
      }
    },
    onError: (error) => {
      if (!isCurrentGeneration()) {
        return;
      }

      room.sessionReady = false;
      room.connectionState = 'failed';

      if (!session?.isReady()) {
        cancelActiveTransfer('WebRTC-соединение завершилось с ошибкой.');
      }

      notify(
        `WebRTC-соединение завершилось с ошибкой: ${sanitizeText(error?.message || 'неизвестная ошибка', 120)}.`,
        'error',
      );
    },
  });

  sessionPeerId = targetPeerId;
  flushPendingSignals();
}

function ensureSessionForPeer(peerId) {
  if (!peerId) {
    return;
  }

  if (session && sessionPeerId !== peerId) {
    resetSession();
  }

  if (!session) {
    createSession();
  }
}

function applyPeer(peerId, { keepInfo = false } = {}) {
  if (!peerId) {
    if (session) {
      resetSession();
    }
    room.peerId = '';
    if (!keepInfo) {
      room.peerInfo = null;
    }
    return;
  }

  if (room.peerId !== peerId) {
    room.peerInfo = null;
  }

  room.peerId = peerId;
  ensureSessionForPeer(peerId);
}

function applyRoomSnapshot(response) {
  const selfId = response?.room?.selfId || socket?.id || room.socketId;
  const peerIds = response?.room?.peerIds || [];
  const otherPeerId = peerIds.find((peerId) => peerId !== selfId) || '';

  if (selfId) {
    room.socketId = selfId;
  }

  applyPeer(otherPeerId);

  if (!otherPeerId) {
    room.connectionState = 'idle';
    room.sessionReady = false;
  }
}

async function joinSocketRoom(code) {
  await waitForSocketConnection();
  return emitWithAck(socket, 'join-room', {
    code,
    participantId: getParticipantId(),
  });
}

async function restoreRoomAfterReconnect({ silent = false } = {}) {
  if (!room.joined || !room.code || joinInFlight) {
    return;
  }

  joinInFlight = true;
  const restoreCode = room.code;
  const notifySuccess = !silent && socketWasDisconnected;

  try {
    const response = await joinSocketRoom(restoreCode);

    // The user may have left or switched rooms while the join was in flight.
    if (!room.joined || room.code !== restoreCode) {
      return;
    }

    room.joined = true;
    applyRoomSnapshot(response);
    saveRoomSession();
    socketWasDisconnected = false;

    if (notifySuccess) {
      notify('Подключение к комнате восстановлено.', 'success', 4500);
    }
  } catch (error) {
    if (!room.joined || room.code !== restoreCode) {
      return;
    }

    room.actionError = formatRoomError(error);

    if (['room-not-found', 'room-full'].includes(error?.message)) {
      clearRoomSession();
      room.joined = false;
      room.code = '';
      room.role = '';
      resetSession();
    }

    notify(room.actionError, 'error', 7000);
  } finally {
    joinInFlight = false;
  }
}

function registerSocketListeners() {
  socket.on('connect', () => {
    const wasDisconnected = socketWasDisconnected;
    room.socketConnected = true;
    room.socketId = socket.id;

    if (room.joined && room.code) {
      restoreRoomAfterReconnect({ silent: !wasDisconnected });
    }
  });

  socket.on('disconnect', () => {
    room.socketConnected = false;
    room.socketId = '';
    socketWasDisconnected = true;

    if (room.joined) {
      notify(
        'Сигнальный сервер временно недоступен. Пробуем переподключиться…',
        'warning',
      );
    }
  });

  socket.on('connect_error', () => {
    room.socketConnected = false;
  });

  socket.on('reconnect_failed', () => {
    if (room.joined) {
      notify(
        'Не удалось автоматически восстановить соединение с сигнальным сервером. Нажмите «Обновить соединение».',
        'error',
        8000,
      );
    }
  });

  socket.on('peer-joined', ({ peerId }) => {
    if (!room.joined) {
      return;
    }

    applyPeer(peerId || '');
  });

  socket.on('peer-left', () => {
    if (!room.joined) {
      return;
    }

    resetSession();
    room.peerId = '';
    room.peerInfo = null;
    room.actionError = '';
    notify('Второе устройство вышло из комнаты.', 'warning');
  });

  socket.on('room-state', ({ size, peerIds }) => {
    if (!room.joined) {
      return;
    }

    const selfId = room.socketId || socket.id;
    const otherPeerId = (peerIds || []).find((peerId) => peerId !== selfId) || '';

    if (size < 2 || !otherPeerId) {
      resetSession();
      room.peerId = '';
      room.peerInfo = null;
      return;
    }

    applyPeer(otherPeerId);
  });

  socket.on('signal', (payload) => {
    if (!room.joined || !payload?.signal) {
      return;
    }

    if (payload.from) {
      applyPeer(payload.from);
    }

    if (!session) {
      pendingSignals.push(payload);
      return;
    }

    session.handleSignal(payload.signal);
  });
}

function startKeepAlive() {
  window.clearInterval(keepAliveTimer);
  room.keepAliveActive = true;
  keepAliveTimer = window.setInterval(() => {
    api?.ping().catch(() => {});
  }, KEEPALIVE_INTERVAL_MS);
}

function handleBeforeUnload() {
  window.clearInterval(keepAliveTimer);
  keepAliveTimer = null;
  room.keepAliveActive = false;

  // Do not emit leave-room here: a reload keeps the same participant ID and
  // must be able to rejoin the room. The server removes the socket on
  // disconnect anyway, while the stored session lets the new page restore it.
  resetSession();
  cleanupTransferUrls();
}

function bindBeforeUnload() {
  if (beforeUnloadBound) {
    return;
  }

  beforeUnloadBound = true;
  window.addEventListener('beforeunload', handleBeforeUnload);
}

export function initializeRoomStore() {
  if (initializationPromise) {
    return initializationPromise;
  }

  room.initializing = true;
  room.initError = '';

  initializationPromise = (async () => {
    try {
      const config = await loadRuntimeConfig();
      room.config = config;
      room.localDevice = detectDevice();
      api = createApiClient(config);
      configureTransfer(config);
      initTransferAdapters();
      updateTransferLimits(config);

      bindTransferTransport({
        getChannel: () => session?.getDataChannel() || null,
        getMaxMessageSize: () => session?.getMaxMessageSize() || 0,
        isActive: () => Boolean(room.joined && session?.isReady()),
        getPeer: () => room.peerInfo,
        sendControl: (payload) => session?.sendMessage(payload),
        waitForOpen: async () => {
          if (!session) {
            throw new Error('P2P-канал ещё не готов.');
          }
          await session.waitForOpen();
        },
      });

      restoreRoomSession();
      socket = createSocket(config);
      registerSocketListeners();
      bindBeforeUnload();
      startKeepAlive();
      room.initialized = true;

      if (socket.connected) {
        room.socketConnected = true;
        room.socketId = socket.id;

        if (room.joined && room.code) {
          restoreRoomAfterReconnect({ silent: true });
        }
      }

      return config;
    } catch (error) {
      room.initError = error?.message || 'Не удалось загрузить конфигурацию приложения.';
      notify(`Не удалось инициализировать приложение: ${room.initError}`, 'error', 8000);
      initializationPromise = null;
      throw error;
    } finally {
      room.initializing = false;
    }
  })();

  return initializationPromise;
}

export async function createRoom() {
  if (room.joined && room.code) {
    return room.code;
  }

  if (room.creating || room.joining) {
    return '';
  }

  if (!room.initialized) {
    await initializeRoomStore();
  }

  room.creating = true;
  setActionError('');

  try {
    const code = await api.createRoom();
    const length = Number(room.config?.roomCodeLength) || 6;

    if (typeof code !== 'string' || !new RegExp(`^\\d{${length}}$`).test(code)) {
      throw new Error('invalid-room-code');
    }

    room.code = code;
    room.role = 'creator';
    const response = await joinSocketRoom(code);
    room.joined = true;
    room.creating = false;
    applyRoomSnapshot(response);
    saveRoomSession();
    notify(`Комната ${code} создана. Передайте код или QR-код второму устройству.`, 'success', 6500);
    return code;
  } catch (error) {
    clearRoomSession();
    room.joined = false;
    room.code = '';
    room.role = '';
    resetSession();
    setActionError(formatRoomError(error));
    notify(room.actionError, 'error', 7000);
    throw error;
  } finally {
    room.creating = false;
  }
}

export async function joinRoom(rawCode) {
  const code = normalizeRoomCode(rawCode, room.config?.roomCodeLength || 6);

  if (code.length !== (room.config?.roomCodeLength || 6)) {
    setActionError(`Введите код из ${room.config?.roomCodeLength || 6} цифр.`);
    throw new Error('invalid-code');
  }

  if (room.joined && room.code === code) {
    return code;
  }

  if (room.joining || room.creating) {
    return '';
  }

  if (!room.initialized) {
    await initializeRoomStore();
  }

  room.joining = true;
  setActionError('');

  try {
    const roomInfo = await api.getRoom(code);

    if (!roomInfo.exists) {
      throw new Error('room-not-found');
    }

    if (Number(roomInfo.size) >= Number(roomInfo.capacity || 2)) {
      throw new Error('room-full');
    }

    const response = await joinSocketRoom(code);
    room.code = code;
    room.role = 'joiner';
    room.joined = true;
    applyRoomSnapshot(response);
    saveRoomSession();
    notify(`Подключение к комнате ${code} установлено.`, 'success', 5000);
    return code;
  } catch (error) {
    clearRoomSession();
    room.joined = false;
    room.code = '';
    room.role = '';
    resetSession();
    setActionError(formatRoomError(error));
    notify(room.actionError, 'error', 7000);
    throw error;
  } finally {
    room.joining = false;
  }
}

export async function refreshConnection() {
  if (!room.joined || !room.code || room.refreshing) {
    return false;
  }

  if (transfer.isSending || transfer.isReceiving) {
    notify('Дождитесь завершения передачи, чтобы обновить соединение.', 'warning');
    return false;
  }

  room.refreshing = true;
  setActionError('');

  try {
    // A channel that never became ready is usually stuck in negotiation.
    // Recreate the peer session before rejoining so the refresh can recover it.
    if (!room.sessionReady) {
      resetSession();
    }

    const response = await joinSocketRoom(room.code);
    applyRoomSnapshot(response);
    saveRoomSession();
    notify(
      room.peerId ? 'Соединение проверено и обновлено.' : 'Комната активна. Ожидаем второе устройство.',
      'success',
      4500,
    );
    return true;
  } catch (error) {
    room.actionError = formatRoomError(error);
    notify(room.actionError, 'error', 7000);
    return false;
  } finally {
    room.refreshing = false;
  }
}

export function leaveRoom({ silent = false } = {}) {
  const code = room.code;

  if (socket?.connected && room.joined && code) {
    socket.emit('leave-room', { code });
  }

  resetSession();
  resetTransferState();
  clearRoomSession();
  setActionError('');
  room.code = '';
  room.role = '';
  room.joined = false;
  room.creating = false;
  room.joining = false;
  room.refreshing = false;
  room.peerId = '';
  room.peerInfo = null;
  room.socketId = socket?.id || '';

  if (!silent) {
    notify('Вы вышли из комнаты. Выбранные файлы сохранены.', 'info');
  }
}

export function leaveRoomOnUnload() {
  handleBeforeUnload();
}
