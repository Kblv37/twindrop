<script setup>
import { computed } from 'vue';
import { useRoute } from 'vue-router';
import { room } from '../stores/room.js';

const route = useRoute();

const roomRoute = computed(() => (room.role === 'creator' ? '/r' : '/s'));
const createActive = computed(() => route.path === '/r' && !room.joined);
const joinActive = computed(() => route.path === '/s' && !room.joined);
</script>

<template>
  <header class="app-header" role="banner" aria-label="Навигация Twindrop">
    <div class="header-inner container">
      <h1>
        <RouterLink class="brand" to="/" aria-label="Twindrop — на главную">Twindrop</RouterLink>
      </h1>
      <nav class="nav" aria-label="Основная навигация">
        <template v-if="room.joined">
          <RouterLink class="nav-link nav-room-link active" :to="roomRoute">
            <span class="nav-room-dot" aria-hidden="true"></span>
            <span class="nav-room-label">Комната</span>
            <span class="nav-room-code mono">{{ room.code }}</span>
          </RouterLink>
        </template>
        <template v-else>
          <RouterLink class="nav-link" :class="{ active: createActive }" to="/r">Создать</RouterLink>
          <RouterLink class="nav-link" :class="{ active: joinActive }" to="/s">Подключиться</RouterLink>
        </template>
        <RouterLink class="nav-icon-link" to="/about" aria-label="О проекте" title="О проекте">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <circle cx="12" cy="12" r="9"></circle>
            <path d="M12 11v5"></path>
            <path d="M12 8h.01"></path>
          </svg>
        </RouterLink>
      </nav>
    </div>
    <div class="hairline"></div>
  </header>
</template>
