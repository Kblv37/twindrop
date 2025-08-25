// server.js
const path = require('path');
const express = require('express');
const http = require('http');
const { v4: uuidv4 } = require('uuid'); // для генерации uuid
const cors = require('cors');

const app = express();

// Middleware
app.use(cors({
    origin: 'https://twindrop.netlify.app', // для теста можно '*'
    methods: ['GET', 'POST']
}));
app.use(express.json());

// Статика (локально — public/)
app.use(express.static(path.join(__dirname, 'public')));

const server = http.createServer(app);

// --- Хранилище сигналов (in-memory) ---
const sessions = new Map(); // uuid -> { offer, answer }

// Создать новую сессию и вернуть UUID
app.get('/api/new-session', (req, res) => {
    const id = uuidv4();
    sessions.set(id, {});
    res.json({ id });
});

// Отправитель кладёт offer
app.post('/api/:id/offer', (req, res) => {
    const { id } = req.params;
    const { offer } = req.body;
    if (!sessions.has(id)) return res.status(404).json({ error: 'Session not found' });

    sessions.get(id).offer = offer;
    res.json({ ok: true });
});

// Получатель забирает offer
app.get('/api/:id/offer', (req, res) => {
    const { id } = req.params;
    const session = sessions.get(id);
    if (!session || !session.offer) return res.status(404).json({ error: 'Offer not found' });

    res.json({ offer: session.offer });
});

// Получатель кладёт answer
app.post('/api/:id/answer', (req, res) => {
    const { id } = req.params;
    const { answer } = req.body;
    if (!sessions.has(id)) return res.status(404).json({ error: 'Session not found' });

    sessions.get(id).answer = answer;
    res.json({ ok: true });
});

// Отправитель забирает answer
app.get('/api/:id/answer', (req, res) => {
    const { id } = req.params;
    const session = sessions.get(id);
    if (!session || !session.answer) return res.status(404).json({ error: 'Answer not found' });

    res.json({ answer: session.answer });
});

// Запуск
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Signaling server running on port ${PORT}`));
