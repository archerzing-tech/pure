// src/adapter/node/fileText.ts
// Node mirror of the Rust format-aware text extraction engine (lib.rs):
// encoding detection (UTF-8/UTF-16/GB18030/Big5), ZIP office formats
// (docx/xlsx/pptx/odt via jszip), PDF (raw stream scan + zlib inflate +
// ToUnicode CMap), RTF, and binary detection with actionable notes.
// Returns (text, note) — note is ONLY set when nothing usable was extracted.

import { inflateRawSync, inflateSync } from 'node:zlib';

export interface ExtractedText {
  text: string;
  note: string;
}

/** Hard cap for read_file — a file above this gets an actionable error. */
export const MAX_READ_BYTES = 64 * 1024 * 1024;
/** search_files skips files above this size (they would dominate the scan). */
export const MAX_SEARCH_FILE_BYTES = 32 * 1024 * 1024;

function hexDigit(b: number): number {
  if (b >= 0x30 && b <= 0x39) return b - 0x30;
  if (b >= 0x61 && b <= 0x66) return b - 0x61 + 10;
  if (b >= 0x41 && b <= 0x46) return b - 0x41 + 10;
  return 16;
}

/**
 * Decode plain-text bytes with BOM detection and a CJK-friendly fallback
 * chain: UTF-8 strict → GB18030 (covers GBK, the ANSI default on Chinese
 * Windows) → Big5 → lossy Latin-1. TextDecoder never fails, so the GB18030
 * step effectively catches every legacy-CJK file.
 */
export function decodeTextBytes(bytes: Uint8Array): string {
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    return new TextDecoder('utf-8').decode(bytes.subarray(3));
  }
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) {
    return new TextDecoder('utf-16le').decode(bytes.subarray(2));
  }
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
    return new TextDecoder('utf-16be').decode(bytes.subarray(2));
  }
  // Strict UTF-8 first: replacement chars mean the file is NOT valid UTF-8.
  const utf8 = new TextDecoder('utf-8', { fatal: true });
  try {
    return utf8.decode(bytes);
  } catch {
    // fall through to legacy CJK decoders
  }
  const gbk = new TextDecoder('gb18030').decode(bytes);
  // GB18030 decodes almost anything; Big5 only wins for its own char sets.
  // There's no cheap round-trip check here, so prefer GB18030 (covers the
  // common Chinese-Windows case) and fall back to Big5 only when the GBK
  // decode produced replacement chars.
  if (!gbk.includes('\uFFFD')) return gbk;
  const big5 = new TextDecoder('big5').decode(bytes);
  if (!big5.includes('\uFFFD')) return big5;
  return gbk;
}

function unescapeXmlEntities(s: string): string {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex: string) => {
      const cp = parseInt(hex, 16);
      return Number.isFinite(cp) && cp >= 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : '';
    })
    .replace(/&#(\d+);/g, (_, dec: string) => {
      const cp = parseInt(dec, 10);
      return Number.isFinite(cp) && cp >= 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : '';
    });
}

/**
 * Collect the text content inside every `<tag>…</tag>` element of an XML
 * document (docx `<w:t>`, xlsx `<t>`, pptx `<a:t>`, odt `<text:p>`). Nested
 * tags are flattened; XML entities are decoded; paragraphs joined with \n.
 * (docx XML is well-formed, so the regex equivalent of the Rust
 * quick-xml walk is reliable here.)
 */
