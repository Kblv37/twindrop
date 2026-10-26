<script setup>
import { computed, ref, watch } from 'vue';
import {
  formatRoomError,
  joinRoom,
  room,
} from '../stores/room.js';
import { normalizeRoomCode } from '../services/utils.js';

const props = defineProps({
  initialCode: {
    type: String,
    default: '',
  },
  hint: {
    type: String,
    default: '',
  },
});

const emit = defineEmits(['joined']);
const code = ref(normalizeRoomCode(props.initialCode, room.config?.roomCodeLength || 6));
const error = ref('');

const codeLength = computed(() => Number(room.config?.roomCodeLength) || 6);
const busy = computed(() => room.joining || room.creating);
const canSubmit = computed(() => code.value.length === codeLength.value && !busy.value && !room.joined);
const feedback = computed(() => {
  if (error.value) {
    return error.value;
  }
  if (props.hint && room.joined === false) {
    return props.hint;
  }
  return '';
});

watch(() => props.initialCode, (value) => {
  const normalized = normalizeRoomCode(value, codeLength.value);
  if (normalized) {
    code.value = normalized;
  }
});

watch(codeLength, (length) => {
  code.value = normalizeRoomCode(code.value, length);
});

function handleInput(event) {
  code.value = normalizeRoomCode(event.target.value, codeLength.value);
  event.target.value = code.value;
  error.value = '';
}

async function handleSubmit() {
  if (busy.value || room.joined) {
    return;
  }

  error.value = '';

  if (code.value.length !== codeLength.value) {
    error.value = `Введите код из ${codeLength.value} цифр.`;
    return;
  }

  try {
    const joinedCode = await joinRoom(code.value);

    if (joinedCode) {
      emit('joined', joinedCode);
    }
  } catch (joinError) {
    error.value = formatRoomError(joinError);
  }
}
</script>

<template>
  <article class="action-card home-room-card" aria-labelledby="action-connect-title">
    <span class="action-icon" aria-hidden="true">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
        <path d="M10 13a5 5 0 0 0 7.1 0l2.4-2.4a5 5 0 0 0-7.1-7.1L11 4.9"></path>
        <path d="M14 11a5 5 0 0 0-7.1 0l-2.4 2.4a5 5 0 0 0 7.1 7.1L13 19.1"></path>
      </svg>
    </span>
    <span class="action-eyebrow">Для отправителя</span>
    <h3 id="action-connect-title" class="action-title">Подключиться</h3>
    <p class="action-desc">Отсканируйте QR-код камерой телефона или введите код комнаты, чтобы начать передачу.</p>

    <form class="home-card-form" novalidate @submit.prevent="handleSubmit">
      <label class="visually-hidden" for="homeJoinCode">Код комнаты</label>
      <input
        id="homeJoinCode"
        class="input mono home-code-input"
        type="text"
        inputmode="numeric"
        pattern="[0-9]*"
        autocomplete="one-time-code"
        enterkeyhint="go"
        spellcheck="false"
        :placeholder="'0'.repeat(codeLength)"
        :maxlength="codeLength"
        :value="code"
        :aria-invalid="Boolean(error)"
        aria-describedby="homeJoinFeedback"
        @input="handleInput"
      >
      <div
        v-if="feedback"
        id="homeJoinFeedback"
        class="join-feedback"
        :data-state="error ? 'error' : 'info'"
        role="status"
        aria-live="polite"
      >
        <span class="join-feedback-dot" aria-hidden="true"></span>
        <span>{{ feedback }}</span>
      </div>
      <p v-else id="homeJoinFeedback" class="small muted home-card-hint">Введите код из {{ codeLength }} цифр.</p>
      <button
        class="btn btn-secondary btn-lg action-cta"
        :class="{ 'is-loading': room.joining }"
        type="submit"
        :disabled="!canSubmit"
      >
        <span>{{ room.joining ? 'Подключаемся…' : (room.joined ? 'Комната уже активна' : 'Подключиться') }}</span>
        <svg v-if="!room.joining" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <path d="M5 12h14"></path>
          <path d="m13 6 6 6-6 6"></path>
        </svg>
      </button>
    </form>
  </article>
</template>
