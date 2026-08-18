// src/adapter/node/__tests__/searchParser.test.ts
// Mirrors src-tauri/src/lib.rs `web_search_tests` — the Node (CLI) and Rust
// (GUI) search parsers (Bing AND DuckDuckGo) must produce IDENTICAL results
// for the same HTML. These tests lock the shared behavior (entity decoding,
// quote handling, block skipping, max cap) so either side drifting is caught
// by its own suite.

import { describe, expect, it } from 'bun:test';
import {
  parseBingResults,
  parseDuckDuckGoResults,
  parseSogouResults,
  parseSo360Results,
  parseBaiduResults,
  parseBraveResults,
  parseJinaMarkdownResults,
  resolveBingCkUrl,
  normalizeQueryForRetry,
  searxngSearch,
  resultsRelevant,
  significantCJKBigrams,
  containsCJK,
  serperSearch,
  tavilySearch,
  exaSearch,
  firstRelevantResult,
  readResponseText,
  charsetFromContentType,
  sniffHtmlCharset,
} from '../NodeToolAdapter';

describe('Bing HTML result parser (mirrors Rust web_search_tests)', () => {
  it('parses result blocks with titles, snippets, and URLs', () => {
    // Titles/snippets padded with stray whitespace — both parsers
    // strip → decode → trim, so it must not leak into the output.
    const html = `<html><body><ol id="b_results">
<li class="b_algo"><h2><a href="https://rust-lang.org/" h="ID=SERP,5039.1"> Rust Programming Language </a></h2><div class="b_caption"><p> Rust is blazingly fast and memory-efficient. </p></div></li>
<li class="b_algo b_algo_big"><h2><a href="https://www.runoob.com/rust/rust-tutorial.html"> Rust &#10148; 教程 </a></h2><div class="b_caption"><p> Rust 教程 &ensp;&#0183;&ensp;由 Mozilla 主导开发。 </p></div></li>
</ol></body></html>`;
    const results = parseBingResults(html, 10);
    expect(results.length).toBe(2);
    expect(results[0].title).toBe('Rust Programming Language');
    expect(results[0].url).toBe('https://rust-lang.org/');
    expect(results[0].snippet).toContain('memory-efficient');
    expect(results[1].title).toContain('教程');
    expect(results[1].snippet).toContain('Mozilla');
    // Numeric + named entities decoded out of the raw markup — in BOTH the
    // title (&#10148; arrow) and the snippet (&#0183; / &ensp;). Mirrors the
    // Rust assertions exactly.
    expect(results[1].title).not.toContain('&#10148;');
    expect(results[1].snippet).not.toContain('&#');
    expect(results[1].snippet).not.toContain('&ensp;');
  });

  it('stops at max results', () => {
    const html = `<li class="b_algo"><h2><a href="https://a.com">A</a></h2><p>a</p></li><li class="b_algo"><h2><a href="https://b.com">B</a></h2><p>b</p></li><li class="b_algo"><h2><a href="https://c.com">C</a></h2><p>c</p></li>`;
    const results = parseBingResults(html, 2);
    expect(results.length).toBe(2);
    expect(results[0].url).toBe('https://a.com');
    expect(results[1].url).toBe('https://b.com');
  });

  it('skips blocks without links', () => {
    const html = `<li class="b_algo"><div>no link here</div></li><li class="b_algo"><h2><a href="https://ok.com">OK</a></h2><p>snippet</p></li>`;
    const results = parseBingResults(html, 10);
    expect(results.length).toBe(1);
    expect(results[0].url).toBe('https://ok.com');
  });

  it('accepts single-quoted hrefs (mirrors Rust extract_href)', () => {
    const html = `<li class="b_algo"><h2><a href='https://single-quoted.example/x'>Single</a></h2><p>s</p></li>`;
    const results = parseBingResults(html, 10);
    expect(results.length).toBe(1);
    expect(results[0].url).toBe('https://single-quoted.example/x');
  });

  it('parses cn.bing.com markup with the shared parser (mirrors Rust)', () => {
    // cn.bing.com serves the SAME b_algo structure as www.bing.com — this
    // locks that the China backend can reuse parseBingResults unchanged.
    const html = `<li class="b_algo"><h2><a href="https://baike.baidu.com/item/西安"> 西安市（Xi'an City） </a></h2><div class="b_caption"><p> 陕西省省会、副省级市、特大城市。 </p></div></li>`;
    const results = parseBingResults(html, 10);
    expect(results.length).toBe(1);
    expect(results[0].title).toContain('西安');
    expect(results[0].snippet).toContain('省会');
    expect(results[0].url).toBe('https://baike.baidu.com/item/西安');
  });

  it('detects CJK queries for the Chinese-priority backend (mirrors Rust is_chinese_query)', () => {
    expect(containsCJK('查机票，从西安到重庆')).toBe(true);
    expect(containsCJK('西安到重庆 机票 航班 价格')).toBe(true);
    expect(containsCJK('繁體中文')).toBe(true);
    expect(containsCJK("flights Xi'an to Chongqing")).toBe(false);
    expect(containsCJK('rust programming language')).toBe(false);
    expect(containsCJK('')).toBe(false);
  });

  it('yields nothing for a fragment whose </li> never closes', () => {
    // The block-scan breaks when </li> is missing, so a trailing fragment
    // produces no results. (The parseBingBlock titleEnd check is defensive
    // parity with Rust — every real block ends with </li>, which contains a
    // '<', so that branch is unreachable through parseBingResults.)
    const html = `<li class="b_algo"><h2><a href="https://open.example/x">Unclosed title`;
    const results = parseBingResults(html, 10);
    expect(results.length).toBe(0);
  });
});

