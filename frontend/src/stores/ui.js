import { reactive } from 'vue';

let noticeSequence = 0;

export const ui = reactive({
  notices: [],
  confirm: {
    open: false,
    title: '',
    message: '',
    confirmLabel: 'Да, продолжить',
    cancelLabel: 'Отмена',
    tone: 'danger',
  },
  infoOpen: false,
});

let confirmResolver = null;

export function notify(message, type = 'info', options = {}) {
  const timeout = typeof options === 'number'
    ? options
    : (Number.isFinite(options?.timeout) ? options.timeout : 5200);
  const text = String(message || '').trim();

  if (!text) {
    return null;
  }

  const id = ++noticeSequence;
  ui.notices.push({ id, message: text, type });

  if (ui.notices.length > 4) {
    ui.notices.splice(0, ui.notices.length - 4);
  }

  if (timeout > 0) {
    window.setTimeout(() => dismissNotice(id), timeout);
  }

  return id;
}

export function dismissNotice(id) {
  const index = ui.notices.findIndex((notice) => notice.id === id);

  if (index >= 0) {
    ui.notices.splice(index, 1);
  }
}

export function askConfirmation({
  title,
  message,
  confirmLabel = 'Да, продолжить',
  cancelLabel = 'Отмена',
  tone = 'danger',
}) {
  if (confirmResolver) {
    confirmResolver(false);
    confirmResolver = null;
  }

  ui.confirm.open = true;
  ui.confirm.title = title;
  ui.confirm.message = message;
  ui.confirm.confirmLabel = confirmLabel;
  ui.confirm.cancelLabel = cancelLabel;
  ui.confirm.tone = tone;

  return new Promise((resolve) => {
    confirmResolver = resolve;
  });
}

export function resolveConfirmation(accepted) {
  const resolver = confirmResolver;
  confirmResolver = null;
  ui.confirm.open = false;

  if (resolver) {
    resolver(Boolean(accepted));
  }
}

export function openInfoDialog() {
  ui.infoOpen = true;
}

export function closeInfoDialog() {
  ui.infoOpen = false;
}
