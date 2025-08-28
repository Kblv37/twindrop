// server.js
const path = require('path');
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');

const app = express();

// Разрешаем CORS для фронтенда (Netlify)
app.use(cors({
    origin: 'https://twindrop.netlify.app', // замени на '*' для локальных тестов
    methods: ['GET', 'POST']
}));

// Раздача статики (если нужно для локалки)
app.use(express.static(path.join(__dirname, 'public')));

const server = http.createServer(app);

const io = new Server(server, {
    cors: {
        origin: 'https://twindrop.netlify.app', // фронтенд
        methods: ['GET', 'POST']
    }
});

// Хранилище: code -> Set(socketId)
const rooms = new Map();

// Генерация 6-значного кода
function genCode() {
    return Math.floor(Math.random() * 1000000).toString().padStart(6, '0');
}

// API: создать новую комнату
app.get('/api/new-room', (req, res) => {
    let code;
    do {
        code = genCode();
    } while (rooms.has(code));
    rooms.set(code, new Set());
    res.json({ code });
});

// API: проверить существование комнаты
app.get('/api/check-room/:code', (req, res) => {
    const { code } = req.params;
    res.json({ exists: rooms.has(code) });
});

// Socket.IO логика
io.on('connection', (socket) => {
    // Присоединение к комнате
    socket.on('join-room', ({ code }) => {
        if (!code) return;

        if (!rooms.has(code)) {
            rooms.set(code, new Set());
        }
        const set = rooms.get(code);

        // ограничение до 2 участников
        if (set.size >= 2) {
            socket.emit('room-full');
            return;
        }

        set.add(socket.id);
        socket.join(code);
        socket.data.code = code;

        // уведомляем второго
        socket.to(code).emit('peer-joined');

        // всем в комнате говорим, сколько участников
        io.to(code).emit('room-size', { size: set.size });
    });

    // передача WebRTC сигналов
    socket.on('signal', ({ code, data }) => {
        if (!code) return;
        socket.to(code).emit('signal', data);
    });

    // выход
    socket.on('disconnect', () => {
        const code = socket.data.code;
        if (!code) return;

        const set = rooms.get(code);
        if (!set) return;

        set.delete(socket.id);

        // уведомляем оставшегося
        socket.to(code).emit('peer-left');

        // чистим пустые комнаты
        if (set.size === 0) {
            rooms.delete(code);
        } else {
            io.to(code).emit('room-size', { size: set.size });
        }
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Signaling server running on port ${PORT}`));
