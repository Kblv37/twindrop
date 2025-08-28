// send.js — фронт для отправителя
const SOCKET_URL = 'https://twindrop.onrender.com';
const APP_URL = 'https://twindrop.onrender.com'; // твой домен/Render URL

const socket = io(SOCKET_URL);

(async function () {
    const sendUI = $('#sendUI');
    const fileInput = $('#file');
    const sendBtn = $('#sendBtn');
    const sendBar = $('#sendBar');
    const sendText = $('#sendText');
    const statusEl = $('#status');
    const qrContainer = $('#qrContainer');

    let peer;
    let code;

    // 1. создаём комнату на сервере
    const r = await fetch(`${SOCKET_URL}/api/new-room`);
    const { code: newCode } = await r.json();
    code = newCode;

    setStatus(statusEl, `Ваша комната: ${code}`);

    // 2. генерируем QR с правильной ссылкой
    const url = `${APP_URL}/receive.html?id=${code}`;
    qrContainer.innerHTML = '';
    new QRCode(qrContainer, {
        text: url,
        width: 220,
        height: 220,
        correctLevel: QRCode.CorrectLevel.H
    });

    // 3. присоединяемся к комнате
    socket.emit('join-room', { code });

    // события от сервера
    socket.on('room-size', ({ size }) => {
        if (size === 1) {
            setStatus(statusEl, 'Ожидание получателя…');
        } else if (size === 2 && !peer) {
            setStatus(statusEl, 'Получатель подключился. Устанавливаем P2P…');

            peer = createPeer({
                initiator: true,
                onSignal: (data) => socket.emit('signal', { code, data }),
                onConnect: () => {
                    setStatus(statusEl, 'P2P установлено. Выберите файл.');
                    sendBtn.disabled = !fileInput.files?.length;
                },
                onData: () => { },
                onClose: () => setStatus(statusEl, 'Соединение закрыто.'),
                onError: (e) => setStatus(statusEl, 'Ошибка: ' + e?.message)
            });

            sendUI.style.display = 'block';
        }
    });

    socket.on('signal', (data) => { if (peer) peer.handleSignal(data); });
    socket.on('room-full', () => setStatus(statusEl, 'Комната переполнена.'));

    // выбор файла
    fileInput.addEventListener('change', () => {
        sendBtn.disabled = !(fileInput.files && fileInput.files.length);
    });

    // отправка файла
    sendBtn.onclick = async () => {
        if (!peer || !peer.channel() || peer.channel().readyState !== 'open') {
            setStatus(statusEl, 'Канал ещё не готов.');
            return;
        }
        const file = fileInput.files[0];
        if (!file) return;

        peer.channel().send(JSON.stringify({ __meta: 'file', name: file.name, size: file.size }));

        const reader = file.stream().getReader();
        let sent = 0;

        setBar(sendBar, 0);
        sendText.textContent = `Отправка: ${file.name}`;

        while (true) {
            const { value, done } = await reader.read();
            if (done) break;
            await waitForBufferLow(peer.channel());
            peer.channel().send(value.buffer);
            sent += value.byteLength;
            setBar(sendBar, sent / file.size);
            sendText.textContent = `${(sent / 1024 / 1024).toFixed(2)} / ${(file.size / 1024 / 1024).toFixed(2)} MB`;
        }

        setStatus(statusEl, 'Файл отправлен.');
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
