function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function normalizeRoomCode(code, length = 6) {
  if (typeof code !== 'string') {
    return '';
  }

  const normalized = code.replace(/\D/g, '').slice(0, length);
  return normalized.length === length ? normalized : '';
}

function sanitizeDisplayText(value, maxLength = 160) {
  if (typeof value !== 'string') {
    return '';
  }

  return value.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim().slice(0, maxLength);
}

function safeJsonByteLength(value) {
  try {
    return Buffer.byteLength(JSON.stringify(value), 'utf8');
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

function validateJoinPayload(payload, roomCodeLength) {
  if (!isPlainObject(payload)) {
    return { ok: false, error: 'invalid-payload' };
  }

  const code = normalizeRoomCode(payload.code, roomCodeLength);

  if (!code) {
    return { ok: false, error: 'invalid-room-code' };
  }

  return { ok: true, value: { code } };
}

function validateSignalData(signal) {
  if (!isPlainObject(signal)) {
    return { ok: false, error: 'invalid-signal' };
  }

  if (typeof signal.type === 'string') {
    if (!['offer', 'answer'].includes(signal.type)) {
      return { ok: false, error: 'invalid-description-type' };
    }

    if (typeof signal.sdp !== 'string' || signal.sdp.length === 0 || signal.sdp.length > 10_000) {
      return { ok: false, error: 'invalid-sdp' };
    }

    return {
      ok: true,
      value: {
        type: signal.type,
        sdp: signal.sdp,
      },
    };
  }

  if (isPlainObject(signal.candidate)) {
    const { candidate, sdpMid, sdpMLineIndex, usernameFragment } = signal.candidate;

    if (typeof candidate !== 'string' || candidate.length === 0 || candidate.length > 4_096) {
      return { ok: false, error: 'invalid-candidate' };
    }

    if (typeof sdpMid !== 'undefined' && typeof sdpMid !== 'string') {
      return { ok: false, error: 'invalid-candidate-mid' };
    }

    if (typeof sdpMLineIndex !== 'undefined' && !Number.isInteger(sdpMLineIndex)) {
      return { ok: false, error: 'invalid-candidate-line' };
    }

    if (typeof usernameFragment !== 'undefined' && typeof usernameFragment !== 'string') {
      return { ok: false, error: 'invalid-candidate-fragment' };
    }

    return {
      ok: true,
      value: {
        candidate: {
          candidate,
          ...(typeof sdpMid === 'string' ? { sdpMid: sdpMid.slice(0, 256) } : {}),
          ...(Number.isInteger(sdpMLineIndex) ? { sdpMLineIndex } : {}),
          ...(typeof usernameFragment === 'string' ? { usernameFragment: usernameFragment.slice(0, 256) } : {}),
        },
      },
    };
  }

  return { ok: false, error: 'unsupported-signal' };
}

function validateSignalEnvelope(payload, { roomCodeLength, maxSignalPayloadBytes }) {
  if (!isPlainObject(payload)) {
    return { ok: false, error: 'invalid-payload' };
  }

  const code = normalizeRoomCode(payload.code, roomCodeLength);
  const to = sanitizeDisplayText(payload.to, 64);

  if (!code) {
    return { ok: false, error: 'invalid-room-code' };
  }

  if (!to) {
    return { ok: false, error: 'invalid-target-peer' };
  }

  const signalResult = validateSignalData(payload.signal);

  if (!signalResult.ok) {
    return signalResult;
  }

  const normalizedPayload = {
    code,
    to,
    signal: signalResult.value,
  };

  if (safeJsonByteLength(normalizedPayload) > maxSignalPayloadBytes) {
    return { ok: false, error: 'signal-too-large' };
  }

  return { ok: true, value: normalizedPayload };
}

module.exports = {
  isPlainObject,
  normalizeRoomCode,
  sanitizeDisplayText,
  validateJoinPayload,
  validateSignalEnvelope,
};
