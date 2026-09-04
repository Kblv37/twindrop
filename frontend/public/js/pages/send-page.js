import { createApiClient, createSocket, emitWithAck } from '../core/api.js';
import { loadRuntimeConfig } from '../core/config.js';
import { $, setDisabled, setProgress, showNotice } from '../core/dom.js';
import { FileSender } from '../core/file-transfer.js';
import { buildSendUrl, formatBytes, normalizeRoomCode, parseQuery, sanitizeText } from '../core/utils.js';
import { WebRtcPeerSession } from '../core/webrtc-peer.js';

const SHARE_TARGET_DB = 'twindrop-share-target';
const SHARE_TARGET_STORE = 'files';
const SHARE_TARGET_KEY = 'shared-files';

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

function registerServiceWorker(elements) {
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/service-worker.js', { scope: '/' })
      .then(() => {
        navigator.serviceWorker.addEventListener('message', (event) => {
          if (event.data && event.data.type === 'SHARED_FILES_AVAILABLE') {
            processSharedFiles(elements);
          }
        });
      })
      .catch((error) => {
        console.warn('Service worker registration failed:', error);
      });
  }
}

async function getAndConvertSharedFiles() {
  try {
    const sharedFiles = await getSharedFiles();
    if (sharedFiles.length > 0) {
      const files = sharedFiles.map((f) => new File([f.data], f.name, {
        type: f.type,
        lastModified: f.lastModified,
      }));
      return files;
    }
  } catch (error) {
    console.warn('Failed to load shared files:', error);
  }
  return [];
}

async function processSharedFiles(elements) {
  const files = await getAndConvertSharedFiles();
  if (files.length > 0) {
    try {
      addFiles(files);
      showNotice(elements.status, { type: 'info', message: `Файлы добавлены из меню «Поделиться»` });
    } finally {
      await clearSharedFiles();
    }
  }
}

