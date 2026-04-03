const LEVELS = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

function sanitizeLogValue(value) {
  if (typeof value !== 'string') {
    return value;
  }

  return value.replace(/[\r\n\t]+/g, ' ').slice(0, 500);
}

function serializeMeta(meta) {
  if (!meta || typeof meta !== 'object') {
    return '';
  }

  const sanitized = Object.entries(meta).reduce((result, [key, value]) => {
    result[key] = sanitizeLogValue(value);
    return result;
  }, {});

  return ` ${JSON.stringify(sanitized)}`;
}

function createLogger(levelName = 'info') {
  const threshold = LEVELS[levelName] ?? LEVELS.info;

  function log(level, message, meta) {
    if ((LEVELS[level] ?? Number.MAX_SAFE_INTEGER) < threshold) {
      return;
    }

    const timestamp = new Date().toISOString();
    const line = `[${timestamp}] [${level}] ${sanitizeLogValue(message)}${serializeMeta(meta)}`;

    if (level === 'error') {
      console.error(line);
      return;
    }

    if (level === 'warn') {
      console.warn(line);
      return;
    }

    console.log(line);
  }

  return {
    debug: (message, meta) => log('debug', message, meta),
    info: (message, meta) => log('info', message, meta),
    warn: (message, meta) => log('warn', message, meta),
    error: (message, meta) => log('error', message, meta),
  };
}

module.exports = { createLogger };
