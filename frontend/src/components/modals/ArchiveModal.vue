<script setup>
import { computed } from 'vue';
import BaseDialog from './BaseDialog.vue';
import {
  cancelArchive,
  handleArchiveDismiss,
  retryArchive,
  zip,
} from '../../stores/transfer.js';
import { formatBytes } from '../../services/utils.js';
import { formatEta } from '../../services/room-ui.js';

const open = computed(() => zip.mode === 'archive');
const percent = computed(() => Math.round(Math.min(1, Math.max(0, zip.archiveProgress.ratio || 0)) * 100));
const tone = computed(() => zip.archiveState.tone || 'working');
const stateTitle = computed(() => zip.archiveState.title || 'Подготовка к архивации');
const stateText = computed(() => zip.archiveState.text || '');
const subtitle = computed(() => {
  if (tone.value === 'error') {
    return 'Архивация остановлена.';
  }
  if (tone.value === 'success') {
    return 'ZIP-архив успешно создан на вашем устройстве.';
  }
  return 'ZIP-архив создаётся прямо в браузере. Пожалуйста, подождите…';
});
const cancelLabel = computed(() => {
  if (tone.value === 'success') {
    return 'Архив готов';
  }
  if (tone.value === 'error') {
    return 'Вернуться к файлам';
  }
  return zip.archiveInFlight ? 'Отменить архивацию' : 'Закрыть';
});
const cancelDisabled = computed(() => tone.value === 'success');
const filesLabel = computed(() => (
  `${zip.archiveProgress.preparedFiles || 0} из ${zip.archiveProgress.totalFiles || zip.sourceCount || 0}`
));
const etaLabel = computed(() => formatEta(zip.archiveProgress.etaSeconds));
</script>

<template>
  <BaseDialog
    :open="open"
    :can-close="!zip.archiveInFlight"
    dialog-class="tw-dialog--archive"
    labelled-by="archiveTitle"
    @close="handleArchiveDismiss"
  >
    <header class="tw-dialog__head">
      <div class="tw-dialog__heading">
        <span class="tw-dialog-step" aria-hidden="true">2</span>
        <div>
          <h2 id="archiveTitle" class="tw-dialog__title">Создание архива</h2>
          <p class="tw-dialog__subtitle">{{ subtitle }}</p>
        </div>
      </div>
      <button
        class="tw-dialog__close"
        type="button"
        :disabled="zip.archiveInFlight"
        aria-label="Закрыть создание архива"
        title="Закрыть"
        @click="handleArchiveDismiss"
      >
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true">
          <line x1="18" y1="6" x2="6" y2="18"></line>
          <line x1="6" y1="6" x2="18" y2="18"></line>
        </svg>
      </button>
    </header>

    <div class="tw-dialog__body">
      <div class="archive-hero" :data-state="tone">
        <span class="archive-hero-halo" aria-hidden="true"></span>
        <span class="archive-hero-icon" aria-hidden="true">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">
            <rect x="3" y="4" width="18" height="16" rx="2.5"></rect>
            <path d="M12 4v6"></path>
            <path d="M10 7h4"></path>
            <path d="M10 10h4"></path>
            <path d="M10 13h4"></path>
            <path d="M12 16v4"></path>
          </svg>
        </span>
        <h3 class="archive-state-title">{{ stateTitle }}</h3>
        <p class="archive-state-text">{{ stateText }}</p>
        <p class="archive-name">{{ zip.archiveName || 'twindrop.zip' }}</p>
      </div>

      <div class="archive-progress-block">
        <div class="archive-progress-row">
          <div
            class="progress archive-progress"
            role="progressbar"
            aria-label="Создание ZIP-архива"
            aria-valuemin="0"
            aria-valuemax="100"
            :aria-valuenow="percent"
          >
            <div class="bar" :style="{ width: `${percent}%` }"></div>
          </div>
          <span class="transfer-percent">{{ percent }}%</span>
        </div>

        <dl class="archive-stats">
          <div>
            <dt>Подготовлено файлов</dt>
            <dd>{{ filesLabel }}</dd>
          </div>
          <div>
            <dt>Текущий размер архива</dt>
            <dd>{{ formatBytes(zip.archiveProgress.currentSize) }}</dd>
          </div>
          <div>
            <dt>Примерное время</dt>
            <dd>{{ etaLabel }}</dd>
          </div>
        </dl>
      </div>

      <div v-if="tone === 'error'" class="archive-error" role="alert">
        {{ zip.archiveError || 'Неизвестная ошибка при создании архива.' }}
      </div>
    </div>

    <footer class="tw-dialog__footer">
      <button
        v-if="tone === 'error'"
        class="btn btn-secondary tw-dialog-action"
        type="button"
        @click="retryArchive"
      >
        <span>Повторить</span>
      </button>
      <button
        class="btn btn-secondary tw-dialog-action"
        type="button"
        :disabled="cancelDisabled"
        @click="cancelArchive"
      >
        <span>{{ cancelLabel }}</span>
      </button>
    </footer>
  </BaseDialog>
</template>
