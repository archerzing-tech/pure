// src/shared/__tests__/sha256.test.ts
// 纯 TS SHA-256 的 NIST 向量验证 —— 这个实现存在的唯一理由就是"浏览器里也要
// 能算出和 node:crypto 一样的 sha256"（反思证据 id / 草稿去重键都按它写库），
// 所以逐位对齐官方向量是必须的：错一个 bit，旧的 dedupeKey 就对不上了。

import { describe, expect, it } from 'bun:test';
import { createHash } from 'node:crypto';
import { sha256Hex } from '../sha256';

const vector = (input: string): string => createHash('sha256').update(input, 'utf8').digest('hex');

describe('sha256Hex', () => {
  it('matches the published NIST vectors', () => {
    expect(sha256Hex('')).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
    expect(sha256Hex('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    expect(sha256Hex('abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq'))
      .toBe('248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1');
  });

  it('matches node:crypto across the padding boundaries (55 / 56 / 63 / 64 bytes)', () => {
    for (const length of [1, 54, 55, 56, 57, 63, 64, 65, 119, 120, 127, 128, 1000]) {
      const input = 'x'.repeat(length);
      expect(sha256Hex(input)).toBe(vector(input));
    }
  });

  it('matches node:crypto for multi-byte UTF-8 (Chinese / emoji)', () => {
    for (const input of ['中文测试', '反思器 lesson ✅', '中文'.repeat(40)]) {
      expect(sha256Hex(input)).toBe(vector(input));
    }
  });

  it('hashes long input (multi-block + large bit-length field)', () => {
    const input = 'a'.repeat(200_000);
    expect(sha256Hex(input)).toBe(vector(input));
  });
});
