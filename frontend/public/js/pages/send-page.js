import { createApiClient, createSocket, emitWithAck } from '../core/api.js';
import { loadRuntimeConfig } from '../core/config.js';
import { $, setDisabled, setProgress, showNotice } from '../core/dom.js';
import { FileSender } from '../core/file-transfer.js';
import { buildSendUrl, formatBytes, normalizeRoomCode, parseQuery, sanitizeText } from '../core/utils.js';
import { WebRtcPeerSession } from '../core/webrtc-peer.js';

async function init() {
  const config = await loadRuntimeConfig();
  const api = createApiClient(config);
  const socket = createSocket(config);

  const elements = {
    codeInput: $('#codeInput'),
    roomHint: $('#roomHint'),
    joinButton: $('#joinBtn'),
    fileInput: $('#fileInput'),
    dropzone: $('#dropzone'),
    sendButton: $('#sendBtn'),
    status: $('#status'),
    sendBar: $('#sendBar'),
    sendText: $('#sendText'),
    sendPanel: $('#sendPanel'),
    chunkSizeSelect: $('#chunkSize'),
    shareLink: $('#shareLink'),
  };

  const state = {
    code: '',
    joined: false,
    peerId: '',
    pendingSignals: [],
    session: null,
  };

  const sender = new FileSender({
    getChannel: () => state.session?.getDataChannel(),
    maxFileSizeBytes: config.maxFileSizeBytes,
    maxFilesPerTransfer: config.maxFilesPerTransfer,
    onProgress: ({ fileName, sentBytes, totalBytes }) => {
      const ratio = totalBytes > 0 ? sentBytes / totalBytes : 0;
      setProgress(
        elements.sendBar,
        elements.sendText,
        ratio,
        `${sanitizeText(fileName)} · ${formatBytes(sentBytes)} / ${formatBytes(totalBytes)}`,
      );
    },
  });

  function resetSession() {
    state.session?.destroy();
    state.session = null;
    setDisabled(elements.sendButton, true);
  }

  function updateRoomHint(message, type = 'info') {
    showNotice(elements.roomHint, { type, message });
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
      onStateChange: ({ connectionState }) => {
        if (connectionState === 'connected') {
          showNotice(elements.status, { type: 'success', message: 'Соединение готово. Можно отправлять файлы.' });
        } else if (connectionState === 'connecting') {
          showNotice(elements.status, { type: 'info', message: 'Подключаем P2P-канал…' });
        } else if (connectionState === 'failed') {
          showNotice(elements.status, { type: 'warning', message: 'Соединение просело. Пробуем восстановить…' });
        }
      },
      onChannelOpen: () => {
        setDisabled(elements.sendButton, !(elements.fileInput.files?.length));
        showNotice(elements.status, { type: 'success', message: 'Канал открыт. Передача доступна.' });
      },
      onChannelClose: () => {
        setDisabled(elements.sendButton, true);
      },
      onError: () => {
        showNotice(elements.status, { type: 'error', message: 'WebRTC-соединение завершилось с ошибкой.' });
      },
    });

    flushPendingSignals();
  }

  async function joinRoom() {
    const code = normalizeRoomCode(elements.codeInput.value, config.roomCodeLength);
    elements.codeInput.value = code;

    if (code.length !== config.roomCodeLength) {
      showNotice(elements.status, { type: 'warning', message: 'Введите корректный код комнаты.' });
      return;
    }

    try {
      const roomInfo = await api.getRoom(code);

      if (!roomInfo.exists) {
        updateRoomHint('Комната не найдена.', 'warning');
        return;
      }

      const response = await emitWithAck(socket, 'join-room', { code });
      state.code = code;
      state.joined = true;
      state.peerId = response.room.peerIds[0] || '';
      elements.shareLink.value = buildSendUrl(config.frontendUrl, code);
      elements.sendPanel.hidden = false;
      setDisabled(elements.joinButton, true);
      updateRoomHint(`Комната ${code} готова. Ждём получателя.`, 'success');

      if (state.peerId) {
        createSession();
      }
    } catch (error) {
      const message = error.message === 'room-full'
        ? 'Комната уже занята.'
        : 'Не удалось подключиться к комнате.';
      showNotice(elements.status, { type: 'error', message });
    }
  }

  async function sendFiles() {
    if (!state.session) {
      showNotice(elements.status, { type: 'warning', message: 'P2P-канал ещё не готов.' });
      return;
    }

    try {
      await state.session.waitForOpen();
      const chunkSize = Number(elements.chunkSizeSelect.value);
      const files = Array.from(elements.fileInput.files || []);
      await sender.sendFiles(files, chunkSize);
      showNotice(elements.status, { type: 'success', message: 'Файлы отправлены.' });
    } catch (error) {
      showNotice(elements.status, {
        type: 'error',
        message: error.message || 'Передача не удалась.',
      });
    }
  }

  elements.codeInput.addEventListener('input', async () => {
    const code = normalizeRoomCode(elements.codeInput.value, config.roomCodeLength);
    elements.codeInput.value = code;

    if (code.length !== config.roomCodeLength) {
      updateRoomHint('Введите 6-значный код комнаты.');
      setDisabled(elements.joinButton, true);
      return;
    }

    try {
      const room = await api.getRoom(code);
      setDisabled(elements.joinButton, !room.exists);
      updateRoomHint(room.exists ? 'Комната найдена.' : 'Комната не найдена.', room.exists ? 'success' : 'warning');
    } catch {
      setDisabled(elements.joinButton, true);
      updateRoomHint('Не удалось проверить комнату.', 'warning');
    }
  });

  elements.joinButton.addEventListener('click', joinRoom);
  elements.codeInput.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && !elements.joinButton.disabled) {
      joinRoom();
    }
  });

  elements.fileInput.addEventListener('change', () => {
    setDisabled(elements.sendButton, !(state.session?.isReady() && elements.fileInput.files?.length));
  });

  elements.sendButton.addEventListener('click', sendFiles);

  elements.dropzone.addEventListener('dragover', (event) => {
    event.preventDefault();
    elements.dropzone.classList.add('drag-over');
  });

  elements.dropzone.addEventListener('dragleave', () => {
    elements.dropzone.classList.remove('drag-over');
  });

  elements.dropzone.addEventListener('drop', (event) => {
    event.preventDefault();
    elements.dropzone.classList.remove('drag-over');
    if (event.dataTransfer?.files?.length) {
      elements.fileInput.files = event.dataTransfer.files;
      setDisabled(elements.sendButton, !(state.session?.isReady()));
    }
  });

  socket.on('connect', async () => {
    showNotice(elements.status, { type: 'info', message: 'Сигнальный сервер подключён.' });

    if (state.joined && state.code) {
      try {
        const response = await emitWithAck(socket, 'join-room', { code: state.code });
        state.peerId = response.room.peerIds[0] || state.peerId;
        if (state.peerId) {
          createSession();
        }
      } catch {
        showNotice(elements.status, { type: 'warning', message: 'Не удалось переподключиться к комнате.' });
      }
    }
  });

  socket.on('disconnect', () => {
    showNotice(elements.status, { type: 'warning', message: 'Сигнальный сервер временно недоступен. Пробуем переподключиться…' });
  });

  socket.on('peer-joined', ({ peerId }) => {
    state.peerId = peerId;
    createSession();
  });

  socket.on('peer-left', () => {
    resetSession();
    state.peerId = '';
    setProgress(elements.sendBar, elements.sendText, 0, 'Получатель отключился.');
    showNotice(elements.status, { type: 'warning', message: 'Получатель вышел из комнаты.' });
  });

  socket.on('room-state', ({ size, peerIds }) => {
    const otherPeerId = (peerIds || []).find((peerId) => peerId !== socket.id) || '';
    state.peerId = otherPeerId;

    if (size < 2) {
      showNotice(elements.status, { type: 'info', message: 'Комната открыта. Ждём подключение получателя…' });
      return;
    }

    createSession();
  });

  socket.on('signal', (payload) => {
    if (!payload?.signal) {
      return;
    }

    if (!state.peerId && payload.from) {
      state.peerId = payload.from;
    }

    if (!state.session) {
      state.pendingSignals.push(payload);
      return;
    }

    state.session.handleSignal(payload.signal);
  });

  window.addEventListener('beforeunload', () => {
    if (state.joined) {
      socket.emit('leave-room', { code: state.code });
    }

    resetSession();
  });

  const query = parseQuery();
  const prefilledRoom = normalizeRoomCode(query.room, config.roomCodeLength);

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

  elements.shareLink.value = buildSendUrl(config.frontendUrl, prefilledRoom || '000000');

  if (prefilledRoom) {
    elements.codeInput.value = prefilledRoom;
    elements.codeInput.dispatchEvent(new Event('input'));
  } else {
    updateRoomHint('Введите код комнаты, который показан у получателя.');
  }
}

init().catch(() => {
  showNotice(document.querySelector('#status'), {
    type: 'error',
    message: 'Не удалось инициализировать страницу отправки.',
  });
});
