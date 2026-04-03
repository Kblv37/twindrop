import { createApiClient, createSocket, emitWithAck } from '../core/api.js';
import { loadRuntimeConfig } from '../core/config.js';
import { $, createDownloadCard, setProgress, showNotice } from '../core/dom.js';
import { FileReceiver } from '../core/file-transfer.js';
import { buildSendUrl, formatBytes } from '../core/utils.js';
import { WebRtcPeerSession } from '../core/webrtc-peer.js';

async function init() {
  const config = await loadRuntimeConfig();
  const api = createApiClient(config);
  let socket;

  const elements = {
    code: $('#code'),
    status: $('#status'),
    downloads: $('#downloads'),
    copyButton: $('#copyCode'),
    recvBar: $('#recvBar'),
    recvText: $('#recvText'),
    qr: $('#qr'),
    sendLink: $('#sendLink'),
  };

  const state = {
    code: '',
    joined: false,
    peerId: '',
    pendingSignals: [],
    session: null,
  };

  const receiver = new FileReceiver({
    maxFileSizeBytes: config.maxFileSizeBytes,
    onProgress: ({ fileName, receivedBytes, totalBytes }) => {
      const ratio = totalBytes > 0 ? receivedBytes / totalBytes : 0;
      setProgress(
        elements.recvBar,
        elements.recvText,
        ratio,
        `${fileName} · ${formatBytes(receivedBytes)} / ${formatBytes(totalBytes)}`,
      );
    },
    onTransferReady: ({ fileName, fileSize, href }) => {
      elements.downloads.prepend(
        createDownloadCard({
          fileName,
          sizeLabel: formatBytes(fileSize),
          href,
        }),
      );
      showNotice(elements.status, { type: 'success', message: `Файл ${fileName} готов к скачиванию.` });
    },
    onError: (error) => {
      showNotice(elements.status, { type: 'error', message: error.message || 'Передача завершилась с ошибкой.' });
    },
  });

  function destroySession() {
    state.session?.destroy();
    state.session = null;
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
    if (state.session) {
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
          showNotice(elements.status, { type: 'error', message: 'Не удалось отправить ответ сигнальному серверу.' });
        }
      },
      onMessage: (data) => {
        receiver.handleData(data);
      },
      onStateChange: ({ connectionState }) => {
        if (connectionState === 'connected') {
          showNotice(elements.status, { type: 'success', message: 'Отправитель подключён. Ожидаем файлы…' });
        } else if (connectionState === 'connecting') {
          showNotice(elements.status, { type: 'info', message: 'Устанавливаем P2P-соединение…' });
        } else if (connectionState === 'failed') {
          showNotice(elements.status, { type: 'warning', message: 'Соединение просело. Ждём повторную попытку…' });
        }
      },
      onChannelOpen: () => {
        showNotice(elements.status, { type: 'success', message: 'Канал открыт. Можно принимать файлы.' });
      },
      onError: () => {
        showNotice(elements.status, { type: 'error', message: 'WebRTC-соединение завершилось с ошибкой.' });
      },
    });

    flushPendingSignals();
  }

  async function joinRoom() {
    const response = await emitWithAck(socket, 'join-room', { code: state.code });
    state.joined = true;
    state.peerId = response.room.peerIds[0] || '';

    if (state.peerId) {
      createSession();
    }
  }

  function renderQr(url) {
    elements.qr.textContent = '';
    new window.QRCode(elements.qr, {
      text: url,
      width: 192,
      height: 192,
    });
  }

  state.code = await api.createRoom();
  elements.code.textContent = state.code;

  const sendLink = buildSendUrl(config.frontendUrl, state.code);
  elements.sendLink.value = sendLink;
  renderQr(sendLink);
  socket = createSocket(config);

  elements.copyButton.addEventListener('click', async () => {
    await navigator.clipboard.writeText(state.code);
    showNotice(elements.status, { type: 'success', message: 'Код комнаты скопирован.' });
  });

  socket.on('connect', async () => {
    try {
      await joinRoom();
      showNotice(elements.status, { type: 'info', message: 'Комната создана. Ждём отправителя…' });
    } catch {
      showNotice(elements.status, { type: 'error', message: 'Не удалось подключить комнату на сервере.' });
    }
  });

  socket.on('disconnect', () => {
    showNotice(elements.status, { type: 'warning', message: 'Сигнальный сервер переподключается…' });
  });

  socket.on('peer-joined', ({ peerId }) => {
    state.peerId = peerId;
    createSession();
  });

  socket.on('peer-left', () => {
    destroySession();
    state.peerId = '';
    setProgress(elements.recvBar, elements.recvText, 0, 'Отправитель отключился. Можно ждать новое подключение.');
    showNotice(elements.status, { type: 'warning', message: 'Отправитель вышел из комнаты.' });
  });

  socket.on('room-state', ({ size, peerIds }) => {
    const otherPeerId = (peerIds || []).find((peerId) => peerId !== socket.id) || '';
    state.peerId = otherPeerId;

    if (size < 2) {
      showNotice(elements.status, { type: 'info', message: 'Комната активна. Ждём отправителя…' });
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

    destroySession();
  });

  if (socket.connected) {
    await joinRoom();
    showNotice(elements.status, { type: 'info', message: 'Комната создана. Ждём отправителя…' });
  }
}

init().catch(() => {
  showNotice(document.querySelector('#status'), {
    type: 'error',
    message: 'Не удалось инициализировать страницу получения.',
  });
});
