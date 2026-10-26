<script setup>
import { computed } from 'vue';
import {
  downloadReceivedFile,
  filteredHistory,
  historyDetail,
  historyMeta,
  historyPeer,
  historyStatus,
  requestCancelTransfer,
  requestClearHistory,
  setHistoryFilter,
  transfer,
} from '../stores/transfer.js';
import { getDeviceIconSvg, getFileIconSvg } from '../services/room-ui.js';

const filters = [
  { id: 'all', label: 'Все' },
  { id: 'sent', label: 'Отправленные' },
  { id: 'received', label: 'Полученные' },
];

const activeFilter = computed(() => transfer.historyFilter || 'all');
const records = filteredHistory;
const hasRecords = computed(() => records.value.length > 0);
const emptyTitle = computed(() => {
  if (activeFilter.value === 'sent') {
    return 'Отправленных файлов пока нет';
  }
  if (activeFilter.value === 'received') {
    return 'Полученных файлов пока нет';
  }
  return 'История пока пуста';
});
const emptyText = computed(() => {
  if (activeFilter.value === 'sent') {
    return 'После отправки файлы появятся здесь вместе со статусом и прогрессом.';
  }
  if (activeFilter.value === 'received') {
    return 'Полученные по P2P файлы появятся здесь. Скачать их можно до выхода из комнаты.';
  }
  return 'Отправленные и полученные файлы появятся здесь вместе со статусом и прогрессом.';
});
const canClear = computed(() => transfer.history.some((record) => (
  record.status !== 'active'
  && record.status !== 'awaiting'
  && record.status !== 'receiving'
)));

function statusFor(record) {
  return historyStatus(record);
}

function setFilter(id) {
  setHistoryFilter(id);
}
</script>

<template>
  <section class="room-panel history-card" aria-labelledby="historyTitle">
    <div class="history-head">
      <div>
        <p class="room-eyebrow">Журнал комнаты</p>
        <h2 id="historyTitle" class="panel-title">История передачи</h2>
      </div>
      <button
        class="btn btn-secondary history-clear-btn"
        type="button"
        :disabled="!canClear"
        @click="requestClearHistory"
      >
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <path d="M3 6h18"></path>
          <path d="M8 6V4h8v2"></path>
          <path d="M19 6l-1 14H6L5 6"></path>
          <path d="M10 11v5"></path>
          <path d="M14 11v5"></path>
        </svg>
        <span>Очистить историю</span>
      </button>
    </div>

    <div class="history-tabs" role="tablist" aria-label="Фильтр истории">
      <button
        v-for="filter in filters"
        :key="filter.id"
        class="history-tab"
        :class="{ 'is-active': activeFilter === filter.id }"
        type="button"
        role="tab"
        :aria-selected="activeFilter === filter.id"
        @click="setFilter(filter.id)"
      >
        {{ filter.label }}
      </button>
    </div>

    <div v-if="hasRecords" class="history-list" role="list" aria-live="polite">
      <article
        v-for="record in records"
        :key="record.id"
        class="history-item"
        :data-status="record.status"
        :data-direction="record.direction"
        :data-storage="record.storage || ''"
        role="listitem"
      >
        <div class="history-file-cell">
          <span
            class="file-type-icon"
            aria-hidden="true"
            v-html="getFileIconSvg(record.name, record.mimeType)"
          ></span>
          <div class="history-file-copy">
            <strong class="history-file-name" :title="record.name">{{ record.name }}</strong>
            <span class="history-file-meta">{{ historyMeta(record) }}</span>
          </div>
        </div>

        <div class="history-status-cell">
          <span class="history-status-pill" :data-tone="statusFor(record).tone">
            <span class="history-status-dot" aria-hidden="true"></span>
            <span>{{ statusFor(record).label }}</span>
          </span>
          <span class="history-status-detail">{{ historyDetail(record) }}</span>
        </div>

        <div class="history-peer-cell">
          <span class="history-peer-label">{{ record.direction === 'sent' ? 'Кому' : 'От кого' }}</span>
          <span class="history-peer-value">
            <span
              class="history-peer-icon"
              aria-hidden="true"
              v-html="getDeviceIconSvg(record.peer?.type || 'unknown')"
            ></span>
            <span>{{ historyPeer(record) }}</span>
          </span>
        </div>

        <div class="history-actions">
          <button
            v-if="record.status === 'completed' && (record.opfsPath || record.memoryBlob)"
            class="history-icon-action"
            type="button"
            data-action="download"
            :disabled="record.downloading"
            :aria-label="`Скачать ${record.name}`"
            :aria-busy="record.downloading ? 'true' : 'false'"
            title="Скачать файл"
            @click="downloadReceivedFile(record)"
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path>
              <polyline points="7 10 12 15 17 10"></polyline>
              <line x1="12" y1="15" x2="12" y2="3"></line>
            </svg>
          </button>
          <button
            v-if="record.status === 'active' && record.direction === 'sent' && transfer.isSending"
            class="history-icon-action history-icon-action--cancel"
            type="button"
            :aria-label="`Отменить передачу ${record.name}`"
            title="Отменить передачу"
            @click="requestCancelTransfer(record)"
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true">
              <line x1="18" y1="6" x2="6" y2="18"></line>
              <line x1="6" y1="6" x2="18" y2="18"></line>
            </svg>
          </button>
        </div>
      </article>
    </div>

    <div v-else class="history-empty">
      <span class="history-empty-icon" aria-hidden="true">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">
          <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path>
          <polyline points="14 2 14 8 20 8"></polyline>
          <path d="M8 13h8"></path>
          <path d="M8 17h5"></path>
        </svg>
      </span>
      <strong>{{ emptyTitle }}</strong>
      <p>{{ emptyText }}</p>
    </div>
  </section>
</template>