export function xmlTextInTag(xml: string, tag: string): string {
  const re = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)</${tag}>`, 'g');
  const parts: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml)) !== null) {
    const inner = m[1]!.replace(/<[^>]*>/g, '');
    const trimmed = unescapeXmlEntities(inner).trim();
    if (trimmed) parts.push(trimmed);
  }
  return parts.join('\n');
}

/** Extract text from a single named XML entry of a ZIP container (docx/xlsx). */
export async function zipEntryXmlText(bytes: Uint8Array, entry: string, tag: string): Promise<string | null> {
  try {
    const { default: JSZip } = await import('jszip');
    const zip = await JSZip.loadAsync(bytes);
    const file = zip.file(entry);
    if (!file) return null;
    const xml = await file.async('string');
    const text = xmlTextInTag(xml, tag);
    return text.trim() ? text : null;
  } catch {
    return null;
  }
}

/** Extract text from every XML entry whose name matches `predicate`. */
export async function zipEntriesXmlText(
  bytes: Uint8Array,
  predicate: (name: string) => boolean,
  tag: string,
): Promise<string | null> {
  try {
    const { default: JSZip } = await import('jszip');
    const zip = await JSZip.loadAsync(bytes);
    const out: string[] = [];
    let any = false;
    for (const name of Object.keys(zip.files)) {
      if (!predicate(name)) continue;
      const file = zip.files[name]!;
      if (file.dir) continue;
      try {
        const xml = await file.async('string');
        const text = xmlTextInTag(xml, tag);
        if (text.trim()) {
          out.push(text);
          any = true;
        }
      } catch {
        // skip unreadable entries
      }
    }
    return any ? out.join('\n') : null;
  } catch {
    return null;
  }
}

// ── PDF ────────────────────────────────────────────────────────────────────

/** Locate every `stream … endstream` body in a PDF byte buffer (raw scan). */
export function pdfStreams(bytes: Uint8Array): Uint8Array[] {
  const out: Uint8Array[] = [];
  let i = 0;
  const len = bytes.length;
  while (i + 6 <= len) {
    if (bytes[i] === 0x73 && bytes[i + 1] === 0x74 && bytes[i + 2] === 0x72 && bytes[i + 3] === 0x65 && bytes[i + 4] === 0x61 && bytes[i + 5] === 0x6d) {
      // "stream"
      let j = i + 6;
      if (j < len && bytes[j] === 0x0d) j += 1;
      if (j < len && bytes[j] === 0x0a) j += 1;
      const start = j;
      // findSequence returns an ABSOLUTE position (its search starts at `j`)
      const endAbs = findSequence(bytes, j, new Uint8Array([0x65, 0x6e, 0x64, 0x73, 0x74, 0x72, 0x65, 0x61, 0x6d]));
      if (endAbs >= 0) {
        let end = endAbs;
        while (end > start && (bytes[end - 1] === 0x0a || bytes[end - 1] === 0x0d)) end -= 1;
        out.push(bytes.slice(start, end));
        i = endAbs + 9;
        continue;
      }
    }
    i += 1;
  }
  return out;
}

function findSequence(haystack: Uint8Array, from: number, needle: Uint8Array): number {
  outer: for (let i = from; i + needle.length <= haystack.length; i++) {
    for (let k = 0; k < needle.length; k++) {
      if (haystack[i + k] !== needle[k]) continue outer;
    }
    return i;
  }
  return -1;
}

/** Inflate a PDF stream: try zlib-wrapped first, then raw deflate. */
export function inflatePdfStream(stream: Uint8Array): Uint8Array | null {
  try {
    const out = inflateSync(stream);
    if (out.length > 0) return out;
  } catch {
    // fall through
  }
  try {
    const out = inflateRawSync(stream);
    if (out.length > 0) return out;
  } catch {
    // fall through
  }
  return null;
}

export function isAsciiText(bytes: Uint8Array): boolean {
  if (bytes.length === 0) return false;
  for (const b of bytes) {
    if (!(b === 0x0a || b === 0x0d || b === 0x09 || (b >= 0x20 && b <= 0x7e))) return false;
  }
  return true;
}

export function looksLikePdfContent(text: string): boolean {
  return text.includes('Tj') || text.includes('TJ') || text.includes('BT') || text.includes('Tf');
}

/** Two hex chars = one byte; two bytes = one big-endian code unit. */
export function hexToUnits(hex: string): number[] {
  const bytes = new TextEncoder().encode(hex);
  const units: number[] = [];
  let pending: number | null = null;
  let i = 0;
  while (i + 1 < bytes.length) {
    const hi = hexDigit(bytes[i]!);
    const lo = hexDigit(bytes[i + 1]!);
    if (hi < 16 && lo < 16) {
      const byte = (hi << 4) | lo;
      if (pending === null) {
        pending = byte;
      } else {
        units.push(((pending as number) << 8) | byte);
        pending = null;
      }
    }
    i += 2;
  }
  if (pending !== null) units.push(pending);
  return units;
}

export function parsePdfCmap(data: Uint8Array): Map<number, number[]> {
  const text = new TextDecoder().decode(data);
  const map = new Map<number, number[]>();
  const bfcharRe = /beginbfchar([\s\S]*?)endbfchar/g;
  let section: RegExpExecArray | null;
  while ((section = bfcharRe.exec(text)) !== null) {
    const pair = /<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>/g;
    let m: RegExpExecArray | null;
    while ((m = pair.exec(section[1]!)) !== null) {
      const src = hexToUnits(m[1]!)[0];
      if (src !== undefined) map.set(src, hexToUnits(m[2]!));
    }
  }
  const bfrangeRe = /beginbfrange([\s\S]*?)endbfrange/g;
  while ((section = bfrangeRe.exec(text)) !== null) {
    const range = /<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>\s*(?:<([0-9A-Fa-f]+)>|\[([^\]]*)\])/g;
    let m: RegExpExecArray | null;
    while ((m = range.exec(section[1]!)) !== null) {
      const lo = hexToUnits(m[1]!)[0];
      const hi = hexToUnits(m[2]!)[0];
      if (lo === undefined || hi === undefined) continue;
      if (m[3] !== undefined) {
        const dst = hexToUnits(m[3]);
        let code = lo;
        while (code <= hi) {
          map.set(code, [...dst]);
          // dst increments as a big-endian number for the next code
          for (let k = dst.length - 1; k >= 0; k--) {
            const next = (dst[k]! + 1) & 0xffff;
            dst[k] = next;
            if (next !== 0) break;
          }
          code = (code + 1) & 0xffff;
        }
      } else if (m[4] !== undefined) {
        const list = /<([0-9A-Fa-f]+)>/g;
        let k = 0;
        let item: RegExpExecArray | null;
        while ((item = list.exec(m[4])) !== null) {
          const code = (lo + k) & 0xffff;
          if (code <= hi) map.set(code, hexToUnits(item[1]!));
          k += 1;
        }
      }
    }
  }
  return map;
}

/**
 * Read one PDF string starting at `i` (`(` literal or `<` hex). Returns the
 * decoded text and the index just past the closing delimiter.
 */
export function readPdfString(
  bytes: Uint8Array,
  i: number,
  cmaps: Map<number, number[]>[],
): { text: string; next: number } {
  if (bytes[i] === 0x28) {
    // '(' literal string
    const out: number[] = [];
    let j = i + 1;
    while (j < bytes.length) {
      const b = bytes[j]!;
      if (b === 0x5c) {
        // backslash escape
        j += 1;
        if (j >= bytes.length) break;
        const e = bytes[j]!;
        if (e === 0x6e) out.push(0x0a);
        else if (e === 0x72) out.push(0x0d);
        else if (e === 0x74) out.push(0x09);
        else if (e === 0x62) out.push(8);
        else if (e === 0x66) out.push(12);
        else if (e >= 0x30 && e <= 0x37) {
          let octal = 0;
          for (let k = 0; k < 3; k++) {
            if (j < bytes.length && bytes[j]! >= 0x30 && bytes[j]! <= 0x37) {
              octal = octal * 8 + (bytes[j]! - 0x30);
              j += 1;
            } else {
              break;
            }
          }
          out.push(octal & 0xff);
          j -= 1;
        } else {
          out.push(e);
        }
        j += 1;
      } else if (b === 0x29) {
        return { text: new TextDecoder('utf-8', { fatal: false }).decode(Uint8Array.from(out)), next: j + 1 };
      } else {
        out.push(b);
        j += 1;
      }
    }
    return { text: new TextDecoder().decode(Uint8Array.from(out)), next: j };
  }
  // hex string <…> — codes map through the document's ToUnicode CMaps
  let close = i;
  while (close < bytes.length && bytes[close] !== 0x3e) close += 1;
  const hex = new TextDecoder().decode(bytes.subarray(i + 1, close));
  const units = hexToUnits(hex);
  let out = '';
  let k = 0;
  while (k < units.length) {
    const code = units[k]!;
    const mapped = cmaps.find((cmap) => cmap.has(code))?.get(code);
    if (mapped) {
      if (mapped.length >= 2 && mapped[0]! >= 0xd800 && mapped[0]! <= 0xdbff && mapped[1]! >= 0xdc00 && mapped[1]! <= 0xdfff) {
        const cp = 0x10000 + (((mapped[0]! - 0xd800) << 10) | (mapped[1]! - 0xdc00));
        out += String.fromCodePoint(cp);
        k += 2;
        continue;
      }
      for (const u of mapped) {
        out += String.fromCodePoint(u);
      }
      k += 1;
      continue;
    }
    if (code < 256) {
      out += String.fromCharCode(code);
    }
    k += 1;
  }
  return { text: out, next: close + 1 };
}

/**
 * Extract the text of one PDF content stream: literal `(…)` and hex `<…>`
 * strings, TJ arrays, with newlines at positioning operators.
 */
export function pdfContentText(content: Uint8Array, cmaps: Map<number, number[]>[]): string {
  let out = '';
  let line = '';
  const flush = () => {
    if (line) {
      out += line + '\n';
      line = '';
    }
  };
  let i = 0;
  const n = content.length;
  while (i < n) {
    const b = content[i]!;
    if (b === 0x28 || b === 0x3c) {
      const { text, next } = readPdfString(content, i, cmaps);
      line += text;
      i = next;
    } else if (b === 0x5b) {
      // TJ array: strings (and kerning numbers) until the closing ]
      i += 1;
      while (i < n && content[i] !== 0x5d) {
        if (content[i] === 0x28 || content[i] === 0x3c) {
          const { text, next } = readPdfString(content, i, cmaps);
          line += text;
          i = next;
        } else {
          i += 1;
        }
      }
      if (i < n) i += 1;
    } else if ((b >= 0x41 && b <= 0x5a) || (b >= 0x61 && b <= 0x7a)) {
      const start = i;
      while (i < n && ((content[i]! >= 0x41 && content[i]! <= 0x5a) || (content[i]! >= 0x61 && content[i]! <= 0x7a))) i += 1;
      const op = new TextDecoder().decode(content.subarray(start, i));
      if (['Tj', 'TJ', 'Td', 'TD', 'T*', 'Tm', 'TL', 'BT', 'ET', "'", '"'].includes(op)) {
        flush();
      }
    } else {
      i += 1;
    }
  }
  flush();
  return out;
}

/** Best-effort PDF text extraction (mirror of the Rust pdf_extract_text). */
export function pdfExtractText(bytes: Uint8Array): ExtractedText {
  const streams = pdfStreams(bytes);
  const cmaps: Map<number, number[]>[] = [];
  const contents: Uint8Array[] = [];
  for (const raw of streams) {
    let data = inflatePdfStream(raw);
    if (!data || data.length === 0) {
      data = isAsciiText(raw) ? raw : null;
    }
    if (!data) continue;
    const text = new TextDecoder().decode(data);
    if (text.includes('beginbfchar') || text.includes('beginbfrange')) {
      cmaps.push(parsePdfCmap(data));
    } else if (looksLikePdfContent(text)) {
      contents.push(data);
    }
  }
  let extracted = '';
  for (const content of contents) {
    extracted += pdfContentText(content, cmaps);
  }
  const trimmed = extracted.trim();
  if (!trimmed) {
    return {
      text: '',
      note: 'PDF 未提取到文本：可能是扫描/图片型 PDF（无文本层），或使用了无法解析的字体编码。可尝试用 OCR 工具，或把 PDF 转成文本/图片后再读取。',
    };
  }
  return { text: trimmed, note: '' };
}

// ── RTF ────────────────────────────────────────────────────────────────────

/**
 * Extract readable text from RTF (Chinese WordPad/WPS RTF escapes text as
 * `\'hh` GBK bytes; newer files use `\uN` unicode escapes — both handled).
 */
export function rtfExtractText(bytes: Uint8Array): string {
  const ansiBytes: number[] = [];
  let unicode = '';
  let isGbk = false;
  let i = 0;
  const n = bytes.length;
  while (i < n) {
    const b = bytes[i]!;
    if (b === 0x5c) {
      // backslash control
      i += 1;
      if (i >= n) break;
      if (bytes[i] === 0x27) {
        // \'hh — one ANSI byte
        i += 1;
        if (i + 1 < n) {
          const hi = hexDigit(bytes[i]!);
          const lo = hexDigit(bytes[i + 1]!);
          if (hi < 16 && lo < 16) ansiBytes.push(hi * 16 + lo);
          i += 2;
        }
      } else if (bytes[i] === 0x75) {
        // \uN
        i += 1;
        let sign = 1;
        if (i < n && bytes[i] === 0x2d) {
          sign = -1;
          i += 1;
        }
        let num = 0;
        while (i < n && bytes[i]! >= 0x30 && bytes[i]! <= 0x39) {
          num = num * 10 + (bytes[i]! - 0x30);
          i += 1;
        }
        let cp = num * sign;
        if (cp < 0) cp += 65536;
        if (cp >= 0 && cp <= 0x10ffff) {
          try {
            unicode += String.fromCodePoint(cp);
          } catch {
            // invalid code point — skip
          }
        }
        // `\uN?` — the single ANSI fallback char follows; skip it
        if (i < n && bytes[i] !== 0x5c) i += 1;
      } else {
        const start = i;
        while (i < n && ((bytes[i]! >= 0x41 && bytes[i]! <= 0x5a) || (bytes[i]! >= 0x61 && bytes[i]! <= 0x7a))) i += 1;
        const word = new TextDecoder().decode(bytes.subarray(start, i));
        let arg = 0;
        if (i < n && bytes[i] === 0x2d) i += 1;
        while (i < n && bytes[i]! >= 0x30 && bytes[i]! <= 0x39) {
          arg = arg * 10 + (bytes[i]! - 0x30);
          i += 1;
        }
        if (word === 'ansicpg' && arg === 936) isGbk = true;
        // delimiter space is part of the control word
        if (i < n && bytes[i] === 0x20) i += 1;
      }
    } else if (b === 0x7b || b === 0x7d || b === 0x0d) {
      i += 1;
    } else {
      ansiBytes.push(b);
      i += 1;
    }
  }
  let decoded: string;
  const raw = Uint8Array.from(ansiBytes);
  if (isGbk || !isValidUtf8(raw)) {
    decoded = new TextDecoder('gb18030').decode(raw);
  } else {
    decoded = new TextDecoder().decode(raw);
  }
  if (unicode) {
    if (decoded.trim()) decoded += '\n';
    decoded += unicode;
  }
  return decoded.trim();
}

function isValidUtf8(bytes: Uint8Array): boolean {
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    return true;
  } catch {
    return false;
  }
}

