<script setup>
import { computed } from 'vue';
import BaseDialog from './modals/BaseDialog.vue';
import {
  connectionModeLabel,
  connectionNote,
  roleLabel,
  room,
  roomStatus,
} from '../stores/room.js';

defineProps({
  open: {
    type: Boolean,
    default: false,
  },
});

const emit = defineEmits(['close']);

const peerText = computed(() => {
  if (room.peerInfo) {
    return `${room.peerInfo.typeLabel} · ${room.peerInfo.os} · ${room.peerInfo.browser}`;
  }
  return room.peerId ? 'Устройство подключено, определяем данные' : 'Ожидаем подключение';
});
</script>

<template>
  <BaseDialog
    :open="open"
    dialog-class="tw-dialog--info"
    labelled-by="infoTitle"
    @close="emit('close')"
  >
    <header class="tw-dialog__head">
      <div class="tw-dialog__heading">
        <span class="tw-dialog-step tw-dialog-step--info" aria-hidden="true">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <circle cx="12" cy="12" r="9"></circle>
            <path d="M12 11v5"></path>
            <path d="M12 8h.01"></path>
          </svg>
        </span>
        <div>
          <h2 id="infoTitle" class="tw-dialog__title">О комнате</h2>
          <p class="tw-dialog__subtitle">Параметры текущего соединения</p>
        </div>
      </div>
      <button
        class="tw-dialog__close"
        type="button"
        aria-label="Закрыть информацию о комнате"
        title="Закрыть"
        @click="emit('close')"
      >
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true">
          <line x1="18" y1="6" x2="6" y2="18"></line>
          <line x1="6" y1="6" x2="18" y2="18"></line>
        </svg>
      </button>
    </header>

    <div class="tw-dialog__body">
      <dl class="info-list">
        <div><dt>Код комнаты</dt><dd class="mono">{{ room.code || '—' }}</dd></div>
        <div><dt>Роль</dt><dd>{{ roleLabel }}</dd></div>
        <div><dt>Состояние</dt><dd>{{ roomStatus.title }}</dd></div>
        <div><dt>Второе устройство</dt><dd>{{ peerText }}</dd></div>
        <div><dt>Режим</dt><dd>{{ connectionModeLabel }}</dd></div>
        <div v-if="room.localCandidateType || room.remoteCandidateType">
          <dt>ICE-кандидаты</dt>
          <dd>{{ room.localCandidateType || '—' }} / {{ room.remoteCandidateType || '—' }}</dd>
        </div>
      </dl>
      <p class="info-note">{{ connectionNote }}</p>
    </div>
  </BaseDialog>
</template>
