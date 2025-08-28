// server.js
const path = require('path');
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');

const app = express();

// Разрешаем CORS для фронтенда (Netlify + локально)
app.use(cors({
    origin: [
        'https://twindrop.netlify.app',
        'http://localhost:3000'
    ],
    methods: ['GET', 'POST']
}));

// Статика (для локального фронтенда, если нужно)
app.use(express.static(path.join(__dirname, 'public')));

const server = http.createServer(app);

const io = new Server(server, {
    cors: {
        origin: [
            'https://twindrop.netlify.app',
            'http://localhost:3000'
        ],
        methods: ['GET', 'POST']
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

// REST API: проверить комнату
app.get('/api/check-room/:code', (req, res) => {
    const code = req.params.code;
    if (!rooms.has(code)) {
        return res.json({ exists: false, size: 0 });
    }
    res.json({ exists: true, size: rooms.get(code).size });
});

// Socket.IO события
io.on('connection', (socket) => {
    socket.on('join-room', ({ code }) => {
        if (!code) return;

        if (!rooms.has(code)) rooms.set(code, new Set());
        const set = rooms.get(code);

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

    socket.on('disconnect', () => {
        const code = socket.data.code;
        if (!code) return;
        const set = rooms.get(code);
        if (!set) return;
        set.delete(socket.id);

        // уведомляем оставшегося участника
        socket.to(code).emit('peer-left');

        if (set.size === 0) {
            rooms.delete(code);
        } else {
            io.to(code).emit('room-size', { size: set.size });
        }
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Signaling server running on port ${PORT}`));
