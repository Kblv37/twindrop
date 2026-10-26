import { formatBytes } from './utils.js';

export const DEVICE_ICONS = {
  desktop: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="4" width="18" height="13" rx="2"></rect><path d="M8 21h8"></path><path d="M12 17v4"></path></svg>',
  phone: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="6.5" y="2.5" width="11" height="19" rx="2.5"></rect><path d="M10 5h4"></path><path d="M11 18.5h2"></path></svg>',
  tablet: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="4.5" y="2.5" width="15" height="19" rx="2.5"></rect><path d="M10.5 18.5h3"></path></svg>',
  unknown: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="4" width="18" height="13" rx="2"></rect><path d="M8 21h8"></path><path d="M12 17v4"></path></svg>',
};

export const FILE_ICONS = {
  image: '<rect x="3" y="4" width="18" height="16" rx="2.5"></rect><circle cx="8.5" cy="9.5" r="1.5"></circle><path d="m21 15-5-5L5 20"></path>',
  video: '<rect x="3" y="5" width="18" height="14" rx="2.5"></rect><path d="m10 9 5 3-5 3z"></path>',
  audio: '<path d="M9 18V5l11-2v13"></path><circle cx="6" cy="18" r="3"></circle><circle cx="17" cy="16" r="3"></circle>',
  pdf: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path><polyline points="14 2 14 8 20 8"></polyline><path d="M8 13h8"></path><path d="M8 17h5"></path>',
  archive: '<path d="M4 8h16"></path><path d="M5 8v12h14V8"></path><path d="M4 4h16v4H4z"></path><path d="M10 12h4"></path><path d="M12 8v4"></path>',
  text: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path><polyline points="14 2 14 8 20 8"></polyline><path d="M8 13h8"></path><path d="M8 17h8"></path>',
  spreadsheet: '<rect x="3" y="4" width="18" height="16" rx="2"></rect><path d="M3 10h18"></path><path d="M3 15h18"></path><path d="M9 4v16"></path><path d="M15 4v16"></path>',
  presentation: '<path d="M3 4h18"></path><path d="M4 4v11h16V4"></path><path d="M12 15v5"></path><path d="m8 20 4-5 4 5"></path>',
  other: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path><polyline points="14 2 14 8 20 8"></polyline>',
};

const IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'avif', 'bmp', 'svg', 'heic', 'heif', 'tif', 'tiff']);
const VIDEO_EXTENSIONS = new Set(['mp4', 'm4v', 'mov', 'webm', 'mkv', 'avi', 'wmv', 'flv']);
const AUDIO_EXTENSIONS = new Set(['mp3', 'wav', 'ogg', 'oga', 'm4a', 'aac', 'flac', 'opus', 'wma']);
const ARCHIVE_EXTENSIONS = new Set(['zip', 'rar', '7z', 'tar', 'gz', 'tgz', 'bz2', 'xz']);
const TEXT_EXTENSIONS = new Set(['txt', 'md', 'json', 'xml', 'html', 'htm', 'css', 'js', 'ts', 'jsx', 'tsx', 'log', 'rtf']);
const DOCUMENT_EXTENSIONS = new Set(['doc', 'docx', 'odt', 'pages', 'pdf']);
const SPREADSHEET_EXTENSIONS = new Set(['xls', 'xlsx', 'ods', 'numbers', 'csv']);
const PRESENTATION_EXTENSIONS = new Set(['ppt', 'pptx', 'odp', 'key']);

function getExtension(fileName) {
  const name = String(fileName || '').trim();
  const dot = name.lastIndexOf('.');
  if (dot < 0 || dot === name.length - 1) {
    return '';
  }
  return name.slice(dot + 1).toLowerCase().slice(0, 8);
}

