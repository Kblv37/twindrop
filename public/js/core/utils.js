export function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

export function normalizeRoomCode(value, length = 6) {
  return String(value || '').replace(/\D/g, '').slice(0, length);
}

export function sanitizeText(value, maxLength = 160) {
  return String(value || '')
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .trim()
    .slice(0, maxLength);
}

export function sanitizeFileName(value) {
  const sanitized = sanitizeText(value, 180)
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_')
    .replace(/\.+$/g, '')
    .trim();

  return sanitized || 'file';
}

export function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) {
    return '0 B';
  }

  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const exponent = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const value = bytes / (1024 ** exponent);
  return `${value.toFixed(value >= 100 || exponent === 0 ? 0 : 2)} ${units[exponent]}`;
}

export function parseQuery() {
  return Object.fromEntries(new URL(window.location.href).searchParams.entries());
}

export function yieldToBrowser() {
  return new Promise((resolve) => {
    window.requestAnimationFrame(() => resolve());
  });
}

export function createTransferId() {
  return window.crypto?.randomUUID?.() || `transfer-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

export function buildSendUrl(frontendUrl, roomCode) {
  const url = new URL('/send.html', frontendUrl);
  url.searchParams.set('room', roomCode);
  return url.toString();
}
