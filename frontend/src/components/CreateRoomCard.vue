<script setup>
import { computed, ref } from 'vue';
import { createRoom, formatRoomError, room } from '../stores/room.js';

const emit = defineEmits(['created']);
const error = ref('');

const busy = computed(() => room.creating || room.joining);
const disabled = computed(() => busy.value || room.joined);

async function handleCreate() {
  if (disabled.value) {
    return;
  }

  error.value = '';

  try {
    const code = await createRoom();

    if (code) {
      emit('created', code);
    }
  } catch (createError) {
    error.value = formatRoomError(createError);
  }
}
</script>

<template>
  <article class="action-card action-card--primary home-room-card" aria-labelledby="action-create-title">
    <span class="action-icon" aria-hidden="true">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
        <rect x="3" y="3" width="7" height="7" rx="1.4"></rect>
        <rect x="14" y="3" width="7" height="7" rx="1.4"></rect>
        <rect x="3" y="14" width="7" height="7" rx="1.4"></rect>
        <path d="M14 14h3v3h-3z"></path>
        <path d="M20 14h1"></path>
        <path d="M20 18v2h-2"></path>
        <path d="M14 20h1"></path>
      </svg>
    </span>
    <span class="action-eyebrow">Для получателя</span>
    <h3 id="action-create-title" class="action-title">Создать комнату</h3>
    <p class="action-desc">Получите QR-код или 6-значный код комнаты и передайте его собеседнику.</p>

    <div class="home-card-form">
      <p v-if="room.initError && !error" class="room-inline-error" role="alert">{{ room.initError }}</p>
      <p v-if="error" class="room-inline-error" role="alert">{{ error }}</p>
      <button
        class="btn btn-primary btn-lg action-cta"
        :class="{ 'is-loading': room.creating }"
        type="button"
        :disabled="disabled"
        @click="handleCreate"
      >
        <span>{{ room.creating ? 'Создаём комнату…' : (room.joined ? 'Комната уже активна' : 'Создать комнату') }}</span>
        <svg v-if="!room.creating" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <path d="M5 12h14"></path>
          <path d="m13 6 6 6-6 6"></path>
        </svg>
      </button>
    </div>
  </article>
</template>
