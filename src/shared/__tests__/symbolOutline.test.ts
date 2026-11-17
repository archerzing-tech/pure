// src/shared/__tests__/symbolOutline.test.ts
// read_file(outline:true) 的纯函数面（2026-11-17）：只回声明行 + 行号。
// 判据收得窄是刻意的——漏一个局部函数可以接受，把正文/控制流当符号塞给
// 模型不可接受（那样大纲反而比直接读更费）。

import { describe, expect, it } from 'bun:test';
import { extractSymbolOutline, formatSymbolOutline, outlineFamilyFor } from '../symbolOutline';

describe('symbolOutline — 语言族与判据', () => {
  it('按扩展名认语言族，未知类型不硬猜', () => {
    expect(outlineFamilyFor('src/a.ts')).toBe('js');
    expect(outlineFamilyFor('a.py')).toBe('python');
    expect(outlineFamilyFor('a.rs')).toBe('rust');
    expect(outlineFamilyFor('a.go')).toBe('go');
    expect(outlineFamilyFor('a.kt')).toBe('jvm');
    expect(outlineFamilyFor('notes.txt')).toBe('none');
    expect(outlineFamilyFor('README')).toBe('none');
  });

  it('TS：类/函数/类型/箭头函数与方法带行号，控制流不算符号', () => {
    const src = [
      'import x from "y";',            // 1 不算
      'export class Foo {',            // 2
      '  bar() {',                     // 3 方法
      '    if (x) { return 1; }',      // 4 控制流
      '  }',
      '}',
      'export function baz() {}',      // 7
      'export const qux = async () => 1;', // 8
      'type Shape = { a: number };',   // 9
    ].join('\n');
    const symbols = extractSymbolOutline(src, 'a.ts');
    expect(symbols.map((s) => s.line)).toEqual([2, 3, 7, 8, 9]);
    expect(symbols[1].text).toBe('  bar() {');
  });

  it('Python / Rust / Go：def、class、fn、impl、func 都认', () => {
    expect(extractSymbolOutline('def f():\n    pass\nclass C:\n    pass\n', 'a.py').map((s) => s.line)).toEqual([1, 3]);
    expect(extractSymbolOutline('fn a() {}\npub fn b() {}\nimpl X {}\n', 'a.rs').map((s) => s.line)).toEqual([1, 2, 3]);
    expect(extractSymbolOutline('func (s *S) Run() {}\ntype T struct{}\n', 'a.go').map((s) => s.line)).toEqual([1, 2]);
  });

  it('成稿带行数与符号数；未知类型与零命中都如实说，不回空串', () => {
    const ts = formatSymbolOutline('a.ts', 'export class Foo {}\nexport function bar() {}\n');
    expect(ts).toContain('[outline: a.ts — 2 lines, 2 symbols]');
    expect(ts).toContain('1: export class Foo {}');

    expect(formatSymbolOutline('notes.txt', 'hello')).toContain('no symbol outline for this file type');
    // 纯文本代码以外，TS 文件也可能确实没有声明：说清楚，而不是假装文件是空的。
    expect(formatSymbolOutline('a.ts', 'const x = 1;\nconsole.log(x);\n')).toContain('no declaration lines matched');
  });

  it('符号数封顶 120，并如实标注截断', () => {
    const many = Array.from({ length: 130 }, (_, i) => `export function f${i}() {}`).join('\n');
    const out = formatSymbolOutline('many.ts', many);
    expect(out).toContain(', 120 symbols]');
    expect(out).toContain('outline capped at 120 symbols');
  });

  it('单行超长时压到 160 字符，不把 minified 代码整行搬进大纲', () => {
    const line = `export function f(${'a'.repeat(500)}) {}`;
    const [symbol] = extractSymbolOutline(line, 'a.ts');
    expect(symbol.text.length).toBe(160);
  });
});
