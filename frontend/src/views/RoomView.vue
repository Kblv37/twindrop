<script setup>
import { computed, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import CreateRoomCard from '../components/CreateRoomCard.vue';
import JoinRoomCard from '../components/JoinRoomCard.vue';
import InviteCard from '../components/InviteCard.vue';
import DevicesPanel from '../components/DevicesPanel.vue';
import FileQueuePanel from '../components/FileQueuePanel.vue';
import TransferProgress from '../components/TransferProgress.vue';
import TransferHistory from '../components/TransferHistory.vue';
import RoomInfoDialog from '../components/RoomInfoDialog.vue';
import {
  leaveRoom,
  refreshConnection,
  room,
  roomStatus,
} from '../stores/room.js';
import {
  queueHasFiles,
  queueSummary,
} from '../stores/fileQueue.js';
import {
  sendQueuedFiles,
  showPreparation,
  transfer,
} from '../stores/transfer.js';
import { askConfirmation } from '../stores/ui.js';
import { getRoomCodeFromQuery } from '../services/utils.js';

const route = useRoute();
const router = useRouter();
const infoOpen = ref(false);

const mode = computed(() => route.meta.roomMode || 'join');
const isCreatorMode = computed(() => mode.value === 'create');
const initialCode = computed(() => getRoomCodeFromQuery(route.query));
const preparing = computed(() => transfer.isSending || transfer.isReceiving);
const canSend = computed(() => (
  room.joined
  && room.sessionReady
  && queueHasFiles.value
  && !transfer.isSending
));
const refreshDisabled = computed(() => room.refreshing || preparing.value);
const sendHint = computed(() => {
  if (transfer.isSending) {
    return 'Передача выполняется. Дождитесь завершения или отмените её.';
  }
  if (!room.sessionReady) {
    return 'Дождитесь открытия защищённого P2P-канала — выбранные файлы останутся в очереди.';
  }
  return `${queueSummary.value}. Отправка начнётся только после нажатия кнопки.`;
});

function handlePreparation() {
  if (preparing.value) {
    return;
  }
  showPreparation();
}

async function handleSend() {
  if (!canSend.value) {
    return;
  }
  await sendQueuedFiles();
}

async function handleRefresh() {
  if (refreshDisabled.value) {
    return;
  }
  await refreshConnection();
}

async function requestLeave() {
  if (!room.joined) {
    return;
  }

  if (preparing.value) {
    const confirmed = await askConfirmation({
      title: 'Выйти из комнаты?',
      message: 'Текущая передача будет прервана, а комната закроется для этого устройства. Выбранные файлы останутся в очереди. Вы сможете подключиться снова по тому же коду.',
      confirmLabel: 'Да, выйти',
      cancelLabel: 'Нет, остаться',
      tone: 'danger',
    });

    if (!confirmed) {
      return;
    }
  }

  leaveRoom();
  router.push('/');
}
</script>

<template>
  <div v-if="!room.joined" class="room-page" :class="isCreatorMode ? 'room-page--create' : 'room-page--join'">
    <header class="room-page-head">
      <span class="room-page-icon" aria-hidden="true">
        <svg v-if="isCreatorMode" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
          <rect x="3" y="3" width="7" height="7" rx="1.4"></rect>
          <rect x="14" y="3" width="7" height="7" rx="1.4"></rect>
          <rect x="3" y="14" width="7" height="7" rx="1.4"></rect>
          <path d="M14 14h3v3h-3z"></path>
          <path d="M20 14h1"></path>
          <path d="M20 18v2h-2"></path>
          <path d="M14 20h1"></path>
        </svg>
        <svg v-else viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
          <path d="M10 13a5 5 0 0 0 7.1 0l2.4-2.4a5 5 0 0 0-7.1-7.1L11 4.9"></path>
          <path d="M14 11a5 5 0 0 0-7.1 0l-2.4 2.4a5 5 0 0 0 7.1 7.1L13 19.1"></path>
        </svg>
      </span>
      <p class="room-eyebrow">{{ isCreatorMode ? 'Приём файлов' : 'Отправка файлов' }}</p>
      <h1 class="room-page-title">{{ isCreatorMode ? 'Создать комнату' : 'Подключиться к комнате' }}</h1>
      <p class="room-page-subtitle">
        {{ isCreatorMode
          ? 'Создайте комнату, передайте код или QR-код второму устройству и дождитесь подключения.'
          : 'Введите код комнаты, чтобы установить прямое защищённое соединение и отправить файлы второму устройству.' }}
      </p>
    </header>

    <div class="room-prejoin-card-wrap">
      <CreateRoomCard v-if="isCreatorMode" />
      <JoinRoomCard v-else :initial-code="initialCode" />
    </div>

    <FileQueuePanel
      class="room-prejoin-queue"
      eyebrow="Выбранные файлы"
      title="Очередь передачи"
      description="Файлы можно выбрать до подключения. Они сохраняются между перезагрузками и не отправляются автоматически."
      @prepare="handlePreparation"
    />
  </div>

  <section v-else class="room-workspace" aria-labelledby="workspaceTitle">
    <h2 id="workspaceTitle" class="visually-hidden">Комната Twindrop</h2>

    <div class="room-toolbar" :data-state="roomStatus.state">
      <div class="room-toolbar-status">
        <span class="conn-dot" aria-hidden="true"></span>
        <div class="room-toolbar-copy">
          <strong>{{ roomStatus.title }}</strong>
          <span>{{ roomStatus.text }}</span>
        </div>
      </div>
      <div class="room-toolbar-actions">
        <button
          class="btn btn-secondary room-tool-btn"
          :class="{ 'is-loading': room.refreshing }"
          type="button"
          :disabled="refreshDisabled"
          title="Обновить соединение"
          @click="handleRefresh"
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <path d="M20 11a8.1 8.1 0 0 0-15.5-2M4 4v5h5"></path>
            <path d="M4 13a8.1 8.1 0 0 0 15.5 2M20 20v-5h-5"></path>
          </svg>
          <span class="tool-btn-label">Обновить соединение</span>
          <span class="tool-btn-label-short">Обновить</span>
        </button>
        <button
          class="btn room-leave-btn"
          type="button"
          title="Отключиться от комнаты"
          @click="requestLeave"
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"></path>
            <polyline points="16 17 21 12 16 7"></polyline>
            <line x1="21" y1="12" x2="9" y2="12"></line>
          </svg>
          <span class="tool-btn-label">Отключиться</span>
          <span class="tool-btn-label-short">Выйти</span>
        </button>
        <button
          class="room-icon-btn"
          type="button"
          aria-label="Информация о комнате"
          title="Информация о комнате"
          @click="infoOpen = true"
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <circle cx="12" cy="12" r="9"></circle>
            <path d="M12 11v5"></path>
            <path d="M12 8h.01"></path>
          </svg>
        </button>
      </div>
    </div>

    <div class="room-overview">
      <InviteCard />
      <DevicesPanel />
    </div>

    <FileQueuePanel
      eyebrow="Быстрая отправка"
      title="Отправить файлы"
      :show-chunk-size="true"
      :hint="sendHint"
      :send-disabled="!canSend"
      :send-label="transfer.isSending ? 'Отправляем…' : 'Отправить'"
      :show-send="true"
      @prepare="handlePreparation"
      @send="handleSend"
    />

    <TransferProgress />
    <TransferHistory />
  </section>

  <RoomInfoDialog :open="infoOpen" @close="infoOpen = false" />
</template>
