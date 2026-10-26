const assert = require('node:assert/strict');
const test = require('node:test');

const { RoomStore } = require('../src/server/room-store');

function createStore() {
  return new RoomStore({
    capacity: 2,
    roomTtlMs: 60 * 60 * 1000,
    emptyRoomTtlMs: 15 * 60 * 1000,
  });
}

test('replaces the stale socket of the same participant instead of returning room-full', () => {
  const store = createStore();
  store.createRoom('123456');

  assert.equal(store.addMember('123456', 'participant-a', 'socket-1').ok, true);
  assert.equal(store.addMember('123456', 'participant-b', 'socket-2').ok, true);

  const replacement = store.addMember('123456', 'participant-a', 'socket-3');

  assert.equal(replacement.ok, true);
  assert.equal(replacement.isNew, false);
  assert.equal(replacement.replacedSocketId, 'socket-1');
  assert.equal(store.getSize('123456'), 2);
  assert.deepEqual(store.getPeerIds('123456', 'socket-3'), ['socket-2']);
});

test('a delayed disconnect from a replaced socket does not remove the live member', () => {
  const store = createStore();
  store.createRoom('123456');
  store.addMember('123456', 'participant-a', 'socket-1');
  store.addMember('123456', 'participant-a', 'socket-2');

  const staleRemoval = store.removeMember('123456', 'participant-a', 'socket-1');

  assert.equal(staleRemoval.removed, false);
  assert.equal(staleRemoval.stale, true);
  assert.equal(store.isMember('123456', 'socket-2'), true);
  assert.equal(store.getSize('123456'), 1);
});

test('rejects a third distinct participant and allows the current socket to leave', () => {
  const store = createStore();
  store.createRoom('123456');
  store.addMember('123456', 'participant-a', 'socket-1');
  store.addMember('123456', 'participant-b', 'socket-2');

  const third = store.addMember('123456', 'participant-c', 'socket-3');
  assert.equal(third.ok, false);
  assert.equal(third.reason, 'room-full');

  const removal = store.removeMember('123456', 'participant-b', 'socket-2');
  assert.equal(removal.removed, true);
  assert.deepEqual(store.getPeerIds('123456'), ['socket-1']);
});

test('cleans up empty rooms after the configured TTL', () => {
  const store = createStore();
  store.createRoom('123456');
  store.addMember('123456', 'participant-a', 'socket-1');
  store.removeMember('123456', 'participant-a', 'socket-1');

  assert.equal(store.cleanupStaleRooms(Date.now() + 60_000), 0);
  assert.equal(store.cleanupStaleRooms(Date.now() + 16 * 60 * 1000), 1);
  assert.equal(store.hasRoom('123456'), false);
});
