<script setup>
import { onBeforeUnmount, onMounted, ref, watch } from 'vue';

const props = defineProps({
  open: {
    type: Boolean,
    default: false,
  },
  canClose: {
    type: Boolean,
    default: true,
  },
  dialogClass: {
    type: String,
    default: '',
  },
  labelledBy: {
    type: String,
    default: '',
  },
});

const emit = defineEmits(['close']);
const dialogRef = ref(null);

function syncBodyDialogState() {
  const open = Boolean(document.querySelector('dialog[open]'));
  document.body.classList.toggle('dialog-open', open);
}

function syncOpenState() {
  const dialog = dialogRef.value;

  if (!dialog) {
    return;
  }

  if (props.open && !dialog.open) {
    if (typeof dialog.showModal === 'function') {
      dialog.showModal();
    } else {
      dialog.setAttribute('open', '');
    }
  } else if (!props.open && dialog.open) {
    if (typeof dialog.close === 'function') {
      dialog.close();
    } else {
      dialog.removeAttribute('open');
    }
  }

  syncBodyDialogState();
}

function requestClose() {
  if (props.canClose) {
    emit('close');
  }
}

function handleCancel(event) {
  event.preventDefault();
  requestClose();
}

function handleDialogClick(event) {
  if (event.target === dialogRef.value) {
    event.preventDefault();
    requestClose();
  }
}

watch(() => props.open, syncOpenState, { flush: 'post' });
watch(() => props.canClose, () => {});

onMounted(syncOpenState);

onBeforeUnmount(() => {
  const dialog = dialogRef.value;

  if (dialog?.open && typeof dialog.close === 'function') {
    dialog.close();
  }

  syncBodyDialogState();
});
</script>

<template>
  <dialog
    ref="dialogRef"
    class="tw-dialog"
    :class="dialogClass"
    :aria-labelledby="labelledBy || undefined"
    @cancel="handleCancel"
    @click="handleDialogClick"
    @close="syncBodyDialogState"
  >
    <div class="tw-dialog__panel">
      <slot />
    </div>
  </dialog>
</template>
