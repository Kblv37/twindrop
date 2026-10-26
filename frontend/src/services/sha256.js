// Incremental SHA-256 for the receive path.
//
// WebCrypto only exposes a one-shot `crypto.subtle.digest()` API. Calling it
// for every chunk would not produce the SHA-256 of the whole file, and
// concatenating the file in memory would defeat the streaming receiver. This
// implementation keeps only one 64-byte block and the 256-bit state, so its
// memory use is constant regardless of the file size.

const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5,
  0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3,
  0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc,
  0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7,
  0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
  0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3,
  0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5,
  0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
  0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

const INITIAL_STATE = new Uint32Array([
  0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
  0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
]);

const BLOCK_SIZE = 64;
const HEX = Array.from({ length: 256 }, (_, index) => index.toString(16).padStart(2, '0'));

function rotr(value, bits) {
  return (value >>> bits) | (value << (32 - bits));
}

function toBytes(data) {
  if (data instanceof Uint8Array) {
    return data;
  }

  if (data instanceof ArrayBuffer) {
    return new Uint8Array(data);
  }

  if (ArrayBuffer.isView(data)) {
    return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  }

  return new Uint8Array(data);
}

export class Sha256 {
  constructor() {
    this.state = new Uint32Array(INITIAL_STATE);
    this.words = new Uint32Array(64);
    this.buffer = new Uint8Array(BLOCK_SIZE);
    this.bufferLength = 0;
    this.totalBytes = 0;
    this.finished = false;
  }

  update(data) {
    if (this.finished) {
      throw new Error('sha256-already-finished');
    }

    const bytes = toBytes(data);

    if (bytes.byteLength === 0) {
      return this;
    }

    this.totalBytes += bytes.byteLength;
    let offset = 0;

    if (this.bufferLength > 0) {
      const take = Math.min(BLOCK_SIZE - this.bufferLength, bytes.byteLength);
      this.buffer.set(bytes.subarray(0, take), this.bufferLength);
      this.bufferLength += take;
      offset += take;

      if (this.bufferLength === BLOCK_SIZE) {
        this.processBlock(this.buffer, 0);
        this.bufferLength = 0;
      }
    }

    while (offset + BLOCK_SIZE <= bytes.byteLength) {
      this.processBlock(bytes, offset);
      offset += BLOCK_SIZE;
    }

    if (offset < bytes.byteLength) {
      this.buffer.set(bytes.subarray(offset), 0);
      this.bufferLength = bytes.byteLength - offset;
    }

    return this;
  }

  processBlock(bytes, offset) {
    const words = this.words;

    for (let index = 0; index < 16; index += 1) {
      const position = offset + index * 4;
      words[index] = (
        (bytes[position] << 24)
        | (bytes[position + 1] << 16)
        | (bytes[position + 2] << 8)
        | bytes[position + 3]
      ) >>> 0;
    }

    for (let index = 16; index < 64; index += 1) {
      const word15 = words[index - 15];
      const word2 = words[index - 2];
      const sigma0 = rotr(word15, 7) ^ rotr(word15, 18) ^ (word15 >>> 3);
      const sigma1 = rotr(word2, 17) ^ rotr(word2, 19) ^ (word2 >>> 10);
      words[index] = (words[index - 16] + sigma0 + words[index - 7] + sigma1) >>> 0;
    }

    let a = this.state[0];
    let b = this.state[1];
    let c = this.state[2];
    let d = this.state[3];
    let e = this.state[4];
    let f = this.state[5];
    let g = this.state[6];
    let h = this.state[7];

    for (let index = 0; index < 64; index += 1) {
      const sigma1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const choose = (e & f) ^ (~e & g);
      const temp1 = (h + sigma1 + choose + K[index] + words[index]) >>> 0;
      const sigma0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const majority = (a & b) ^ (a & c) ^ (b & c);
      const temp2 = (sigma0 + majority) >>> 0;

      h = g;
      g = f;
      f = e;
      e = (d + temp1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (temp1 + temp2) >>> 0;
    }

    this.state[0] = (this.state[0] + a) >>> 0;
    this.state[1] = (this.state[1] + b) >>> 0;
    this.state[2] = (this.state[2] + c) >>> 0;
    this.state[3] = (this.state[3] + d) >>> 0;
    this.state[4] = (this.state[4] + e) >>> 0;
    this.state[5] = (this.state[5] + f) >>> 0;
    this.state[6] = (this.state[6] + g) >>> 0;
    this.state[7] = (this.state[7] + h) >>> 0;
  }

  digest() {
    if (this.finished) {
      throw new Error('sha256-already-finished');
    }

    const totalBytes = this.totalBytes;
    const bitLengthHigh = Math.floor(totalBytes / 0x20000000) >>> 0;
    const bitLengthLow = ((totalBytes % 0x20000000) * 8) >>> 0;
    const buffer = this.buffer;
    let length = this.bufferLength;

    buffer[length] = 0x80;
    length += 1;

    if (length > 56) {
      buffer.fill(0, length);
      this.processBlock(buffer, 0);
      length = 0;
    }

    buffer.fill(0, length, 56);
    const view = new DataView(buffer.buffer);
    view.setUint32(56, bitLengthHigh, false);
    view.setUint32(60, bitLengthLow, false);
    this.processBlock(buffer, 0);
    this.finished = true;

    const result = new Uint8Array(32);

    for (let index = 0; index < 8; index += 1) {
      const value = this.state[index];
      result[index * 4] = value >>> 24;
      result[index * 4 + 1] = (value >>> 16) & 0xff;
      result[index * 4 + 2] = (value >>> 8) & 0xff;
      result[index * 4 + 3] = value & 0xff;
    }

    return result;
  }

  digestHex() {
    const bytes = this.digest();
    let result = '';

    for (let index = 0; index < bytes.length; index += 1) {
      result += HEX[bytes[index]];
    }

    return result;
  }
}

export function createSha256() {
  return new Sha256();
}
