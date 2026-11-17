// src/ui/__tests__/planEvidence.test.ts
// 规划证据采集（2026-11-17 规划落地刀）的机械面：规划要先读到真实文件，
// 同一份快照再充当解析阶段的路径存在性依据。这里用假 adapter 锁住四条
// 契约——依赖目录剪掉、点名文件带真实头部、命令只从 manifest 抄、
// 快照被截断时不做存在性判定（少扫到 ≠ 不存在）。

import { describe, expect, it } from 'bun:test';
import { gatherPlanEvidence, type PlanEvidenceBundle } from '../chat';
import type { ToolAdapter, ToolCall, ToolResult } from '../../shared/types';

interface FakeRepo {
  root: string[];
  files: string[];
  dirs: Record<string, string>;
  contents: Record<string, string>;
  /** 让所有调用失败，模拟没有工作区/工具被关掉。 */
  dead?: boolean;
}

function fakeAdapter(repo: FakeRepo): ToolAdapter {
  const ok = (call: ToolCall, result: string): ToolResult => ({
    id: call.id, toolName: call.function.name, success: true, result, duration: 0,
  });
  const fail = (call: ToolCall): ToolResult => ({
    id: call.id, toolName: call.function.name, success: false, error: 'not available', duration: 0,
  });
  return {
    getTools: () => [],
    getMetadata: () => undefined,
    execute: async (call: ToolCall): Promise<ToolResult> => {
      if (repo.dead) return fail(call);
      const args = JSON.parse(call.function.arguments || '{}') as { path?: string; pattern?: string };
      switch (call.function.name) {
        case 'list_files': {
          const path = args.path ?? '.';
          if (path === '.' || path === '') return ok(call, repo.root.join('\n'));
          const listing = repo.dirs[path];
          return listing ? ok(call, listing) : fail(call);
        }
        case 'glob_files':
          return ok(call, repo.files.join('\n'));
        case 'read_file': {
          const content = repo.contents[args.path ?? ''];
          return content !== undefined ? ok(call, content) : fail(call);
        }
        default:
          return fail(call);
      }
    },
  } as ToolAdapter;
}

const repo: FakeRepo = {
  root: ['package.json', 'README.md', 'src', 'docs', 'node_modules', '.git'],
  files: ['package.json', 'README.md'],
  dirs: {
    src: [
      'engine/AgentLoopEngine.ts',
      'engine/ToolExecutionCoordinator.ts',
      'harness/ContextEngine.ts',
      // 子目录里的依赖目录同样要剪掉：它不该占据快照也不该进证据。
      'node_modules/left-pad/index.js',
    ].join('\n'),
    docs: 'guide.md',
  },
  contents: {
    'package.json': JSON.stringify({ scripts: { test: 'bun test', typecheck: 'tsc --noEmit' } }),
    'src/engine/AgentLoopEngine.ts': 'export class AgentLoopEngine {}\n',
    'docs/guide.md': '# guide\n',
  },
};

describe('gatherPlanEvidence — 规划先读真实文件', () => {
  const bundle = (): Promise<PlanEvidenceBundle | undefined> =>
    gatherPlanEvidence(fakeAdapter(repo), '/ws/proj', '看一下 src/engine/AgentLoopEngine.ts 的循环，顺便修 docs/guide.md');

  it('目录结构来自真实快照，依赖目录从根上剪掉', async () => {
    const evidence = await bundle();
    expect(evidence).toBeDefined();
    expect(evidence!.text).toContain('src/engine');
    expect(evidence!.text).toContain('src/harness');
    expect(evidence!.text).not.toContain('node_modules');
    expect(evidence!.text).not.toContain('.git');
  });

  it('请求点名的文件带真实头部，命令只从 manifest 抄', async () => {
    const evidence = await bundle();
    expect(evidence!.text).toContain('Head of src/engine/AgentLoopEngine.ts');
    expect(evidence!.text).toContain('export class AgentLoopEngine {}');
    expect(evidence!.text).toContain('test: bun test');
    expect(evidence!.text).toContain('typecheck: tsc --noEmit');
    expect(evidence!.text).toContain('Manifests present: package.json');
  });

  it('同一份快照判定路径存在：文件、目录前缀算存在，编出来的不存在', async () => {
    const evidence = await bundle();
    expect(evidence!.pathExists?.('src/engine/AgentLoopEngine.ts')).toBe(true);
    expect(evidence!.pathExists?.('src/engine')).toBe(true);
    expect(evidence!.pathExists?.('docs/guide.md')).toBe(true);
    expect(evidence!.pathExists?.('src/engine/Nope.ts')).toBe(false);
  });

  it('Windows 反斜杠清单归一化后照样能对上正斜杠路径', async () => {
    const windowsRepo: FakeRepo = {
      root: ['src'],
      files: [],
      dirs: { src: 'engine\\AgentLoopEngine.ts' },
      contents: {},
    };
    const evidence = await gatherPlanEvidence(fakeAdapter(windowsRepo), 'C:/ws', '改 src/engine/AgentLoopEngine.ts');
    expect(evidence!.text).toContain('src/engine/AgentLoopEngine.ts');
    expect(evidence!.pathExists?.('src/engine/AgentLoopEngine.ts')).toBe(true);
  });

  it('快照被截断时不交存在性判定（少扫到 ≠ 不存在），但快照仍如实自证截断', async () => {
    const truncatedRepo: FakeRepo = {
      root: ['src'],
      files: [],
      dirs: { src: 'a.ts\n[截断] 仅显示前 1 项；目录还有更多内容。' },
      contents: {},
    };
    const evidence = await gatherPlanEvidence(fakeAdapter(truncatedRepo), '/ws', '改 src/a.ts');
    expect(evidence!.text).toContain('listing truncated');
    expect(evidence!.pathExists).toBeUndefined();
  });

  it('读不到工作区时返回 undefined，规划退回「没有证据」的措辞', async () => {
    expect(await gatherPlanEvidence(fakeAdapter({ ...repo, dead: true }), '/ws', 'x')).toBeUndefined();
    expect(await gatherPlanEvidence(undefined, '/ws', 'x')).toBeUndefined();
    expect(await gatherPlanEvidence(fakeAdapter(repo), '', 'x')).toBeUndefined();
  });
});
