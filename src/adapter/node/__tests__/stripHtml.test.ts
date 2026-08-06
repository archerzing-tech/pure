// src/adapter/node/__tests__/stripHtml.test.ts
// Mirrors src-tauri/src/lib.rs `web_fetch_tests` — the Node (CLI) and Rust
// (GUI) web_fetch text extractors must produce IDENTICAL results on the
// common core: tag stripping, script/style removal, <br> and block tags as
// line breaks, and whitespace collapsed to trimmed non-empty lines. These
// tests lock the shared behavior so either side drifting is caught by its
// own suite.
//
// KNOWN INTENTIONAL DIVERGENCES (pinned separately below — do NOT "unify"
// blindly):
// 1. Entities — the shared stripHtml helper keeps raw entities (&amp; stays
//    &amp;), because it also feeds the DDG/Bing parsers which decode AFTER
//    stripping (decoding in the helper would double-decode &amp;copy; → ©).
//    The web_fetch PIPELINE however decodes, via extractReadableText (tested
//    below) — matching the Rust strip_html_full, which also decodes after
//    stripping.
// 2. Tag boundaries — this side only inserts breaks for <br> and the block
//    closers </p>, </div>, </h1-6>, </li>, </tr>, </section>, </article>;
//    every other tag (inline <b>/<span>, table <td>/<th> cells, attribute-
//    bearing <br class="…">) is removed WITHOUT a break ("Hello world",
//    "AB" for two cells). Rust inserts a line break at EVERY tag boundary
//    ("Hello\nworld", "A\nB").

import { describe, expect, it } from 'bun:test';
import { extractReadableText, stripHtml } from '../NodeToolAdapter';

describe('web_fetch stripHtml (mirrors Rust strip_html_full)', () => {
  // ── Common core: identical fixtures + identical assertions on both sides ──

  it('passes plain text through', () => {
    expect(stripHtml('Hello world')).toBe('Hello world');
  });

  it('strips tags and collapses block layout to lines', () => {
    expect(stripHtml('<h1>Title</h1><p>Hello world</p>')).toBe('Title\nHello world');
  });

  it('turns paragraphs into separate lines', () => {
    const html = '<div><p>First paragraph.</p><p>Second paragraph.</p></div>';
    expect(stripHtml(html)).toBe('First paragraph.\nSecond paragraph.');
  });

  it('treats <br> as a line break', () => {
    expect(stripHtml('a<br>b')).toBe('a\nb');
  });

  it('drops script and style blocks entirely', () => {
    const html = '<script>var x = 1;</script><style>.c { color: red }</style><p>Clean</p>';
    expect(stripHtml(html)).toBe('Clean');
  });

  it('strips uppercase and mixed-case script/style (case-insensitive like Rust)', () => {
    expect(stripHtml('<SCRIPT>var x=1;</SCRIPT><p>Ok</p>')).toBe('Ok');
    expect(stripHtml('<ScRiPt type="text/javascript">var y=2;</ScRiPt><Style>.a{}</Style><p>Hi</p>')).toBe('Hi');
  });

  it('treats script-like tags as plain tags', () => {
    // <scripture> only STARTS with "script" — the open-tag boundary check on
    // the Rust side keeps it out of skip mode; both sides strip it like any
    // other tag.
    expect(stripHtml('<scripture>foo</scripture>')).toBe('foo');
  });

  it('collapses indentation but keeps inner spacing', () => {
    const html = '<div>\n  <p>  Indented  text  </p>\n</div>';
    expect(stripHtml(html)).toBe('Indented  text');
  });

  // ── Documented divergences (each side pinned; see file header) ──

  it('keeps HTML entities raw at the stripHtml level (shared with parsers — intentional)', () => {
    // The web_fetch pipeline decodes AFTER stripping (extractReadableText,
    // below); the helper itself must stay raw for the DDG/Bing parse paths.
    expect(stripHtml('<p>Tom &amp; Jerry</p>')).toBe('Tom &amp; Jerry');
  });

  it('keeps inline-tag content on the same line (Rust splits — intentional)', () => {
    expect(stripHtml('<p>Hello <b>world</b></p>')).toBe('Hello world');
  });

  it('merges table cells (Rust splits — intentional)', () => {
    // <td>/<th> are outside the block list; only </tr> separates rows here.
    const html = '<table><tr><td>A</td><td>B</td></tr><tr><td>C</td></tr></table>';
    expect(stripHtml(html)).toBe('AB\nC');
  });

  it('merges across attribute-bearing <br> (Rust splits — intentional)', () => {
    // The <br\s*/?> regex only matches bare/self-closed <br>; <br class="…">
    // falls through to generic removal with no break.
    expect(stripHtml('a<br class="x">b')).toBe('ab');
  });
});

describe('web_fetch extractReadableText (pipeline: strip + decode, mirrors Rust strip_html_full)', () => {
  it('decodes named and numeric entities (Rust decodes_html_entities)', () => {
    // Same assertion as the Rust strip_html_full test — both pipelines
    // produce identical text from the same HTML.
    expect(extractReadableText('<p>Tom &amp; Jerry</p>')).toBe('Tom & Jerry');
    expect(extractReadableText('<p>A &#38; B &#0183; C</p>')).toBe('A & B · C');
  });

  it('does not double-decode (&amp;copy; stays literal &copy;)', () => {
    // The reason decoding lives HERE and not in shared stripHtml: a single
    // decode pass turns &amp;copy; into the literal text &copy; (what a
    // browser shows). Decoding twice would corrupt it into ©.
    expect(extractReadableText('<p>&amp;copy;</p>')).toBe('&copy;');
  });

  it('decodes &nbsp; AFTER trim (trailing space stays — matches Rust)', () => {
    // Locks the trim-then-decode ordering: &nbsp; is literal text at trim
    // time, so it survives to decode and becomes a trailing space. A
    // decode-then-trim order would strip it ("a") and diverge from the Rust
    // strip_html_full, which also trims before html_decode.
    expect(extractReadableText('<p>a&nbsp;</p>')).toBe('a ');
  });

  it('still strips tags and collapses layout before decoding', () => {
    expect(extractReadableText('<h1>Title</h1><p>Tom &amp; Jerry</p>')).toBe('Title\nTom & Jerry');
  });
});
