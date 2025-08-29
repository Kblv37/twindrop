// send.js — фронт для отправителя с проверкой комнаты в реальном времени
const SOCKET_URL = 'https://twindrop.onrender.com';
const API_URL = SOCKET_URL + '/api';
const socket = io(SOCKET_URL);

(function () {
    const codeInput = document.getElementById('codeInput');
    const joinBtn = document.getElementById('joinBtn');
    const sendUI = document.getElementById('sendUI');
    const fileInput = document.getElementById('file');
    const sendBtn = document.getElementById('sendBtn');
    const sendBar = document.getElementById('sendBar');
    const sendText = document.getElementById('sendText');
    const statusEl = document.getElementById('status');
    const dz = document.querySelector('.dropzone');

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
        } catch {
            setStatus(statusEl, 'Ошибка проверки комнаты.');
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
    codeInput.addEventListener('keydown', e => { if (e.key === 'Enter') join(); });

    // P2P события
    socket.on('room-size', ({ size }) => {
        if (size === 2 && !peer) {
            setStatus(statusEl, 'Получатель на месте. Устанавливаем P2P…');
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
    socket.on('peer-left', () => {
        setStatus(statusEl, 'Получатель отключился.');
        resetPeer();
        socket.data.joined = false;
        joinBtn.disabled = false;
        joinBtn.textContent = 'Подключиться';
        sendUI.style.display = 'none';
    });

    // ==============================
    // Дропзона и многовыборный файл
    // ==============================
    const activate = (on) => dz.classList.toggle('drag-over', !!on);

    const setFiles = (files) => {
        if (!files || files.length === 0) return;
        const names = Array.from(files).map(f => f.name).join(', ');
        dz.querySelector('.dz-title').textContent = names;
        const totalSize = Array.from(files).reduce((acc, f) => acc + f.size, 0);
        dz.querySelector('.dz-sub').textContent = totalSize ? (Math.round(totalSize/1024/1024*100)/100)+' MB' : 'Размер неизвестен';
        sendBtn.disabled = false;
    };

    dz.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fileInput.click(); }});
    ['dragenter','dragover'].forEach(ev => dz.addEventListener(ev, e => { e.preventDefault(); activate(true); }));
    ['dragleave','drop'].forEach(ev => dz.addEventListener(ev, e => { e.preventDefault(); activate(false); }));
    dz.addEventListener('drop', e => {
        const files = e.dataTransfer.files;
        if (files.length) {
            fileInput.files = files;
            setFiles(files);
        }
    });
    fileInput.addEventListener('change', () => setFiles(fileInput.files));

    // ==============================
    // Отправка файлов
    // ==============================
    sendBtn.onclick = async () => {
        if (!peer || peer.channel().readyState !== 'open') {
            setStatus(statusEl, 'Канал ещё не готов.');
            return;
        }

        const files = fileInput.files;
        for (const file of files) {
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
            setStatus(statusEl, `Файл ${file.name} отправлен.`);
        }
        setStatus(statusEl, 'Все файлы отправлены.');
    };

    function waitForBufferLow(dc) {
        return new Promise(resolve => {
            const threshold = 1 * 1024 * 1024;
            if (dc.bufferedAmount < threshold) return resolve();
            const check = () => { if (dc.bufferedAmount < threshold) { dc.removeEventListener('bufferedamountlow', check); resolve(); }};
            try { dc.bufferedAmountLowThreshold = threshold; } catch {}
            dc.addEventListener('bufferedamountlow', check);
            setTimeout(check, 50);
        });
    }

    function resetPeer() { if (peer) { try { peer.destroy(); } catch {} peer = null; } }

})();
