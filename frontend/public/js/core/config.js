import { createApiClient } from './api.js';

const DEFAULT_CONFIG = {
  signalingUrl: window.location.origin.replace(/\/+$/, ''),
  frontendUrl: window.location.origin.replace(/\/+$/, ''),
  roomCodeLength: 6,
  reconnectAttempts: 4,
  socketPath: '/socket.io',
  maxFileSizeBytes: 2 * 1024 * 1024 * 1024,
  maxFilesPerTransfer: 10,
  chunkSizeOptions: [16 * 1024, 64 * 1024, 128 * 1024, 256 * 1024, 512 * 1024],
  iceServers: [
    { urls: ['stun:stun.l.google.com:19302'] },
    { urls: ['stun:stun1.l.google.com:19302'] },
  ],
};

function normalizeUrl(url, fallback) {
  return typeof url === 'string' && url.trim()
    ? url.trim().replace(/\/+$/, '')
    : fallback;
}

export async function loadRuntimeConfig() {
  const bootConfig = window.__TWINDROP_CONFIG__ || {};
  const mergedBootConfig = {
    ...DEFAULT_CONFIG,
    ...bootConfig,
    signalingUrl: normalizeUrl(bootConfig.signalingUrl, DEFAULT_CONFIG.signalingUrl),
    frontendUrl: normalizeUrl(bootConfig.frontendUrl, DEFAULT_CONFIG.frontendUrl),
  };

  try {
    const api = createApiClient(mergedBootConfig);
    const serverConfig = await api.getClientConfig();

    return {
      ...mergedBootConfig,
      ...serverConfig,
    };
  } catch {
    return mergedBootConfig;
  }
}
