const http = require('http');

const { createApp } = require('./app');
const { loadConfig } = require('./config');
const { createLogger } = require('./logger');
const { RoomStore } = require('./room-store');
const { createSocketServer } = require('./socket-server');

async function startServer() {
  const config = loadConfig();
  const logger = createLogger(config.logLevel);
  const roomStore = new RoomStore({
    capacity: config.roomCapacity,
    roomTtlMs: config.roomTtlMs,
    emptyRoomTtlMs: config.emptyRoomTtlMs,
  });
  const app = createApp({ config, roomStore, logger });
  const server = http.createServer(app);
  const io = createSocketServer(server, { config, roomStore, logger });

  const cleanupInterval = setInterval(() => {
    const deletedCount = roomStore.cleanupStaleRooms();

    if (deletedCount > 0) {
      logger.info('cleaned up stale rooms', { deletedCount });
    }
  }, config.cleanupIntervalMs);

  cleanupInterval.unref();

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(config.port, config.host, resolve);
  });

  logger.info('signaling server listening', {
    env: config.env,
    host: config.host,
    port: config.port,
  });

  const shutdown = (signal) => {
    logger.info('shutting down server', { signal });
    clearInterval(cleanupInterval);
    io.close();
    server.close(() => process.exit(0));
  };

  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);

  return { app, server, io, roomStore, config };
}

module.exports = { startServer };
