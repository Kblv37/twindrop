// receive.js — фронт для получателя с подключением к Render
const SOCKET_URL = 'https://twindrop.onrender.com';
const socket = io(SOCKET_URL);

(async function () {
    const codeEl = $('#code');
    const copyBtn = $('#copyCode');
    const statusEl = $('#status');
    const recvBar = $('#recvBar');
    const recvText = $('#recvText');
    const downloads = $('#downloads');
    const qrContainer = $('#qr'); // элемент для QR-кода

    // 1) Запрашиваем новый код комнаты у сервера
    const r = await fetch(`${SOCKET_URL}/api/new-room`);
    const { code } = await r.json();
    codeEl.textContent = code;

    // 2) Рисуем QR, который ведёт на страницу отправителя с предзаполненным кодом
    const url = `${SOCKET_URL}/send.html?room=${code}`;
    new QRCode(qrContainer, { text: url, width: 200, height: 200 });

    // 3) Копирование кода
    copyBtn.onclick = async () => {
        await navigator.clipboard.writeText(code);
        copyBtn.textContent = 'Скопировано!';
        setTimeout(() => copyBtn.textContent = 'Скопировать', 1200);
    };

    // 4) Подключаемся к комнате через сокет
    socket.emit('join-room', { code });

    let fileChunks = [];
    let expectedSize = 0;
    let fileName = 'file';

    function saveIfComplete() {
        const total = fileChunks.reduce((s, b) => s + b.byteLength, 0);
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

        // получатель не инициатор
        peer = createPeer({
            initiator: false,
            onSignal: (data) => socket.emit('signal', { code, data }),
            onConnect: () => setStatus(statusEl, 'P2P соединение установлено. Ожидаем файл…'),
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
                    } catch {}
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

    socket.on('peer-left', () => setStatus(statusEl, 'Отправитель отключился.'));
})();
