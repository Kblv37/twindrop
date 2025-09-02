// server.js
const path = require('path');
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');

const app = express();

// Разрешаем CORS для фронтенда (Netlify)
app.use(cors({
    origin: ['https://twindrop.netlify.app'], // можно массивом
    methods: ['GET', 'POST'],
    allowedHeaders: ['Content-Type'], // важно!
    credentials: true
}));

// Статика (для локального фронтенда, если нужно)
app.use(express.static(path.join(__dirname, 'public')));

const server = http.createServer(app);

const io = new Server(server, {
    cors: {
        origin: ['https://twindrop.netlify.app'],
        methods: ['GET', 'POST'],
        allowedHeaders: ['Content-Type'],
        credentials: true
    }
});

// Память для комнат: code -> Set(socketId)
const rooms = new Map();

// Генерация 6-значного кода комнаты
function genCode() {
    return Math.floor(Math.random() * 1000000).toString().padStart(6, '0');
}

// REST API: получение нового кода комнаты
app.get('/api/new-room', (req, res) => {
    let code;
    do {
        code = genCode();
    } while (rooms.has(code));
    rooms.set(code, new Set());
    res.json({ code });
});

// REST API: проверка существования комнаты
app.get('/api/check-room/:code', (req, res) => {
    const { code } = req.params;
    res.json({ exists: rooms.has(code) });
});

// Socket.IO события
io.on('connection', (socket) => {
    socket.on('join-room', ({ code }) => {
        if (!code) return;

        if (!rooms.has(code)) rooms.set(code, new Set());
        const set = rooms.get(code);

        // если этот сокет уже в комнате — игнорируем
        if (set.has(socket.id)) {
            socket.emit('already-joined');
            return;
        }

        // ограничение до 2 участников
        if (set.size >= 2) {
            socket.emit('room-full');
            return;
        }

        set.add(socket.id);
        socket.join(code);
        socket.data.code = code;

        // уведомляем второго участника
        socket.to(code).emit('peer-joined');

        // отправляем размер комнаты всем участникам
        io.to(code).emit('room-size', { size: set.size });
    });

    socket.on('signal', ({ code, data }) => {
        if (!code) return;
        socket.to(code).emit('signal', data);
    });

    // Relay: пересылаем чанк файла другому участнику
    socket.on('relay-chunk', (payload) => {
        const { code } = payload;
        if (!code) return;
        socket.to(code).emit('relay-chunk', payload);
    });

    // Relay: пересылаем метаданные (например имя файла, размер и т.д.)
    socket.on('relay-meta', (payload) => {
        const { code } = payload;
        if (!code) return;
        socket.to(code).emit('relay-meta', payload);
    });

    // Relay: пинг/понг (чтобы проверять связь)
    socket.on('relay-ping', ({ code }) => {
        if (!code) return;
        socket.to(code).emit('relay-pong', { from: socket.id });
    });

    socket.on('disconnect', () => {
        const code = socket.data.code;
        if (!code) return;
        const set = rooms.get(code);
        if (!set) return;
        set.delete(socket.id);

        // уведомляем оставшегося участника
        socket.to(code).emit('peer-left');

        if (set.size === 0) rooms.delete(code);
        else io.to(code).emit('room-size', { size: set.size });
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Signaling server running on port ${PORT}`));
