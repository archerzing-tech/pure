// src/adapter/node/__tests__/searchParser.test.ts
// Mirrors src-tauri/src/lib.rs `web_search_tests` — the Node (CLI) and Rust
// (GUI) search parsers (Bing AND DuckDuckGo) must produce IDENTICAL results
// for the same HTML. These tests lock the shared behavior (entity decoding,
// quote handling, block skipping, max cap) so either side drifting is caught
// by its own suite.

import { describe, expect, it } from 'bun:test';
import { parseBingResults, parseDuckDuckGoResults, containsCJK } from '../NodeToolAdapter';

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
