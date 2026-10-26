<script setup>
import { queue, removeItem } from '../stores/fileQueue.js';
import { formatBytes } from '../services/utils.js';
import { getFileIconSvg, getFileKind } from '../services/room-ui.js';

defineProps({
  disabled: {
    type: Boolean,
    default: false,
  },
});
</script>

<template>
  <div v-if="queue.loading" class="file-list queue-loading" role="status">
    <span class="spinner" aria-hidden="true"></span>
    <span>Восстанавливаем очередь файлов…</span>
  </div>
  <div v-else-if="queue.items.length > 0" class="file-list" aria-live="polite">
    <div
      v-for="item in queue.items"
      :key="item.id"
      class="file-list-item"
    >
      <span
        class="file-type-icon"
        :class="`file-type-icon--${getFileKind(item.file.name, item.file.type).kind}`"
        aria-hidden="true"
        v-html="getFileIconSvg(item.file.name, item.file.type)"
      ></span>
      <span class="file-list-name" :title="item.file.name">{{ item.file.name }}</span>
      <span class="file-list-size">
        {{ formatBytes(item.file.size) }} · {{ getFileKind(item.file.name, item.file.type).extension || 'FILE' }}
      </span>
      <button
        class="file-list-remove"
        type="button"
        :disabled="disabled"
        :aria-label="`Удалить ${item.file.name}`"
        title="Удалить файл"
        @click="removeItem(item.id)"
      >
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true">
          <line x1="18" y1="6" x2="6" y2="18"></line>
          <line x1="6" y1="6" x2="18" y2="18"></line>
        </svg>
      </button>
    </div>
  </div>
</template>
