// receive.js — фронт для получателя
const SOCKET_URL = 'https://twindrop.onrender.com';
const socket = io(SOCKET_URL);

(async function () {
    const TAG = '[recv]';
    function rlog(...args) { console.log(TAG, ...args); }

    const codeEl = $('#code');
    const copyBtn = $('#copyCode');
    const statusEl = $('#status');
    const recvBar = $('#recvBar');
    const recvText = $('#recvText');
    const downloads = $('#downloads');
    const qrContainer = $('#qr');

    // Получаем код комнаты от сервера
    const r = await fetch(`${SOCKET_URL}/api/new-room`);
    const { code } = await r.json();
    codeEl.textContent = code;

    const url = `https://twindrop.netlify.app/send.html?room=${code}`;
    qrContainer.innerHTML = "";
    new QRCode(qrContainer, { text: url, width: 200, height: 200 });

    copyBtn.onclick = async () => {
        await navigator.clipboard.writeText(code);
        copyBtn.textContent = 'Скопировано!';
        setTimeout(() => copyBtn.textContent = 'Скопировать', 1200);
    };

    socket.emit('join-room', { code });

    let fileChunks = [];
    let expectedSize = 0;
    let fileName = 'file';
    let receivedBytes = 0;

    function saveIfComplete() {
        const total = fileChunks.reduce((s, b) => s + b.byteLength, 0);
        setBar(recvBar, expectedSize ? total / expectedSize : 0);
        recvText.textContent = expectedSize
            ? `${(total / 1024 / 1024).toFixed(2)} / ${(expectedSize / 1024 / 1024).toFixed(2)} MB`
            : `${(total / 1024 / 1024).toFixed(2)} MB`;

        if (expectedSize && total >= expectedSize) {
            rlog('all chunks received, building blob', fileName, total);
            const blob = new Blob(fileChunks);
            const a = document.createElement('a');
            a.href = URL.createObjectURL(blob);
            a.download = fileName;
            a.textContent = `Скачать: ${fileName} (${(expectedSize / 1024 / 1024).toFixed(2)} MB)`;
            a.className = 'btn';
            downloads.appendChild(a);
            setStatus(statusEl, 'Передача завершена.');

            // дополнительный финальный ACK (подтверждение того, что собрали)
            try {
                peer && peer.channel() && peer.channel().send(JSON.stringify({ __meta: 'ack', name: fileName, receivedBytes: total, complete: true }));
                rlog('sent final ACK', fileName, total);
            } catch (e) { rlog('error sending final ACK', e); }

            fileChunks = [];
            expectedSize = 0;
            receivedBytes = 0;
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
                rlog('datachannel open');
                setStatus(statusEl, 'P2P соединение установлено. Ожидаем файл…');
            },
            onData: (data) => {
                rlog('onData', typeof data, data && (data.byteLength || data.length || 'str'));
                if (typeof data === 'string') {
                    try {
                        const meta = JSON.parse(data);
                        if (meta.__meta === 'file') {
                            fileName = meta.name || 'file';
                            expectedSize = meta.size || 0;
                            fileChunks = [];
                            receivedBytes = 0;
                            rlog('incoming file meta', fileName, expectedSize);
                            recvText.textContent = `Получение: ${fileName}`;
                            setBar(recvBar, 0);
                            return;
                        }
                        if (meta.__meta === 'file-complete') {
                            rlog('sender signalled file-complete', meta);
                            // как запасной механизм — запустить saveIfComplete (если всё пришло)
                            saveIfComplete();
                            return;
                        }
                        // прочие контролы
                        rlog('ctrl msg', meta);
                    } catch (e) {
                        rlog('string parse error', e);
                    }
                    return;
                }

                if (data instanceof ArrayBuffer) {
                    fileChunks.push(data);
                    receivedBytes += data.byteLength;

                    if (receivedBytes > 0 || (typeof meta !== 'undefined' && meta && meta.__meta === 'file-complete')) {
                        peer && peer.channel() && peer.channel().send(JSON.stringify({
                            __meta: 'ack',
                            name: fileName,
                            receivedBytes,
                            chunks: fileChunks.length,
                            ts: Date.now(),
                            complete: (expectedSize && receivedBytes >= expectedSize) ? true : undefined
                        }));
                    }

                    rlog(`received chunk: ${data.byteLength} bytes — total ${receivedBytes}/${expectedSize}`);
                    saveIfComplete();

                    // отправляем ACK по чанку/прогрессу
                    try {
                        peer && peer.channel() && peer.channel().send(JSON.stringify({
                            __meta: 'ack',
                            name: fileName,
                            receivedBytes,
                            chunks: fileChunks.length,
                            ts: Date.now()
                        }));
                        rlog('sent ACK', fileName, receivedBytes, fileChunks.length);
                    } catch (e) {
                        rlog('ack send error', e);
                    }
                }
            },
            onClose: () => {
                rlog('peer closed');
                setStatus(statusEl, 'Соединение закрыто.');
            },
            onError: (e) => {
                rlog('peer error', e);
                setStatus(statusEl, 'Ошибка соединения: ' + e?.message);
            }
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
        try { setBar(recvBar, 0); } catch { }
        recvText.textContent = '';
    });

    function resetPeer() {
        if (peer) {
            try { peer.destroy(); } catch { }
            peer = null;
        }
    }

})();
