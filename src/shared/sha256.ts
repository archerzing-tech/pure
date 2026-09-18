// src/shared/sha256.ts
// 同步、纯 TypeScript 的 SHA-256 —— GUI（WebView）与 CLI 共用。
//
// 为什么不用 node:crypto：Vite 的浏览器打包解析不了 node 内置模块。E1.1 的
// LessonReflector 直接 `import { createHash } from 'node:crypto'`，而 Harness
// 在 GUI 路径上是**静态导入**的 —— 结果不是"少个功能"，是整个 GUI 构建直接
// 失败（rollup: "failed to resolve import node:crypto"）。这些 id 的用途只需要
// "同文本 → 同短 id"的稳定性（反思证据引用 / 纠正草稿去重键），但已经有落库
// 数据（sha256 前 12 位）与设计文档都写着 sha256，所以这里保留同一算法而不是
// 换成弱哈希 —— 换算法会让旧的 dedupeKey 对不上新写入，同一句纠正会重复冒卡。
//
// 用法：`sha256Hex(text).slice(0, 12)`。实现是教科书版 FIPS 180-4，配 NIST
// 测试向量（空串/abc/跨块边界字符串）单测。

const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

const H0 = new Uint32Array([
  0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
]);

/** rotl32 via the standard two-shift form (JS numbers are doubles, so mask). */
function rotr(value: number, bits: number): number {
  return ((value >>> bits) | (value << (32 - bits))) >>> 0;
}

/** SHA-256 of a UTF-8 string, lowercase hex (64 chars). */
export function sha256Hex(input: string): string {
  const data = new TextEncoder().encode(input);
  const length = data.length;
  // Padding: message + 0x80 + zeros + 8-byte big-endian bit length, to a 64-byte
  // boundary. `length + 9` is the smallest size that still needs the length
  // field, so rounding it up gives the block count for every input length.
  const blockCount = Math.floor((length + 9 + 63) / 64);
  const padded = new Uint8Array(blockCount * 64);
  padded.set(data);
  padded[length] = 0x80;
  const view = new DataView(padded.buffer);
  const bitLengthHigh = Math.floor(length / 0x20000000); // (length * 8) / 2^32
  const bitLengthLow = (length * 8) >>> 0;
  view.setUint32(padded.length - 8, bitLengthHigh);
  view.setUint32(padded.length - 4, bitLengthLow);

  const h = H0.slice();
  const w = new Uint32Array(64);
  for (let block = 0; block < blockCount; block++) {
    const offset = block * 64;
    for (let i = 0; i < 16; i++) w[i] = view.getUint32(offset + i * 4);
    for (let i = 16; i < 64; i++) {
      const s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3);
      const s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10);
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0;
    }

    let a = h[0];
    let b = h[1];
    let c = h[2];
    let d = h[3];
    let e = h[4];
    let f = h[5];
    let g = h[6];
    let hh = h[7];

    for (let i = 0; i < 64; i++) {
      const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const ch = (e & f) ^ (~e & g);
      const temp1 = (hh + S1 + ch + K[i] + w[i]) >>> 0;
      const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const temp2 = (S0 + maj) >>> 0;
      hh = g;
      g = f;
      f = e;
      e = (d + temp1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (temp1 + temp2) >>> 0;
    }

    h[0] = (h[0] + a) >>> 0;
    h[1] = (h[1] + b) >>> 0;
    h[2] = (h[2] + c) >>> 0;
    h[3] = (h[3] + d) >>> 0;
    h[4] = (h[4] + e) >>> 0;
    h[5] = (h[5] + f) >>> 0;
    h[6] = (h[6] + g) >>> 0;
    h[7] = (h[7] + hh) >>> 0;
  }

  let hex = '';
  for (let i = 0; i < 8; i++) hex += h[i].toString(16).padStart(8, '0');
  return hex;
}
