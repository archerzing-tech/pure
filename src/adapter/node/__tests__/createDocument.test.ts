// src/adapter/node/__tests__/createDocument.test.ts
// create_document 的 Node（CLI）执行路径。GUI 侧经 save_file_binary（Rust
// resolve_document_path 落盘），CLI 在适配器内直接生成并写盘；两端必须同构：
// 落点语义对齐 Rust 单测 resolve_document_path_matches_the_delivery_semantics
// 的口径，报告用落盘实路径（「卡片在、文件不在」判例类）。
// 文档格式选 xlsx：纯 JS 生成，不依赖 atob/btoa，无需 DOM 全局替身。

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { existsSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NodeToolAdapter, resolveDocumentPath } from '../NodeToolAdapter';
import type { ToolCall } from '../../../shared/types';

function docCall(args: Record<string, unknown>): ToolCall {
  return {
    id: 'call-1',
    index: 0,
    function: { name: 'create_document', arguments: JSON.stringify(args) },
  };
}

function safeRm(p: string): void {
  rmSync(p, { recursive: true, force: true });
}

const xlsxSpec = { sheets: [{ name: '数据', rows: [['名目', '数量'], ['样例', 1]] }] };

describe('create_document (Node chain)', () => {
  let workspace: string;
  let realWs: string; // resolve() 会 symlink 实化（macOS /var → /private/var）
  let fakeHome: string;
  let adapter: NodeToolAdapter;

  beforeAll(() => {
    workspace = mkdtempSync(join(tmpdir(), 'pure-doc-ws-'));
    realWs = realpathSync(workspace);
    fakeHome = mkdtempSync(join(tmpdir(), 'pure-doc-home-'));
    adapter = new NodeToolAdapter({ workspace, homeDir: fakeHome });
  });

  afterAll(() => {
    safeRm(workspace);
    safeRm(fakeHome);
  });

  it('生成 xlsx 落盘到工作区（保相对结构），报告带实路径且文件非空', async () => {
    const r = await adapter.execute(docCall({ format: 'xlsx', path: 'docs/报表.xlsx', spec: xlsxSpec }));
    expect(r.success).toBe(true);
    const landed = join(realWs, 'docs', '报表.xlsx');
    // 报告的是落盘实路径，不是模型输入的原始 path
    expect(String(r.result)).toContain(landed);
    expect(String(r.result)).toContain('XLSX');
    expect(existsSync(landed)).toBe(true);
    const bytes = readFileSync(landed);
    expect(bytes.length).toBeGreaterThan(0);
    // xlsx 是 zip：PK 魔数
    expect(bytes[0]).toBe(0x50);
    expect(bytes[1]).toBe(0x4b);
  });

  it('重名直接覆盖不加序号（与 Rust fs::write 同款），落点不变仍是单文件', async () => {
    const path = '覆盖.xlsx';
    await adapter.execute(docCall({ format: 'xlsx', path, spec: xlsxSpec }));
    const landed = join(realWs, path);
    const sizeBefore = readFileSync(landed).length;
    const bigSpec = { sheets: [{ name: '另一份', rows: Array.from({ length: 200 }, (_, i) => [`r${i}`, i, `${i}`]) }] };
    const r2 = await adapter.execute(docCall({ format: 'xlsx', path, spec: bigSpec }));
    expect(r2.success).toBe(true);
    expect(String(r2.result)).toContain(landed);
    // 覆盖生效（内容变大）、没有孵出 a(1).xlsx 一类序号副本
    expect(readFileSync(landed).length).toBeGreaterThan(sizeBefore);
    expect(readdirSync(realWs).filter((n) => n.startsWith('覆盖'))).toEqual(['覆盖.xlsx']);
  });

  it('无工作区落 ~/Downloads（主目录用注入替身，不碰真实 Downloads）', async () => {
    const bare = new NodeToolAdapter({ workspace: '', homeDir: fakeHome });
    const r = await bare.execute(docCall({ format: 'xlsx', path: '裸会话报表.xlsx', spec: xlsxSpec }));
    expect(r.success).toBe(true);
    const landed = join(fakeHome, 'Downloads', '裸会话报表.xlsx');
    expect(String(r.result)).toContain(landed);
    expect(existsSync(landed)).toBe(true);
  });

  it('无工作区时 `~/` 前缀按注入主目录展开，不落字面量 ~ 目录', async () => {
    const bare = new NodeToolAdapter({ workspace: '', homeDir: fakeHome });
    const r = await bare.execute(docCall({ format: 'xlsx', path: '~/Documents/展开.xlsx', spec: xlsxSpec }));
    expect(r.success).toBe(true);
    const landed = join(fakeHome, 'Documents', '展开.xlsx');
    expect(String(r.result)).toContain(landed);
    expect(existsSync(landed)).toBe(true);
    expect(existsSync(join(fakeHome, '~'))).toBe(false);
  });

  it('绝对路径原样落盘（全盘可达契约）', async () => {
    const abs = join(realWs, '绝对.xlsx');
    const r = await adapter.execute(docCall({ format: 'xlsx', path: abs, spec: xlsxSpec }));
    expect(r.success).toBe(true);
    expect(String(r.result)).toContain(abs);
    expect(existsSync(abs)).toBe(true);
  });

  it('缺 format/path 拒绝执行且不落盘', async () => {
    const r = await adapter.execute(docCall({ path: 'a.xlsx', spec: xlsxSpec }));
    expect(r.success).toBe(false);
    expect(String(r.error)).toContain('必填');
    expect(existsSync(join(realWs, 'a.xlsx'))).toBe(false);
  });

  it('未知 format 报可行动错误（与 GUI 同一 generateDocument 报错文案）', async () => {
    const r = await adapter.execute(docCall({ format: 'pdf', path: 'a.pdf', spec: {} }));
    expect(r.success).toBe(false);
    expect(String(r.error)).toContain('pptx / docx / xlsx');
  });
});

describe('resolveDocumentPath（纯函数，逐条对齐 Rust 单测口径）', () => {
  const home = '/Users/tester';

  it('有工作区：锚工作区、保相对结构、尾斜杠不拼出双斜杠', () => {
    expect(resolveDocumentPath('docs/deck.pptx', '/ws/dir', home)).toBe('/ws/dir/docs/deck.pptx');
    expect(resolveDocumentPath('a.pptx', '/ws/dir/', home)).toBe('/ws/dir/a.pptx');
  });

  it('没工作区：落 ~/Downloads（保结构），绝不落进程 cwd', () => {
    expect(resolveDocumentPath('docs/deck.pptx', '', home)).toBe('/Users/tester/Downloads/docs/deck.pptx');
  });

  it('`~/` 与 `$HOME` 前缀展开到真实主目录，不许落字面量 ~ 目录', () => {
    expect(resolveDocumentPath('~/Documents/r.docx', '', home)).toBe('/Users/tester/Documents/r.docx');
    expect(resolveDocumentPath('$HOME/Downloads/a.xlsx', '/ws', home)).toBe('/Users/tester/Downloads/a.xlsx');
  });

  it('绝对路径原样通过（全盘可达契约）', () => {
    expect(resolveDocumentPath('/data/a.pptx', '/ws', home)).toBe('/data/a.pptx');
  });
});
