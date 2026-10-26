<script setup>
import { ref } from 'vue';
import { addFiles } from '../stores/fileQueue.js';

const props = defineProps({
  disabled: {
    type: Boolean,
    default: false,
  },
});

const inputRef = ref(null);
const dragging = ref(false);
let dragDepth = 0;

function handleChange() {
  const files = Array.from(inputRef.value?.files || []);

  if (files.length > 0) {
    addFiles(files);
  }

  if (inputRef.value) {
    inputRef.value.value = '';
  }
}

function handleDragEnter(event) {
  event.preventDefault();

  if (props.disabled) {
    return;
  }

  dragDepth += 1;
  dragging.value = true;
}

function handleDragOver(event) {
  event.preventDefault();

  if (event.dataTransfer) {
    event.dataTransfer.dropEffect = props.disabled ? 'none' : 'copy';
  }
}

function handleDragLeave(event) {
  event.preventDefault();
  dragDepth = Math.max(0, dragDepth - 1);

  if (dragDepth === 0) {
    dragging.value = false;
  }
}

function handleDrop(event) {
  event.preventDefault();
  dragDepth = 0;
  dragging.value = false;

  if (props.disabled) {
    return;
  }

  const files = Array.from(event.dataTransfer?.files || []);

  if (files.length > 0) {
    addFiles(files);
  }
}
</script>

<template>
  <label
    class="dropzone"
    :class="{ 'drag-over': dragging, 'is-transferring': disabled }"
    @dragenter="handleDragEnter"
    @dragover="handleDragOver"
    @dragleave="handleDragLeave"
    @drop="handleDrop"
  >
    <input
      ref="inputRef"
      type="file"
      multiple
      :disabled="disabled"
      @change="handleChange"
    >
    <div class="dz-visual">
      <div class="dz-icon" aria-hidden="true">
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path>
          <polyline points="17 8 12 3 7 8"></polyline>
          <line x1="12" y1="3" x2="12" y2="15"></line>
        </svg>
      </div>
      <div class="dz-text">
        <div class="dz-title">Перетащите файлы сюда</div>
        <div class="dz-sub muted">Выберите несколько файлов. При необходимости они будут объединены в ZIP-архив.</div>
        <div class="dz-cta">
          <svg viewBox="0 0 24 24" width="13" height="13" aria-hidden="true">
            <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path>
            <polyline points="17 8 12 3 7 8"></polyline>
            <line x1="12" y1="3" x2="12" y2="15"></line>
          </svg>
          Выбрать файлы
        </div>
      </div>
    </div>
  </label>
</template>
