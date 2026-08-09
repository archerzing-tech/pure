// src/ui/__tests__/statsExportToast.test.ts
import { describe, it, expect } from 'bun:test';
import { buildExportSavedToast } from '../statsExportToast';

describe('buildExportSavedToast', () => {
  it('embeds the saved path as a clickable .path-link', () => {
    const html = buildExportSavedToast('/Users/me/report.md');
    expect(html).toContain('class="path-link"');
    expect(html).toContain('data-path="/Users/me/report.md"');
    expect(html).toContain('title="/Users/me/report.md"');
    expect(html).toContain('/Users/me/report.md');
  });

  it('escapes the path for both attribute and text', () => {
    const html = buildExportSavedToast('/tmp/a"b<c>.md');
    expect(html).not.toContain('a"b<c>.md');
    expect(html).toContain('a&quot;b&lt;c&gt;.md');
  });
});
