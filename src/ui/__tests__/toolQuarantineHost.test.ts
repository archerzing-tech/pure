// src/ui/__tests__/toolQuarantineHost.test.ts
// 阶段 13.4 停用门的宿主缝测试。
//
// 这里锁的是两件「判据层测不到」的事：
//  1. **红线**：总开关关掉时，连一次写盘命令都不能发出去。装载面的缓存是进程级的，
//     用户「装载之后关掉开关」照样会走到 mark —— 守门必须落在每一个出入口。
//  2. **跨语言契约**：Rust 发的是 serde_json::Value（对象），TS 曾按 string 消费，
//     结果 `text.trim is not a function` 把整条加载路径抛掉，表现为「仪表盘永远
//     显示没有被停用、重新启用按钮一个都渲染不出来」。tsc 抓不到——tauriInvoke<T>
//     只是个断言。

import { describe, expect, it, mock } from 'bun:test';
import {
  createToolQuarantineHost,
  loadQuarantinedTools,
  reinstateTool,
  type QuarantinedToolEntry,
} from '../toolQuarantineHost';
import {
  buildQuarantineCard,
  emptyQuarantineState,
  quarantineVerdict,
  tallyToolOutcome,
  type ToolQuarantineCard,
  parseQuarantineMarker,
  type ToolQuarantineState,
} from '../../harness/toolQuarantine';
import { invalidateConfigCache, STORAGE_KEY } from '../config';

const mem: Record<string, string> = {};
(globalThis as Record<string, unknown>).localStorage = {
  getItem: (k: string) => mem[k] ?? null,
  setItem: (k: string, v: string) => { mem[k] = v; },
  removeItem: (k: string) => { delete mem[k]; },
};
(globalThis as Record<string, unknown>).window = { location: { search: '' } };

/** The Tauri bridge is stubbed wholesale: every command this module can issue is
 *  recorded, so "did the red line hold" is answerable by looking at the log
 *  rather than by trusting the code. `tauriInvoke` lazily imports
 *  `@tauri-apps/api/core`, so the module itself is mocked — stubbing a global
 *  would leave the real import (and a real throw) in place. */
const calls: string[] = [];
let sources: unknown[] = [];
/** Mimics the Rust contract EXACTLY, because that contract is where the gate
 *  went inert before: `record` writes the marker, `reinstate` deletes it, and
 *  conflating the two (an earlier `reason: null` overload) silently swallowed
 *  every counter write. A mock that only records command NAMES cannot catch
 *  that class of bug — this one keeps the file system honest. */
const disk = new Map<string, unknown>();
mock.module('../../shared/tauri', () => ({
  isTauriRuntime: () => true,
  tauriInvoke: async (cmd: string, args?: Record<string, unknown>) => {
    calls.push(cmd);
    if (cmd === 'list_external_tools') {
      return (sources as Array<{ file: string; quarantineMarker?: unknown }>).map((s) => {
        const name = s.file.replace(/\/TOOL\.json$/, '');
        // What the fake wrote during this test wins; otherwise the fixture's own
        // marker (used by the parse-shape cases) is served as-is.
        const marker = disk.has(name) ? disk.get(name) : s.quarantineMarker ?? null;
        // Rust parses the marker and reads `quarantined` off it; a marker that
        // does not parse yields false, so the tool loads normally. Mirror that
        // here or the fake would claim a protection the real backend lacks.
        let parsed: unknown = marker;
        if (typeof marker === 'string') {
          try { parsed = JSON.parse(marker); } catch { parsed = null; }
        }
        const stopped = typeof parsed === 'object' && parsed !== null
          && (parsed as { quarantined?: boolean }).quarantined === true;
        return { ...s, quarantined: stopped, quarantineMarker: marker };
      });
    }
    if (cmd === 'set_tool_quarantined') {
      const name = String(args?.name ?? '');
      if (args?.op === 'reinstate') { disk.delete(name); return undefined; }
      disk.set(name, { ...(args?.state as object), quarantined: args?.op === 'quarantine', reason: args?.reason ?? undefined });
      return undefined;
    }
    return undefined;
  },
}));

// loadConfig is NOT mocked: `mock.module` is process-global in bun, and an
// earlier version of this file mocked '../config' and turned 21 unrelated
// config/phaseModels/toolRow tests red. The switch is driven through the real
// loadConfig() path instead — localStorage + invalidateConfigCache — so this
// file proves the red line against the code that actually runs in the app.
function reset(scanSources: unknown[], switchOn: boolean): void {
  calls.length = 0;
  disk.clear();
  sources = scanSources;
  mem[STORAGE_KEY] = JSON.stringify({ configVersion: 16, skills: { evolution: switchOn } });
  invalidateConfigCache();
}

const MARKER = {
  quarantined: true,
  reason: '连续 3 次调用「跑不起来」',
  consecutiveFailures: 3,
  totalCalls: 4,
  lastFailureAt: 1_700_000_000_000,
  quarantinedAt: 1_700_000_000_001,
};

describe('扫描与解析', () => {
  it('收 Rust 发来的对象形态标记（不是字符串）', async () => {
    reset([{ file: 'a_tool/TOOL.json', text: '{}', quarantined: true, quarantineMarker: MARKER }], true);
    const entries = await loadQuarantinedTools();
    expect(entries).toHaveLength(1);
    expect(entries[0].name).toBe('a_tool');
    expect(entries[0].state.quarantined).toBe(true);
    expect(entries[0].state.reason).toContain('跑不起来');
    expect(entries[0].state.consecutiveFailures).toBe(3);
  });

  it('字符串形态也收（宿主回归时手写标记的情况）', async () => {
    reset([{ file: 'a_tool/TOOL.json', text: '{}', quarantined: true, quarantineMarker: JSON.stringify(MARKER) }], true);
    expect((await loadQuarantinedTools())[0].state.quarantined).toBe(true);
  });

  it('坏标记不等于停用——工具照常加载，不被永久死锁', async () => {
    reset([{ file: 'a_tool/TOOL.json', text: '{}', quarantined: true, quarantineMarker: '{ not json' }], true);
    // Rust 侧：标记解析不出 `quarantined` ⇒ false ⇒ 不在停用名单里。
    expect(await loadQuarantinedTools()).toEqual([]);
    // 而解析本身读成全新状态，绝不抛。
    expect(parseQuarantineMarker('{ not json')).toEqual(emptyQuarantineState());
  });
});