describe('DuckDuckGo HTML result parser (mirrors Rust web_search_tests)', () => {
  it('parses result blocks with entity-decoded titles, snippets, and URLs', () => {
    // The title/snippet are intentionally padded with stray whitespace:
    // BOTH parsers strip → decode → trim, so the padding must not leak
    // into the parsed output. Locked here so the mirror holds even when
    // real HTML has ragged spacing inside the anchor/snippet tags.
    const html = `<div class="result"><a class="result__a" href="https://rust-lang.org/"> Rust Programming Language </a>
<div class="result__snippet"> Rust is blazingly fast and memory-efficient. </div>
</div>
<div class="result"><a class="result__a" href="https://www.runoob.com/rust/rust-tutorial.html?a=1&amp;b=2"> Rust &#10148; 教程 </a>
<div class="result__snippet"> Rust 教程 &ensp;&#0183;&ensp;由 Mozilla 主导开发。 </div>
</div>`;
    const results = parseDuckDuckGoResults(html, 10);
    expect(results.length).toBe(2);
    expect(results[0].title).toBe('Rust Programming Language');
    expect(results[0].url).toBe('https://rust-lang.org/');
    expect(results[0].snippet).toContain('memory-efficient');
    expect(results[1].title).toContain('教程');
    expect(results[1].snippet).toContain('Mozilla');
    // Numeric + named entities decoded out of the raw markup — the title
    // (&#10148; arrow), the snippet (&#0183; middle dot / &ensp;), and &amp;
    // in the URL. Mirrors the Rust assertions exactly.
    expect(results[1].title).toContain('➤');
    expect(results[1].title).not.toContain('&#10148;');
    expect(results[1].snippet).toContain('·');
    expect(results[1].snippet).not.toContain('&#');
    expect(results[1].snippet).not.toContain('&ensp;');
    expect(results[1].url).toBe('https://www.runoob.com/rust/rust-tutorial.html?a=1&b=2');
  });

  it('stops at max results', () => {
    const html = `<div class="result"><a class="result__a" href="https://a.com/x">A</a>
<div class="result__snippet">a</div>
</div>
<div class="result"><a class="result__a" href="https://b.com/x">B</a>
<div class="result__snippet">b</div>
</div>
<div class="result"><a class="result__a" href="https://c.com/x">C</a>
<div class="result__snippet">c</div>
</div>`;
    const results = parseDuckDuckGoResults(html, 2);
    expect(results.length).toBe(2);
    expect(results[0].url).toBe('https://a.com/x');
    expect(results[1].url).toBe('https://b.com/x');
  });

  it('skips result blocks without a link', () => {
    const html = `<div class="result"><div class="result__snippet">No link here</div>
</div>
<div class="result"><a class="result__a" href="https://ok.com/x">OK Title</a>
<div class="result__snippet">snippet</div>
</div>`;
    const results = parseDuckDuckGoResults(html, 10);
    expect(results.length).toBe(1);
    expect(results[0].url).toBe('https://ok.com/x');
  });
});

