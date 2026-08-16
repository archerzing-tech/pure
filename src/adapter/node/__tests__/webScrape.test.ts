// src/adapter/node/__tests__/webScrape.test.ts
// Tier-3 web scrape helpers: noise stripping, selector scoping, HTML/JSON/RSS
// formatting, truncation, and the Jina Reader fallback (network mocked).

import { describe, expect, it, afterEach } from 'bun:test';
import {
  extractBySelector,
  extractScrapeText,
  formatFeedText,
  formatJsonBody,
  isFeedBody,
  scrapeViaFirecrawl,
  scrapeViaJina,
  stripHtml,
  stripNoiseTags,
  truncateText,
} from '../webScrape';

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe('stripNoiseTags', () => {
  it('removes navigation/boilerplate blocks and keeps content', () => {
    const html = '<nav><a>menu</a></nav><header>brand</header><article><p>Real content</p></article><footer>© 2026</footer>';
    const cleaned = stripNoiseTags(html);
    expect(cleaned).not.toContain('menu');
    expect(cleaned).not.toContain('brand');
    expect(cleaned).not.toContain('© 2026');
    expect(cleaned).toContain('Real content');
  });

  it('handles nested noise blocks', () => {
    const html = '<div><nav><div><span>deep</span></div></nav><p>kept</p></div>';
    expect(stripNoiseTags(html)).toBe('<div><p>kept</p></div>');
  });
});

describe('extractBySelector', () => {
  it('scopes by #id', () => {
    const html = '<div id="main"><p>Main content</p></div><div id="sidebar"><p>Side</p></div>';
    expect(extractBySelector(html, '#main')).toEqual(['<p>Main content</p>']);
  });

  it('scopes by .class', () => {
    const html = '<div class="content">A</div><div class="sidebar">B</div>';
    expect(extractBySelector(html, '.content')).toEqual(['A']);
  });

  it('scopes by bare tag name', () => {
    const html = '<article>One</article><p>x</p><article>Two</article>';
    expect(extractBySelector(html, 'article')).toEqual(['One', 'Two']);
  });

  it('returns [] for missing or unsupported selectors', () => {
    const html = '<div id="main">x</div>';
    expect(extractBySelector(html, '#nope')).toEqual([]);
    expect(extractBySelector(html, 'a[b]')).toEqual([]);
    expect(extractBySelector(html, '')).toEqual([]);
  });
});

describe('stripHtml / extractScrapeText', () => {
  it('strips tags and collapses whitespace like the adapter helper', () => {
    expect(stripHtml('<h1>Title</h1><p>Hello world</p>')).toBe('Title\nHello world');
  });

  it('extracts scoped readable text when a selector is given', () => {
    const html = '<nav>menu</nav><main><h1>Story</h1><p>First &amp; second.</p></main>';
    expect(extractScrapeText(html, '#story')).toBe('Story\nFirst & second.');
  });
});

describe('feed detection and formatting', () => {
  const rss = `<?xml version="1.0"?><rss><channel>
    <item><title>First story</title><link>https://example.com/1</link><pubDate>Mon, 11 Aug 2026 10:00:00 GMT</pubDate><description>Lead one.</description></item>
    <item><title>Second story</title><link>https://example.com/2</link><pubDate>Tue, 12 Aug 2026 09:00:00 GMT</pubDate></item>
  </channel></rss>`;

  it('detects feed bodies', () => {
    expect(isFeedBody(rss)).toBe(true);
    expect(isFeedBody('<html><body>not a feed</body></html>')).toBe(false);
  });

  it('formats feeds as a numbered list', () => {
    const text = formatFeedText(rss);
    expect(text).toContain('1. First story');
    expect(text).toContain('https://example.com/1');
    expect(text).toContain('2. Second story');
    expect(text).toContain('Lead one.');
  });
});

describe('formatJsonBody', () => {
  it('pretty-prints valid JSON', () => {
    expect(formatJsonBody('{"a":1,"b":[2,3]}')).toBe('{\n  "a": 1,\n  "b": [\n    2,\n    3\n  ]\n}');
  });

  it('passes through invalid JSON untouched', () => {
    expect(formatJsonBody('not json')).toBe('not json');
  });
});

describe('truncateText', () => {
  it('keeps short text and caps long text with a marker', () => {
    expect(truncateText('abc', 5)).toBe('abc');
    const capped = truncateText('abcdefghij', 5);
    expect(capped).toBe('abcde\n\n[truncated]');
  });
});

describe('scrapeViaJina', () => {
  it('returns readable text from r.jina.ai', async () => {
    globalThis.fetch = (async () =>
      new Response('Readable page text from Jina', { status: 200, headers: { 'Content-Type': 'text/plain' } })
    ) as unknown as typeof fetch;
    expect(await scrapeViaJina('https://example.com/page')).toBe('Readable page text from Jina');
  });

  it('returns null on failure so callers degrade gracefully', async () => {
    globalThis.fetch = (async () => new Response('blocked', { status: 403 })) as unknown as typeof fetch;
    expect(await scrapeViaJina('https://example.com/blocked')).toBeNull();
  });
});

describe('scrapeViaFirecrawl', () => {
  it('POSTs the URL and returns the markdown payload', async () => {
    let posted = '';
    let auth = '';
    globalThis.fetch = (async (_input: any, init: any) => {
      posted = String(init?.body ?? '');
      auth = String((init?.headers as Record<string, string> | undefined)?.Authorization ?? '');
      return new Response(JSON.stringify({ success: true, data: { markdown: '# Clean markdown' } }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }) as unknown as typeof fetch;
    const text = await scrapeViaFirecrawl('https://example.com/page', 'fc-test');
    expect(text).toBe('# Clean markdown');
    expect(posted).toContain('https://example.com/page');
    expect(auth).toBe('Bearer fc-test');
  });

  it('returns null without a key or on failure so callers degrade to the next tier', async () => {
    expect(await scrapeViaFirecrawl('https://example.com/page', '')).toBeNull();
    globalThis.fetch = (async () => new Response('quota', { status: 402 })) as unknown as typeof fetch;
    expect(await scrapeViaFirecrawl('https://example.com/page', 'fc-test')).toBeNull();
  });
});