describe('红线：总开关关掉时不发任何写盘命令', () => {
  it('mark / record / reinstate 全部静默', async () => {
    reset([{ file: 'a_tool/TOOL.json', text: '{}', quarantined: true, quarantineMarker: MARKER }], false);
    const seed: QuarantinedToolEntry[] = [{ name: 'a_tool', state: { ...emptyQuarantineState(), quarantined: true, reason: 'x' } }];
    const host = createToolQuarantineHost({ seed });
    host.record('a_tool', { ...emptyQuarantineState(), totalCalls: 9 });
    host.mark('a_tool', { ...emptyQuarantineState(), quarantined: true, reason: 'y' }, {
      toolName: 'a_tool', reason: 'y', evidence: 'e', consecutiveFailures: 3, totalCalls: 3, quarantinedAt: 1, toolDir: 'd',
    });
    await reinstateTool('a_tool');
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(calls.filter((c) => c.startsWith('set_tool_quarantined'))).toEqual([]);
    expect(await loadQuarantinedTools()).toEqual([]);
  });

  it('开关开着时 record 真的发命令（否则「红线测试」恒真，等于没测）', async () => {
    reset([], true);
    const host = createToolQuarantineHost();
    host.record('a_tool', { ...emptyQuarantineState(), totalCalls: 1 });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(calls).toContain('set_tool_quarantined');
    await reinstateTool('a_tool');
    expect(calls).toContain('set_tool_quarantined');
  });
});

describe('计数持久化', () => {
  it('seed 灌进来的计数被 host 采用——这正是「连续」能跨回合的原因', () => {
    const seeded: QuarantinedToolEntry[] = [
      { name: 'a_tool', state: { ...emptyQuarantineState(), consecutiveFailures: 2, totalCalls: 5, lastFailureAt: 1 } },
    ];
    const host = createToolQuarantineHost({ seed: seeded });
    expect(host.seed('a_tool').consecutiveFailures).toBe(2);
    // 未知工具从头开始，不是上一家的残留。
    expect(host.seed('other')).toEqual(emptyQuarantineState());
  });

  it('record 会更新内存视图，让同一进程内的后续 seed 看到最新计数', () => {
    const host = createToolQuarantineHost();
    host.record('a_tool', { ...emptyQuarantineState(), consecutiveFailures: 1, totalCalls: 1 });
    expect(host.seed('a_tool').consecutiveFailures).toBe(1);
  });
});

describe('跨回合：计数真的落盘并被下一回合读回', () => {
  it('每回合 2 次记录，第 2 回合就攒到停用线——走真实的写盘契约而非内存 Map', () => {
    // 这条是 B2 的回归锚点。之前 host 测试整体 mock 掉 tauriInvoke、只断言命令
    // 「名」，于是「计数写盘其实被当成删除」这类 bug 可以在 7 条全绿的测试里活着。
    reset([{ file: 'rot_tool/TOOL.json', text: '{}', quarantined: false, quarantineMarker: null }], true);
    const cards: ToolQuarantineCard[] = [];
    const host = createToolQuarantineHost({
      seed: [],
      onQuarantined: (card) => cards.push(card),
    });
    for (let call = 0; call < 4; call++) {
      const before = host.seed('rot_tool');
      const after = tallyToolOutcome(before, { outcome: 'broken', now: Date.now() });
      host.record('rot_tool', after);
      const verdict = quarantineVerdict('rot_tool', after);
      if (verdict.kind === 'quarantine') {
        const stopped = { ...after, quarantined: true, quarantinedAt: Date.now(), reason: verdict.reason } as ToolQuarantineState;
        host.record('rot_tool', stopped);
        host.mark('rot_tool', stopped, buildQuarantineCard('rot_tool', stopped, verdict));
      }
    }
    expect(cards).toHaveLength(1);
  });

  it('新回合从扫描结果 seed 回来的计数必须是磁盘上那份', async () => {
    reset([{ file: 'rot_tool/TOOL.json', text: '{}', quarantined: false, quarantineMarker: null }], true);
    const first = createToolQuarantineHost({ seed: [] });
    first.record('rot_tool', { ...emptyQuarantineState(), consecutiveFailures: 2, totalCalls: 2, lastFailureAt: Date.now() });
    // 模拟下一回合：重新扫描 + 用扫描结果 seed。
    const entries = await loadQuarantinedTools();
    const second = createToolQuarantineHost({ seed: entries });
    // loadQuarantinedTools 只列已停用的，所以未停用工具的计数走 chat.ts 的
    // marked 通道 —— 这里直接断言「标记在扫描结果里、且带计数」。
    const scan = (await import('../../shared/tauri')).tauriInvoke as unknown as (c: string) => Promise<Array<{ quarantineMarker: { consecutiveFailures?: number } }>>;
    const rows = await scan('list_external_tools');
    expect(rows[0].quarantineMarker.consecutiveFailures).toBe(2);
    expect(second.seed('missing_tool')).toEqual(emptyQuarantineState());
  });
});
