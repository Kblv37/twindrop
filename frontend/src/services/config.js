import { createApiClient } from './api.js';

const LOCAL_HOSTNAMES = new Set(['localhost', '127.0.0.1', '[::1]', '::1', '0.0.0.0']);

const DEFAULT_CONFIG = {
  signalingUrl: '',
  frontendUrl: '',
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

function normalizeOrigin(value) {
  return typeof value === 'string' ? value.trim().replace(/\/+$/, '') : '';
}

function isLocalDevelopment() {
  return LOCAL_HOSTNAMES.has(window.location.hostname);
}

function isLocalOrigin(value) {
  try {
    return LOCAL_HOSTNAMES.has(new URL(value).hostname);
  } catch {
    return false;
  }
}

function validateOrigin(value, label) {
  let parsed;

  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`${label} должен быть абсолютным http(s) origin.`);
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`${label} должен использовать http или https.`);
  }

  if (parsed.origin !== value) {
    throw new Error(`${label} должен быть origin без пути, query или hash.`);
  }

  return parsed.origin;
}

export async function loadRuntimeConfig() {
  const bootConfig = window.__TWINDROP_CONFIG__ || {};
  const localDevelopment = isLocalDevelopment();
  const pageOrigin = normalizeOrigin(window.location.origin);
  const configuredSignalingUrl = normalizeOrigin(bootConfig.signalingUrl);
  const configuredFrontendUrl = normalizeOrigin(bootConfig.frontendUrl);
  // Local development must never inherit production signaling URLs from a
  // checked-in build artifact. An explicitly local URL is still respected.
  const signalingUrl = localDevelopment
    ? (isLocalOrigin(configuredSignalingUrl) ? configuredSignalingUrl : pageOrigin)
    : configuredSignalingUrl;
  const frontendUrl = localDevelopment
    ? (isLocalOrigin(configuredFrontendUrl) ? configuredFrontendUrl : pageOrigin)
    : configuredFrontendUrl;

  if (!signalingUrl) {
    throw new Error('signaling-URL не настроен: задайте TWINDROP_SIGNALING_URL при сборке.');
  }

  if (!frontendUrl) {
    throw new Error('frontend-URL не настроен: задайте TWINDROP_FRONTEND_URL при сборке.');
  }

  const validatedSignalingUrl = validateOrigin(signalingUrl, 'signaling-URL');
  const validatedFrontendUrl = validateOrigin(frontendUrl, 'frontend-URL');

  if (!localDevelopment && validatedSignalingUrl === pageOrigin) {
    throw new Error(
      'signaling-URL указывает на origin страницы. Задайте TWINDROP_SIGNALING_URL для production.',
    );
  }

  if (window.location.protocol === 'https:' && new URL(validatedSignalingUrl).protocol !== 'https:') {
    throw new Error('signaling-URL должен использовать https на https-странице.');
  }

  const mergedBootConfig = {
    ...DEFAULT_CONFIG,
    ...bootConfig,
    signalingUrl: validatedSignalingUrl,
    frontendUrl: validatedFrontendUrl,
  };

  try {
    const api = createApiClient(mergedBootConfig);
    const serverConfig = await api.getClientConfig();

    return {
      ...mergedBootConfig,
      ...serverConfig,
    };
  } catch (error) {
    console.warn('[config] Не удалось получить серверную конфигурацию:', error?.message || error);
    return mergedBootConfig;
  }
}
