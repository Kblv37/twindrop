<script setup>
import { onMounted, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import AppHeader from './components/AppHeader.vue';
import AppFooter from './components/AppFooter.vue';
import GlobalNotices from './components/GlobalNotices.vue';
import ConfirmDialog from './components/modals/ConfirmDialog.vue';
import PrepareFilesModal from './components/modals/PrepareFilesModal.vue';
import ArchiveModal from './components/modals/ArchiveModal.vue';
import ReadyArchiveModal from './components/modals/ReadyArchiveModal.vue';
import { consumeSharedFiles, ensureQueueLoaded } from './stores/fileQueue.js';
import { hasStoredRoomSession, initializeRoomStore } from './stores/room.js';
import { notify } from './stores/ui.js';
import { registerServiceWorker } from './services/pwa.js';
import { cleanupStaleReceiveFiles } from './services/receive-storage.js';

const route = useRoute();
const router = useRouter();
const pageClasses = ['page-home', 'page-join', 'page-create', 'page-receive', 'page-about'];
const SHARE_ERROR_NOTICES = {
  request: {
    type: 'error',
    message: 'Не удалось прочитать данные, полученные через «Поделиться». Попробуйте ещё раз.',
  },
  storage: {
    type: 'error',
    message: 'Не удалось сохранить файлы из меню «Поделиться». Ранее ожидавшие файлы не потеряны; попробуйте ещё раз.',
  },
  read: {
    type: 'warning',
    message: 'Не удалось прочитать один или несколько файлов из меню «Поделиться». Остальные файлы сохранены.',
  },
};

function handleShareError(queryValue) {
  const code = Array.isArray(queryValue) ? queryValue[0] : queryValue;

  if (typeof code !== 'string' || !code) {
    return;
  }

  const notice = SHARE_ERROR_NOTICES[code] || SHARE_ERROR_NOTICES.request;
  notify(notice.message, notice.type, 9000);

  const query = { ...route.query };
  delete query.shareError;
  router.replace({ query }).catch(() => {});
}

function ensureRoomReady() {
  if (!route.meta?.roomMode && !hasStoredRoomSession()) {
    return;
  }

  initializeRoomStore().catch((error) => {
    console.warn('[room] Failed to initialize room store:', error);
  });
}

watch(
  () => route.meta?.roomMode,
  () => {
    ensureRoomReady();
  },
  { immediate: true },
);

watch(
  () => route.meta?.pageClass,
  (pageClass) => {
    document.body.classList.remove(...pageClasses);
    document.body.classList.add('theme-premium', pageClass || 'page-home');
  },
  { immediate: true },
);

watch(
  () => route.query.shareError,
  (shareError) => {
    handleShareError(shareError);
  },
  { immediate: true },
);

onMounted(() => {
  ensureQueueLoaded().catch((error) => {
    console.warn('[queue] Failed to initialize file queue:', error);
  });

  consumeSharedFiles().catch(() => {});

  // History is intentionally in-memory. Remove receive files left behind by
  // a crash or a page that could not finish asynchronous cleanup on unload.
  cleanupStaleReceiveFiles().catch((error) => {
    console.warn('[transfer] Failed to clean stale receive files:', error);
  });

  registerServiceWorker({
    onSharedFiles: () => {
      consumeSharedFiles().catch(() => {});
    },
  });
});
</script>

<template>
  <div class="bg">
    <div class="bg-gradient"></div>
    <div class="bg-vignette"></div>
    <div class="bg-noise" aria-hidden="true"></div>
  </div>

  <AppHeader />

  <main class="app-main container" role="main">
    <RouterView />
  </main>

  <AppFooter />

  <GlobalNotices />
  <ConfirmDialog />
  <PrepareFilesModal />
  <ArchiveModal />
  <ReadyArchiveModal />
</template>
