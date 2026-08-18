// src/adapter/node/__tests__/fileText.test.ts
// Mirror of the Rust file_text_extraction_tests: encoding detection, docx/PDF/
// RTF extraction, binary notes, and the adapter-level read/search wiring.

import { describe, expect, it, beforeAll, afterAll } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import JSZip from 'jszip';
import { decodeTextBytes, extractFileText, looksBinary, describeBinary, xmlTextInTag, pdfExtractText } from '../fileText';
import { NodeToolAdapter } from '../NodeToolAdapter';
import type { ToolCall } from '../../../shared/types';

function toolCall(name: string, args: Record<string, unknown>): ToolCall {
  return { id: 'call-1', index: 0, function: { name, arguments: JSON.stringify(args) } };
}

describe('fileText encoding detection', () => {
  it('decodes GBK bytes (Chinese Windows ANSI) to 你好', () => {
    const gbk = new Uint8Array([0xc4, 0xe3, 0xba, 0xc3]); // 你好 in GBK
    expect(decodeTextBytes(gbk)).toBe('你好');
  });

  it('decodes UTF-16LE with BOM', () => {
    const bom = new Uint8Array([0xff, 0xfe]);
    const utf16 = new TextEncoder().encode('你好').buffer;
    const bytes = new Uint8Array([...bom, ...new Uint8Array([0x60, 0x4f, 0x7d, 0x59])]);
    expect(decodeTextBytes(bytes)).toBe('你好');
  });

  it('decodes UTF-8 strictly (no mojibake for valid UTF-8)', () => {
    const bytes = new TextEncoder().encode('北极星科技有限公司');
    expect(decodeTextBytes(bytes)).toBe('北极星科技有限公司');
  });
});

describe('fileText binary detection', () => {
  it('flags NUL-heavy and non-printable blobs as binary', () => {
    expect(looksBinary(new Uint8Array([0x00, 0x01, 0x02, 0x03]))).toBe(true);
    expect(describeBinary(new Uint8Array([0x89, 0x50, 0x4e, 0x47]))).toContain('PNG');
    expect(looksBinary(new TextEncoder().encode('hello world\nplain text'))).toBe(false);
  });
});

describe('fileText xml extraction', () => {
  it('extracts docx paragraphs and decodes XML entities', () => {
    const text = xmlTextInTag(
      '<w:document><w:p><w:r><w:t>第一段&amp;内容</w:t></w:r></w:p><w:p><w:t>第二段</w:t></w:p></w:document>',
      'w:t',
    );
    expect(text).toContain('第一段&内容');
    expect(text).toContain('第二段');
  });
});

describe('fileText extractFileText', () => {
  it('extracts docx text via jszip', async () => {
    const zip = new JSZip();
    zip.file(
      'word/document.xml',
      '<w:document><w:p><w:r><w:t>北极星科技有限公司</w:t></w:r></w:p></w:document>',
    );
    const bytes = new Uint8Array(await zip.generateAsync({ type: 'uint8array' }));
    const { text, note } = await extractFileText(bytes, '公司简介.docx');
    expect(note).toBe('');
    expect(text).toContain('北极星科技有限公司');
  });

  it('extracts PDF text mapping CID codes through a ToUnicode CMap', async () => {
    const pdf = [
      '%PDF-1.4\n',
      '1 0 obj\n<< /Type /Catalog >>\nendobj\n',
      '2 0 obj\n<< /Length 400 >>\nstream\n',
      '/CIDInit /ProcSet findresource begin\n12 dict begin\nbegincmap\n',
      '/CMapName /Adobe-Identity-UCS def\n/CMapType 2 def\n',
      '1 begincodespacerange\n<0000> <FFFF>\nendcodespacerange\n',
      '1 beginbfchar\n<C4E3> <4F60>\nendbfchar\n',
      '1 beginbfrange\n<BAC3> <BAC3> <597D>\nendbfrange\n',
      'endcmap\nend\nend\nendstream\nendobj\n',
      '3 0 obj\n<< /Length 120 >>\nstream\n',
      'BT\n/F1 12 Tf\n(Hello) Tj\nT*\n<C4E3BAC3> Tj\nET\n',
      'endstream\nendobj\n%%EOF\n',
    ].join('');
    const { text, note } = pdfExtractText(new TextEncoder().encode(pdf));
    expect(note).toBe('');
    expect(text).toContain('Hello');
    expect(text).toContain('你好');
  });

  it('extracts RTF with GBK escapes and \\uN unicode escapes', async () => {
    // \'c4\'e3\'ba\'c3 = 你好 in GBK; \u20320/\u22909 = 你/好 via unicode escapes
    const rtf = "{\\rtf1\\ansi\\ansicpg936 \\'c4\\'e3\\'ba\\'c3{\\u20320?}{\\u22909?}}";
    const { text } = await rtfExtract(rtf);
    expect(text).toBe('你好\n你好');
  });

  it('notes OLE2 .doc files with a conversion hint', async () => {
    const ole = new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
    const { text, note } = await extractFileText(ole, 'old.doc');
    expect(text).toBe('');
    expect(note).toContain('soffice');
  });

  it('notes scanned PDFs as image-only', async () => {
    const pdf = '%PDF-1.4\n1 0 obj\n<< /Length 0 >>\nstream\n\nendstream\nendobj\n%%EOF';
    const { text, note } = pdfExtractText(new TextEncoder().encode(pdf));
    expect(text).toBe('');
    expect(note).toContain('OCR');
  });
});

