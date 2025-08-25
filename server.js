// server.js
const path = require('path');
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');

const app = express();

// Разрешаем CORS для фронтенда на Netlify
app.use(cors({
    origin: 'https://twindrop.netlify.app', // или '*' для всех
    methods: ['GET', 'POST']
}));

// Статика для публичных файлов
app.use(express.static(path.join(__dirname, 'public')));

const server = http.createServer(app);
const io = new Server(server, {
    cors: {
        origin: 'https://twindrop.netlify.app', // фронтенд
        methods: ['GET', 'POST']
    }
});

// Память для комнат: code -> Set(socketId)
const rooms = new Map();

// Генерация 6-значного кода
function genCode() {
    return Math.floor(Math.random() * 1000000).toString().padStart(6, '0');
}

// REST API: новый код комнаты
app.get('/api/new-room', (req, res) => {
    let code;
    do {
        code = genCode();
    } while (rooms.has(code));
    rooms.set(code, new Set());
    res.json({ code });
});

// Socket.IO
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

        // уведомляем другого участника
        socket.to(code).emit('peer-joined');

        // текущий размер комнаты
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
        socket.to(code).emit('peer-left');
        if (set.size === 0) rooms.delete(code);
        else io.to(code).emit('room-size', { size: set.size });
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Signaling server running on http://localhost:${PORT}`));
