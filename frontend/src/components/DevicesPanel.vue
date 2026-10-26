<script setup>
import { computed } from 'vue';
import { getDeviceIconSvg } from '../services/room-ui.js';
import { room } from '../stores/room.js';

const hasPeer = computed(() => Boolean(room.peerId));
const online = computed(() => Boolean(room.sessionReady));
const remoteState = computed(() => {
  if (online.value) {
    return 'online';
  }
  return hasPeer.value ? 'connecting' : 'waiting';
});

const selfIcon = computed(() => getDeviceIconSvg(room.localDevice?.type || 'desktop'));
const remoteIcon = computed(() => getDeviceIconSvg(room.peerInfo?.type || 'unknown'));
const remoteName = computed(() => room.peerInfo?.typeLabel || 'Второе устройство');
const remoteType = computed(() => {
  if (room.peerInfo) {
    return `${room.peerInfo.os} · ${room.peerInfo.browser}`;
  }
  return hasPeer.value ? 'Определяем устройство' : 'Ожидаем подключение';
});
const remoteMeta = computed(() => {
  if (online.value) {
    if (room.connectionPath === 'relay') {
      return 'Подключено через TURN-ретранслятор';
    }
    if (room.connectionPath === 'direct') {
      return 'Подключено напрямую по WebRTC';
    }
    return 'WebRTC-канал открыт';
  }
  return hasPeer.value ? 'Данные появятся после соединения' : 'Передайте код комнаты на другое устройство';
});
const remoteStatus = computed(() => {
  if (online.value) {
    return 'В сети';
  }
  return hasPeer.value ? 'Соединение' : 'Не в сети';
});
</script>

<template>
  <section class="room-panel devices-panel" aria-labelledby="devicesTitle">
    <div class="panel-heading">
      <div>
        <p class="room-eyebrow">Устройства</p>
        <h2 id="devicesTitle" class="panel-title">Подключены к комнате</h2>
      </div>
      <span class="device-counter">{{ hasPeer ? '2 из 2' : '1 из 2' }}</span>
    </div>

    <div class="devices-grid">
      <article class="device-card device-card--self" data-state="online" aria-label="Это устройство">
        <span class="device-icon" aria-hidden="true" v-html="selfIcon"></span>
        <div class="device-copy">
          <strong>Это устройство</strong>
          <span class="device-line">{{ room.localDevice?.typeLabel || 'Устройство' }}</span>
          <span class="device-meta">
            {{ room.localDevice?.os || 'ОС неизвестна' }} · {{ room.localDevice?.browser || 'браузер' }}
          </span>
        </div>
        <span class="device-self-badge">Вы</span>
      </article>

      <span class="device-connector" aria-hidden="true">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
          <path d="M10 13a5 5 0 0 0 7.1 0l2.4-2.4a5 5 0 0 0-7.1-7.1L11 4.9"></path>
          <path d="M14 11a5 5 0 0 0-7.1 0l-2.4 2.4a5 5 0 0 0 7.1 7.1L13 19.1"></path>
        </svg>
      </span>

      <article
        class="device-card"
        :data-state="remoteState"
        :data-connection-path="room.connectionPath"
        aria-label="Второе устройство"
      >
        <span class="device-icon" aria-hidden="true" v-html="remoteIcon"></span>
        <div class="device-copy">
          <strong>{{ remoteName }}</strong>
          <span class="device-line">{{ remoteType }}</span>
          <span class="device-meta">{{ remoteMeta }}</span>
        </div>
        <span class="device-online-status" :data-state="remoteState">
          <span class="device-online-dot" aria-hidden="true"></span>
          <span>{{ remoteStatus }}</span>
        </span>
      </article>
    </div>
  </section>
</template>
