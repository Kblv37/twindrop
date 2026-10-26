<script setup>
import { nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { loadQrCode } from '../services/qr.js';

const props = defineProps({
  value: {
    type: String,
    default: '',
  },
  label: {
    type: String,
    default: 'QR-код для подключения к комнате',
  },
});

const containerRef = ref(null);
const failed = ref(false);
let renderGeneration = 0;

async function render() {
  const generation = ++renderGeneration;
  const container = containerRef.value;

  if (!container) {
    return;
  }

  container.replaceChildren();
  failed.value = false;

  if (!props.value) {
    return;
  }

  await nextTick();

  try {
    const QRCode = await loadQrCode();

    if (generation !== renderGeneration || !container.isConnected) {
      return;
    }

    container.replaceChildren();
    new QRCode(container, {
      text: props.value,
      width: 160,
      height: 160,
      colorDark: '#0b1220',
      colorLight: '#ffffff',
      correctLevel: QRCode.CorrectLevel?.M,
    });
  } catch {
    if (generation === renderGeneration) {
      failed.value = true;
    }
  }
}

watch(() => props.value, render);
onMounted(render);
onBeforeUnmount(() => {
  renderGeneration += 1;
});
</script>

<template>
  <div class="invite-qr" role="img" :aria-label="label">
    <div ref="containerRef" class="invite-qr-canvas"></div>
    <span v-if="failed" class="invite-qr-fallback">QR временно недоступен</span>
  </div>
</template>
