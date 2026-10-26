const { Server } = require('socket.io');

const { SlidingWindowRateLimiter } = require('./rate-limiter');
const { validateJoinPayload, validateSignalEnvelope } = require('./validation');

function getClientAddress(socket) {
  const forwardedFor = socket.handshake.headers['x-forwarded-for'];

  if (typeof forwardedFor === 'string' && forwardedFor.trim()) {
    const hops = forwardedFor
      .split(',')
      .map((value) => value.trim())
      .filter(Boolean);

    // The left-most value is client-controlled. Use the address appended by
    // the nearest trusted proxy so rate limits cannot be bypassed with a
    // forged X-Forwarded-For header.
    if (hops.length > 0) {
      return hops[hops.length - 1];
    }
  }

  return socket.handshake.address || 'unknown';
}

function createRoomStatePayload({ roomStore, config, code }) {
  return {
    code,
    size: roomStore.getSize(code),
    capacity: config.roomCapacity,
    peerIds: roomStore.getPeerIds(code),
  };
}

function createRoomSnapshot({ roomStore, config, code, selfId }) {
  return {
    ...createRoomStatePayload({ roomStore, config, code }),
    selfId,
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

    const participantId = socket.data.participantId;
    const result = roomStore.removeMember(code, participantId, socket.id);

    socket.leave(code);
    socket.data.roomCode = null;
    socket.data.participantId = null;

    if (!result.removed) {
      if (result.stale) {
        logger.debug('ignored disconnect from replaced socket', { socketId: socket.id, code });
      }
      return;
    }

    socket.to(code).emit('peer-left', { peerId: socket.id, reason });

    if (!result.deleted) {
      io.to(code).emit('room-state', createRoomStatePayload({ roomStore, config, code }));
    }

    logger.info('socket left room', { socketId: socket.id, code, reason });
  }

  io.on('connection', (socket) => {
    const clientAddress = getClientAddress(socket);
    socket.data.roomCode = null;
    socket.data.participantId = null;

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

      const { code, participantId: requestedParticipantId } = validation.value;
      // Older clients do not send a participant ID. Falling back to the socket
      // ID keeps them compatible, but such clients cannot survive reconnects
      // without occupying a new room slot.
      const participantId = requestedParticipantId || socket.id;

      if (socket.data.roomCode && (
        socket.data.roomCode !== code
        || socket.data.participantId !== participantId
      )) {
        leaveCurrentRoom(socket, 'switch-room');
      }

      const joinResult = roomStore.addMember(code, participantId, socket.id);

      if (!joinResult.ok) {
        ack({ ok: false, error: joinResult.reason });
        return;
      }

      if (joinResult.replacedSocketId && joinResult.replacedSocketId !== socket.id) {
        const staleSocket = io.sockets.sockets.get(joinResult.replacedSocketId);

        if (staleSocket) {
          staleSocket.leave(code);

          if (staleSocket.data.roomCode === code) {
            staleSocket.data.roomCode = null;
          }

          if (staleSocket.data.participantId === participantId) {
            staleSocket.data.participantId = null;
          }
        }
      }

      socket.join(code);
      socket.data.roomCode = code;
      socket.data.participantId = participantId;

      const snapshot = createRoomSnapshot({ roomStore, config, code, selfId: socket.id });
      ack({ ok: true, room: snapshot });

      if (joinResult.isNew || joinResult.replacedSocketId) {
        socket.to(code).emit('peer-joined', { peerId: socket.id });
        io.to(code).emit('room-state', createRoomStatePayload({ roomStore, config, code }));
      }

      logger.info('socket joined room', {
        socketId: socket.id,
        code,
        size: snapshot.size,
        replaced: Boolean(joinResult.replacedSocketId),
      });
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
