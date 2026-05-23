const { Server } = require('socket.io');

const { SlidingWindowRateLimiter } = require('./rate-limiter');
const { validateJoinPayload, validateSignalEnvelope } = require('./validation');

function getClientAddress(socket) {
  const forwardedFor = socket.handshake.headers['x-forwarded-for'];

  if (typeof forwardedFor === 'string' && forwardedFor.trim()) {
    return forwardedFor.split(',')[0].trim();
  }

  return socket.handshake.address || 'unknown';
}

function createRoomSnapshot({ roomStore, config, code, selfId }) {
  return {
    code,
    selfId,
    size: roomStore.getSize(code),
    capacity: config.roomCapacity,
    peerIds: roomStore.getPeerIds(code, selfId),
  };
}

function createSocketServer(httpServer, { config, roomStore, logger }) {
  const joinLimiter = new SlidingWindowRateLimiter({
    windowMs: config.requestWindowMs,
    max: config.socketJoinLimit,
  });
  const signalLimiter = new SlidingWindowRateLimiter({
    windowMs: config.requestWindowMs,
    max: config.socketSignalLimit,
  });

  const io = new Server(httpServer, {
    path: config.socketPath,
    serveClient: false,
    transports: ['websocket', 'polling'],
    maxHttpBufferSize: config.maxSocketPayloadBytes,
    allowRequest: (req, callback) => {
      callback(null, config.isOriginAllowed(req.headers.origin));
    },
    cors: {
      origin: (origin, callback) => callback(null, config.isOriginAllowed(origin)),
      credentials: true,
    },
  });

  function leaveCurrentRoom(socket, reason) {
    const code = socket.data.roomCode;

    if (!code) {
      return;
    }

    const result = roomStore.removeMember(code, socket.id);
    socket.leave(code);
    socket.data.roomCode = null;

    if (!result.removed) {
      return;
    }

    socket.to(code).emit('peer-left', { peerId: socket.id, reason });

    if (!result.deleted) {
      io.to(code).emit('room-state', {
        code,
        size: roomStore.getSize(code),
        capacity: config.roomCapacity,
        peerIds: roomStore.getPeerIds(code),
      });
    }

    logger.info('socket left room', { socketId: socket.id, code, reason });
  }

  io.on('connection', (socket) => {
    const clientAddress = getClientAddress(socket);
    socket.data.roomCode = null;

    logger.info('socket connected', { socketId: socket.id, ip: clientAddress });

    socket.on('join-room', (payload, ack = () => {}) => {
      const rateResult = joinLimiter.consume(`${clientAddress}:join-room`);

      if (!rateResult.allowed) {
        logger.warn('socket join rate limit exceeded', { ip: clientAddress, socketId: socket.id });
        ack({ ok: false, error: 'rate-limited' });
        return;
      }

      const validation = validateJoinPayload(payload, config.roomCodeLength);

      if (!validation.ok) {
        ack({ ok: false, error: validation.error });
        return;
      }

      const { code } = validation.value;

      if (socket.data.roomCode && socket.data.roomCode !== code) {
        leaveCurrentRoom(socket, 'switch-room');
      }

      const joinResult = roomStore.addMember(code, socket.id);

      if (!joinResult.ok) {
        ack({ ok: false, error: joinResult.reason });
        return;
      }

      socket.join(code);
      socket.data.roomCode = code;

      const snapshot = createRoomSnapshot({ roomStore, config, code, selfId: socket.id });
      ack({ ok: true, room: snapshot });

      socket.to(code).emit('peer-joined', { peerId: socket.id });
      io.to(code).emit('room-state', {
        code,
        size: roomStore.getSize(code),
        capacity: config.roomCapacity,
        peerIds: roomStore.getPeerIds(code),
      });

      logger.info('socket joined room', { socketId: socket.id, code, size: snapshot.size });
    });

    socket.on('leave-room', (payload, ack = () => {}) => {
      leaveCurrentRoom(socket, 'client-leave');
      ack({ ok: true });
    });

    socket.on('signal', (payload, ack = () => {}) => {
      const rateResult = signalLimiter.consume(`${clientAddress}:signal`);

      if (!rateResult.allowed) {
        logger.warn('socket signal rate limit exceeded', { ip: clientAddress, socketId: socket.id });
        ack({ ok: false, error: 'rate-limited' });
        return;
      }

      const validation = validateSignalEnvelope(payload, {
        roomCodeLength: config.roomCodeLength,
        maxSignalPayloadBytes: config.maxSignalPayloadBytes,
      });

      if (!validation.ok) {
        ack({ ok: false, error: validation.error });
        return;
      }

      const { code, to, signal } = validation.value;

      if (socket.data.roomCode !== code || !roomStore.isMember(code, socket.id)) {
        ack({ ok: false, error: 'not-in-room' });
        return;
      }

      if (!roomStore.isMember(code, to)) {
        ack({ ok: false, error: 'peer-not-found' });
        return;
      }

      io.to(to).emit('signal', { from: socket.id, signal });
      ack({ ok: true });
    });

    socket.on('disconnect', (reason) => {
      leaveCurrentRoom(socket, reason);
      logger.info('socket disconnected', { socketId: socket.id, ip: clientAddress, reason });
    });
  });

  return io;
}

module.exports = { createSocketServer };
