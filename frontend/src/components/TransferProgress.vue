<script setup>
import { computed } from 'vue';
import {
  currentPercent,
  currentRecord,
  downloadReceivedFile,
  requestCancelTransfer,
  transfer,
  transferProgressStats,
} from '../stores/transfer.js';
import { getFileIconSvg, getFileKind } from '../services/room-ui.js';
import { formatBytes } from '../services/utils.js';

const record = currentRecord;
const visible = computed(() => Boolean(record.value));
const isArchive = computed(() => (
  record.value?.mimeType === 'application/zip'
  || getFileKind(record.value?.name || '', record.value?.mimeType || '').kind === 'archive'
));
const directionLabel = computed(() => (record.value?.direction === 'received' ? 'Приём' : 'Отправка'));
const kindLabel = computed(() => `${directionLabel.value} ${isArchive.value ? 'архива' : 'файла'}`);
const icon = computed(() => getFileIconSvg(record.value?.name || '', record.value?.mimeType || ''));
const stats = computed(() => transferProgressStats(record.value));
const tone = computed(() => {
  if (!record.value) {
    return 'active';
  }
  if (record.value.status === 'completed') {
    return 'success';
  }
  if (record.value.status === 'error' || record.value.status === 'canceled') {
    return 'error';
  }
  return 'active';
});
const metaText = computed(() => {
  const value = record.value;

  if (!value) {
    return '';
  }

  if (value.status === 'awaiting') {
    return 'Файл передан. Ожидаем подтверждение получателя…';
  }
  if (value.status === 'receiving') {
    return `Принимаем данные… ${formatBytes(value.size)}`;
  }
  if (value.status === 'completed') {
    if (value.direction === 'received') {
      return value.storage === 'memory'
        ? 'Файл готов к скачиванию. Сохранён во временной памяти браузера.'
        : 'Файл готов к скачиванию. Целостность проверена.';
    }

    return 'Передача подтверждена получателем.';
  }
  if (value.status === 'canceled') {
    return value.errorMessage || 'Передача отменена.';
  }
  if (value.status === 'error') {
    return value.errorMessage || 'Передача завершилась с ошибкой.';
  }
  return `${formatBytes(value.size)} · ${getFileKind(value.name, value.mimeType).label}`;
});
const canCancel = computed(() => (
  record.value?.direction === 'sent'
  && record.value?.status === 'active'
  && transfer.isSending
));
const canDownload = computed(() => (
  record.value?.direction === 'received'
  && record.value?.status === 'completed'
  && Boolean(record.value?.opfsPath || record.value?.memoryBlob)
));
</script>

<template>
  <section
    v-if="visible"
    class="room-panel current-transfer"
    :data-state="tone"
    aria-labelledby="currentTransferTitle"
  >
    <div class="current-transfer-head">
      <div class="current-file-icon" aria-hidden="true" v-html="icon"></div>
      <div class="current-file-copy">
        <p class="room-eyebrow">{{ kindLabel }}</p>
        <h2 id="currentTransferTitle" class="current-file-name">{{ record.name }}</h2>
        <p class="current-file-meta">{{ metaText }}</p>
      </div>
      <div class="current-transfer-actions">
        <span class="transfer-percent">{{ currentPercent }}%</span>
        <button
          v-if="canDownload"
          class="history-icon-action"
          type="button"
          data-action="download"
          :disabled="record.downloading"
          :aria-label="`Скачать ${record.name}`"
          :aria-busy="record.downloading ? 'true' : 'false'"
          title="Скачать файл"
          @click="downloadReceivedFile(record)"
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path>
            <polyline points="7 10 12 15 17 10"></polyline>
            <line x1="12" y1="15" x2="12" y2="3"></line>
          </svg>
        </button>
        <button
          v-if="canCancel"
          class="current-cancel-btn"
          type="button"
          aria-label="Отменить передачу"
          title="Отменить передачу"
          @click="requestCancelTransfer(record)"
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true">
            <line x1="18" y1="6" x2="6" y2="18"></line>
            <line x1="6" y1="6" x2="18" y2="18"></line>
          </svg>
        </button>
      </div>
    </div>
    <div
      class="progress current-transfer-progress"
      role="progressbar"
      :aria-label="`Ход ${directionLabel.toLowerCase()} файла`"
      aria-valuemin="0"
      aria-valuemax="100"
      :aria-valuenow="currentPercent"
    >
      <div class="bar" :style="{ width: `${currentPercent}%` }"></div>
    </div>
    <div class="transfer-stats">
      <div class="transfer-stat">
        <span>Передано</span>
        <strong>{{ stats.transferred }}</strong>
      </div>
      <div class="transfer-stat">
        <span>Скорость передачи</span>
        <strong>{{ stats.speed }}</strong>
      </div>
      <div class="transfer-stat">
        <span>Примерное время</span>
        <strong>{{ stats.eta }}</strong>
      </div>
    </div>
  </section>
</template>
