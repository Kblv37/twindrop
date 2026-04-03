const path = require('path');
const express = require('express');

const { SlidingWindowRateLimiter } = require('./rate-limiter');
const { normalizeRoomCode } = require('./validation');

function createCorsMiddleware(config) {
  return (req, res, next) => {
    const origin = req.headers.origin;

    if (origin) {
      if (!config.isOriginAllowed(origin)) {
        res.status(403).json({ ok: false, error: 'origin-not-allowed' });
        return;
      }

      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Vary', 'Origin');
      res.setHeader('Access-Control-Allow-Credentials', 'true');
      res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    }

    if (req.method === 'OPTIONS') {
      res.status(204).end();
      return;
    }

    next();
  };
}

function createRequestRateLimitMiddleware({ limiter, logger, name }) {
  return (req, res, next) => {
    const key = req.ip || req.socket.remoteAddress || 'unknown';
    const result = limiter.consume(key);

    if (result.allowed) {
      next();
      return;
    }

    logger.warn('http rate limit exceeded', { name, ip: key, path: req.path });
    res.setHeader('Retry-After', Math.ceil(result.retryAfterMs / 1000));
    res.status(429).json({ ok: false, error: 'rate-limited' });
  };
}

function setSecurityHeaders(req, res, next) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  next();
}

function buildPublicClientConfig(config) {
  return {
    roomCodeLength: config.roomCodeLength,
    reconnectAttempts: config.reconnectAttempts,
    socketPath: config.socketPath,
    maxFileSizeBytes: config.maxFileSizeBytes,
    maxFilesPerTransfer: config.maxFilesPerTransfer,
    chunkSizeOptions: config.chunkSizeOptions,
    iceServers: config.iceServers,
  };
}

function createRoomCode(roomStore, roomCodeLength) {
  let attempts = 0;

  while (attempts < 1000) {
    const code = Math.floor(Math.random() * (10 ** roomCodeLength))
      .toString()
      .padStart(roomCodeLength, '0');

    if (!roomStore.hasRoom(code)) {
      roomStore.createRoom(code);
      return code;
    }

    attempts += 1;
  }

  throw new Error('room-code-generation-failed');
}

function createApp({ config, roomStore, logger }) {
  const app = express();
  const createRoomLimiter = new SlidingWindowRateLimiter({
    windowMs: config.requestWindowMs,
    max: config.roomCreateLimit,
  });
  const roomCheckLimiter = new SlidingWindowRateLimiter({
    windowMs: config.requestWindowMs,
    max: config.roomCheckLimit,
  });

  app.disable('x-powered-by');
  app.set('trust proxy', true);

  app.use(setSecurityHeaders);
  app.use(createCorsMiddleware(config));
  app.use(express.json({ limit: config.maxHttpPayloadBytes }));
  app.use(express.urlencoded({ extended: false, limit: config.maxHttpPayloadBytes }));

  app.get('/api/health', (req, res) => {
    res.json({
      ok: true,
      env: config.env,
      uptimeSeconds: Math.round(process.uptime()),
      rooms: roomStore.rooms.size,
    });
  });

  app.get('/api/client-config', (req, res) => {
    res.json({ ok: true, config: buildPublicClientConfig(config) });
  });

  app.post(
    '/api/rooms',
    createRequestRateLimitMiddleware({ limiter: createRoomLimiter, logger, name: 'create-room' }),
    (req, res) => {
      try {
        const code = createRoomCode(roomStore, config.roomCodeLength);
        logger.info('room created', { code });
        res.status(201).json({ ok: true, code });
      } catch (error) {
        logger.error('failed to create room', { error: error.message });
        res.status(503).json({ ok: false, error: 'room-unavailable' });
      }
    },
  );

  app.get(
    '/api/new-room',
    createRequestRateLimitMiddleware({ limiter: createRoomLimiter, logger, name: 'create-room' }),
    (req, res) => {
      try {
        const code = createRoomCode(roomStore, config.roomCodeLength);
        logger.info('room created', { code });
        res.json({ ok: true, code });
      } catch (error) {
        logger.error('failed to create room', { error: error.message });
        res.status(503).json({ ok: false, error: 'room-unavailable' });
      }
    },
  );

  app.get(
    '/api/rooms/:code',
    createRequestRateLimitMiddleware({ limiter: roomCheckLimiter, logger, name: 'check-room' }),
    (req, res) => {
      const code = normalizeRoomCode(req.params.code, config.roomCodeLength);

      if (!code) {
        res.status(400).json({ ok: false, error: 'invalid-room-code' });
        return;
      }

      const room = roomStore.getRoom(code);
      res.json({
        ok: true,
        exists: Boolean(room),
        size: room ? room.members.size : 0,
        capacity: config.roomCapacity,
      });
    },
  );

  app.get(
    '/api/check-room/:code',
    createRequestRateLimitMiddleware({ limiter: roomCheckLimiter, logger, name: 'check-room' }),
    (req, res) => {
      const code = normalizeRoomCode(req.params.code, config.roomCodeLength);

      if (!code) {
        res.status(400).json({ ok: false, error: 'invalid-room-code' });
        return;
      }

      const room = roomStore.getRoom(code);
      res.json({
        ok: true,
        exists: Boolean(room),
        size: room ? room.members.size : 0,
        capacity: config.roomCapacity,
      });
    },
  );

  app.use(
    express.static(config.publicDir, {
      extensions: ['html'],
      setHeaders: (res, filePath) => {
        if (path.basename(filePath) === 'app-config.js') {
          res.setHeader('Cache-Control', 'no-store');
          return;
        }

        res.setHeader('Cache-Control', config.isProduction ? 'public, max-age=3600' : 'no-store');
      },
    }),
  );

  app.get('/send', (req, res) => res.sendFile(path.join(config.publicDir, 'send.html')));
  app.get('/about', (req, res) => res.sendFile(path.join(config.publicDir, 'about.html')));

  app.use((req, res) => {
    if (req.path.startsWith('/api/')) {
      res.status(404).json({ ok: false, error: 'not-found' });
      return;
    }

    res.status(404).sendFile(path.join(config.publicDir, 'index.html'));
  });

  return app;
}

module.exports = { createApp };
