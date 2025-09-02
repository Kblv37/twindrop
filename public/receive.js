// receive.js — фронт для получателя
const SOCKET_URL = 'https://twindrop.onrender.com';
const socket = io(SOCKET_URL);

(async function () {
    const codeEl = $('#code');
    const copyBtn = $('#copyCode');
    const statusEl = $('#status');
    const recvBar = $('#recvBar');
    const recvText = $('#recvText');
    const downloads = $('#downloads');
    const qrContainer = $('#qr');

    const disconnectBtn = $('#disconnectBtn');
    disconnectBtn.style.display = 'none'; // скрыта изначально

    // Получаем код комнаты от сервера
    const r = await fetch(`${SOCKET_URL}/api/new-room`);
    const { code } = await r.json();
    codeEl.textContent = code;

    // Формируем URL на основе кода
    const url = `https://twindrop.netlify.app/send.html?room=${code}`;

    // Генерация QR на клиенте (чисто JS, без сервера)
    qrContainer.innerHTML = ""; // очищаем, чтобы не плодились
    new QRCode(qrContainer, {
        text: url,
        width: 200,
        height: 200,
    });

    // Копирование кода
    copyBtn.onclick = async () => {
        await navigator.clipboard.writeText(code);
        copyBtn.textContent = 'Скопировано!';
        setTimeout(() => copyBtn.textContent = 'Скопировать', 1200);
    };

    socket.emit('join-room', { code });

    let fileChunks = [];
    let expectedSize = 0;
    let fileName = 'file';
    let total = 0;

    function saveIfComplete() {
        total = fileChunks.reduce((s, b) => s + b.byteLength, 0); // обновляем глобальную total
        setBar(recvBar, expectedSize ? total / expectedSize : 0);
        recvText.textContent = expectedSize
            ? `${(total / 1024 / 1024).toFixed(2)} / ${(expectedSize / 1024 / 1024).toFixed(2)} MB`
            : `${(total / 1024 / 1024).toFixed(2)} MB`;

        if (expectedSize && total >= expectedSize) {
            const blob = new Blob(fileChunks);
            const a = document.createElement('a');
            a.href = URL.createObjectURL(blob);
            a.download = fileName;
            a.textContent = `Скачать: ${fileName} (${(expectedSize / 1024 / 1024).toFixed(2)} MB)`;
            a.className = 'btn';
            downloads.appendChild(a);
            setStatus(statusEl, 'Передача завершена.');
            fileChunks = [];
            expectedSize = 0;
        }
    }


    let peer;

    socket.on('peer-joined', () => {
        setStatus(statusEl, 'Отправитель подключился. Устанавливаем P2P…');

        peer = createPeer({
            initiator: false,
            iceServers: [
                { urls: 'stun:stun.l.google.com:19302' },
                { urls: 'stun:stun1.l.google.com:19302' }
            ],
            onSignal: (data) => socket.emit('signal', { code, data }),

            onConnect: () => {
                setStatus(statusEl, 'P2P соединение установлено. Ожидаем файл…');
                disconnectBtn.style.display = 'inline-block';
            },

            // receive.js — фрагмент внутри onData:
            onData: (data) => {
                if (typeof data === 'string') {
                    try {
                        const meta = JSON.parse(data);
                        if (meta.__meta === 'file') {
                            fileName = meta.name || 'file';
                            expectedSize = meta.size || 0;
                            recvText.textContent = `Получение: ${fileName}`;
                            setBar(recvBar, 0);
                            return;
                        }
                        if (meta.__meta === 'file-complete') {
                            if (total !== expectedSize) {
                                console.warn(`Файл ${fileName} получен не полностью: ${total} из ${expectedSize}`);
                                const dc = peer?.channel?.();
                                if (dc && dc.readyState === 'open') {
                                    dc.send(JSON.stringify({ __meta: 'error', name: fileName, reason: 'incomplete' }));
                                }
                            } else {
                                const dc = peer?.channel?.();
                                if (dc && dc.readyState === 'open') {
                                    dc.send(JSON.stringify({ __meta: 'ack', name: fileName }));
                                }
                            }
                            return;
                        }

                    } catch {
                        // не-JSON — игнор
                    }
                }

                if (data instanceof ArrayBuffer) {
                    fileChunks.push(data);
                    saveIfComplete();
                }
            },

            onClose: () => setStatus(statusEl, 'Соединение закрыто.'),
            onError: (e) => setStatus(statusEl, 'Ошибка соединения: ' + e?.message)
        });
    });

    socket.on('signal', (data) => {
        if (peer) peer.handleSignal(data);
    });

    socket.on('room-size', ({ size }) => {
        if (size < 2) setStatus(statusEl, 'Ждём отправителя…');
    });

    socket.on('peer-left', () => {
        setStatus(statusEl, 'Отправитель отключился. Соединение разорвано.');

        // закрываем peer и сбрасываем
        resetPeer();

        // Можно очистить прогрессбар/загрузки, чтобы не путать юзера
        recvBar.value = 0;
        recvText.textContent = '';
    });

    function resetPeer() {
        if (peer) {
            try { peer.destroy(); } catch { }
            peer = null;
        }
    }

    disconnectBtn.onclick = () => {
        resetPeer();
        socket.emit('leave-room', { code });
        setStatus(statusEl, 'Соединение завершено пользователем.');
        disconnectBtn.style.display = 'none';
        recvBar.value = 0;
        recvText.textContent = '';
    };

})();
