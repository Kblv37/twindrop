// receive.js — фронт для получателя
const SOCKET_URL = 'https://twindrop.onrender.com';
const socket = io(SOCKET_URL);

(async function () {
    const statusEl = $('#status');
    const recvBar = $('#recvBar');
    const recvText = $('#recvText');
    const downloads = $('#downloads');

    // читаем id из URL (?id=123456)
    const params = new URLSearchParams(location.search);
    const code = params.get('id');
    if (!code) {
        setStatus(statusEl, 'Ошибка: нет ID комнаты.');
        return;
    }

    setStatus(statusEl, `Подключаемся к комнате ${code}…`);
    socket.emit('join-room', { code });

    let peer;
    let fileChunks = [];
    let expectedSize = 0;
    let fileName = 'file';

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
            onError: (e) => setStatus(statusEl, 'Ошибка: ' + e?.message)
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