async function init() {
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
    dropzoneSubtext: document.querySelector('#dropzone .dz-sub'),
    fileList: $('#fileList'),
  };

  registerServiceWorker(elements);

  const state = {
    code: '',
    joined: false,
    peerId: '',
    pendingSignals: [],
    session: null,
    keepAliveTimer: null,
    completedTransfers: new Set(),
    // Virtual file list — since FileList is read-only we manage our own array
    selectedFiles: [],
    isTransferring: false,
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
    onRemoteProgress: ({ stage, transferId, fileName, receivedBytes, totalBytes, sha256, integrity, message }) => {
      const ratio = totalBytes > 0 ? receivedBytes / totalBytes : 0;
      setProgress(
        elements.sendBar,
        elements.sendText,
        ratio,
        `Передача: ${sanitizeText(fileName)} · ${formatBytes(receivedBytes)} / ${formatBytes(totalBytes)}`,
      );

      if (stage === 'complete' && transferId && !state.completedTransfers.has(transferId)) {
        state.completedTransfers.add(transferId);
        const integrityMsg = integrity === 'verified' ? ' ✓ Целостность проверена' : '';
        showNotice(elements.status, { type: 'success', message: `Получатель подтвердил файл: ${sanitizeText(fileName)}.${integrityMsg}` });
      }

      if (stage === 'error' && transferId) {
        showNotice(elements.status, { type: 'error', message: `Передача завершена с ошибкой: ${sanitizeText(message || 'проверка целостности не пройдена')}.` });
      }
    },
  });

  await processSharedFiles(elements);

  function resetSession() {
    state.session?.destroy();
    state.session = null;
    setTransferring(false);
    setDisabled(elements.sendButton, true);
  }

  function updateRoomHint(message, type = 'info') {
    showNotice(elements.roomHint, { type, message });
  }

  function updateSendButton() {
    const canSend = state.session?.isReady() && state.selectedFiles.length > 0 && !state.isTransferring;
    setDisabled(elements.sendButton, !canSend);
  }

  function setTransferring(active) {
    state.isTransferring = active;
    if (elements.dropzone) {
      elements.dropzone.classList.toggle('is-transferring', active);
    }
    if (elements.fileInput) {
      elements.fileInput.disabled = active;
    }
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
      onMessage: (data) => {
        sender.handleData(data);
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
        updateSendButton();
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
    if (state.selectedFiles.length === 0) {
      showNotice(elements.status, { type: 'warning', message: 'Выберите хотя бы один файл.' });
      return;
    }
    if (state.isTransferring) return;

    setTransferring(true);

    try {
      await state.session.waitForOpen();
      const chunkSize = Number(elements.chunkSizeSelect.value);
      const files = [...state.selectedFiles];
      await sender.sendFiles(files, chunkSize);
      showNotice(elements.status, { type: 'info', message: 'Файлы отправлены. Ожидаем подтверждение получения…' });
      // Clear list after successful send
      state.selectedFiles = [];
      renderFileList();
    } catch (error) {
      showNotice(elements.status, {
        type: 'error',
        message: error.message || 'Передача не удалась.',
      });
    } finally {
      setTransferring(false);
    }
  }

  elements.sendButton.addEventListener('click', sendFiles);

  function startKeepAlive() {
    window.clearInterval(state.keepAliveTimer);
    state.keepAliveTimer = window.setInterval(() => {
      api.ping().catch(() => {});
    }, 140000);
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

  // ── File management ──────────────────────────────────────────

  function formatFileSize(bytes) {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }

  function renderFileList() {
    if (!elements.fileList) return;
    elements.fileList.innerHTML = '';

    if (state.selectedFiles.length === 0) return;

    // Header row
    const header = document.createElement('div');
    header.className = 'file-list-header';

    const label = document.createElement('span');
    label.className = 'file-list-label';
    label.textContent = `Файлов: ${state.selectedFiles.length}`;

    const clearBtn = document.createElement('button');
    clearBtn.className = 'file-list-clear';
    clearBtn.type = 'button';
    clearBtn.textContent = 'Очистить всё';
    clearBtn.addEventListener('click', () => {
      if (state.isTransferring) return;
      state.selectedFiles = [];
      renderFileList();
      updateSendButton();
    });

    header.append(label, clearBtn);
    elements.fileList.appendChild(header);

    // File rows
    state.selectedFiles.forEach((file, index) => {
      const item = document.createElement('div');
      item.className = 'file-list-item';

      const iconWrap = document.createElement('div');
      iconWrap.className = 'file-list-icon';
      iconWrap.innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>`;

      const name = document.createElement('span');
      name.className = 'file-list-name';
      name.textContent = file.name;
      name.title = file.name;

      const size = document.createElement('span');
      size.className = 'file-list-size';
      size.textContent = formatFileSize(file.size);

      const removeBtn = document.createElement('button');
      removeBtn.className = 'file-list-remove';
      removeBtn.type = 'button';
      removeBtn.setAttribute('aria-label', `Удалить ${file.name}`);
      removeBtn.innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>`;
      removeBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        if (state.isTransferring) return;
        state.selectedFiles.splice(index, 1);
        renderFileList();
        updateSendButton();
      });

      item.append(iconWrap, name, size, removeBtn);
      elements.fileList.appendChild(item);
    });
  }

  function addFiles(newFiles) {
    if (state.isTransferring) return;
    // Merge — avoid exact duplicates by name+size
    for (const file of newFiles) {
      const isDupe = state.selectedFiles.some(
        (f) => f.name === file.name && f.size === file.size,
      );
      if (!isDupe) {
        state.selectedFiles.push(file);
      }
    }
    renderFileList();
    updateSendButton();
  }

  elements.fileInput.addEventListener('change', () => {
    const files = Array.from(elements.fileInput.files || []);
    if (files.length > 0) addFiles(files);
    // Reset input so same file can be re-added after removal
    elements.fileInput.value = '';
  });

  elements.dropzone.addEventListener('dragover', (event) => {
    if (state.isTransferring) return;
    event.preventDefault();
    elements.dropzone.classList.add('drag-over');
  });

  elements.dropzone.addEventListener('dragleave', () => {
    elements.dropzone.classList.remove('drag-over');
  });

  elements.dropzone.addEventListener('drop', (event) => {
    event.preventDefault();
    elements.dropzone.classList.remove('drag-over');
    if (state.isTransferring) return;
    const files = Array.from(event.dataTransfer?.files || []);
    if (files.length > 0) addFiles(files);
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
    window.clearInterval(state.keepAliveTimer);
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

  startKeepAlive();
}

init().catch((error) => {
  showNotice(document.querySelector('#status'), {
    type: 'error',
    message: `Не удалось инициализировать страницу отправки: ${error?.message || 'неизвестная ошибка'}.`,
  });
});
