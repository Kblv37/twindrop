const assert = require('node:assert/strict');
const test = require('node:test');

const { loadConfig } = require('../src/server/config');

function withEnv(values, callback) {
  const previous = {};

  for (const [key, value] of Object.entries(values)) {
    previous[key] = process.env[key];

    if (typeof value === 'undefined') {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }

  try {
    return callback();
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (typeof value === 'undefined') {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}

test('production CORS allowlist accepts the custom domain and pages.dev only', () => {
  withEnv({
    NODE_ENV: 'production',
    TWINDROP_FRONTEND_URL: 'https://t.sendcore.uz',
    TWINDROP_FRONTEND_ORIGINS: 'https://t.sendcore.uz,https://twindrop.pages.dev',
    TWINDROP_SELF_PING_URL: '',
  }, () => {
    const config = loadConfig();

    assert.equal(config.isOriginAllowed('https://t.sendcore.uz'), true);
    assert.equal(config.isOriginAllowed('https://twindrop.pages.dev'), true);
    assert.equal(config.isOriginAllowed('https://evil.example'), false);
    assert.equal(config.allowedOrigins.includes('http://localhost:5173'), false);
    assert.equal(config.allowedOrigins.includes('*'), false);
  });
});

test('development keeps local origins available without production URLs', () => {
  withEnv({
    NODE_ENV: 'development',
    TWINDROP_FRONTEND_URL: undefined,
    TWINDROP_FRONTEND_ORIGINS: undefined,
    TWINDROP_SELF_PING_URL: '',
  }, () => {
    const config = loadConfig();

    assert.equal(config.isOriginAllowed('http://localhost:5173'), true);
    assert.equal(config.isOriginAllowed('http://127.0.0.1:8888'), true);
    assert.equal(config.isOriginAllowed('https://twindrop.pages.dev'), false);
  });
});
