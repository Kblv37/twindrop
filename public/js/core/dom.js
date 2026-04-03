import { clamp } from './utils.js';

export function $(selector) {
  return document.querySelector(selector);
}

export function showNotice(element, { type = 'info', message = '', link = null } = {}) {
  if (!element) {
    return;
  }

  element.textContent = '';
  element.dataset.type = type;
  element.style.display = message ? 'block' : 'none';

  if (!message) {
    return;
  }

  const textNode = document.createElement('span');
  textNode.textContent = message;
  element.appendChild(textNode);

  if (link && typeof link.href === 'string' && typeof link.text === 'string') {
    element.appendChild(document.createTextNode(' '));

    const anchor = document.createElement('a');
    anchor.href = link.href;
    anchor.target = '_blank';
    anchor.rel = 'noopener noreferrer';
    anchor.textContent = link.text;
    element.appendChild(anchor);
  }
}

export function setProgress(barElement, textElement, ratio, text) {
  if (barElement) {
    barElement.style.width = `${clamp(ratio || 0, 0, 1) * 100}%`;
  }

  if (textElement && typeof text === 'string') {
    textElement.textContent = text;
  }
}

export function setDisabled(element, disabled) {
  if (element) {
    element.disabled = Boolean(disabled);
  }
}

export function createDownloadCard({ fileName, sizeLabel, href }) {
  const wrapper = document.createElement('a');
  wrapper.className = 'download-card';
  wrapper.href = href;
  wrapper.download = fileName;

  const title = document.createElement('strong');
  title.textContent = fileName;

  const meta = document.createElement('span');
  meta.className = 'muted small';
  meta.textContent = sizeLabel;

  wrapper.append(title, meta);
  return wrapper;
}