describe('Sogou HTML result parser (mirrors Rust parse_sogou_results)', () => {
  it('parses titles with <em> highlights, snippets, and absolutizes /link redirects', () => {
    const html = `<h3 class="vr-title  "  vrcid="title.b429921">
    <a class=" " target="_blank" href="http://u.ctrip.com/union/CtripRedirect.aspx?TypeID=2"  id="sogou_vr_11002601_title_1"  ><em><!--red_beg-->西安到重庆<!--red_end--></em>特价<em><!--red_beg-->机票<!--red_end--></em>查询 携程旅行网提供<span class="tag-website" >认证</span></a>
</h3>
<div class="text-layout ">
<p class="star-wiki base-ellipsis clamp3 space-txt"  vrcid="baike.498ee65"><em><!--red_beg-->西安<!--red_end--></em>到<em><!--red_beg-->重庆<!--red_end--></em>特价<em><!--red_beg-->机票<!--red_end--></em>查询</p>
</div>
<h3 class="vr-title  "  vrcid="title.ba18e87">
    <a class=" " target="_blank" href="/link?url=hedJjaC291MBtMZVirtXo7CqjI0tE6P9O"   >为什么<em><!--red_beg-->从西安去<!--red_end--></em>成都<em><!--red_beg-->的机票<!--red_end--></em>比<em><!--red_beg-->去重庆<!--red_end--></em>贵 ? - 知乎</a>
</h3>
<div class="text-layout ">
<div class="fz-mid space-txt"  vrsid="otherLayout.ab819d7" vrcid="otherLayout.876963e">因此，航空公司能买到的航时，机位资源相对来说会比<em><!--red_beg-->重庆<!--red_end--></em>贵。</div>
</div>
<h3 class="vr-title  "  vrcid="title.c23308d">
    <a class=" " target="_blank" href="https://baike.baidu.com/item/西安" id="sogou_vr_11002601_title_3" >西安</a>
</h3>
<h3 class="vr-title  "  vrcid="title.c23308e">
    <a class=" " target="_blank" href="https://baike.baidu.com/item/西安" id="sogou_vr_11002601_title_4" >西安（dup）</a>
</h3>`;
    const results = parseSogouResults(html, 10);
    expect(results.length).toBe(3); // dedup drops the same-URL repeat
    expect(results[0].title).toContain('西安到重庆');
    expect(results[0].title).toContain('机票');
    expect(results[0].title).not.toContain('<!--');
    expect(results[0].title).not.toContain('<em>');
    expect(results[0].url).toBe('http://u.ctrip.com/union/CtripRedirect.aspx?TypeID=2');
    expect(results[0].snippet).toContain('特价机票');
    expect(results[1].url).toBe('https://www.sogou.com/link?url=hedJjaC291MBtMZVirtXo7CqjI0tE6P9O');
    expect(results[1].title).toContain('重庆');
    expect(results[1].snippet).toContain('重庆');
    expect(results[2].title).toBe('西安');
  });

  it('stops at max results', () => {
    const html = `<h3><a href="https://a.com">A</a></h3><p class="star-wiki">a</p><h3><a href="https://b.com">B</a></h3><p class="star-wiki">b</p><h3><a href="https://c.com">C</a></h3><p class="star-wiki">c</p>`;
    const results = parseSogouResults(html, 2);
    expect(results.length).toBe(2);
    expect(results[0].url).toBe('https://a.com');
    expect(results[1].url).toBe('https://b.com');
  });

  it('skips h3 blocks without anchors', () => {
    const html = `<h3>no link here</h3><h3><a href="https://ok.com">OK</a></h3><p class="star-wiki">s</p>`;
    const results = parseSogouResults(html, 10);
    expect(results.length).toBe(1);
    expect(results[0].url).toBe('https://ok.com');
  });
});

