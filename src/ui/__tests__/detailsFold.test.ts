// src/ui/__tests__/detailsFold.test.ts
// Collapsible <details> blocks: models fold long reference material (full
// logs, long quotes) into <details><summary>…</summary>…</details>. The pure
// side of that promise is marked's HTML passthrough — pinned here.
//
// Deliberately DOM-free: "DOMPurify keeps details/input in its default
// allow-list" is the library's own behavior, not pure's — and pinning it here
// means importing dompurify in a test file, which detonates the known
// cross-file mock landmine (streaming test files mock.module('dompurify') as
// an identity OBJECT; bun test is single-process, so any later-loading file
// that calls createDOMPurify(window) gets the mock and dies — 2026-10-18
// full-suite case). Real-WebView rendering of the folded card is covered by
// the styles block and manual QA.
import { describe, it, expect } from 'bun:test';
import { marked } from 'marked';

describe('details 折叠卡(marked HTML passthrough)', () => {
  it('<details>/<summary> pass through marked untouched', () => {
    const html = marked.parse(
      '前文\n\n<details><summary>完整日志</summary><p>2026-10-17 ...</p></details>\n\n后文',
      { gfm: true, breaks: true },
    ) as string;
    expect(html).toContain('<details><summary>完整日志</summary>');
    expect(html).toContain('</details>');
    expect(html).toContain('前文');
    expect(html).toContain('后文');
  });

  it('the open attribute passes through too (models may author default-open)', () => {
    const html = marked.parse('<details open><summary>s</summary>b</details>', { gfm: true, breaks: true }) as string;
    expect(html).toContain('<details open>');
  });
});
