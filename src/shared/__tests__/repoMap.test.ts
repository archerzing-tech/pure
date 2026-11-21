import { describe, expect, it } from 'bun:test';
import {
  REPO_MAP_MAX_CHARS,
  formatRepoMap,
  parseRepoMapListing,
  pickRepoMapSymbolFiles,
  repoMapBubbleText,
  repoMapFingerprint,
  repoMapSymbolNamesFromOutline,
} from '../repoMap';
import { clearRepoMapCache, collectRepoMap } from '../repoMapSource';
import type { ToolAdapter, ToolResult } from '../types';

describe('repoMap 探索气泡摘要', () => {
  const map = [
    '<repo_map>',
    'Workspace snapshot: 904 source/entry files. Format: path — top-level declarations.',
    'This is a scan taken when the turn started, not ground truth.',
    'Key files:',
    '  src/ui/chat.ts — ChatController, send',
    '  src/shared/repoMap.ts — formatRepoMap',
    'Tree:',
    '  src/ui/ (2) chat.ts, styles.css',
    '</repo_map>',
  ].join('\n');

  it('报出扫描文件数、带符号的文件数和字符量', () => {
    const text = repoMapBubbleText(map);
    expect(text).toContain('904 个源文件');
    expect(text).toContain('2 个文件带符号');
    expect(text).toContain(`${map.length} 字符`);
  });

  it('没有符号段时不给零计数', () => {
    const bare = ['<repo_map>', 'Workspace snapshot: 70 source/entry files.', 'Tree:', '  src/ (1) a.ts', '</repo_map>'].join('\n');
    const text = repoMapBubbleText(bare);
    expect(text).toContain('70 个源文件');
    expect(text).not.toContain('0 个文件带符号');
  });

  it('头部读不出来也不编数字', () => {
    const text = repoMapBubbleText('<repo_map>\nnothing\n</repo_map>');
    expect(text).toContain('已附仓库骨架图：');
    expect(text).not.toContain('个源文件');
  });
});

describe('repoMap 纯函数', () => {
  it('drops dependency dirs, binaries and duplicate lines from a listing', () => {
    const listing = [
      'src/app.ts',
      './src/app.ts',
      'node_modules/react/index.js',
      'dist/bundle.js',
      'src/logo.png',
      'assets/font.woff2',
      '[截断] 仅显示前 4000 项',
      '(empty directory)',
      'src/shared/store.ts',
      'package.json',
      'notes.txt',
    ].join('\n');
    expect(parseRepoMapListing(listing)).toEqual(['package.json', 'src/app.ts', 'src/shared/store.ts']);
  });

  it('keeps declaration names and drops line numbers from an outline', () => {
    const outline = [
      '[outline: src/a.ts — 120 lines, 4 symbols]',
      '1: export function buildEnvFacts(conventions?: string) {',
      '2: export const MAX_TURNS = 10;',
      '40:   private handle(event: Event) {',
      '41: export function buildEnvFacts(x: number) {',
      '[outline capped at 120 symbols — read a range for the rest]',
    ].join('\n');
    expect(repoMapSymbolNamesFromOutline(outline)).toEqual(['buildEnvFacts', 'MAX_TURNS', 'handle']);
  });

  it('prefers shallow entry files when choosing which outlines to read', () => {
    const paths = [
      'src/deep/nested/impl/thing.ts',
      'src/index.ts',
      'src/shared/agentBehavior.ts',
      'src/__tests__/thing.test.ts',
    ];
    const picked = pickRepoMapSymbolFiles(paths, 2);
    expect(picked[0]).toBe('src/index.ts');
    expect(picked).toHaveLength(2);
    expect(picked).not.toContain('src/__tests__/thing.test.ts');
  });

  it('renders key files plus a directory tree and stays inside the budget', () => {
    const entries = Array.from({ length: 80 }, (_, index) => ({
      path: `src/mod${index % 7}/file${index}.ts`,
      symbols: index % 10 === 0 ? ['handler', 'render'] : [],
    }));
    const text = formatRepoMap({ entries, totalFiles: 80, maxChars: 900 });
    expect(text.startsWith('<repo_map>')).toBe(true);
    expect(text.endsWith('</repo_map>')).toBe(true);
    expect(text).toContain('Key files:');
    expect(text).toContain('src/mod0/file0.ts — handler, render');
    expect(text).toContain('Tree:');
    expect(text.length).toBeLessThanOrEqual(900);
  });

  it('stays inside the default budget for a large repo', () => {
    const entries = Array.from({ length: 1200 }, (_, index) => ({ path: `packages/p${index % 40}/src/f${index}.ts`, symbols: ['a', 'b', 'c'] }));
    const text = formatRepoMap({ entries, totalFiles: 1200 });
    expect(text.length).toBeLessThanOrEqual(REPO_MAP_MAX_CHARS);
    expect(text).toContain('</repo_map>');
  });

  it('changes fingerprint when the listing changes and is stable otherwise', () => {
    const base = ['src/a.ts', 'src/b.ts'];
    expect(repoMapFingerprint(base)).toBe(repoMapFingerprint([...base]));
    expect(repoMapFingerprint(base)).not.toBe(repoMapFingerprint([...base, 'src/c.ts']));
  });
});

