<script setup>
import { computed, ref } from 'vue';
import BaseDialog from './BaseDialog.vue';
import {
  addPreparedFiles,
  closePreparation,
  continuePreparation,
  removePreparedFile,
  updateZipEnabled,
  zip,
} from '../../stores/transfer.js';
import { formatBytes, fileCountLabel } from '../../services/utils.js';
import { getFileIconSvg, getFileKind } from '../../services/room-ui.js';

const fileInputRef = ref(null);
const open = computed(() => zip.mode === 'prepare');
const totalBytes = computed(() => (
  zip.prepFiles.reduce((sum, file) => sum + (Number(file.size) || 0), 0)
));
const summary = computed(() => (
  `Выбрано ${fileCountLabel(zip.prepFiles.length)} · ${formatBytes(totalBytes.value)}`
));
const continueDisabled = computed(() => zip.prepFiles.length === 0 || zip.archiveInFlight);
const zipNote = computed(() => {
  const count = zip.prepFiles.length;

  if (count === 0) {
    return 'Выберите файлы, чтобы настроить отправку.';
  }

  if (zip.zipEnabled) {
    if (count > 1) {
      return `ZIP включён автоматически, так как выбрано ${fileCountLabel(count)} (${formatBytes(totalBytes.value)}). Архив создаётся прямо в браузере.`;
    }
    return 'Файл будет упакован в ZIP-архив перед отправкой. Архивация выполняется прямо в браузере.';
  }

  return count > 1
    ? 'Файлы будут отправлены по отдельности. Получатель увидит их как несколько входящих файлов.'
    : 'Файл будет отправлен напрямую, без создания архива.';
});

function close() {
  closePreparation();
}

function triggerAddFiles() {
  fileInputRef.value?.click();
}

function handleFiles(event) {
  const files = Array.from(event.target.files || []);

  if (files.length > 0) {
    addPreparedFiles(files);
  }

  if (event.target) {
    event.target.value = '';
  }
}

function handleZipToggle(event) {
  updateZipEnabled(event.target.checked);
}

function handleContinue() {
  if (continueDisabled.value) {
    return;
  }

  continuePreparation();
}
</script>

<template>
  <BaseDialog
    :open="open"
    dialog-class="tw-dialog--prepare"
    labelled-by="prepareTitle"
    @close="close"
  >
    <header class="tw-dialog__head">
      <div class="tw-dialog__heading">
        <span class="tw-dialog-step" aria-hidden="true">1</span>
        <div>
          <h2 id="prepareTitle" class="tw-dialog__title">Подготовка файлов</h2>
          <p class="tw-dialog__subtitle">{{ summary }}</p>
        </div>
      </div>
      <button
        class="tw-dialog__close"
        type="button"
        aria-label="Закрыть подготовку файлов"
        title="Закрыть"
        @click="close"
      >
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true">
          <line x1="18" y1="6" x2="6" y2="18"></line>
          <line x1="6" y1="6" x2="18" y2="18"></line>
        </svg>
      </button>
    </header>

    <div class="tw-dialog__body">
      <div class="prep-file-list" role="list" aria-label="Выбранные файлы">
        <div v-if="zip.prepFiles.length === 0" class="prep-empty">
          <strong>Файлы не выбраны</strong>
          <span>Добавьте файлы, чтобы продолжить.</span>
        </div>
        <template v-else>
          <div
            v-for="(file, index) in zip.prepFiles"
            :key="`${file.name}-${file.size}-${index}`"
            class="prep-file-row"
            role="listitem"
          >
            <span
              class="file-type-icon"
              aria-hidden="true"
              v-html="getFileIconSvg(file.name, file.type)"
            ></span>
            <div class="prep-file-copy">
              <strong class="prep-file-name" :title="file.name">{{ file.name }}</strong>
              <span class="prep-file-meta">
                {{ formatBytes(file.size) }} · {{ getFileKind(file.name, file.type).label }}
              </span>
            </div>
            <button
              class="prep-file-remove"
              type="button"
              :aria-label="`Удалить ${file.name} из подготовки`"
              title="Удалить файл"
              @click="removePreparedFile(index)"
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true">
                <line x1="18" y1="6" x2="6" y2="18"></line>
                <line x1="6" y1="6" x2="18" y2="18"></line>
              </svg>
            </button>
          </div>
        </template>
      </div>

      <p v-if="zip.prepareFeedback" class="prep-feedback" role="alert">{{ zip.prepareFeedback }}</p>

      <div class="zip-option">
        <div class="zip-option-copy">
          <span class="zip-option-icon" aria-hidden="true">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
              <rect x="3" y="4" width="18" height="16" rx="2.5"></rect>
              <path d="M12 4v6"></path>
              <path d="M10 7h4"></path>
              <path d="M10 10h4"></path>
              <path d="M10 13h4"></path>
              <path d="M12 16v4"></path>
            </svg>
          </span>
          <div>
            <strong>Объединить в ZIP-архив</strong>
            <span>Один архив вместо нескольких файлов</span>
          </div>
        </div>
        <label class="switch" aria-label="Объединить файлы в ZIP-архив">
          <input
            type="checkbox"
            :checked="zip.zipEnabled"
            @change="handleZipToggle"
          >
          <span class="switch-track" aria-hidden="true"><span class="switch-knob"></span></span>
        </label>
      </div>

      <div class="zip-info">
        <span class="zip-info-icon" aria-hidden="true">i</span>
        <p>{{ zipNote }}</p>
      </div>

      <input
        ref="fileInputRef"
        type="file"
        multiple
        hidden
        @change="handleFiles"
      >
    </div>

    <footer class="tw-dialog__footer">
      <button class="btn btn-secondary tw-dialog-action" type="button" @click="triggerAddFiles">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <path d="M12 5v14"></path>
          <path d="M5 12h14"></path>
        </svg>
        <span>Добавить файлы</span>
      </button>
      <button
        class="btn btn-primary tw-dialog-action"
        type="button"
        :disabled="continueDisabled"
        @click="handleContinue"
      >
        <span>Продолжить</span>
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <path d="M5 12h14"></path>
          <path d="m13 6 6 6-6 6"></path>
        </svg>
      </button>
    </footer>
  </BaseDialog>
</template>
