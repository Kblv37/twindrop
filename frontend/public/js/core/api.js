export async function fetchJson(url, options = {}) {
  const controller = new AbortController();
  const timeoutMs = options.timeoutMs ?? 8000;
  const timer = window.setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      method: options.method || 'GET',
      headers: {
        'Content-Type': 'application/json',
        ...(options.headers || {}),
      },
      body: options.body ? JSON.stringify(options.body) : undefined,
      signal: controller.signal,
      credentials: 'omit',
    });

    const payload = await response.json().catch(() => ({}));

    if (!response.ok) {
      throw new Error(payload.error || `request-failed-${response.status}`);
    }

    return payload;
  } finally {
    window.clearTimeout(timer);
  }
}

export async function emitWithAck(socket, eventName, payload, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    socket.timeout(timeoutMs).emit(eventName, payload, (error, response) => {
      if (error) {
        reject(new Error('request-timeout'));
        return;
      }

      if (!response?.ok) {
        reject(new Error(response?.error || 'request-failed'));
        return;
      }

      resolve(response);
    });
  });
}

export function createApiClient(config) {
  const baseUrl = `${config.signalingUrl}/api`;

  return {
    async createRoom() {
      const payload = await fetchJson(`${baseUrl}/rooms`, { method: 'POST' });
      return payload.code;
    },
    async getRoom(code) {
      return fetchJson(`${baseUrl}/rooms/${encodeURIComponent(code)}`);
    },
    async getClientConfig() {
      const payload = await fetchJson(`${baseUrl}/client-config`);
      return payload.config;
    },
  };
}

export function createSocket(config) {
  return window.io(config.signalingUrl, {
    path: config.socketPath,
    autoConnect: true,
    withCredentials: true,
    transports: ['websocket', 'polling'],
    reconnection: true,
    reconnectionAttempts: config.reconnectAttempts,
    reconnectionDelay: 1000,
    reconnectionDelayMax: 4000,
    timeout: 8000,
  });
}
