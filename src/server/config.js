const path = require('path');

const DEFAULT_ALLOWED_CHUNK_SIZES = [
  16 * 1024,
  64 * 1024,
  128 * 1024,
  256 * 1024,
  512 * 1024,
];

const DEFAULT_ICE_SERVERS = [
  { urls: ['stun:stun.l.google.com:19302'] },
  { urls: ['stun:stun1.l.google.com:19302'] },
];

const DEFAULT_DEV_ORIGINS = [
  'http://localhost:3000',
  'http://127.0.0.1:3000',
  'http://localhost:5173',
  'http://127.0.0.1:5173',
  'http://localhost:8888',
  'http://127.0.0.1:8888',
];

function parseInteger(value, fallback, { min, max } = {}) {
  const parsed = Number.parseInt(value, 10);

  if (!Number.isFinite(parsed)) {
    return fallback;
  }

  if (Number.isFinite(min) && parsed < min) {
    return fallback;
  }

  if (Number.isFinite(max) && parsed > max) {
    return fallback;
  }

  return parsed;
}

function normalizeOrigin(origin) {
  if (typeof origin !== 'string') {
    return '';
  }

  return origin.trim().replace(/\/+$/, '');
}

function parseOrigins(value) {
  if (!value) {
    return [];
  }

  return value
    .split(',')
    .map((origin) => normalizeOrigin(origin))
    .filter(Boolean)
    .filter((origin, index, values) => values.indexOf(origin) === index);
}

function sanitizeIceServer(server) {
  if (!server || typeof server !== 'object' || Array.isArray(server)) {
    return null;
  }

  const rawUrls = Array.isArray(server.urls) ? server.urls : [server.urls];
  const urls = rawUrls
    .filter((url) => typeof url === 'string')
    .map((url) => url.trim())
    .filter((url) => url.length > 0 && url.length <= 512);

  if (urls.length === 0) {
    return null;
  }

  const result = { urls };

  if (typeof server.username === 'string' && server.username.trim()) {
    result.username = server.username.trim().slice(0, 256);
  }

  if (typeof server.credential === 'string' && server.credential.trim()) {
    result.credential = server.credential.trim().slice(0, 256);
  }

  return result;
}

function parseIceServers(value) {
  if (!value) {
    return DEFAULT_ICE_SERVERS;
  }

  try {
    const parsed = JSON.parse(value);

    if (!Array.isArray(parsed)) {
      return DEFAULT_ICE_SERVERS;
    }

    const sanitized = parsed
      .map((server) => sanitizeIceServer(server))
      .filter(Boolean);

    return sanitized.length > 0 ? sanitized : DEFAULT_ICE_SERVERS;
  } catch {
    return DEFAULT_ICE_SERVERS;
  }
}

function parseChunkSizes(value) {
  if (!value) {
    return DEFAULT_ALLOWED_CHUNK_SIZES;
  }

  const sizes = value
    .split(',')
    .map((entry) => parseInteger(entry, NaN, { min: 8 * 1024, max: 2 * 1024 * 1024 }))
    .filter((size) => Number.isFinite(size))
    .sort((left, right) => left - right);

  return sizes.length > 0
    ? sizes.filter((size, index, values) => values.indexOf(size) === index)
    : DEFAULT_ALLOWED_CHUNK_SIZES;
}

function loadConfig() {
  const isProduction = process.env.NODE_ENV === 'production';
  const frontendOrigins = parseOrigins(process.env.TWINDROP_FRONTEND_ORIGINS);
  const frontendUrl = normalizeOrigin(process.env.TWINDROP_FRONTEND_URL);
  const allowedOrigins = [
    ...frontendOrigins,
    ...(frontendUrl ? [frontendUrl] : []),
    ...(!isProduction ? DEFAULT_DEV_ORIGINS : []),
  ].filter((origin, index, values) => values.indexOf(origin) === index);

  const config = {
    env: process.env.NODE_ENV || 'development',
    isProduction,
    host: process.env.HOST || '0.0.0.0',
    port: parseInteger(process.env.PORT, 3000, { min: 1, max: 65535 }),
    publicDir: path.resolve(__dirname, '../../public'),
    logLevel: process.env.TWINDROP_LOG_LEVEL || (isProduction ? 'info' : 'debug'),
    roomCodeLength: parseInteger(process.env.TWINDROP_ROOM_CODE_LENGTH, 6, { min: 4, max: 10 }),
    roomCapacity: parseInteger(process.env.TWINDROP_ROOM_CAPACITY, 2, { min: 2, max: 2 }),
    roomTtlMs: parseInteger(process.env.TWINDROP_ROOM_TTL_MS, 60 * 60 * 1000, { min: 60_000 }),
    emptyRoomTtlMs: parseInteger(process.env.TWINDROP_EMPTY_ROOM_TTL_MS, 15 * 60 * 1000, { min: 10_000 }),
    cleanupIntervalMs: parseInteger(process.env.TWINDROP_CLEANUP_INTERVAL_MS, 60 * 1000, { min: 5_000 }),
    maxHttpPayloadBytes: parseInteger(process.env.TWINDROP_MAX_HTTP_PAYLOAD_BYTES, 16 * 1024, { min: 1024 }),
    maxSocketPayloadBytes: parseInteger(process.env.TWINDROP_MAX_SOCKET_PAYLOAD_BYTES, 24 * 1024, { min: 1024 }),
    maxSignalPayloadBytes: parseInteger(process.env.TWINDROP_MAX_SIGNAL_PAYLOAD_BYTES, 12 * 1024, { min: 1024 }),
    maxFileSizeBytes: parseInteger(process.env.TWINDROP_MAX_FILE_SIZE_BYTES, 2 * 1024 * 1024 * 1024, { min: 1024 }),
    maxFilesPerTransfer: parseInteger(process.env.TWINDROP_MAX_FILES_PER_TRANSFER, 10, { min: 1, max: 25 }),
    requestWindowMs: parseInteger(process.env.TWINDROP_REQUEST_WINDOW_MS, 60 * 1000, { min: 1_000 }),
    roomCreateLimit: parseInteger(process.env.TWINDROP_ROOM_CREATE_LIMIT, 30, { min: 1 }),
    roomCheckLimit: parseInteger(process.env.TWINDROP_ROOM_CHECK_LIMIT, 120, { min: 1 }),
    socketJoinLimit: parseInteger(process.env.TWINDROP_SOCKET_JOIN_LIMIT, 20, { min: 1 }),
    socketSignalLimit: parseInteger(process.env.TWINDROP_SOCKET_SIGNAL_LIMIT, 240, { min: 1 }),
    socketPath: process.env.TWINDROP_SOCKET_PATH || '/socket.io',
    reconnectAttempts: parseInteger(process.env.TWINDROP_RECONNECT_ATTEMPTS, 4, { min: 0, max: 10 }),
    chunkSizeOptions: parseChunkSizes(process.env.TWINDROP_ALLOWED_CHUNK_SIZES),
    iceServers: parseIceServers(process.env.TWINDROP_ICE_SERVERS),
    frontendUrl,
    allowedOrigins,
  };

  config.isOriginAllowed = (origin) => {
    if (!origin) {
      return true;
    }

    const normalizedOrigin = normalizeOrigin(origin);
    return config.allowedOrigins.includes(normalizedOrigin);
  };

  return config;
}

module.exports = {
  DEFAULT_ICE_SERVERS,
  DEFAULT_ALLOWED_CHUNK_SIZES,
  loadConfig,
  normalizeOrigin,
  parseIceServers,
};
