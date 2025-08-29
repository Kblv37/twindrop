// send.js — фронт для отправителя с проверкой комнаты в реальном времени
const SOCKET_URL = 'https://twindrop.onrender.com';
const API_URL = SOCKET_URL + '/api'; // REST API
const socket = io(SOCKET_URL);

(function () {
    const TAG = '[send]';
    const codeInput = $('#codeInput');
    const joinBtn = $('#joinBtn');
    const sendUI = $('#sendUI');
    const fileInput = $('#file');
    const sendBtn = $('#sendBtn');
    const sendBar = $('#sendBar');
    const sendText = $('#sendText');
    const statusEl = $('#status');

    const q = parseQuery();
    if (q.room) {
        codeInput.value = q.room;
        setTimeout(async () => {
            await checkRoom();
            if (roomExists) join();
        }, 0);
    }

    let peer;
    let code;
    let roomExists = false; // хранение статуса

    // ACK резолверы: ожидаем подтверждение по имени файла
    const ackResolvers = new Map();
    function waitForAck(name, timeout = 15000) {
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                ackResolvers.delete(name);
                reject(new Error('ACK timeout'));
            }, timeout);
            ackResolvers.set(name, (msg) => {
                clearTimeout(timer);
                ackResolvers.delete(name);
                resolve(msg);
            });
        });
    }

    function slog(...args){ console.log(TAG, ...args); }

    // Проверка комнаты
    async function checkRoom() {
        const val = (codeInput.value || '').replace(/\D/g, '').padStart(6, '0');
        if (val.length !== 6) {
            setStatus(statusEl, 'Введите 6-значный код.');
            roomExists = false;
            joinBtn.disabled = true;
            return;
        }

        try {
            const res = await fetch(`${API_URL}/check-room/${val}`);
            const data = await res.json();

            if (data.exists) {
                setStatus(statusEl, 'Комната найдена');
                roomExists = true;
                joinBtn.disabled = false;
            } else {
                setStatus(statusEl, 'Комната не найдена');
                roomExists = false;
                joinBtn.disabled = true;
            }
        } catch (err) {
            setStatus(statusEl, 'Ошибка проверки комнаты.');
            console.error(err);
            joinBtn.disabled = true;
            roomExists = false;
        }
    }

    codeInput.addEventListener('input', checkRoom);

    function join() {
        if (peer || socket.data?.joined) {
            setStatus(statusEl, 'Вы уже подключены.');
            return;
        }

        code = (codeInput.value || '').replace(/\D/g, '').padStart(6, '0');
        if (!roomExists) {
            setStatus(statusEl, 'Сначала введите существующий код.');
            return;
        }

        setStatus(statusEl, 'Подключаемся к комнате…');
        socket.emit('join-room', { code });
        socket.data = { joined: true };
        joinBtn.disabled = true;
        joinBtn.textContent = 'Подключено';
    }

    joinBtn.onclick = join;
    codeInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') join(); });

    // socket events — добавим логи
    socket.on('connect', () => slog('socket connected', socket.id));
    socket.on('disconnect', (reason) => slog('socket disconnected', reason));
    socket.on('room-full', () => setStatus(statusEl, 'Комната уже занята двумя участниками.'));

    socket.on('room-size', ({ size }) => {
        slog('room-size', size);
        if (!code) return;
        if (size === 1) {
            setStatus(statusEl, 'Ожидание получателя…');
        } else if (size === 2 && !peer) {
            setStatus(statusEl, 'Получатель на месте. Устанавливаем P2P…');

            // создаём P2P соединение с обработкой входящих сообщений (ACKs и логи)
            peer = createPeer({
                initiator: true,
                iceServers: [
                    { urls: 'stun:stun.l.google.com:19302' },
                    { urls: 'stun:stun1.l.google.com:19302' }
                ],
                onSignal: (data) => socket.emit('signal', { code, data }),
                onConnect: () => {
                    slog('datachannel open');
                    setStatus(statusEl, 'P2P соединение установлено. Можно отправлять файл.');
                    sendBtn.disabled = !fileInput.files?.length;
                },
                onData: (data) => {
                    slog('onData received', data);
                    // контролируем текстовые сообщения (ACK / прогресс)
                    if (typeof data === 'string') {
                        try {
                            const msg = JSON.parse(data);
                            if (msg.__meta === 'ack') {
                                slog('ACK from receiver', msg);
                                const resolver = ackResolvers.get(msg.name);
                                if (resolver) resolver(msg);
                            } else {
                                slog('ctrl message', msg);
                            }
                        } catch (e) {
                            slog('non-json string', data);
                        }
                    } else {
                        slog('unexpected binary on sender', data && data.byteLength);
                    }
                },
                onClose: () => {
                    slog('peer connection closed');
                    setStatus(statusEl, 'Соединение закрыто.');
                },
                onError: (e) => {
                    slog('peer error', e);
                    setStatus(statusEl, 'Ошибка соединения: ' + e?.message);
                }
            });

            sendUI.style.display = 'block';
        }
    });

    socket.on('signal', (data) => { if (peer) peer.handleSignal(data); });
    socket.on('peer-left', () => {
        slog('peer-left event');
        setStatus(statusEl, 'Получатель отключился. Соединение разорвано.');
        resetPeer();
        socket.data.joined = false;
        joinBtn.disabled = false;
        joinBtn.textContent = 'Подключиться';
        sendUI.style.display = 'none';
    });

    // file input -> activates send button
    fileInput.addEventListener('change', () => {
        sendBtn.disabled = !(fileInput.files && fileInput.files.length);
    });

    // send logic: отправляем по файлам, логируем и ждём ACK по каждому файлу
    sendBtn.onclick = async () => {
        if (!peer || !peer.channel() || peer.channel().readyState !== 'open') {
            setStatus(statusEl, 'Канал ещё не готов.');
            return;
        }

        const files = fileInput.files;
        if (!files || files.length === 0) return;

        for (const file of files) {
            slog('start sending file', file.name, file.size);
            // отправляем метаданные
            peer.channel().send(JSON.stringify({ __meta: 'file', name: file.name, size: file.size }));
            const reader = file.stream().getReader();
            let sent = 0;
            const CHUNK_LOG_INTERVAL = 1024 * 1024; // лог каждые 1MB
            let lastLogged = 0;

            setBar(sendBar, 0);
            sendText.textContent = `Отправка: ${file.name}`;

            while (true) {
                const { value, done } = await reader.read();
                if (done) break;
                // flow control - ждём если буфер большой
                await waitForBufferLow(peer.channel());
                peer.channel().send(value.buffer);
                sent += value.byteLength;

                // логи
                if (sent - lastLogged >= CHUNK_LOG_INTERVAL || sent === file.size) {
                    lastLogged = sent;
                    slog(`sent ${sent}/${file.size} bytes (buffered=${peer.channel().bufferedAmount})`);
                }

                setBar(sendBar, sent / file.size);
                sendText.textContent = `${(sent / 1024 / 1024).toFixed(2)} / ${(file.size / 1024 / 1024).toFixed(2)} MB`;
            }

            // сигнализируем что файл полностью отправлен
            peer.channel().send(JSON.stringify({ __meta: 'file-complete', name: file.name, size: file.size }));
            slog('file chunks sent, waiting for ACK', file.name);

            setStatus(statusEl, `Ожидание подтверждения доставки для: ${file.name}...`);

            // ждём ACK (timeout 15s)
            try {
                const ack = await waitForAck(file.name, 15000);
                slog('ACK received for file', file.name, ack);
                setStatus(statusEl, `Файл ${file.name} успешно доставлен ✅`);
            } catch (err) {
                slog('ACK timeout for file', file.name);
                setStatus(statusEl, `Нет подтверждения доставки для ${file.name} — возможно потеря связи.`);
                // решаем: пробуем продолжить к следующему файлу или остановиться — сейчас продолжаем
            }
        }

        setStatus(statusEl, 'Все файлы обработаны (отправлены/ожидают ACK).');
    };

    function waitForBufferLow(dc) {
        return new Promise((resolve) => {
            const threshold = 1 * 1024 * 1024;
            if (dc.bufferedAmount < threshold) return resolve();
            const check = () => {
                if (dc.bufferedAmount < threshold) {
                    dc.removeEventListener('bufferedamountlow', check);
                    resolve();
                }
            };
            try { dc.bufferedAmountLowThreshold = threshold; } catch { }
            dc.addEventListener('bufferedamountlow', check);
            setTimeout(check, 50);
        });
    }

    function resetPeer() {
        if (peer) {
            try { peer.destroy(); } catch { }
            peer = null;
        }
    }

})();
