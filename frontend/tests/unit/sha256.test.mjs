import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import test from 'node:test';

import { Sha256, createSha256 } from '../../src/services/sha256.js';

if (!globalThis.crypto) {
  globalThis.crypto = webcrypto;
}

async function webCryptoHex(bytes) {
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function randomBytes(size, seed = 1) {
  const data = new Uint8Array(size);
  let state = seed >>> 0;

  for (let index = 0; index < size; index += 1) {
    state = (state * 1664525 + 1013904223) >>> 0;
    data[index] = state >>> 24;
  }

  return data;
}

test('SHA-256 matches the NIST vectors', () => {
  assert.equal(
    createSha256().digestHex(),
    'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
  );

  assert.equal(
    createSha256().update(new TextEncoder().encode('abc')).digestHex(),
    'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
  );

  assert.equal(
    createSha256()
      .update(new TextEncoder().encode('abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq'))
      .digestHex(),
    '248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1',
  );
});

test('SHA-256 matches the one-million-a vector', () => {
  const hasher = createSha256();
  const block = new Uint8Array(1000).fill(0x61);

  for (let index = 0; index < 1000; index += 1) {
    hasher.update(block);
  }

  assert.equal(
    hasher.digestHex(),
    'cdc76e5c9914fb9281a1c7e284d73e67f1809a48a497200e046d39ccc7112cd0',
  );
});

test('SHA-256 matches WebCrypto across 63/64/65-byte chunk boundaries', async () => {
  const data = randomBytes(4096, 7);
  const sizes = [1, 2, 61, 63, 64, 65, 127, 128, 129, 1, 255, 256, 257, 511];
  const hasher = createSha256();
  let offset = 0;
  let sizeIndex = 0;

  while (offset < data.byteLength) {
    const size = Math.min(sizes[sizeIndex % sizes.length], data.byteLength - offset);
    hasher.update(data.subarray(offset, offset + size));
    offset += size;
    sizeIndex += 1;
  }

  assert.equal(hasher.digestHex(), await webCryptoHex(data));
});

test('SHA-256 produces the same result for every split of the same input', async () => {
  const data = randomBytes(1024, 42);
  const expected = await webCryptoHex(data);

  for (const split of [1, 7, 63, 64, 65, 127, 128, 129, 333, 512, 1023]) {
    const hasher = createSha256();
    hasher.update(data.subarray(0, split));
    hasher.update(data.subarray(split));
    assert.equal(hasher.digestHex(), expected, `split at ${split}`);
  }
});

test('SHA-256 accepts ArrayBuffer and typed-array views with offsets', async () => {
  const data = randomBytes(300, 99);
  const padded = new Uint8Array(data.byteLength + 20);
  padded.set(data, 10);
  const view = padded.subarray(10, 10 + data.byteLength);
  const expected = await webCryptoHex(data);

  assert.equal(createSha256().update(view).digestHex(), expected);
  assert.equal(createSha256().update(padded).digestHex(), await webCryptoHex(padded));
});

test('SHA-256 ignores empty updates', async () => {
  const data = randomBytes(128, 3);
  const hasher = createSha256();

  hasher.update(new Uint8Array(0));
  hasher.update(data);
  hasher.update(new Uint8Array(0));

  assert.equal(hasher.digestHex(), await webCryptoHex(data));
});

test('SHA-256 digest can be called only once', () => {
  const hasher = new Sha256();
  hasher.update(new Uint8Array([1, 2, 3]));

  assert.equal(hasher.digestHex().length, 64);
  assert.throws(() => hasher.digest(), /sha256-already-finished/);
  assert.throws(() => hasher.digestHex(), /sha256-already-finished/);
  assert.throws(() => hasher.update(new Uint8Array([4])), /sha256-already-finished/);
});