// ── Binary detection ───────────────────────────────────────────────────────

/** True when the bytes are a NUL-heavy or mostly non-printable blob. */
export function looksBinary(bytes: Uint8Array): boolean {
  if (bytes.length === 0) return false;
  const sampleLen = Math.min(bytes.length, 8192);
  const sample = bytes.subarray(0, sampleLen);
  if (sample.includes(0)) return true;
  let printable = 0;
  for (const b of sample) {
    if (b === 0x0a || b === 0x0d || b === 0x09 || (b >= 0x20 && b <= 0x7e) || b >= 0x80) printable += 1;
  }
  return printable * 10 < sampleLen * 9;
}

export function describeBinary(bytes: Uint8Array): string {
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47])) return 'PNG 图片';
  if (startsWith(bytes, [0xff, 0xd8])) return 'JPEG 图片';
  if (startsWith(bytes, [0x47, 0x49, 0x46, 0x38])) return 'GIF 图片';
  if (startsWith(bytes, [0x49, 0x49, 0x2a, 0x00]) || startsWith(bytes, [0x4d, 0x4d, 0x00, 0x2a])) return 'TIFF 图片';
  if (startsWith(bytes, [0x1f, 0x8b])) return 'GZIP 压缩文件';
  if (startsWith(bytes, [0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c])) return '7z 压缩文件';
  if (startsWith(bytes, [0x52, 0x61, 0x72, 0x21])) return 'RAR 压缩文件';
  if (startsWith(bytes, [0x00, 0x00, 0x01, 0x00])) return 'ICO 图片';
  if (startsWith(bytes, [0x25, 0x50, 0x44, 0x46])) return 'PDF';
  if (startsWith(bytes, [0x50, 0x4b])) return 'ZIP 压缩包（可能是 .docx/.xlsx 或普通压缩文件）';
  if (startsWith(bytes, [0xd0, 0xcf, 0x11, 0xe0])) return 'OLE2 复合文档（旧版 .doc/.xls）';
  return '未知二进制文件';
}

