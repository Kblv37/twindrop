const path = require('path');
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');


const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    cors: { origin: '*' }
});

// Память для комнат: code -> Set(socketId)
const rooms = new Map();


app.use(express.static(path.join(__dirname, 'public')));


function genCode() {
    // 6-значный код, ведущие нули допустимы
    return Math.floor(Math.random() * 1000000).toString().padStart(6, '0');
}


app.get('/api/new-room', (req, res) => {
    let code;
    do {
        code = genCode();
    } while (rooms.has(code));
    rooms.set(code, new Set());
    res.json({ code });
});


io.on('connection', (socket) => {
    socket.on('join-room', ({ code }) => {
        if (!code) return;


        if (!rooms.has(code)) {
            rooms.set(code, new Set());
        }


        // ограничим размер комнаты двумя участниками
        const set = rooms.get(code);
        if (set.size >= 2) {
            socket.emit('room-full');
            return;
        }


        set.add(socket.id);
        socket.join(code);
        socket.data.code = code;


        // уведомляем другого участника, что peer пришёл
        socket.to(code).emit('peer-joined');


        // возвращаем текущее количество
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
        if (set.size === 0) {
            rooms.delete(code);
        } else {
            io.to(code).emit('room-size', { size: set.size });
        }
    });
});


const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Signaling server running on http://localhost:${PORT}`));