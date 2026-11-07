// src/shared/network/__tests__/dest.test.ts
// destFromUrl 工厂：key 归一（WHATWG hostname 小写 + punycode）与坏 URL 兜底。

import { describe, expect, it } from 'bun:test';
import { destFromUrl } from '../dest';

describe('destFromUrl', () => {
  it('parses hostname as key and fills web-exit defaults', () => {
    expect(destFromUrl('https://Example.COM/a?b=1', 'web-page', 'html')).toEqual({
      key: 'example.com',
      class: 'web-page',
      idempotent: true,
      replayable: true,
      mirrorable: false,
      expect: 'html',
    });
  });

  it('falls back to an empty key for non-URLs (class-level samples only)', () => {
    expect(destFromUrl('not a url', 'vcs', 'html').key).toBe('');
  });

  it('serializes IDN hosts as punycode (stable ledger keys)', () => {
    expect(destFromUrl('https://例子.com/', 'web-page', 'html').key).toContain('xn--');
  });
});