function fakeTools(files: string[]): ToolAdapter & { listCalls: number; readCalls: number } {
  const adapter = {
    listCalls: 0,
    readCalls: 0,
    async execute(call: { function: { name: string; arguments: string } }): Promise<ToolResult> {
      const args = JSON.parse(call.function.arguments) as { path?: string };
      if (call.function.name === 'list_files') {
        adapter.listCalls += 1;
        return { id: 'l', toolName: 'list_files', success: true, duration: 1, result: files.join('\n') };
      }
      adapter.readCalls += 1;
      return {
        id: 'r',
        toolName: 'read_file',
        success: true,
        duration: 1,
        result: `[outline: ${args.path} — 40 lines, 2 symbols]\n1: export function alpha() {\n20: export const beta = 1;`,
      };
    },
    getMetadata: () => ({ isWrite: false }),
    getTools: () => [],
  };
  return adapter as unknown as ToolAdapter & { listCalls: number; readCalls: number };
}

describe('collectRepoMap', () => {
  it('returns nothing for a repo below the size gate', async () => {
    const tools = fakeTools(['src/a.ts', 'src/b.ts']);
    expect(await collectRepoMap(tools)).toBe('');
    expect(tools.readCalls).toBe(0);
  });

  it('builds a map with symbols and reuses it while the listing is unchanged', async () => {
    const files = Array.from({ length: 80 }, (_, index) => `src/mod${index % 4}/file${index}.ts`);
    const tools = fakeTools(files);
    clearRepoMapCache(tools);
    const first = await collectRepoMap(tools);
    expect(first).toContain('<repo_map>');
    expect(first).toContain('alpha, beta');
    const readsAfterFirst = tools.readCalls;
    expect(readsAfterFirst).toBeGreaterThan(0);

    const second = await collectRepoMap(tools);
    expect(second).toBe(first);
    // 60s 重扫窗口内的第二回合连清单都不重列，大纲读取更不会再发生。
    expect(tools.listCalls).toBe(1);
    expect(tools.readCalls).toBe(readsAfterFirst);
  });

  it('rescans when a file appears between turns', async () => {
    const files = Array.from({ length: 80 }, (_, index) => `src/file${index}.ts`);
    const tools = fakeTools(files);
    clearRepoMapCache(tools);
    await collectRepoMap(tools);
    const readsAfterFirst = tools.readCalls;
    files.push('src/newly-added.ts');
    // 关掉重扫窗口，等价于「下一回合已经超过 60s」。
    await collectRepoMap(tools, { refreshMs: 0 });
    expect(tools.readCalls).toBeGreaterThan(readsAfterFirst);
  });
});
