<script setup>
import { computed } from 'vue';
import BaseDialog from './BaseDialog.vue';
import { resolveConfirmation, ui } from '../../stores/ui.js';

const tone = computed(() => ui.confirm.tone || 'danger');
const acceptClass = computed(() => (tone.value === 'danger' ? 'btn-danger' : 'btn-primary'));

function close() {
  resolveConfirmation(false);
}

function accept() {
  resolveConfirmation(true);
}
</script>

<template>
  <BaseDialog
    :open="ui.confirm.open"
    dialog-class="tw-dialog--confirm"
    labelled-by="confirmTitle"
    @close="close"
  >
    <div class="tw-dialog__body confirm-body">
      <span class="confirm-icon" :data-tone="tone" aria-hidden="true">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round">
          <path d="M10.3 3.6 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.6a2 2 0 0 0-3.4 0Z"></path>
          <path d="M12 9v4"></path>
          <path d="M12 17h.01"></path>
        </svg>
      </span>
      <h2 id="confirmTitle" class="confirm-title">{{ ui.confirm.title || 'Подтвердите действие' }}</h2>
      <p class="confirm-message">{{ ui.confirm.message }}</p>
    </div>
    <footer class="tw-dialog__footer">
      <button class="btn btn-secondary tw-dialog-action" type="button" @click="close">
        {{ ui.confirm.cancelLabel || 'Отмена' }}
      </button>
      <button class="btn tw-dialog-action" :class="acceptClass" type="button" @click="accept">
        {{ ui.confirm.confirmLabel || 'Подтвердить' }}
      </button>
    </footer>
  </BaseDialog>
</template>
