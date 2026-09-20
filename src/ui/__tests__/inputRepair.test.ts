// src/ui/__tests__/inputRepair.test.ts
// Roadmap 阶段 11.1 (P0): lossless normalization + the typo-tolerant risk
// expansion. The alias table carries an invariant — every canonical must be a
// word the danger floor already recognises — so it is asserted here against the
// real assessIntent instead of against a hand-written list: an entry the floor
// cannot see would expand to nothing and ship as dead weight.

import { describe, expect, it } from 'bun:test';
import { assessIntent } from '../../coding-agent/Planner';
import { expandRiskSynonyms, normalizeDraft, RISK_ALIASES } from '../inputRepair';

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

describe('expandRiskSynonyms (shadow text for the risk floor)', () => {
  it('maps a homophone slip onto the word the floor understands', () => {
    const expansion = expandRiskSynonyms('帮我把缓存目录闪除了');
    expect(expansion.text).toBe('帮我把缓存目录删除了');
    expect(expansion.applied).toEqual([{ from: '闪除', to: '删除' }]);
    expect(assessIntent(expansion.text).riskLevel).toBe('high');
  });

  it('expands the spoken and overwrite forms the floor learned on 2026-09-20', () => {
    const empty = expandRiskSynonyms('把缓存轻空了');
    expect(empty.text).toBe('把缓存清空了');
    expect(assessIntent(empty.text).riskLevel).toBe('high');
    expect(expandRiskSynonyms('把配置复盖掉').text).toBe('把配置覆盖掉');
  });

  it('leaves ordinary prompts alone — same string, no replacements', () => {
    const expansion = expandRiskSynonyms('解释这个文件的作用');
    expect(expansion.text).toBe('解释这个文件的作用');
    expect(expansion.applied).toEqual([]);
  });

  it('matches English variants case-insensitively and fixes smart dashes', () => {
    expect(expandRiskSynonyms('Destory the cache').text).toBe('destroy the cache');
    expect(expandRiskSynonyms('rm –rf /tmp').text).toBe('rm -rf /tmp');
    expect(expandRiskSynonyms('forcepush origin main').text).toBe('force push origin main');
  });

  it('never expands a correctly spelled word — no garbled shadow text', () => {
    const expansion = expandRiskSynonyms('delete all the logs');
    expect(expansion.text).toBe('delete all the logs');
    expect(expansion.applied).toEqual([]);
  });

  it('leaves ordinary prose that merely contains a near-miss untouched', () => {
    // 情理 / 闪出 were dropped from the table for exactly this reason: gating
    // sentences like these would accuse the user of a typo they never made.
    expect(expandRiskSynonyms('这件事在情理之中').text).toBe('这件事在情理之中');
    expect(expandRiskSynonyms('画面上闪出一个弹窗').applied).toEqual([]);
  });

  it('reports each fired variant once, in the order the draft uses them', () => {
    const expansion = expandRiskSynonyms('山除 A，山除 B，闪除 C');
    expect(expansion.text).toBe('删除 A，删除 B，删除 C');
    expect(expansion.applied).toEqual([
      { from: '山除', to: '删除' },
      { from: '闪除', to: '删除' },
    ]);
  });

  it('never rescans its own output — no garbled text, no invented replacement', () => {
    // Variant-by-variant expansion used to rewrite 'delete all' (just produced
    // from 'delelte all') with the shorter 'delete al' variant, producing
    // 'delete alll' and a second pair the user never typed.
    const expansion = expandRiskSynonyms('delelte all the logs in /tmp');
    expect(expansion.text).toBe('delete all the logs in /tmp');
    expect(expansion.applied).toEqual([{ from: 'delelte all', to: 'delete all' }]);
  });

  it('ignores a correctly spelled canonical elsewhere in the same group', () => {
    const expansion = expandRiskSynonyms('delete all the logs');
    expect(expansion.applied).toEqual([]);
  });

  it('handles empty input', () => {
    expect(expandRiskSynonyms('')).toEqual({ text: '', applied: [] });
  });
});

describe('alias table invariant', () => {
  it('every canonical is a word the danger floor already flags', () => {
    for (const { canonical } of RISK_ALIASES) {
      expect([canonical, assessIntent(canonical).riskLevel]).toEqual([canonical, 'high']);
    }
  });

  it('every variant expands into a high-risk shadow text', () => {
    const dead: string[] = [];
    for (const { canonical, variants } of RISK_ALIASES) {
      for (const variant of variants) {
        const draft = `把目标${variant}掉`;
        const expansion = expandRiskSynonyms(draft);
        if (expansion.text === draft || assessIntent(expansion.text).riskLevel !== 'high') {
          dead.push(`${variant} → ${canonical}`);
        }
      }
    }
    expect(dead).toEqual([]);
  });
});