export function detectDevice() {
  const ua = navigator.userAgent || '';
  const platform = navigator.userAgentData?.platform || navigator.platform || '';
  const maxTouchPoints = Number(navigator.maxTouchPoints) || 0;
  let type = 'desktop';

  if (navigator.userAgentData?.mobile) {
    type = 'phone';
  } else if (/iPad|Tablet|PlayBook|Silk/i.test(ua) || (/Mac/i.test(platform) && maxTouchPoints > 1)) {
    type = 'tablet';
  } else if (/Mobi|iPhone|iPod|Windows Phone/i.test(ua) || (/Android/i.test(ua) && /Mobile/i.test(ua))) {
    type = 'phone';
  } else if (/Android/i.test(ua)) {
    type = 'tablet';
  }

  let os = 'Неизвестная ОС';
  if (/Windows Phone/i.test(ua)) {
    os = 'Windows Phone';
  } else if (/Windows NT|Win32|Win64/i.test(ua) || /^Windows/i.test(platform)) {
    os = 'Windows';
  } else if (/Android/i.test(ua)) {
    os = 'Android';
  } else if (/iPhone|iPad|iPod/i.test(ua) || (/Mac/i.test(platform) && maxTouchPoints > 1)) {
    os = 'iOS / iPadOS';
  } else if (/Mac OS X|Macintosh/i.test(ua) || /^macOS/i.test(platform)) {
    os = 'macOS';
  } else if (/CrOS/i.test(ua)) {
    os = 'ChromeOS';
  } else if (/Linux|X11/i.test(ua) || /^Linux/i.test(platform)) {
    os = 'Linux';
  }

  let browser = 'Браузер';
  if (/Edg(?:e|A|iOS)?\//i.test(ua)) {
    browser = 'Edge';
  } else if (/OPR\/|Opera/i.test(ua)) {
    browser = 'Opera';
  } else if (/SamsungBrowser\//i.test(ua)) {
    browser = 'Samsung Internet';
  } else if (/YaBrowser\//i.test(ua)) {
    browser = 'Яндекс Браузер';
  } else if (/FxiOS\//i.test(ua)) {
    browser = 'Firefox';
  } else if (/Firefox\//i.test(ua)) {
    browser = 'Firefox';
  } else if (/CriOS\//i.test(ua)) {
    browser = 'Chrome';
  } else if (/Chrome\//i.test(ua) || /Chromium\//i.test(ua)) {
    browser = 'Chrome';
  } else if (/Safari\//i.test(ua)) {
    browser = 'Safari';
  }

  const typeLabels = {
    desktop: 'Компьютер',
    phone: 'Телефон',
    tablet: 'Планшет',
    unknown: 'Устройство',
  };

  return {
    type,
    typeLabel: typeLabels[type] || typeLabels.unknown,
    os,
    browser,
  };
}

export function getDeviceIconSvg(type = 'unknown') {
  return DEVICE_ICONS[type] || DEVICE_ICONS.unknown;
}

export function setDeviceIcon(element, type = 'unknown') {
  if (!element) {
    return;
  }
  element.innerHTML = getDeviceIconSvg(type);
}

export function getFileKind(fileName, mimeType = '') {
  const extension = getExtension(fileName);
  const mime = String(mimeType || '').toLowerCase();
  let kind = 'other';

  if (mime === 'application/pdf' || extension === 'pdf') {
    kind = 'pdf';
  } else if (mime.startsWith('image/') || IMAGE_EXTENSIONS.has(extension)) {
    kind = 'image';
  } else if (mime.startsWith('video/') || VIDEO_EXTENSIONS.has(extension)) {
    kind = 'video';
  } else if (mime.startsWith('audio/') || AUDIO_EXTENSIONS.has(extension)) {
    kind = 'audio';
  } else if (ARCHIVE_EXTENSIONS.has(extension) || /zip|compressed|archive/.test(mime)) {
    kind = 'archive';
  } else if (DOCUMENT_EXTENSIONS.has(extension) || /word|document|opendocument\.text/.test(mime)) {
    kind = extension === 'pdf' ? 'pdf' : 'text';
  } else if (SPREADSHEET_EXTENSIONS.has(extension) || /spreadsheet|excel|csv/.test(mime)) {
    kind = 'spreadsheet';
  } else if (PRESENTATION_EXTENSIONS.has(extension) || /presentation|powerpoint/.test(mime)) {
    kind = 'presentation';
  } else if (TEXT_EXTENSIONS.has(extension) || mime.startsWith('text/')) {
    kind = 'text';
  }

  const kindLabels = {
    image: 'Изображение',
    video: 'Видео',
    audio: 'Аудио',
    pdf: 'Документ',
    archive: 'Архив',
    text: 'Текстовый файл',
    spreadsheet: 'Таблица',
    presentation: 'Презентация',
    other: 'Файл',
  };

  const extensionLabel = extension ? extension.toUpperCase() : (mime.split('/')[1] || '').toUpperCase();
  return {
    kind,
    extension: extensionLabel,
    label: extensionLabel ? `${kindLabels[kind]} (${extensionLabel})` : kindLabels[kind],
  };
}