describe('Relevance gate (mirrors Rust results_relevant)', () => {
  it('drops glue chars from significant bigrams', () => {
    expect(significantCJKBigrams('西安到重庆 机票')).toEqual(['西安', '重庆', '机票']);
    const disney = significantCJKBigrams('上海迪士尼门票价格');
    expect(disney).toContain('上海');
    expect(disney).toContain('门票');
    expect(disney).toContain('价格');
    expect(significantCJKBigrams('rust programming')).toEqual([]);
  });

  it('rejects cn.bing.com tourism garbage for a flight query', () => {
    const results = [
      { title: '西安市_百度百科', snippet: '陕西省省会', url: 'https://baike.baidu.com/item/西安' },
      { title: '西安旅游攻略', snippet: '西安必去景点', url: 'https://x.example/1' },
      { title: '西安市人民政府', snippet: '', url: 'https://x.example/2' },
      { title: '西安美食', snippet: '', url: 'https://x.example/3' },
      { title: '西安天气', snippet: '', url: 'https://x.example/4' },
    ];
    expect(resultsRelevant('西安到重庆 机票', results)).toBe(false);
  });

  it('accepts Sogou flight results for the same query', () => {
    const results = [
      { title: '西安到重庆特价机票查询 携程旅行网', snippet: '经过搜狗确认', url: 'http://u.ctrip.com/x' },
      { title: '为什么从西安去成都的机票比去重庆贵', snippet: '', url: 'https://www.sogou.com/link?url=1' },
      { title: '重庆到西安机票比价', snippet: '', url: 'https://x.example/1' },
    ];
    expect(resultsRelevant('西安到重庆 机票', results)).toBe(true);
  });

  it('accepts non-CJK and short queries unconditionally', () => {
    const results = [{ title: 'anything', snippet: '', url: 'https://x.example/1' }];
    expect(resultsRelevant('rust programming language', results)).toBe(true);
    expect(resultsRelevant('机票', results)).toBe(true);
  });
});

describe('Serper API backend (mirrors Rust lib.rs search_backend_serper)', () => {
  it('maps Serper organic results to SearchResult (title/link/snippet)', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({
        organic: [
          { title: '西安到重庆机票查询', link: 'https://flights.example.com/1', snippet: '携程特价机票：西安到重庆 ¥380 起', position: 1 },
          { title: 'Second', link: 'https://b.com', snippet: 'plain snippet' },
          { title: 'No link', snippet: 'x' },
          { title: '', link: 'https://empty.example', snippet: 'y' },
        ],
      }), { status: 200, headers: { 'Content-Type': 'application/json' } })
    ) as unknown as typeof fetch;
    process.env.SERPER_API_KEY = 'serper-test';
    try {
      const results = await serperSearch('西安到重庆 机票', 10);
      expect(results.length).toBe(2);
      expect(results[0].title).toBe('西安到重庆机票查询');
      expect(results[0].url).toBe('https://flights.example.com/1');
      expect(results[0].snippet).toContain('携程');
      expect(results[1].snippet).toBe('plain snippet');
    } finally {
      delete process.env.SERPER_API_KEY;
      globalThis.fetch = originalFetch;
    }
  });

  it('throws when no SERPER_API_KEY is set', async () => {
    delete process.env.SERPER_API_KEY;
    await expect(serperSearch('query', 10)).rejects.toThrow('SERPER_API_KEY');
  });
});

