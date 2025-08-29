// send.js — фронт для отправителя с проверкой комнаты в реальном времени + resume/ACK retry
const SOCKET_URL = 'https://twindrop.onrender.com';
const API_URL = SOCKET_URL + '/api'; // REST API
const socket = io(SOCKET_URL);

(function () {
    const TAG = '[send]';
    function slog(...a){ console.log(TAG, ...a); }

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

    let peer = null;
    let code = null;
    let roomExists = false;

    // maps & helpers для ACK/resume
    const progressMap = new Map();     // fileName -> last receivedBytes from receiver
    const ackResolvers = new Map();    // fileName -> resolver for final ack (used while waiting)
    const MAX_RETRIES = 3;
    const FINAL_ACK_TIMEOUT = 15000; // ms

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

    // socket basic logs
    socket.on('connect', () => slog('socket connected', socket.id));
    socket.on('disconnect', (reason) => slog('socket disconnected', reason));
    socket.on('room-full', () => setStatus(statusEl, 'Комната уже занята двумя участниками.'));

    // helper: wait for final ack OR for progress >= fileSize (polled)
    function waitForFinalAckOrProgress(name, fileSize, timeout = FINAL_ACK_TIMEOUT) {
        return new Promise((resolve) => {
            let finished = false;

            // если уже известно, что получили всё
            const current = progressMap.get(name) || 0;
            if (current >= fileSize) return resolve(true);

            // регистрируем финальный резолвер (будет вызван если получим complete=true)
            const finalHandler = (msg) => {
                if (finished) return;
                if (msg && msg.complete) {
                    finished = true;
                    cleanup();
                    slog('final ACK handler triggered', name, msg);
                    return resolve(true);
                }
            };
            ackResolvers.set(name, finalHandler);

            // поллинг прогресса от receiver (каждые 300ms)
            const poll = setInterval(() => {
                const p = progressMap.get(name) || 0;
                if (p >= fileSize) {
                    finished = true;
                    cleanup();
                    slog('progress reached fileSize', name, p, fileSize);
                    return resolve(true);
                }
            }, 300);

            const timer = setTimeout(() => {
                if (!finished) {
                    slog('final ACK timeout for', name);
                    cleanup();
                    return resolve(false);
                }
            }, timeout);

            function cleanup() {
                clearInterval(poll);
                clearTimeout(timer);
                ackResolvers.delete(name);
            }
        });
    }

    // when channel sends us a JSON ack, update progressMap and also invoke resolver if it's a final ack
    function onPeerDataFromReceiver(data) {
        slog('onData (sender) got', typeof data);
        if (typeof data !== 'string') return;
        try {
            const msg = JSON.parse(data);
            if (msg.__meta === 'ack' && msg.name) {
                const rcvBytes = Number(msg.receivedBytes || 0);
                progressMap.set(msg.name, Math.max(progressMap.get(msg.name) || 0, rcvBytes));
                slog('ACK update', msg.name, 'receivedBytes=', rcvBytes, 'chunks=', msg.chunks || 0);
                // если есть зарегистрированный финальный обработчик — вызовем его (он проверит complete)
                const resolver = ackResolvers.get(msg.name);
                if (resolver && typeof resolver === 'function') {
                    resolver(msg);
                }
            } else {
                slog('ctrl msg from receiver', msg);
            }
        } catch (e) {
            slog('failed parse onData', e);
        }
    }

    // room-size => создаём peer и подключаем обработчики
    socket.on('room-size', ({ size }) => {
        slog('room-size', size);
        if (!code) return;
        if (size === 1) {
            setStatus(statusEl, 'Ожидание получателя…');
        } else if (size === 2 && !peer) {
            setStatus(statusEl, 'Получатель на месте. Устанавливаем P2P…');

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
                    // важная часть: обработка ACK сообщений от получателя
                    onPeerDataFromReceiver(data);
                },
                onClose: () => { slog('peer closed'); setStatus(statusEl, 'Соединение закрыто.'); },
                onError: (e) => { slog('peer error', e); setStatus(statusEl, 'Ошибка соединения: ' + e?.message); }
            });

            sendUI.style.display = 'block';
        }
    });

    socket.on('peer-left', () => {
        slog('peer-left');
        setStatus(statusEl, 'Получатель отключился. Соединение разорвано.');
        resetPeer();
        socket.data.joined = false;
        joinBtn.disabled = false;
        joinBtn.textContent = 'Подключиться';
        sendUI.style.display = 'none';
    });

    socket.on('signal', (data) => { if (peer) peer.handleSignal(data); });

    // file selection
    fileInput.addEventListener('change', () => {
        sendBtn.disabled = !(fileInput.files && fileInput.files.length);
    });

    // основной цикл отправки: по файлам, с retry/resume
    sendBtn.onclick = async () => {
        if (!peer || !peer.channel() || peer.channel().readyState !== 'open') {
            setStatus(statusEl, 'Канал ещё не готов.');
            return;
        }
        const files = fileInput.files;
        if (!files || files.length === 0) return;

        for (const file of files) {
            const ok = await sendFileWithResume(file);
            if (!ok) {
                setStatus(statusEl, `Ошибка: файл ${file.name} не удалось доставить после попыток.`);
                // дальше: решаем — продолжать отправку следующих файлов или остановиться. Сейчас продолжаем.
            }
        }
        setStatus(statusEl, 'Все файлы обработаны.');
    };

    async function sendFileWithResume(file) {
        slog('sendFileWithResume start', file.name, file.size);
        progressMap.set(file.name, 0);
        let attempts = 0;

        while (attempts <= MAX_RETRIES) {
            const startOffset = progressMap.get(file.name) || 0;
            if (startOffset >= file.size) {
                slog('file already fully received according to progressMap', file.name);
                return true;
            }

            slog('attempt', attempts + 1, 'startOffset', startOffset);
            // read from startOffset using Blob.slice
            const reader = file.slice(startOffset).stream().getReader();
            let sent = startOffset;
            setBar(sendBar, sent / file.size);
            sendText.textContent = `Отправка: ${file.name}`;

            try {
                while (true) {
                    const { value, done } = await reader.read();
                    if (done) break;
                    // backpressure control
                    await waitForBufferLow(peer.channel());
                    peer.channel().send(value.buffer);
                    sent += value.byteLength;

                    // UI + лог
                    if (sent % (1024*256) < value.byteLength) { // лог ~каждые 256KB
                        slog(`sent ${sent}/${file.size} (buffered=${peer.channel().bufferedAmount})`);
                    }
                    setBar(sendBar, Math.min(1, sent / file.size));
                    sendText.textContent = `${(sent / 1024 / 1024).toFixed(2)} / ${(file.size / 1024 / 1024).toFixed(2)} MB`;
                }

                // обозначаем конец файла
                peer.channel().send(JSON.stringify({ __meta: 'file-complete', name: file.name, size: file.size }));
                slog('chunks sent, waiting for final ACK or progress', file.name);

                setStatus(statusEl, `Ожидание подтверждения доставки для: ${file.name}...`);
                const ok = await waitForFinalAckOrProgress(file.name, file.size, FINAL_ACK_TIMEOUT);

                if (ok) {
                    slog('file delivered confirmed', file.name);
                    setStatus(statusEl, `Файл ${file.name} доставлен.`);
                    return true;
                } else {
                    attempts++;
                    if (attempts > MAX_RETRIES) {
                        slog('max retries reached for', file.name);
                        return false;
                    }
                    // retry — продолжим (progressMap должен уже содержать то, что получил ресивер)
                    const got = progressMap.get(file.name) || 0;
                    slog('retrying remaining bytes from', got, 'of', file.size);
                    setStatus(statusEl, `Повторная отправка оставшейся части: ${file.name} (попытка ${attempts + 1})`);
                    // loop повторит — будем читать с нового offset
                    continue;
                }
            } catch (err) {
                slog('error inside send loop', err);
                attempts++;
                if (attempts > MAX_RETRIES) return false;
                // небольшая пауза перед retry
                await new Promise(r => setTimeout(r, 500));
            }
        }

        return false;
    }

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
            try {
                const ch = peer.channel && peer.channel();
                if (ch && ch.readyState !== 'closed') try { ch.close(); } catch {}
                if (peer.pc && peer.pc.close) try { peer.pc.close(); } catch {}
            } catch (e) { slog('resetPeer error', e); }
            peer = null;
        }
    }
})();