async function rtfExtract(rtf: string): Promise<{ text: string }> {
  const { rtfExtractText } = await import('../fileText');
  return { text: rtfExtractText(new TextEncoder().encode(rtf)) };
}

describe('NodeToolAdapter read/search over documents', () => {
  let workspace: string;
  let adapter: NodeToolAdapter;

  beforeAll(() => {
    workspace = mkdtempSync(join(tmpdir(), 'pure-filetext-adapter-'));
    adapter = new NodeToolAdapter({ workspace });
  });

  afterAll(() => {
    rmSync(workspace, { recursive: true, force: true });
  });

  it('read_file returns a directory hint instead of a bare error', async () => {
    const r = await adapter.execute(toolCall('read_file', { path: '.' }));
    expect(r.success).toBe(false);
    expect(r.error).toContain('目录');
  });

  it('read_file decodes a GBK text file', async () => {
    writeFileSync(join(workspace, 'gbk.txt'), Buffer.from([0xc4, 0xe3, 0xba, 0xc3, 0x0a]));
    const r = await adapter.execute(toolCall('read_file', { path: 'gbk.txt' }));
    expect(r.success).toBe(true);
    expect(String(r.result)).toContain('你好');
  });

  it('read_file extracts a real docx built in memory', async () => {
    const zip = new JSZip();
    zip.file('word/document.xml', '<w:document><w:p><w:r><w:t>北极星科技有限公司</w:t></w:r></w:p></w:document>');
    const bytes = await zip.generateAsync({ type: 'nodebuffer' }) as Buffer;
    writeFileSync(join(workspace, 'company.docx'), bytes);
    const r = await adapter.execute(toolCall('read_file', { path: 'company.docx' }));
    expect(r.success).toBe(true);
    expect(String(r.result)).toContain('北极星科技有限公司');
  });

  it('search_files finds content inside a docx and honors caseSensitive', async () => {
    const r1 = await adapter.execute(toolCall('search_files', { pattern: '北极星', path: '.', filePattern: '*.docx' }));
    expect(r1.success).toBe(true);
    expect(String(r1.result)).toContain('company.docx:1');
    expect(String(r1.result)).toContain('北极星科技有限公司');

    writeFileSync(join(workspace, 'case.txt'), 'Apple\nbanana\n');
    const loose = await adapter.execute(toolCall('search_files', { pattern: 'apple', path: '.', filePattern: '*.txt' }));
    expect(String(loose.result)).toContain('Apple');
    const strict = await adapter.execute(toolCall('search_files', { pattern: 'apple', path: '.', filePattern: '*.txt', caseSensitive: true }));
    expect(String(strict.result)).not.toContain('Apple');
    expect(String(strict.result)).toContain('No matches');
  });

  it('search_files accepts a single file path directly', async () => {
    const r = await adapter.execute(toolCall('search_files', { pattern: '北极星', path: 'company.docx' }));
    expect(r.success).toBe(true);
    expect(String(r.result)).toContain('company.docx');
  });

  it('search_files reports skipped binary files with reasons', async () => {
    writeFileSync(join(workspace, 'img.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]));
    const r = await adapter.execute(toolCall('search_files', { pattern: 'nothing', path: '.' }));
    expect(r.success).toBe(true);
    expect(String(r.result)).toContain('[提示]');
    expect(String(r.result)).toContain('PNG');
  });
});
