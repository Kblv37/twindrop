// send.js — фронт для отправителя с проверкой комнаты в реальном времени
const SOCKET_URL = 'https://twindrop.onrender.com';
const API_URL = SOCKET_URL + '/api'; // REST API
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

    const disconnectBtn = $('#disconnectBtn');
    disconnectBtn.style.display = 'none'; // по умолчанию скрыта

    const q = parseQuery();
    if (q.room) {
        codeInput.value = q.room;
        // ждём пока input реально обновится и сразу проверяем комнату
        setTimeout(async () => {
            await checkRoom(); // сначала проверяем через API
            if (roomExists) join(); // если есть — сразу подключаемся
        }, 0);
    }

    let peer;
    let code;
    let roomExists = false; // хранение статуса

    // 🔎 Проверка комнаты в реальном времени
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
            console.error(err);
            joinBtn.disabled = true;
            roomExists = false;
        }
    }

    // Слушатель для ввода кода (реальное время)
    codeInput.addEventListener('input', checkRoom);

    function join() {
        // если уже есть peer или мы уже в комнате — выходим
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
        socket.data = { joined: true }; // ставим флаг
        joinBtn.disabled = true;        // блокируем кнопку
        joinBtn.textContent = 'Подключено';
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
                    disconnectBtn.style.display = 'inline-block'; // показываем кнопку
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

    socket.on('peer-left', () => {
        setStatus(statusEl, 'Получатель отключился. Соединение разорвано.');

        // закрываем peer и сбрасываем
        resetPeer();

        // даём возможность переподключиться
        socket.data.joined = false;
        joinBtn.disabled = false;
        joinBtn.textContent = 'Подключиться';
        sendUI.style.display = 'none'; // скрываем интерфейс отправки
    });

    // Управление файлом
    fileInput.addEventListener('change', () => {
        sendBtn.disabled = !(fileInput.files && fileInput.files.length);
    });

    sendBtn.onclick = async () => {
        if (!peer || !peer.channel() || peer.channel().readyState !== 'open') {
            setStatus(statusEl, 'Канал ещё не готов.');
            return;
        }

        const files = fileInput.files;
        if (!files || files.length === 0) return;

        for (const file of files) {
            // метаданные о файле
            peer.channel().send(JSON.stringify({ __meta: 'file', name: file.name, size: file.size }));

            const reader = file.stream().getReader();
            let sent = 0;

            setBar(sendBar, 0);
            sendText.textContent = `Отправка: ${file.name}`;

            while (true) {
                const { value, done } = await reader.read();
                if (done) break;
                await waitForBufferLow(peer.channel());

                const chunk = value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength);
                peer.channel().send(chunk);

                sent += value.byteLength;
                setBar(sendBar, sent / file.size);
                sendText.textContent = `${(sent / 1024 / 1024).toFixed(2)} / ${(file.size / 1024 / 1024).toFixed(2)} MB`;
            }

            // после всех чанков отправляем "файл закончен"
            peer.channel().send(JSON.stringify({ __meta: 'file-complete', name: file.name, size: file.size }));

            setStatus(statusEl, `Ожидание подтверждения доставки для: ${file.name}...`);

            // ждём ack или error с таймаутом
            await new Promise((resolve, reject) => {
                const dc = peer.channel();
                const handler = (event) => {
                    try {
                        const msg = JSON.parse(event.data);
                        if (msg.__meta === 'ack' && msg.name === file.name) {
                            clearTimeout(timer);
                            dc.removeEventListener('message', handler);
                            setStatus(statusEl, `Файл ${file.name} успешно доставлен ✅`);
                            resolve();
                        } else if (msg.__meta === 'error' && msg.name === file.name) {
                            clearTimeout(timer);
                            dc.removeEventListener('message', handler);
                            setStatus(statusEl, `Ошибка при передаче файла: ${msg.reason || 'неизвестная ошибка'}`);
                            reject(new Error(`Ошибка передачи: ${msg.reason}`));
                        }
                    } catch { /* не JSON */ }
                };

                const timer = setTimeout(() => {
                    dc.removeEventListener('message', handler);
                    setStatus(statusEl, `Подтверждение от получателя не получено (таймаут) ❌`);
                    reject(new Error("ACK timeout"));
                }, 20000); // 10 секунд

                dc.addEventListener('message', handler);
            });


        }

        setStatus(statusEl, 'Все файлы отправлены.');
    };

    function waitForBufferLow(dc) {
        return new Promise((resolve) => {
            const threshold = 256 * 1024; // вместо 1 МБ
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

    function resetPeer() {
        if (peer) {
            try { peer.destroy(); } catch { }
            peer = null;
        }
    }

    // 🔘 Кнопка отключения соединения
    disconnectBtn.onclick = () => {
        resetPeer();
        socket.emit('leave-room', { code });
        setStatus(statusEl, 'Соединение завершено пользователем.');

        disconnectBtn.style.display = 'none';
        sendUI.style.display = 'none';

        socket.data.joined = false;
        joinBtn.disabled = false;
        joinBtn.textContent = 'Подключиться';
    };

})();
