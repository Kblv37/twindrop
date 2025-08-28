// send.js — отправитель: вводит код (или приходит с ?room=) и шлёт файл
const SOCKET_URL = 'https://twindrop.onrender.com';
const socket = io(SOCKET_URL);

(function () {
    const codeInput = $('#codeInput');
    const joinBtn   = $('#joinBtn');
    const sendUI    = $('#sendUI');
    const fileInput = $('#file');
    const sendBtn   = $('#sendBtn');
    const sendBar   = $('#sendBar');
    const sendText  = $('#sendText');
    const statusEl  = $('#status');

    // если пришли по ссылке из QR — код уже в URL
    const q = new URLSearchParams(location.search);
    const prefill = (q.get('room') || '').replace(/\D/g, '').padStart(6, '0');
    if (prefill.length === 6) {
        codeInput.value = prefill;
        join();
    }

    let peer;
    let code;

    joinBtn.onclick = join;
    codeInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') join(); });

    function join() {
        code = (codeInput.value || '').replace(/\D/g, '').padStart(6, '0');
        if (code.length !== 6) {
            setStatus(statusEl, 'Введите корректный 6-значный код.');
            return;
        }
        setStatus(statusEl, `Подключаемся к комнате ${code}…`);
        socket.emit('join-room', { code });
    }

    // события от сервера
    socket.on('room-size', ({ size }) => {
        if (!code) return;
        if (size === 1) {
            setStatus(statusEl, 'Ожидание получателя… (проверьте код)');
        } else if (size === 2 && !peer) {
            setStatus(statusEl, 'Получатель на месте. Устанавливаем P2P…');

            peer = createPeer({
                initiator: true,
                onSignal: (data) => socket.emit('signal', { code, data }),
                onConnect: () => {
                    setStatus(statusEl, 'P2P установлено. Можно отправлять файл.');
                    sendBtn.disabled = !fileInput.files?.length;
                    sendUI.style.display = 'block';
                },
                onData: () => {},
                onClose: () => setStatus(statusEl, 'Соединение закрыто.'),
                onError: (e) => setStatus(statusEl, 'Ошибка соединения: ' + (e?.message || e))
            });
        }
    });

    socket.on('signal', (data) => { if (peer) peer.handleSignal(data); });
    socket.on('room-full', () => setStatus(statusEl, 'Комната уже занята двумя участниками.'));

    // управление файлом
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

        // метаданные
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
            const threshold = 1 * 1024 * 1024; // 1MB водяной знак буфера
            if (dc.bufferedAmount < threshold) return resolve();
            const check = () => {
                if (dc.bufferedAmount < threshold) {
                    dc.removeEventListener('bufferedamountlow', check);
                    resolve();
                }
            };
            try { dc.bufferedAmountLowThreshold = threshold; } catch {}
            dc.addEventListener('bufferedamountlow', check);
            setTimeout(check, 50);
        });
    }
})();