function startsWith(bytes: Uint8Array, prefix: number[]): boolean {
  if (bytes.length < prefix.length) return false;
  for (let i = 0; i < prefix.length; i++) {
    if (bytes[i] !== prefix[i]) return false;
  }
  return true;
}

// ── Dispatcher ─────────────────────────────────────────────────────────────

/**
 * The main dispatcher: turn a local file's bytes into readable text.
 * Returns (text, note) — note is ONLY set when nothing usable was extracted
 * and carries an actionable hint (conversion suggestion / OCR advice).
 */
export async function extractFileText(bytes: Uint8Array, path: string): Promise<ExtractedText> {
  const ext = (path.split('.').pop() ?? '').toLowerCase();
  // ZIP-based office formats (docx / xlsx / pptx / odt…)
  if (startsWith(bytes, [0x50, 0x4b, 0x03, 0x04]) || startsWith(bytes, [0x50, 0x4b, 0x05, 0x06])) {
    let text: string | null = null;
    let note = '';
    if (ext === 'docx' || ext === 'docm') {
      text = await zipEntryXmlText(bytes, 'word/document.xml', 'w:t');
    } else if (ext === 'xlsx' || ext === 'xlsm') {
      text = await zipEntryXmlText(bytes, 'xl/sharedStrings.xml', 't');
    } else if (ext === 'pptx' || ext === 'pptm') {
      text = await zipEntriesXmlText(bytes, (name) => name.startsWith('ppt/slides/slide') && name.endsWith('.xml'), 'a:t');
    } else if (ext === 'odt' || ext === 'ods' || ext === 'odp') {
      text = await zipEntriesXmlText(bytes, (name) => name === 'content.xml', 'text:p');
    } else {
      note = `文件扩展名 .${ext} 不是支持的文档格式（支持 docx/xlsx/pptx/odt/ods/odp）。`;
    }
    if (text && text.trim()) return { text, note: '' };
    if (text !== null) {
      return { text: '', note: `${ext.toUpperCase()} 未提取到文本内容（文档可能为空或内容为图片）。` };
    }
    return { text: '', note };
  }
  // PDF
  if (startsWith(bytes, [0x25, 0x50, 0x44, 0x46])) {
    return pdfExtractText(bytes);
  }
  // RTF
  if (startsWith(bytes, [0x7b, 0x5c, 0x72, 0x74, 0x66])) {
    return { text: rtfExtractText(bytes), note: '' };
  }
  // OLE2 compound documents (.doc / .xls) — not directly parseable
  if (startsWith(bytes, [0xd0, 0xcf, 0x11, 0xe0])) {
    const name = path.split(/[\\/]/).pop() ?? path;
    return {
      text: '',
      note: `${name} 是旧版二进制文档（.doc/.xls），无法直接解析文本。请用 Word/WPS 另存为 .docx/.xlsx/.txt，或执行转换命令（例如 soffice --headless --convert-to txt "${name}"）。`,
    };
  }
  // Everything else: text with encoding detection, or a clear binary note
  if (looksBinary(bytes)) {
    return { text: '', note: `二进制文件（${describeBinary(bytes)}），不是文本文件，无法读取内容。` };
  }
  return { text: decodeTextBytes(bytes), note: '' };
}
