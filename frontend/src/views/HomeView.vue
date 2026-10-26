<script setup>
import { computed } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import CreateRoomCard from '../components/CreateRoomCard.vue';
import JoinRoomCard from '../components/JoinRoomCard.vue';
import FileQueuePanel from '../components/FileQueuePanel.vue';
import { getRoomCodeFromQuery } from '../services/utils.js';
import { showPreparation } from '../stores/transfer.js';

const route = useRoute();
const router = useRouter();
const initialCode = computed(() => getRoomCodeFromQuery(route.query));

function handleCreated(code) {
  if (code) {
    router.push('/r');
  }
}

function handleJoined(code) {
  if (code) {
    router.push({ path: '/s', query: { r: code } });
  }
}

function openPreparation() {
  showPreparation();
}
</script>

<template>
  <div class="home-layout">
    <section class="home-hero" aria-labelledby="home-title">
      <div class="hero-emblem" aria-hidden="true">
        <svg viewBox="0 0 40 40" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
          <path d="M9 14h17a4 4 0 0 1 4 4v1"></path>
          <path d="m26 9 5 5-5 5"></path>
          <path d="M31 26H14a4 4 0 0 1-4-4v-1"></path>
          <path d="m14 31-5-5 5-5"></path>
        </svg>
      </div>
      <h2 id="home-title" class="home-title">Twindrop</h2>
      <p class="home-subtitle">Быстрая и безопасная передача файлов между устройствами</p>
    </section>

    <section class="home-actions" aria-label="Начните передачу файлов">
      <CreateRoomCard @created="handleCreated" />
      <JoinRoomCard :initial-code="initialCode" @joined="handleJoined" />
    </section>

    <FileQueuePanel
      eyebrow="Выбор файлов"
      title="Очередь передачи"
      description="Выберите файлы заранее — они останутся в очереди, пока вы создаёте комнату или подключаетесь ко второй. Комната и отправка не начинаются автоматически."
      :show-chunk-size="false"
      @prepare="openPreparation"
    />
  </div>
</template>
