// src/ui/__tests__/followupChips.test.ts
// Suggested follow-up chips: the model's `<!-- suggested: … ;; … -->` comment
// becomes tappable next-question chips under a reply. Pinned here: extraction
// (strip + clean + cap), chip rendering (inert textContent, idempotent), and
// the bubbling pure-followup event the owning ChatApp answers. DOM tests use
// happy-dom; no dompurify import (cross-file mock landmine, see
// detailsFold.test.ts header).
import { describe, it, expect, afterAll } from 'bun:test';
import { GlobalRegistrator } from '@happy-dom/global-registrator';
import { extractSuggestedFollowups, appendFollowupChips } from '../markdown';

GlobalRegistrator.register();
afterAll(() => {
  GlobalRegistrator.unregister();
});

describe('extractSuggestedFollowups', () => {
  it('pulls the comment out and splits on ;;', () => {
    const { text, questions } = extractSuggestedFollowups('正文\n<!-- suggested: 换个配色? ;; 加个导出按钮? -->');
    expect(text).not.toContain('suggested');
    expect(text).toContain('正文');
    expect(questions).toEqual(['换个配色?', '加个导出按钮?']);
  });

  it('cleans list bullets the model wraps questions in', () => {
    const { questions } = extractSuggestedFollowups('<!-- suggested: - 先做 A? ;; 1. 还是先做 B? ;; • 或者 C? -->');
    expect(questions).toEqual(['先做 A?', '还是先做 B?', '或者 C?']);
  });

  it('caps at 4 and drops empty pieces', () => {
    const { questions } = extractSuggestedFollowups('<!-- suggested: a ;; ;; b ;; c ;; d ;; e -->');
    expect(questions.length).toBe(4);
    expect(questions).toEqual(['a', 'b', 'c', 'd']);
  });

  it('leaves comment-free text untouched', () => {
    const md = '普通回复,没有建议';
    const { text, questions } = extractSuggestedFollowups(md);
    expect(text).toBe(md);
    expect(questions).toEqual([]);
  });
});

describe('appendFollowupChips', () => {
  it('renders one chip per question with inert text', () => {
    const el = document.createElement('div');
    appendFollowupChips(el, ['继续吗?', '要带 <b>样式</b> 吗?']);
    const chips = el.querySelectorAll<HTMLButtonElement>('.followup-chip');
    expect(chips.length).toBe(2);
    expect(chips[1].textContent).toBe('要带 <b>样式</b> 吗?');
    expect(chips[1].querySelector('b')).toBeNull();
  });

  it('is idempotent — a re-render never doubles the row', () => {
    const el = document.createElement('div');
    appendFollowupChips(el, ['一']);
    appendFollowupChips(el, ['一', '二']);
    expect(el.querySelectorAll('.followup-chips').length).toBe(1);
    expect(el.querySelectorAll('.followup-chip').length).toBe(1);
  });

  it('a chip click bubbles a pure-followup event carrying the question', () => {
    const host = document.createElement('div');
    const bubble = document.createElement('div');
    host.appendChild(bubble);
    const received: string[] = [];
    host.addEventListener('pure-followup', (e) => {
      if (!(e.target instanceof Element) || !host.contains(e.target)) return;
      received.push((e as CustomEvent<string>).detail);
    });
    appendFollowupChips(bubble, ['好的,继续']);
    (bubble.querySelector<HTMLButtonElement>('.followup-chip')!).click();
    expect(received).toEqual(['好的,继续']);
  });
});
