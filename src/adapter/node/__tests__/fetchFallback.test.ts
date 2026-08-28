// src/adapter/node/__tests__/fetchFallback.test.ts
// Pure-helper tests for the Tier-3 fallback chain (direct retry / meta-refresh
// follow / Wayback / Firecrawl / PDF text). All network is mocked; the PDF
// fixture is generated in-memory with zlib so no binary fixture file is needed.

import { describe, expect, it } from 'bun:test';
import { deflateSync } from 'node:zlib';
import {
  fetchWithRetry,
  extractMetaRefreshUrl,
  resolveRedirectTarget,
  scrapeViaWayback,
  scrapeViaFirecrawl,
  extractPdfText,
} from '../fetchFallback';

/** Build a minimal single-page PDF whose content stream holds `content`. */
function buildPdf(content: string): Uint8Array {
  const deflated = deflateSync(new TextEncoder().encode(content));
  const head = new TextEncoder().encode(
    `%PDF-1.4\n1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R >>\nendobj\n4 0 obj\n<< /Length ${deflated.length} /Filter /FlateDecode >>\nstream\n`,
  );
  const tail = new TextEncoder().encode(
    `\nendstream\nendobj\ntrailer\n<< /Root 1 0 R >>\n%%EOF`,
  );
  return new Uint8Array([...head, ...deflated, ...tail]);
}

describe('fetchWithRetry', () => {
  it('retries transient 5xx with backoff, then succeeds', async () => {
    let calls = 0;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => {
      calls += 1;
      if (calls < 3) return new Response('boom', { status: 503 });
      return new Response('ok', { status: 200 });
    }) as unknown as typeof fetch;
    try {
      const resp = await fetchWithRetry('https://example.com/');
      expect(resp.status).toBe(200);
      expect(calls).toBe(3);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('does not retry a hard 4xx', async () => {
    let calls = 0;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => {
      calls += 1;
      return new Response('nope', { status: 404 });
    }) as unknown as typeof fetch;
    try {
      const resp = await fetchWithRetry('https://example.com/');
      expect(resp.status).toBe(404);
      expect(calls).toBe(1);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('adds a same-origin Referer header', async () => {
    let seen: Headers | undefined;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (_url: unknown, init: RequestInit) => {
      seen = new Headers(init.headers);
      return new Response('ok', { status: 200 });
    }) as unknown as typeof fetch;
    try {
      await fetchWithRetry('https://example.com/page');
      expect(seen?.get('Referer')).toBe('https://example.com');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe('extractMetaRefreshUrl', () => {
  it('parses refresh meta tags in both attribute orders', () => {
    expect(extractMetaRefreshUrl('<meta http-equiv="refresh" content="0; url=https://example.com/new" />')).toBe('https://example.com/new');
    expect(extractMetaRefreshUrl("<meta http-equiv=\"REFRESH\" content=\"5; url='/rel/path'\" />")).toBe('/rel/path');
    expect(extractMetaRefreshUrl('<meta content="0;url=https://a.com/" http-equiv="refresh">')).toBe('https://a.com/');
  });

  it('returns null when absent or not a refresh', () => {
    expect(extractMetaRefreshUrl('<html><body>plain</body></html>')).toBeNull();
    expect(extractMetaRefreshUrl('<meta charset="utf-8">')).toBeNull();
    expect(extractMetaRefreshUrl('<meta http-equiv="refresh" content="5">')).toBeNull();
  });
});

describe('resolveRedirectTarget', () => {
  it('resolves relative targets against the page URL', () => {
    expect(resolveRedirectTarget('https://a.com/x', '/new')).toBe('https://a.com/new');
    expect(resolveRedirectTarget('https://a.com/x', 'https://b.com/y')).toBe('https://b.com/y');
  });
});

describe('scrapeViaWayback', () => {
  it('fetches the closest archived snapshot', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: unknown) => {
      const url = String(input);
      if (url.includes('archive.org/wayback/available')) {
        return new Response(JSON.stringify({ archived_snapshots: { closest: { url: 'https://web.archive.org/web/20260828000000/https://example.com/', status: '200' } } }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      if (url.startsWith('https://web.archive.org/web/')) {
        return new Response('<html><body><h1>Archived</h1><p>snapshot content</p></body></html>', { status: 200 });
      }
      return new Response('nope', { status: 404 });
    }) as unknown as typeof fetch;
    try {
      const html = await scrapeViaWayback('https://example.com/');
      expect(html).toContain('snapshot content');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('returns null when no snapshot exists', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => new Response(JSON.stringify({ archived_snapshots: {} }), { status: 200, headers: { 'Content-Type': 'application/json' } })) as unknown as typeof fetch;
    try {
      expect(await scrapeViaWayback('https://never-archived.example/')).toBeNull();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe('scrapeViaFirecrawl', () => {
  it('is skipped without a key', async () => {
    expect(await scrapeViaFirecrawl('https://example.com/')).toBeNull();
  });

  it('returns markdown when the key is set', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => new Response(JSON.stringify({ success: true, data: { markdown: '# Title\ncontent' } }), { status: 200, headers: { 'Content-Type': 'application/json' } })) as unknown as typeof fetch;
    try {
      const md = await scrapeViaFirecrawl('https://example.com/', 'fc-key');
      expect(md).toContain('# Title');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe('extractPdfText', () => {
  it('extracts text from a FlateDecode Tj content stream', () => {
    const pdf = buildPdf('BT /F1 12 Tf 72 720 Td (Hello PDF world) Tj ET');
    const text = extractPdfText(pdf);
    expect(text).toBe('Hello PDF world');
  });

  it('extracts TJ arrays with kerning offsets', () => {
    const pdf = buildPdf('BT /F1 12 Tf 72 720 Td [(Hel) -20 (lo) 30 ( PDF) 10 (world)] TJ ET');
    const text = extractPdfText(pdf);
    expect(text).toBe('Hel lo PDF world');
  });

  it('handles escaped parentheses in literal strings', () => {
    const pdf = buildPdf('BT /F1 12 Tf 72 720 Td (a \\(parenthesis\\) b) Tj ET');
    const text = extractPdfText(pdf);
    expect(text).toBe('a (parenthesis) b');
  });

  it('returns null for non-PDF bytes', () => {
    expect(extractPdfText(new TextEncoder().encode('definitely not a pdf'))).toBeNull();
  });
});