export function getFileIconSvg(fileName, mimeType = '') {
  const { kind } = getFileKind(fileName, mimeType);
  return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${FILE_ICONS[kind] || FILE_ICONS.other}</svg>`;
}

export function createFileIcon(fileName, mimeType = '') {
  const { kind } = getFileKind(fileName, mimeType);
  const icon = document.createElement('span');
  icon.className = `file-type-icon file-type-icon--${kind}`;
  icon.setAttribute('aria-hidden', 'true');
  icon.innerHTML = getFileIconSvg(fileName, mimeType);
  return icon;
}

export function formatSpeed(bytesPerSecond) {
  if (!Number.isFinite(bytesPerSecond) || bytesPerSecond <= 0) {
    return '—';
  }
  return `${formatBytes(bytesPerSecond)}/с`;
}

export function formatEta(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) {
    return '—';
  }

  const rounded = Math.ceil(seconds);
  if (rounded <= 1) {
    return 'меньше секунды';
  }
  if (rounded < 60) {
    return `${rounded} сек`;
  }
  if (rounded < 3600) {
    const minutes = Math.floor(rounded / 60);
    const remaining = rounded % 60;
    return remaining ? `${minutes} мин ${remaining} сек` : `${minutes} мин`;
  }

  const hours = Math.floor(rounded / 3600);
  const minutes = Math.floor((rounded % 3600) / 60);
  return minutes ? `${hours} ч ${minutes} мин` : `${hours} ч`;
}

export function formatHistoryTime(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) {
    return '';
  }

  const now = new Date();
  const sameDay = date.toDateString() === now.toDateString();
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  const isYesterday = date.toDateString() === yesterday.toDateString();
  const time = new Intl.DateTimeFormat('ru-RU', { hour: '2-digit', minute: '2-digit' }).format(date);

  if (sameDay) {
    return `Сегодня, ${time}`;
  }
  if (isYesterday) {
    return `Вчера, ${time}`;
  }

  const day = new Intl.DateTimeFormat('ru-RU', {
    day: 'numeric',
    month: 'short',
  }).format(date);
  return `${day}, ${time}`;
}

export async function copyText(text) {
  if (!text) {
    return false;
  }

  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // Fall back to a temporary textarea for non-secure contexts.
  }

  try {
    const textarea = document.createElement('textarea');
    textarea.value = String(text);
    textarea.setAttribute('readonly', '');
    textarea.style.position = 'fixed';
    textarea.style.top = '-9999px';
    textarea.style.opacity = '0';
    document.body.appendChild(textarea);
    textarea.select();
    const copied = document.execCommand('copy');
    textarea.remove();
    return copied;
  } catch {
    return false;
  }
}

function syncBodyDialogState() {
  const hasOpenDialog = Boolean(document.querySelector('dialog[open]'));
  document.body.classList.toggle('dialog-open', hasOpenDialog);
}

export function openDialog(dialog) {
  if (!dialog || dialog.open) {
    return;
  }

  if (typeof dialog.showModal === 'function') {
    dialog.showModal();
  } else {
    dialog.setAttribute('open', '');
  }
  syncBodyDialogState();
}

export function closeDialog(dialog) {
  if (!dialog) {
    return;
  }

  if (dialog.open && typeof dialog.close === 'function') {
    dialog.close();
  } else {
    dialog.removeAttribute('open');
  }
  syncBodyDialogState();
}

export function setupDialogDismiss(dialog, { canDismiss = () => true, onDismiss = null } = {}) {
  if (!dialog) {
    return;
  }

  const requestDismiss = () => {
    if (!canDismiss()) {
      return;
    }
    if (typeof onDismiss === 'function') {
      onDismiss();
    } else {
      closeDialog(dialog);
    }
  };

  dialog.addEventListener('cancel', (event) => {
    event.preventDefault();
    requestDismiss();
  });

  dialog.addEventListener('click', (event) => {
    if (event.target !== dialog) {
      return;
    }
    event.preventDefault();
    requestDismiss();
  });

  dialog.querySelectorAll('[data-dialog-close]').forEach((button) => {
    button.addEventListener('click', requestDismiss);
  });

  dialog.addEventListener('close', syncBodyDialogState);
}