describe('Tavily API backend + parallel first-win (mirrors Rust lib.rs)', () => {
  it('maps Tavily JSON results to SearchResult (title/url/content → snippet)', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({
        results: [
          { title: '西安到重庆机票查询', url: 'https://flights.example.com/1', content: '携程特价机票：西安到重庆 ¥380 起', score: 0.95 },
          { title: 'Second', url: 'https://b.com', content: 'plain snippet' },
        ],
      }), { status: 200, headers: { 'Content-Type': 'application/json' } })
    ) as unknown as typeof fetch;
    process.env.TAVILY_API_KEY = 'tvly-test';
    try {
      const results = await tavilySearch('西安到重庆 机票', 10);
      expect(results.length).toBe(2);
      expect(results[0].title).toBe('西安到重庆机票查询');
      expect(results[0].url).toBe('https://flights.example.com/1');
      expect(results[0].snippet).toContain('携程');
      expect(results[1].snippet).toBe('plain snippet');
    } finally {
      delete process.env.TAVILY_API_KEY;
      globalThis.fetch = originalFetch;
    }
  });

  it('throws when no TAVILY_API_KEY is set', async () => {
    delete process.env.TAVILY_API_KEY;
    await expect(tavilySearch('query', 10)).rejects.toThrow('TAVILY_API_KEY');
  });
  it('first-win: returns the first backend whose results pass the relevance gate', async () => {
    // The slow backend is the RELEVANT one (passes the gate); the fast one is
    // garbage. First-win must wait for the slow good result, not take the fast
    // garbage — same guarantee the old serial chain gave, but without waiting
    // for the slowest backend when a fast good one exists.
    const slowRelevant = async () => {
      await new Promise((r) => setTimeout(r, 30));
      return [
        { title: '西安到重庆特价机票 携程', snippet: '机票查询', url: 'https://ctrip.example/1' },
        { title: '西安到重庆机票价格', snippet: '', url: 'https://x.example/2' },
      ];
    };
    const fastIrrelevant = async () => [
      { title: '西安旅游攻略', snippet: '', url: 'https://x.example/3' },
    ];
    const outcome = await firstRelevantResult('西安到重庆 机票', [
      { label: 'fast-garbage', fetch: fastIrrelevant },
      { label: 'slow-good', fetch: slowRelevant },
    ]);
    expect(outcome.results).toBeDefined();
    expect(outcome.results![0].title).toContain('携程');
    expect(outcome.irrelevant).toBe(1);
  });

  it('aggregates failures when every backend fails the gate or is empty', async () => {
    const garbage = async () => [
      { title: '西安旅游攻略', snippet: '', url: 'https://x.example/3' },
    ];
    const empty = async () => [];
    const failing = async () => { throw new Error('boom'); };
    const outcome = await firstRelevantResult('西安到重庆 机票', [
      { label: 'garbage', fetch: garbage },
      { label: 'empty', fetch: empty },
      { label: 'failing', fetch: failing },
    ]);
    expect(outcome.results).toBeUndefined();
    expect(outcome.irrelevant).toBe(1);
    expect(outcome.anyEmpty).toBe(true);
    expect(outcome.failed.some((f) => f.includes('failing'))).toBe(true);
  });
});

describe('Charset-aware response decoding (mirrors Rust response_text_with_charset)', () => {
  // 中文 in GBK — the exact bytes a Sogou-style page carries. `Response.text()`
  // decodes UTF-8 only (per the Fetch spec), which turns these into mojibake.
  const GBK_ZHONGWEN = new Uint8Array([0xd6, 0xd0, 0xce, 0xc4]);

  it('decodes a GBK body when the Content-Type header declares the charset', async () => {
    const resp = new Response(GBK_ZHONGWEN, {
      headers: { 'Content-Type': 'text/html; charset=gb2312' },
    });
    expect(await readResponseText(resp)).toBe('中文');
  });

  it('decodes a GBK body via the <meta> charset sniff when no header charset is declared', async () => {
    const ascii = '<html><head><meta charset=\'gb2312\'></head><body>';
    const body = new Uint8Array([...new TextEncoder().encode(ascii), ...GBK_ZHONGWEN]);
    const resp = new Response(body, { headers: { 'Content-Type': 'text/html' } });
    expect(await readResponseText(resp)).toContain('中文');
  });

  it('keeps UTF-8 bodies intact when no charset is declared', async () => {
    const resp = new Response('中文', { headers: { 'Content-Type': 'text/html' } });
    expect(await readResponseText(resp)).toBe('中文');
  });

  it('does not re-decode a utf-8/latin1-labeled body (avoids mojibake regressions)', async () => {
    // iso-8859-1 is the classic mislabel on pages that are actually UTF-8.
    const resp = new Response('中文', { headers: { 'Content-Type': 'text/html; charset=iso-8859-1' } });
    expect(await readResponseText(resp)).toBe('中文');
  });

  it('extracts the header charset parameter (mirrors Rust charset_from_content_type)', () => {
    expect(charsetFromContentType('text/html; charset=gb2312')).toBe('gb2312');
    expect(charsetFromContentType('text/html; charset="utf-8"')).toBe('utf-8');
    expect(charsetFromContentType('text/html')).toBeUndefined();
  });

  it('sniffs the <meta> charset tag (mirrors Rust sniff_html_charset)', () => {
    expect(sniffHtmlCharset(new TextEncoder().encode('<meta http-equiv="Content-Type" content="text/html; charset=GBK">'))).toBe('GBK');
    expect(sniffHtmlCharset(new TextEncoder().encode('<meta charset=UTF-8>'))).toBe('UTF-8');
    expect(sniffHtmlCharset(new TextEncoder().encode('<html><body>no meta</body></html>'))).toBeUndefined();
  });
});

