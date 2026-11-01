// src/ui/__tests__/inputRepair.test.ts
// Coverage for the lossless normalization that runs on every GUI send. The
// typo-tolerant risk expansion that used to share this file was removed on
// 2026-11-01 together with preflight.ts (its only consumer).

import { describe, expect, it } from 'bun:test';
import { normalizeDraft } from '../inputRepair';

describe('normalizeDraft (lossless, runs on every send)', () => {
  it('strips invisible characters an IME or a paste leaves behind', () => {
    expect(normalizeDraft('删\u200B除\uFEFF项目\u00AD')).toBe('删除项目');
  });

  it('folds exotic spaces to a plain space without collapsing runs', () => {
    expect(normalizeDraft('a\u00A0\u3000b')).toBe('a  b');
    expect(normalizeDraft('  a   b  ')).toBe('a   b');
  });

  it('turns fullwidth ASCII into halfwidth so keywords and paths match', () => {
    expect(normalizeDraft('ｒｍ －ｒｆ ／ｔｍｐ')).toBe('rm -rf /tmp');
    expect(normalizeDraft('请读 ｓｒｃ／ｕｉ／ｍａｉｎ.ｔｓ')).toBe('请读 src/ui/main.ts');
  });

  it('keeps CJK punctuation the user typed on purpose', () => {
    expect(normalizeDraft('先看（ａ）再说，然后：停')).toBe('先看（a）再说，然后：停');
  });

  it('keeps pasted code indentation and newlines intact', () => {
    const code = 'function a() {\n    return 1;\n}';
    expect(normalizeDraft(code)).toBe(code);
  });

  it('leaves ordinary prompts untouched', () => {
    expect(normalizeDraft('解释这个文件的作用')).toBe('解释这个文件的作用');
  });

  it('is idempotent — a second pass never changes anything', () => {
    for (const input of [' 闪除\u2000整个项目 ', 'ｒｍ －ｒｆ ／', 'a   b', '']) {
      const once = normalizeDraft(input);
      expect(normalizeDraft(once)).toBe(once);
    }
  });
});
