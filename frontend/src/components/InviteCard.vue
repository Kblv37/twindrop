<script setup>
import { computed, onBeforeUnmount, ref } from 'vue';
import QrCode from './QrCode.vue';
import { copyText } from '../services/room-ui.js';
import { notify } from '../stores/ui.js';
import { room, roomShareLink } from '../stores/room.js';

const copiedCode = ref(false);
const copiedLink = ref(false);
let codeTimer = null;
let linkTimer = null;

const qrLabel = computed(() => `QR-код для подключения к комнате ${room.code}`);

async function copyCode() {
  if (!room.code) {
    return;
  }

  const copied = await copyText(room.code);

  if (!copied) {
    notify('Не удалось скопировать код комнаты.', 'warning');
    return;
  }

  copiedCode.value = true;
  notify('Код комнаты скопирован.', 'success', 3200);
  window.clearTimeout(codeTimer);
  codeTimer = window.setTimeout(() => {
    copiedCode.value = false;
  }, 1800);
}

async function copyLink() {
  if (!roomShareLink.value) {
    return;
  }

  const copied = await copyText(roomShareLink.value);

  if (!copied) {
    notify('Не удалось скопировать ссылку.', 'warning');
    return;
  }

  copiedLink.value = true;
  notify('Ссылка на комнату скопирована.', 'success', 3200);
  window.clearTimeout(linkTimer);
  linkTimer = window.setTimeout(() => {
    copiedLink.value = false;
  }, 1800);
}

function selectLink(event) {
  event.target.select();
}

onBeforeUnmount(() => {
  window.clearTimeout(codeTimer);
  window.clearTimeout(linkTimer);
});
</script>

<template>
  <section class="room-panel invite-card" aria-labelledby="inviteTitle">
    <div class="invite-qr-wrap">
      <QrCode :value="roomShareLink" :label="qrLabel" />
      <span class="invite-qr-caption">QR комнаты</span>
    </div>
    <div class="invite-copy">
      <p class="room-eyebrow">Код комнаты</p>
      <div class="invite-code-row">
        <h2 id="inviteTitle" class="invite-code mono">{{ room.code }}</h2>
        <button
          class="room-copy-btn"
          :class="{ 'is-copied': copiedCode }"
          type="button"
          aria-label="Скопировать код комнаты"
          :title="copiedCode ? 'Скопировано' : 'Скопировать код'"
          @click="copyCode"
        >
          <svg v-if="!copiedCode" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <rect x="9" y="9" width="13" height="13" rx="2"></rect>
            <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path>
          </svg>
          <svg v-else viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <path d="m5 12 4 4L19 6"></path>
          </svg>
        </button>
      </div>
      <p class="invite-hint">Отсканируйте QR-код или поделитесь кодом со вторым устройством.</p>
      <div class="invite-link-row">
        <label class="visually-hidden" for="roomLink">Ссылка для подключения</label>
        <input
          id="roomLink"
          class="input mono"
          type="text"
          readonly
          :value="roomShareLink"
          :aria-label="`Ссылка для подключения к комнате ${room.code}`"
          @focus="selectLink"
        >
        <button
          class="btn copy-link-btn"
          :class="{ 'is-copied': copiedLink }"
          type="button"
          aria-label="Скопировать ссылку на комнату"
          :title="copiedLink ? 'Ссылка скопирована' : 'Скопировать ссылку'"
          @click="copyLink"
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <path d="M10 13a5 5 0 0 0 7.1 0l2.4-2.4a5 5 0 0 0-7.1-7.1L11 4.9"></path>
            <path d="M14 11a5 5 0 0 0-7.1 0l-2.4 2.4a5 5 0 0 0 7.1 7.1L13 19.1"></path>
          </svg>
          <span class="copy-link-label">{{ copiedLink ? 'Скопировано' : 'Копировать' }}</span>
        </button>
      </div>
    </div>
  </section>
</template>
