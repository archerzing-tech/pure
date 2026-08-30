// src/__tests__/inlineAutocomplete.test.ts
// Pure candidate-filter logic for the composer autocomplete popup.

import { describe, expect, it } from 'bun:test';
import { filterCandidates, type AutocompleteCandidate } from '../ui/inlineAutocomplete';

function c(label: string, insert = label, kind: AutocompleteCandidate['kind'] = 'session'): AutocompleteCandidate {
  return { label, insert, kind };
}

describe('filterCandidates', () => {
  it('returns [] for an empty or whitespace prefix', () => {
    expect(filterCandidates('', [c('a')])).toEqual([]);
    expect(filterCandidates('   ', [c('a')])).toEqual([]);
  });

  it('matches prefixes case-insensitively', () => {
    const out = filterCandidates('bun', [c('Bun test'), c('Run build'), c('bun run dev')]);
    expect(out.map((o) => o.insert)).toEqual(['bun run dev', 'Bun test']);
  });

  it('sorts starts-with matches before containment matches', () => {
    const out = filterCandidates('fix', [
      c('Refactor the fix module'),
      c('fix login bug'),
    ]);
    expect(out[0].insert).toBe('fix login bug');
  });

  it('dedupes by insert text', () => {
    const out = filterCandidates('bun', [c('bun run dev'), c('run with bun'), c('bun run dev')]);
    expect(out.filter((o) => o.insert === 'bun run dev')).toHaveLength(1);
  });

  it('caps results at the limit', () => {
    const many = Array.from({ length: 20 }, (_, i) => c(`bun run ${i}`));
    expect(filterCandidates('bun', many, 5)).toHaveLength(5);
  });

  it('matches CJK prefixes', () => {
    const out = filterCandidates('删除', [c('删除临时文件'), c('优化启动速度')]);
    expect(out.map((o) => o.insert)).toEqual(['删除临时文件']);
  });
});
