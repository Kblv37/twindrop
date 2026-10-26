<script setup>
import { dismissNotice, ui } from '../stores/ui.js';
</script>

<template>
  <TransitionGroup name="toast-list" tag="div" class="toast-stack" aria-live="polite" aria-atomic="false">
    <div
      v-for="notice in ui.notices"
      :key="notice.id"
      class="toast-card"
      :data-type="notice.type"
      :role="notice.type === 'error' ? 'alert' : 'status'"
    >
      <span class="toast-dot" aria-hidden="true"></span>
      <span class="toast-message">{{ notice.message }}</span>
      <button
        class="toast-close"
        type="button"
        aria-label="Закрыть уведомление"
        title="Закрыть"
        @click="dismissNotice(notice.id)"
      >
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true">
          <line x1="18" y1="6" x2="6" y2="18"></line>
          <line x1="6" y1="6" x2="18" y2="18"></line>
        </svg>
      </button>
    </div>
  </TransitionGroup>
</template>
