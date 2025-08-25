// server.js
const path = require('path');
const express = require('express');
const http = require('http');
const { v4: uuidv4 } = require('uuid');
const cors = require('cors');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);

// --- Middleware ---
app.use(cors({
    origin: [
        'https://twindrop.netlify.app',
        'http://localhost:5173', // для тестов
        'http://localhost:3000'
    ],
    methods: ['GET', 'POST']
}));
app.use(express.json());

// --- favicon, чтобы убрать 404 ---
app.get('/favicon.ico', (req, res) => {
    res.status(204).end();
});

// --- статика ---
app.use(express.static(path.join(__dirname, 'public')));

// --- socket.io ---
const io = new Server(server, {
    cors: {
        origin: [
            'https://twindrop.netlify.app',
            'http://localhost:5173',
            'http://localhost:3000'
        ],
        methods: ['GET', 'POST']
    }
});

// --- In-memory хранилище сессий (для REST) ---
const sessions = new Map(); // uuid -> { offer, answer }

// --- API (как fallback) ---
app.get('/api/new-room', (req, res) => {
    const id = uuidv4();
    sessions.set(id, {});
    res.json({ id });
});

app.post('/api/:id/offer', (req, res) => {
    const { id } = req.params;
    const { offer } = req.body;
    if (!sessions.has(id)) return res.status(404).json({ error: 'Room not found' });

    sessions.get(id).offer = offer;
    res.json({ ok: true });
});

app.get('/api/:id/offer', (req, res) => {
    const { id } = req.params;
    const session = sessions.get(id);
    if (!session || !session.offer) return res.status(404).json({ error: 'Offer not found' });

    res.json({ offer: session.offer });
});

app.post('/api/:id/answer', (req, res) => {
    const { id } = req.params;
    const { answer } = req.body;
    if (!sessions.has(id)) return res.status(404).json({ error: 'Room not found' });

    sessions.get(id).answer = answer;
    res.json({ ok: true });
});

app.get('/api/:id/answer', (req, res) => {
    const { id } = req.params;
    const session = sessions.get(id);
    if (!session || !session.answer) return res.status(404).json({ error: 'Answer not found' });

    res.json({ answer: session.answer });
});

// --- socket.io signaling + data transfer ---
io.on('connection', (socket) => {
    console.log('🔌 client connected:', socket.id);

    // Вход в комнату
    socket.on('join-room', (roomId) => {
        socket.join(roomId);
        console.log(`👤 ${socket.id} joined room ${roomId}`);
        socket.to(roomId).emit('peer-joined', socket.id);
    });

    // Передача сигналинга (offer/answer/candidate)
    socket.on('signal', ({ roomId, data }) => {
        socket.to(roomId).emit('signal', { from: socket.id, data });
    });

    // Чанки файла
    socket.on('file-chunk', ({ roomId, chunk }) => {
        // chunk — это ArrayBuffer или Uint8Array
        socket.to(roomId).emit('file-chunk', { from: socket.id, chunk });
    });

    // Когда файл закончен
    socket.on('file-end', ({ roomId, fileName }) => {
        socket.to(roomId).emit('file-end', { from: socket.id, fileName });
    });

    socket.on('disconnect', () => {
        console.log('❌ client disconnected:', socket.id);
    });
});

// --- Запуск ---
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`🚀 Signaling server running on port ${PORT}`));