describe('Exa API backend', () => {
  it('maps Exa results to SearchResult with the publish date in the title', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({
        results: [
          { title: 'Exa result one', url: 'https://exa.example/1', text: 'content one', publishedDate: '2026-08-10T00:00:00.000Z' },
          { title: 'Exa result two', url: 'https://exa.example/2', text: 'content two' },
          { title: 'No url', text: 'x' },
        ],
      }), { status: 200, headers: { 'Content-Type': 'application/json' } })
    ) as unknown as typeof fetch;
    process.env.EXA_API_KEY = 'exa-test';
    try {
      const results = await exaSearch('rust web framework', 10);
      expect(results.length).toBe(2);
      expect(results[0].title).toContain('Exa result one');
      expect(results[0].title).toContain('2026-08-10');
      expect(results[0].url).toBe('https://exa.example/1');
      expect(results[1].snippet).toBe('content two');
    } finally {
      delete process.env.EXA_API_KEY;
      globalThis.fetch = originalFetch;
    }
  });

  it('throws when no EXA_API_KEY is set', async () => {
    delete process.env.EXA_API_KEY;
    await expect(exaSearch('query', 10)).rejects.toThrow('EXA_API_KEY');
  });
});

describe('360 Search (so.com) parser (mirrors Rust parse_so360_results)', () => {
  it('parses res-list blocks, honoring data-mdurl over the redirect href', () => {
    const html = `<li class="res-list"><h3 class="res-title"><a href="https://www.so.com/link?m=abc" data-mdurl="https://blog.csdn.net/rust/123" rel="noopener">了解<em>Rust语言</em>-CSDN博客</a></h3><div class="res-rich so-rich-blog clearfix"><div class="res-comm-con"><p class="res-desc"><span class="res-list-summary">Rust 是一门系统编程语言。</span></p></div></div></li>
<li class="res-list"><h3 class="res-title"><a href="/link?m=def">无 mdurl 的结果</a></h3><p class="res-desc">摘要</p></li>`;
    const results = parseSo360Results(html, 10);
    expect(results.length).toBe(2);
    expect(results[0].title).toBe('了解Rust语言-CSDN博客');
    expect(results[0].url).toBe('https://blog.csdn.net/rust/123');
    expect(results[0].snippet).toContain('系统编程语言');
    expect(results[1].url).toBe('https://www.so.com/link?m=def');
  });
});

describe('Baidu parser (mirrors Rust parse_baidu_results)', () => {
  it('parses c-container blocks via data-tools JSON and h3 fallback', () => {
    const html = `<div class="result c-container" id="1"><h3 class="t"><a href="https://baike.baidu.com/item/rust">Rust语言百科</a></h3><div class="c-abstract">Rust 是一门系统编程语言。</div></div>
<div class="result c-container" id="2" data-tools='{"title":"百度百科","url":"https://baike.example/2"}'><div class="content-right_8Zs40">工具摘要</div></div>`;
    const results = parseBaiduResults(html, 10);
    expect(results.length).toBe(2);
    expect(results[0].title).toBe('Rust语言百科');
    expect(results[0].url).toBe('https://baike.baidu.com/item/rust');
    expect(results[0].snippet).toContain('系统编程');
    expect(results[1].title).toBe('百度百科');
    expect(results[1].url).toBe('https://baike.example/2');
  });
});

