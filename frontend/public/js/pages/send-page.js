import { createApiClient, createSocket, emitWithAck } from '../core/api.js';
import { loadRuntimeConfig } from '../core/config.js';
import { $, setDisabled, setProgress, showNotice } from '../core/dom.js';
import { FileSender } from '../core/file-transfer.js';
import { buildSendUrl, formatBytes, normalizeRoomCode, parseQuery, sanitizeText } from '../core/utils.js';
import { WebRtcPeerSession } from '../core/webrtc-peer.js';

const SHARE_TARGET_DB = 'twindrop-share-target';
const SHARE_TARGET_STORE = 'files';
const SHARE_TARGET_KEY = 'shared-files';

// QR Scanner constants
const QR_SCANNER_CONSTANTS = {
  SUPPORTED_MIME_TYPES: ['image/png', 'image/jpeg'],
  MIN_QR_SIZE: 128,
  MAX_QR_SIZE: 1024,
  FINDER_PATTERN_SIZE: 7,
};

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

function registerServiceWorker(elements, state) {
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/service-worker.js', { scope: '/' })
      .then(() => {
        navigator.serviceWorker.addEventListener('message', (event) => {
          if (event.data && event.data.type === 'SHARED_FILES_AVAILABLE') {
            processSharedFiles(elements, state);
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

async function processSharedFiles(elements, state) {
  const files = await getAndConvertSharedFiles();
  if (files.length > 0) {
    const beforeCount = elements.fileList ? Array.from(elements.fileList.querySelectorAll('.file-list-item')).length : 0;
    addFiles(files);
    const afterCount = elements.fileList ? Array.from(elements.fileList.querySelectorAll('.file-list-item')).length : 0;
    if (afterCount > beforeCount) {
      showNotice(elements.status, { type: 'info', message: `Файлы добавлены из меню «Поделиться»` });
      await clearSharedFiles();
    } else if (state.isTransferring) {
      showNotice(elements.status, { type: 'warning', message: 'Передача в процессе, файлы будут добавлены после завершения' });
    }
  }
}

function parseQrData(rawData) {
  if (!rawData || typeof rawData !== 'string') {
    return null;
  }
  const trimmed = rawData.trim();
  if (!trimmed) {
    return null;
  }
  if (/^\d{6}$/.test(trimmed)) {
    return trimmed;
  }
  try {
    const url = new URL(trimmed);
    const roomParam = url.searchParams.get('room');
    if (roomParam && /^\d{6}$/.test(roomParam)) {
      return roomParam;
    }
    if (url.pathname === '/send.html' || url.pathname === '/send') {
      const roomParam2 = url.searchParams.get('room');
      if (roomParam2 && /^\d{6}$/.test(roomParam2)) {
        return roomParam2;
      }
    }
  } catch {
  }
  return null;
}

function isPwaMode() {
  return window.matchMedia('(display-mode: standalone)').matches ||
         window.navigator.standalone === true ||
         document.referrer.includes('android-app://');
}

function getCameraErrorMessage(error) {
  if (!error) return 'Неизвестная ошибка камеры';
  switch (error.name) {
    case 'NotAllowedError':
      return 'Доступ к камере запрещён. Разрешите доступ в настройках браузера или введите код вручную.';
    case 'NotFoundError':
      return 'Камера не найдена. Убедитесь, что устройство имеет камеру.';
    case 'NotReadableError':
      return 'Камера занята другим приложением. Закройте другие приложения, использующие камеру.';
    case 'OverconstrainedError':
      return 'Не удалось настроить камеру. Попробуйте ввести код вручную.';
    case 'SecurityError':
      return 'Доступ к камере запрещён политикой безопасности. Требуется HTTPS.';
    case 'AbortError':
      return 'Запуск камеры был прерван.';
    default:
      return `Ошибка камеры: ${error.message || error.name}. Введите код вручную.`;
  }
}

async function openQrScanner(elements, state) {
  const modal = $('#qrScannerModal');
  const video = $('#qrScannerVideo');
  const canvas = $('#qrScannerCanvas');
  const closeBtn = $('#qrScannerClose');
  const errorEl = $('#qrScannerError');
  const fallback = $('#qrScannerFallback');
  const videoWrap = $('#qrScannerVideoWrap');
  const overlay = $('#qrScannerOverlay');

  if (!modal || !video || !canvas || !closeBtn) {
    showNotice(elements.status, { type: 'error', message: 'QR сканер недоступен' });
    return;
  }

  if (state.isScanningQr) {
    return;
  }
  state.isScanningQr = true;

  errorEl.style.display = 'none';
  fallback.hidden = true;
  videoWrap.hidden = false;
  modal.hidden = false;
  document.body.style.overflow = 'hidden';

  let barcodeDetector = null;
  let animationFrameId = null;
  let stream = null;
  let isScanning = true;

  const cleanup = () => {
    isScanning = false;
    state.isScanningQr = false;
    if (animationFrameId) {
      cancelAnimationFrame(animationFrameId);
      animationFrameId = null;
    }
    if (stream) {
      stream.getTracks().forEach((track) => track.stop());
      stream = null;
    }
    video.srcObject = null;
    modal.hidden = true;
    document.body.style.overflow = '';
  };

  const showError = (message) => {
    errorEl.textContent = message;
    errorEl.style.display = 'block';
    videoWrap.hidden = true;
    fallback.hidden = false;
  };

  const processFrame = async () => {
    if (!isScanning || video.readyState < 2) {
      animationFrameId = requestAnimationFrame(processFrame);
      return;
    }

    if (typeof window.BarcodeDetector === 'function' && barcodeDetector) {
      try {
        const barcodes = await barcodeDetector.detect(video);
        for (const barcode of barcodes) {
          if (barcode.rawValue) {
            const roomCode = parseQrData(barcode.rawValue);
            if (roomCode) {
              isScanning = false;
              elements.codeInput.value = roomCode;
              elements.codeInput.dispatchEvent(new Event('input'));
              cleanup();
              return;
            }
          }
        }
      } catch (e) {
        console.warn('BarcodeDetector error:', e);
      }
    } else if (typeof window.QRCode !== 'undefined' && window.QRCode.toDataURL) {
      try {
        const ctx = canvas.getContext('2d');
        canvas.width = video.videoWidth;
        canvas.height = video.videoHeight;
        ctx.drawImage(video, 0, 0);
        const dataUrl = canvas.toDataURL('image/png');
        const decoded = await decodeQrFromImage(dataUrl);
        if (decoded) {
          const roomCode = parseQrData(decoded);
          if (roomCode) {
            isScanning = false;
            elements.codeInput.value = roomCode;
            elements.codeInput.dispatchEvent(new Event('input'));
            cleanup();
            return;
          }
        }
      } catch (e) {
        console.warn('QRCode decode error:', e);
      }
    }

    animationFrameId = requestAnimationFrame(processFrame);
  };

  async function decodeQrFromImage(dataUrl) {
    if (typeof window.QRCode !== 'function' || typeof window.QRCode.decode !== 'function') {
      return null;
    }
    return new Promise((resolve) => {
      const img = new Image();
      img.onload = () => {
        try {
          const result = window.QRCode.decode(img);
          resolve(result || null);
        } catch {
          resolve(null);
        }
      };
      img.onerror = () => resolve(null);
      img.src = dataUrl;
    });
  }

  try {
    if (typeof window.BarcodeDetector === 'function') {
      barcodeDetector = new window.BarcodeDetector({ formats: ['qr_code'] });
    }
  } catch {
    barcodeDetector = null;
  }

  try {
    stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: 'environment', width: { ideal: 1280 }, height: { ideal: 720 } },
    });
    video.srcObject = stream;
    await video.play();
    animationFrameId = requestAnimationFrame(processFrame);
  } catch (error) {
    console.error('Camera access error:', error);
    showError(getCameraErrorMessage(error));
    cleanup();
    return;
  }

  closeBtn.addEventListener('click', cleanup);
  modal.querySelector('.modal-backdrop').addEventListener('click', cleanup);

  const handleKeyDown = (event) => {
    if (event.key === 'Escape') {
      cleanup();
      document.removeEventListener('keydown', handleKeyDown);
    }
  };
  document.addEventListener('keydown', handleKeyDown);

  modal.addEventListener('click', (event) => {
    if (event.target === modal) {
      cleanup();
    }
  });
}

async function init() {
  const elements = {
    codeInput: $('#codeInput'),
    roomHint: $('#roomHint'),
    joinButton: $('#joinBtn'),
    scanQrButton: $('#scanQrBtn'),
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

  const config = await loadRuntimeConfig();

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
    isScanningQr: false,
  };

  registerServiceWorker(elements, state);

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

  await processSharedFiles(elements, state);

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
  elements.scanQrButton?.addEventListener('click', () => openQrScanner(elements, state));
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
