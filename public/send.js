// send.js — фронт для отправителя (только P2P, без relay/чанков)
const SOCKET_URL = 'https://twindrop.onrender.com';
const API_URL = SOCKET_URL + '/api'; // REST API
const socket = io(SOCKET_URL);

(function () {
    const codeInput = $('#codeInput');
    const joinBtn = $('#joinBtn');
    const sendUI = $('#sendUI');
    const fileInput = $('#file');
    const sendBtn = $('#sendBtn');
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
    let roomExists = false;

    // 🔎 Проверка комнаты
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
            // console.error(err);
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

    // События от сервера
    socket.on('peer-joined', () => { /* игнор */ });

    socket.on('room-size', ({ size }) => {
        if (!code) return;
        if (size === 1) {
            setStatus(statusEl, 'Ожидание получателя…');
        } else if (size === 2 && !peer) {
            setStatus(statusEl, 'Получатель подключился. Устанавливаем P2P…');

            peer = createPeer({
                initiator: true,
                iceServers: [
                    { urls: 'stun:stun.l.google.com:19302' },
                    { urls: 'stun:stun1.l.google.com:19302' }
                ],
                onSignal: (data) => socket.emit('signal', { code, data }),
                onConnect: () => {
                    setStatus(statusEl, 'P2P соединение установлено. Можно отправлять файл.');
                    sendBtn.disabled = !fileInput.files?.length;
                },
                onData: () => { },
                onClose: () => {
                    setStatus(statusEl, 'P2P канал закрыт.');
                },
                onError: (e) => setStatus(statusEl, 'Ошибка соединения: ' + e?.message)
            });

            sendUI.style.display = 'block';
        }
    });

    socket.on('signal', (data) => { if (peer) peer.handleSignal(data); });

    socket.on('room-full', () => setStatus(statusEl, 'Комната уже занята двумя участниками.'));
    socket.on('peer-left', () => {
        setStatus(statusEl, 'Получатель отключился. Соединение разорвано.');
        resetPeer();
        socket.data.joined = false;
        joinBtn.disabled = false;
        joinBtn.textContent = 'Подключиться';
        sendUI.style.display = 'none';
    });

    // Файл
    fileInput.addEventListener('change', () => {
        sendBtn.disabled = !(fileInput.files && fileInput.files.length);
    });

    // ВЕРСИЯ С ЧАНКАМИ И BACKPRESSURE
    sendBtn.onclick = async () => {
        if (!peer || !peer.channel() || peer.channel().readyState !== 'open') {
            setStatus(statusEl, 'Канал ещё не готов.');
            return;
        }

        const files = fileInput.files;
        if (!files || files.length === 0) return;

        const dc = peer.channel();

        // Порог, при превышении которого ждём освобождения буфера
        // 1 МБ — безопасно для большинства браузеров
        dc.bufferedAmountLowThreshold = 1 * 1024 * 1024;

        // размер чанка: 64 КБ (для Safari иногда лучше 16 КБ)
        const CHUNK_SIZE = navigator.userAgent.includes('Safari') && !navigator.userAgent.includes('Chrome')
            ? 16 * 1024
            : 64 * 1024;

        const waitForDrain = () => new Promise((resolve) => {
            if (dc.bufferedAmount <= dc.bufferedAmountLowThreshold) return resolve();
            const onLow = () => {
                dc.removeEventListener('bufferedamountlow', onLow);
                resolve();
            };
            dc.addEventListener('bufferedamountlow', onLow);
        });

        try {
            for (const file of files) {
                // метаданные
                dc.send(JSON.stringify({ __meta: 'file', name: file.name, size: file.size }));
                setStatus(statusEl, `Отправка: ${file.name}`);
                let sent = 0;

                // читаем Blob по кускам
                for (let offset = 0; offset < file.size; offset += CHUNK_SIZE) {
                    const slice = file.slice(offset, offset + CHUNK_SIZE);
                    const buf = await slice.arrayBuffer();

                    // если буфер переполнен — ждём
                    if (dc.bufferedAmount > dc.bufferedAmountLowThreshold) {
                        await waitForDrain();
                    }

                    dc.send(buf);
                    sent += buf.byteLength;

                    // прогресс (если есть прогресс-бар на отправителе)
                    const ratio = Math.min(1, sent / file.size);
                    const sendBar = document.getElementById('sendBar');
                    const sendText = document.getElementById('sendText');
                    if (sendBar) sendBar.style.width = (ratio * 100).toFixed(2) + '%';
                    if (sendText) sendText.textContent = `${(sent / 1024 / 1024).toFixed(2)} / ${(file.size / 1024 / 1024).toFixed(2)} MB`;
                }

                // маркер завершения файла
                dc.send(JSON.stringify({ __meta: 'file-complete', name: file.name, size: file.size }));
                setStatus(statusEl, `Файл ${file.name} отправлен.`);
            }
        } catch (e) {
            console.error('Send error:', e);
            setStatus(statusEl, 'Ошибка при отправке: ' + (e?.message || e));
        }
    };

    function resetPeer() {
        if (peer) {
            try { peer.destroy(); } catch { }
            peer = null;
        }
    }

})();
