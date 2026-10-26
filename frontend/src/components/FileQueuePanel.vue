<script setup>
import { computed } from 'vue';
import FileDropzone from './FileDropzone.vue';
import FileQueue from './FileQueue.vue';
import {
  queue,
  queueHasFiles,
  queueSummary,
  requestClearQueue,
} from '../stores/fileQueue.js';
import { transfer } from '../stores/transfer.js';
import { formatBytes } from '../services/utils.js';

const props = defineProps({
  eyebrow: {
    type: String,
    default: 'Файлы',
  },
  title: {
    type: String,
    default: 'Очередь передачи',
  },
  description: {
    type: String,
    default: 'Файлы остаются в этом браузере и сохраняются между перезагрузками. Добавляйте их в любом порядке.',
  },
  showPrepare: {
    type: Boolean,
    default: true,
  },
  showDropzone: {
    type: Boolean,
    default: true,
  },
  showChunkSize: {
    type: Boolean,
    default: false,
  },
  hint: {
    type: String,
    default: '',
  },
  sendLabel: {
    type: String,
    default: 'Отправить',
  },
  sendDisabled: {
    type: Boolean,
    default: true,
  },
  showSend: {
    type: Boolean,
    default: false,
  },
});

const emit = defineEmits(['prepare', 'send']);
const headingId = 'file-queue-panel-title';
const locked = computed(() => transfer.isSending);

async function clearQueue() {
  if (locked.value) {
    return;
  }

  await requestClearQueue();
}
</script>

<template>
  <section class="room-panel home-files-panel" :aria-labelledby="headingId">
    <div class="panel-heading home-files-heading">
      <div>
        <p class="room-eyebrow">{{ eyebrow }}</p>
        <h2 :id="headingId" class="panel-title">{{ title }}</h2>
      </div>
      <div class="home-files-heading-meta">
        <span v-if="queueHasFiles" class="queue-summary-pill">{{ queueSummary }}</span>
        <label v-if="showChunkSize" class="field-group transfer-chunk">
          <span class="small muted">Размер чанка</span>
          <select v-model.number="transfer.chunkSize" class="input" :disabled="locked">
            <option
              v-for="size in transfer.chunkSizeOptions"
              :key="size"
              :value="size"
            >
              {{ formatBytes(size) }}
            </option>
          </select>
        </label>
      </div>
    </div>
    <p class="home-files-description">{{ description }}</p>

    <FileDropzone v-if="showDropzone" :disabled="locked" />
    <FileQueue :disabled="locked" />

    <div v-if="queueHasFiles" class="send-action-row home-files-actions">
      <p class="send-hint">
        {{ hint || 'Можно отправить файлы по отдельности или подготовить один ZIP-архив.' }}
      </p>
      <div class="home-files-buttons">
        <button
          class="btn btn-secondary"
          type="button"
          :disabled="locked"
          @click="clearQueue"
        >
          Очистить
        </button>
        <button
          v-if="showPrepare"
          class="btn btn-secondary"
          type="button"
          :disabled="locked"
          @click="emit('prepare')"
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <rect x="3" y="4" width="18" height="16" rx="2.5"></rect>
            <path d="M12 4v6"></path>
            <path d="M10 7h4"></path>
            <path d="M10 10h4"></path>
            <path d="M10 13h4"></path>
            <path d="M12 16v4"></path>
          </svg>
          ZIP / подготовка
        </button>
        <slot name="actions"></slot>
        <button
          v-if="showSend"
          class="btn btn-send"
          type="button"
          :disabled="sendDisabled"
          @click="emit('send')"
        >
          <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <line x1="22" y1="2" x2="11" y2="13"></line>
            <polygon points="22 2 15 22 11 13 2 9 22 2"></polygon>
          </svg>
          {{ sendLabel }}
        </button>
      </div>
    </div>
    <p v-else-if="queue.loaded" class="small muted home-files-empty">
      Очередь пуста. Выберите файлы выше — комната и передача не начнутся автоматически.
    </p>
  </section>
</template>
