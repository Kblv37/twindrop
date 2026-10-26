const assert = require('node:assert/strict');
const test = require('node:test');

const {
  validateJoinPayload,
  validateSignalEnvelope,
} = require('../src/server/validation');

test('accepts a join payload with a stable participant ID', () => {
  const result = validateJoinPayload({
    code: '123456',
    participantId: 'tab_01HZX9K4Q7',
  }, 6);

  assert.equal(result.ok, true);
  assert.deepEqual(result.value, {
    code: '123456',
    participantId: 'tab_01HZX9K4Q7',
  });
});

test('keeps older clients without a participant ID compatible', () => {
  const result = validateJoinPayload({ code: '123456' }, 6);

  assert.equal(result.ok, true);
  assert.deepEqual(result.value, {
    code: '123456',
    participantId: '',
  });
});

test('rejects a malformed participant ID', () => {
  const result = validateJoinPayload({
    code: '123456',
    participantId: 'bad id with spaces',
  }, 6);

  assert.equal(result.ok, false);
  assert.equal(result.error, 'invalid-participant-id');
});

test('rejects malformed signal payloads', () => {
  const result = validateSignalEnvelope({
    code: '123456',
    to: 'socket-1',
    signal: { type: 'offer', sdp: '' },
  }, {
    roomCodeLength: 6,
    maxSignalPayloadBytes: 12 * 1024,
  });

  assert.equal(result.ok, false);
  assert.equal(result.error, 'invalid-sdp');
});
