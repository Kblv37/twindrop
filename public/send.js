// send.js — фронт для отправителя с подключением к Render
const SOCKET_URL = 'https://twindrop.onrender.com';
const socket = io(SOCKET_URL);

(function () {
    const codeInput = $('#codeInput');
    const joinBtn = $('#joinBtn');
    const sendUI = $('#sendUI');
    const fileInput = $('#file');
    const sendBtn = $('#sendBtn');
    const sendBar = $('#sendBar');
    const sendText = $('#sendText');
    const statusEl = $('#status');
    const qrContainer = $('#qrContainer'); // элемент для QR-кода

    const q = parseQuery();
    if (q.room) codeInput.value = q.room;

    let peer;
    let code;

    // Генерация QR-кода с публичным URL Render
    function generateRoomQR(code) {
        const url = `${SOCKET_URL}/receive.html?room=${code}`; // исправлено
        qrContainer.innerHTML = '';
        new QRCode(qrContainer, {
            text: url,
            width: 200,
            height: 200
        });
    }

    function join() {
        code = (codeInput.value || '').replace(/\D/g, '').padStart(6, '0');
        if (code.length !== 6) {
            setStatus(statusEl, 'Введите корректный 6-значный код.');
            return;
        }
        setStatus(statusEl, 'Подключаемся к комнате…');
        socket.emit('join-room', { code });

        generateRoomQR(code);
    }

    joinBtn.onclick = join;
    codeInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') join(); });

    // События от сервера
    socket.on('peer-joined', () => { /* первый участник игнорирует */ });

    socket.on('room-size', ({ size }) => {
        if (!code) return;
        if (size === 1) {
            setStatus(statusEl, 'Ожидание получателя…');
        } else if (size === 2 && !peer) {
            setStatus(statusEl, 'Получатель на месте. Устанавливаем P2P…');

            // создаём P2P соединение
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
                onClose: () => setStatus(statusEl, 'Соединение закрыто.'),
                onError: (e) => setStatus(statusEl, 'Ошибка соединения: ' + e?.message)
            });
            sendUI.style.display = 'block';
        }
    });

    socket.on('signal', (data) => { if (peer) peer.handleSignal(data); });
    socket.on('room-full', () => setStatus(statusEl, 'Комната уже занята двумя участниками.'));

    // Управление файлом
    fileInput.addEventListener('change', () => {
        sendBtn.disabled = !(fileInput.files && fileInput.files.length);
    });

    sendBtn.onclick = async () => {
        if (!peer || !peer.channel() || peer.channel().readyState !== 'open') {
            setStatus(statusEl, 'Канал ещё не готов.');
            return;
        }
        const file = fileInput.files[0];
        if (!file) return;

        // Отправляем метаданные
        peer.channel().send(JSON.stringify({ __meta: 'file', name: file.name, size: file.size }));

        const chunkSize = 64 * 1024; // 64KB
        const reader = file.stream().getReader();
        let sent = 0;

        setBar(sendBar, 0);
        sendText.textContent = `Отправка: ${file.name}`;

        try {
            while (true) {
                const { value, done } = await reader.read();
                if (done) break;

                // делим на чанки, если слишком большой кусок
                for (let offset = 0; offset < value.byteLength; offset += chunkSize) {
                    const chunk = value.buffer.slice(offset, offset + chunkSize);
                    await waitForBufferLow(peer.channel());
                    peer.channel().send(chunk);
                }

                sent += value.byteLength;
                setBar(sendBar, sent / file.size);
                sendText.textContent = `${(sent / 1024 / 1024).toFixed(2)} / ${(file.size / 1024 / 1024).toFixed(2)} MB`;
            }

            setStatus(statusEl, 'Файл успешно отправлен.');
            sendBtn.disabled = true;
        } catch (err) {
            setStatus(statusEl, 'Ошибка при передаче: ' + err.message);
        }
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
})();