describe('Brave parser (mirrors Rust parse_brave_results)', () => {
  it('parses snippet blocks with rotating svelte class suffixes', () => {
    const html = `<div class="snippet svelte-jmfu5f" data-pos="0" data-type="web"><div class="result-wrapper svelte-1rq4ngz"><div class="result-content svelte-1rq4ngz"><a href="https://rust-lang.org/" target="_self" class="svelte-14r20fy l1"><div class="site-name-wrapper svelte-on1hvy">rust-lang.org</div></a><div class="title search-snippet-title line-clamp-1 svelte-14r20fy">Rust Programming Language</div><p class="generic-snippet svelte-1cwdgg3">A language empowering everyone to build reliable software.</p></div></div></div>
<div class="snippet svelte-jmfu5f" data-pos="1" data-type="web"><div class="result-wrapper svelte-1rq4ngz"><a href="https://example.com/2"><div class="title search-snippet-title svelte-14r20fy">Two</div></a><p class="generic-snippet svelte-1cwdgg3">s2</p></div></div>`;
    const results = parseBraveResults(html, 10);
    expect(results.length).toBe(2);
    expect(results[0].title).toBe('Rust Programming Language');
    expect(results[0].url).toBe('https://rust-lang.org/');
    expect(results[0].snippet).toContain('empowering');
    expect(results[1].url).toBe('https://example.com/2');
  });
});

describe('Jina markdown parser (mirrors Rust parse_jina_markdown_results)', () => {
  it('parses numbered markdown headings and resolves Bing ck/a redirects', () => {
    const md = `Title: rust language - Bing

URL Source: https://www.bing.com/search?q=rust+language

Markdown Content:
About 16,200 results

1.   ## [**Rust** Programming **Language**](https://www.bing.com/ck/a?!&&p=abc&u=aHR0cHM6Ly9ydXN0LWxhbmcub3JnLw&ntb=1)

A language empowering everyone to build reliable and efficient software.

2.   ## [Install **Rust**](https://www.bing.com/ck/a?u=a1aHR0cHM6Ly9ydXN0LWxhbmcub3JnL3Rvb2xzL2luc3RhbGwv)

Install the toolchain.
`;
    const results = parseJinaMarkdownResults(md, 10);
    expect(results.length).toBe(2);
    expect(results[0].title).toBe('Rust Programming Language');
    expect(results[0].url).toBe('https://rust-lang.org/');
    expect(results[0].snippet).toContain('empowering');
    expect(results[1].url).toBe('https://rust-lang.org/tools/install/');
  });

  it('leaves plain URLs untouched and decodes percent-encoded base64', () => {
    expect(resolveBingCkUrl('https://example.com/page')).toBe('https://example.com/page');
    expect(resolveBingCkUrl('https://www.bing.com/ck/a?u=aHR0cHM6Ly9leGFtcGxlLmNvbS8%3D&ntb=1')).toBe('https://example.com/');
  });
});

describe('Query normalization retry (mirrors Rust normalize_query_for_retry)', () => {
  it('strips operators, quotes, and punctuation', () => {
    expect(normalizeQueryForRetry('"rust" site:rust-lang.org 2026')).toBe('rust 2026');
    expect(normalizeQueryForRetry('西安到重庆 机票？（价格）')).toBe('西安到重庆 机票 价格');
  });
  it('returns null when nothing would change', () => {
    expect(normalizeQueryForRetry('plain query')).toBeNull();
    expect(normalizeQueryForRetry('西安天气')).toBeNull();
  });
});

describe('SearXNG JSON backend', () => {
  it('maps SearXNG JSON results to SearchResult', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({
        results: [
          { title: 'Rust', url: 'https://rust-lang.org/', content: 's1' },
          { title: '', url: 'https://empty.example/', content: 'skip me' },
          { title: 'T2', url: 'https://t2.example/', content: 's2' },
        ],
      }), { status: 200, headers: { 'Content-Type': 'application/json' } })
    ) as unknown as typeof fetch;
    process.env.SEARXNG_URL = 'https://searxng.internal';
    try {
      const results = await searxngSearch('rust', 10);
      expect(results.length).toBe(2);
      expect(results[0].title).toBe('Rust');
      expect(results[1].snippet).toBe('s2');
    } finally {
      delete process.env.SEARXNG_URL;
      globalThis.fetch = originalFetch;
    }
  });

  it('throws when SEARXNG_URL is not set', async () => {
    delete process.env.SEARXNG_URL;
    await expect(searxngSearch('query', 10)).rejects.toThrow('SEARXNG_URL');
  });
});
