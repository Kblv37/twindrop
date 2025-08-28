// receive.js — получатель: создаёт комнату и показывает QR
const SOCKET_URL = 'https://twindrop.onrender.com';
const FRONT_URL  = location.origin;   // чтобы QR вёл на тот же домен, где открыта страница
const socket = io(SOCKET_URL);

(async function () {
    const codeEl     = $('#code');
    const copyBtn    = $('#copyCode');
    const statusEl   = $('#status');
    const recvBar    = $('#recvBar');
    const recvText   = $('#recvText');
    const downloads  = $('#downloads');
    const qrContainer= $('#qr');

    // 1) создаём комнату
    let code;
    try {
        const r = await fetch(`${SOCKET_URL}/api/new-room`);
        const data = await r.json();
        code = data.code;
    } catch (e) {
        setStatus(statusEl, 'Ошибка: не удалось получить код комнаты.');
        return;
    }
    codeEl.textContent = code;

    // 2) генерим QR, который ведёт отправителя на send.html с ?room=
    await ensureQRCodeLib();
    qrContainer.innerHTML = '';
    new QRCode(qrContainer, {
        text: `${FRONT_URL}/send.html?room=${code}`,
        width: 220,
        height: 220,
        correctLevel: QRCode.CorrectLevel.H
    });

    // копирование кода
    copyBtn.onclick = async () => {
        try {
            await navigator.clipboard.writeText(code);
            copyBtn.textContent = 'Скопировано!';
            setTimeout(() => copyBtn.textContent = 'Скопировать', 1200);
        } catch {}
    };

    // 3) входим в комнату и ждём отправителя
    socket.emit('join-room', { code });

    let fileChunks = [];
    let expectedSize = 0;
    let fileName = 'file';
    let peer;

    socket.on('peer-joined', () => {
        setStatus(statusEl, 'Отправитель подключился. Устанавливаем P2P…');

        peer = createPeer({
            initiator: false,
            onSignal: (data) => socket.emit('signal', { code, data }),
            onConnect: () => setStatus(statusEl, 'P2P установлено. Ожидаем файл…'),
            onData: (data) => {
                if (typeof data === 'string') {
                    try {
                        const meta = JSON.parse(data);
                        if (meta.__meta === 'file') {
                            fileName = meta.name || 'file';
                            expectedSize = meta.size || 0;
                            recvText.textContent = `Получение: ${fileName}`;
                            setBar(recvBar, 0);
                            fileChunks = [];
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
            onError: (e) => setStatus(statusEl, 'Ошибка соединения: ' + (e?.message || e))
        });
    });

    socket.on('signal', (data) => { if (peer) peer.handleSignal(data); });
    socket.on('room-size', ({ size }) => { if (size < 2) setStatus(statusEl, 'Ждём отправителя…'); });
    socket.on('peer-left', () => setStatus(statusEl, 'Отправитель отключился.'));

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
})();

// загружаем qrcodejs при необходимости
function ensureQRCodeLib() {
    return new Promise((resolve) => {
        if (window.QRCode) return resolve();
        const s = document.createElement('script');
        s.src = 'https://cdnjs.cloudflare.com/ajax/libs/qrcodejs/1.0.0/qrcode.min.js';
        s.onload = () => resolve();
        s.onerror = () => resolve(); // не валим логику
        document.head.appendChild(s);
    });
}
