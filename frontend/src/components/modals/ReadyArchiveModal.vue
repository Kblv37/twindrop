<script setup>
import { computed } from 'vue';
import BaseDialog from './BaseDialog.vue';
import {
  dismissReadyArchive,
  redoArchive,
  zip,
} from '../../stores/transfer.js';
import { fileCountLabel, formatBytes } from '../../services/utils.js';

const open = computed(() => zip.mode === 'ready');
const archiveName = computed(() => zip.archiveFile?.name || zip.archiveName || 'twindrop.zip');
const archiveSize = computed(() => formatBytes(zip.archiveFile?.size || 0));
const sourceCount = computed(() => zip.sourceCount || zip.prepFiles.length || 0);
const countLabel = computed(() => `В архив добавлено ${fileCountLabel(sourceCount.value)}.`);
</script>

<template>
  <BaseDialog
    :open="open"
    dialog-class="tw-dialog--ready"
    labelled-by="readyTitle"
    @close="dismissReadyArchive"
  >
    <header class="tw-dialog__head">
      <div class="tw-dialog__heading">
        <span class="tw-dialog-step" aria-hidden="true">3</span>
        <div>
          <h2 id="readyTitle" class="tw-dialog__title">Архив готов</h2>
          <p class="tw-dialog__subtitle">ZIP-архив успешно создан на вашем устройстве.</p>
        </div>
      </div>
      <button
        class="tw-dialog__close"
        type="button"
        aria-label="Закрыть окно готового архива"
        title="Закрыть"
        @click="dismissReadyArchive"
      >
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true">
          <line x1="18" y1="6" x2="6" y2="18"></line>
          <line x1="6" y1="6" x2="18" y2="18"></line>
        </svg>
      </button>
    </header>

    <div class="tw-dialog__body tw-dialog__body--ready">
      <span class="ready-success" aria-hidden="true">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round">
          <path d="m5 12 4 4L19 6"></path>
        </svg>
      </span>
      <h3 class="ready-name">{{ archiveName }}</h3>
      <p class="ready-size">{{ archiveSize }}</p>
      <p class="ready-count">{{ countLabel }}</p>
    </div>

    <footer class="tw-dialog__footer">
      <button class="btn btn-secondary tw-dialog-action" type="button" @click="redoArchive">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <path d="M20 11a8.1 8.1 0 0 0-15.5-2M4 4v5h5"></path>
          <path d="M4 13a8.1 8.1 0 0 0 15.5 2M20 20v-5h-5"></path>
        </svg>
        <span>Создать заново</span>
      </button>
      <button class="btn btn-primary tw-dialog-action" type="button" @click="dismissReadyArchive">
        <span>Продолжить к отправке</span>
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <path d="M5 12h14"></path>
          <path d="m13 6 6 6-6 6"></path>
        </svg>
      </button>
    </footer>
  </BaseDialog>
</template>
