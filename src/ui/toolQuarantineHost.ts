// src/ui/toolQuarantineHost.ts
// 阶段 13.4 停用门的 GUI 宿主实现（裁决逻辑在 harness/toolQuarantine.ts，这里只
// 做 IO 与接线）。
//
// 为什么单独一个模块而不是塞进 chat.ts：这道门有三个人用——执行面要 seed/mark，
// 装载面要把停用工具从列表里剔掉，仪表盘要列出它们。三处各读各的会立刻漂移成
// 三个真相（「执行面认为它停用了、仪表盘认为它没有」）。这里一个 owner。
//
// 红线：`skills.evolution === false` 时本模块返回「什么都没有」——总开关关掉的
// 会话连外部工具都不装载，也就不该有任何停用动作或停用卡片。这条纪律必须守在
// **每一个**出入口（scan / mark / reinstate），不是只守装载面：装载面的缓存是
// 进程级的，用户「装载之后关掉开关」照样会走到 mark。

import { isTauriRuntime, tauriInvoke } from '../shared/tauri';
import { loadConfig } from './config';
import {
  emptyQuarantineState,
  parseQuarantineMarker,
  type QuarantineMarker,
  type ToolQuarantineCard,
  type ToolQuarantineState,
} from '../harness/toolQuarantine';
import type { ExternalToolQuarantineHost } from '../coding-agent/CodingAgent';

interface RawExternalTool {
  file: string;
  text: string;
  quarantined?: boolean;
  /** An already-parsed marker OBJECT (serde_json::Value), not a string. The
   *  parser accepts both shapes; typing it `string` here is what previously made
   *  `text.trim is not a function` take down the whole load. */
  quarantineMarker?: QuarantineMarker | string | null;
}

export interface QuarantinedToolEntry {
  name: string;
  state: ToolQuarantineState;
}

function evolutionEnabled(): boolean {
  try {
    return loadConfig()?.skills?.evolution !== false;
  } catch {
    return true;
  }
}

/** Read one fresh scan of ~/.pure/tools/. Deliberately NOT cached: the dashboard
 *  must show the state as of now — a tool quarantined ten seconds ago has to be
 *  on screen, and the loader's per-run cache would hide it until restart. */
async function scan(): Promise<RawExternalTool[]> {
  if (!isTauriRuntime() || !evolutionEnabled()) return [];
  try {
    return (await tauriInvoke<RawExternalTool[]>('list_external_tools')) ?? [];
  } catch (error) {
    console.warn('[tool-quarantine] scan failed:', error);
    return [];
  }
}

function toolNameFrom(file: string): string {
  return file.replace(/\/TOOL\.json$/, '');
}

/** The dashboard's data source: every tool currently carrying a marker. */
export async function loadQuarantinedTools(): Promise<QuarantinedToolEntry[]> {
  const out: QuarantinedToolEntry[] = [];
  for (const source of await scan()) {
    if (source.quarantined !== true) continue;
    out.push({ name: toolNameFrom(source.file), state: parseQuarantineMarker(source.quarantineMarker) });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * The `ExternalToolQuarantineHost` for CodingAgent.
 *
 * `known` is seeded from the loader's scan — that is the whole point: a counter
 * that lives only in this process resets every turn, so the gate would only ever
 * fire on "three failures inside ONE turn" and never on the slow breakage it
 * exists for. The loader already hands us every marker, so the counters ride in
 * from disk instead of starting from nothing.
 */
export function createToolQuarantineHost(options: {
  /** Markers from the same scan that produced the tool list. */
  seed?: readonly QuarantinedToolEntry[];
  onQuarantined?: (card: ToolQuarantineCard) => void;
} = {}): ExternalToolQuarantineHost {
  const known = new Map<string, ToolQuarantineState>(
    (options.seed ?? []).map((entry) => [entry.name, entry.state]),
  );
  const persist = (name: string, state: ToolQuarantineState): void => {
    known.set(name, state);
    if (!isTauriRuntime() || !evolutionEnabled()) return;
    // ONE command per call, carrying the operation explicitly. The previous
    // shape overloaded `reason: null` as both "no reason" and "reinstate", and
    // Rust read every counter write as the latter — so the counters never
    // reached disk and the gate only ever fired inside a single turn.
    const op = state.quarantined ? 'quarantine' : 'record';
    void tauriInvoke<void>('set_tool_quarantined', {
      name,
      op,
      reason: state.quarantined ? (state.reason ?? 'quarantined') : null,
      state: {
        consecutiveFailures: state.consecutiveFailures,
        totalCalls: state.totalCalls,
        lastFailureAt: state.lastFailureAt,
        ...(state.quarantinedAt ? { quarantinedAt: state.quarantinedAt } : {}),
      },
    }).catch((error: unknown) => {
      // Fire-and-forget by contract: the call that produced this state already
      // ran and returned. A counter that fails to persist costs accuracy across
      // turns, not the turn itself.
      console.warn(`[tool-quarantine] failed to persist "${name}":`, error);
    });
  };
  return {
    seed(name) {
      return known.get(name) ?? emptyQuarantineState();
    },
    /** Called on EVERY outcome, not just at the quarantine line. A counter that
     *  only reaches disk when it trips has never actually survived a turn —
     *  which is exactly the bug this seam replaced. */
    record(name, state) {
      persist(name, state);
    },
    mark(name, state, card) {
      options.onQuarantined?.(card);
    },
  };
}

/** User action: re-enable. Removes the marker so the next scan loads it again. */
export async function reinstateTool(name: string): Promise<void> {
  if (!isTauriRuntime() || !evolutionEnabled()) return;
  await tauriInvoke<void>('set_tool_quarantined', { name, op: 'reinstate', reason: null });
}
