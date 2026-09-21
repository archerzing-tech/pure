// src/engine/relayPipeline.ts
// 北极星第 5 步 · 接力流水线（relay pipeline）。
// 「接力流水线是委派参数的声明式扩展，不是 agent 间私开 socket」
// （docs/multi-agent-self-evolving-architecture.md 原则三 · 事件即接口）。
//
// 模型在同一条消息的批量工具调用里用保留参数 relay 声明接力关系：
//   relay.as   — 本调用的产出登记为一个阶段名，供同批下游调用引用；
//   relay.from — { 阶段名: 参数名 }，执行前把该阶段的产出直接灌进本调用的
//                对应参数。上游产出不再绕经父级上下文中转（父会话不被刷屏），
//                交接由 ToolExecutionCoordinator 按拓扑序执行。
//
// 本模块只做纯计算：声明解析 / 校验 / 拓扑分层 / 参数替换 / 收据文本。
// 执行编排与「观察消隐」的时机在 ToolExecutionCoordinator（上游产出被下游
// 成功消费后，父级观察替换为一行收据；下游失败则回灌完整产出供重规划）。

import { parseToolArguments } from '../shared/parseRepair';
import type { ToolCall } from '../shared/types';
import type { ExecutedToolResult } from './ToolExecutionCoordinator';

/** One call's parsed relay declaration (absent → undefined). */
export interface RelayDecl {
  /** Register this call's output under a stage name for same-batch consumers. */
  as?: string;
  /** stage name → local argument name: that stage's output becomes args[argName]. */
  from?: Record<string, string>;
}

/** A batched call together with its relay view. */
export interface RelayNode {
  call: ToolCall;
  decl: RelayDecl | undefined;
  /** Upstream stage names this call consumes (keys of decl.from). */
  deps: string[];
}

export interface RelayPlan {
  /** Topological levels: nodes in levels[i] only consume outputs produced by
   * levels[<i]. Within a level the coordinator keeps its existing concurrency
   * policy (reads overlap, writes serialize). */
  levels: RelayNode[][];
  /** Calls that must NOT run, with a model-facing reason (invalid declaration,
   * duplicate stage name, unknown upstream, upstream skipped, dependency
   * cycle). Every one of them still gets a pairing result so the transcript
   * never hangs a toolCall without an observation. */
  errors: Array<{ callId: string; toolName: string; message: string }>;
}

/** Parse the reserved `relay` argument out of a call's JSON arguments. Uses
 * the same repair pass as execution, so a slightly-broken LLM JSON still
 * yields its declaration. Unparseable arguments → undefined (execution will
 * report the parse error through the normal path). */
export function parseRelayDecl(argsText: string): RelayDecl | undefined {
  let args: unknown;
  try {
    args = parseToolArguments(argsText);
  } catch {
    return undefined;
  }
  if (!args || typeof args !== 'object' || Array.isArray(args)) return undefined;
  const relay = (args as Record<string, unknown>).relay;
  if (!relay || typeof relay !== 'object' || Array.isArray(relay)) return undefined;
  const decl: RelayDecl = {};
  const as = (relay as Record<string, unknown>).as;
  if (typeof as === 'string' && as.trim()) decl.as = as.trim();
  const from = (relay as Record<string, unknown>).from;
  if (from && typeof from === 'object' && !Array.isArray(from)) {
    const map: Record<string, string> = {};
    for (const [stage, argName] of Object.entries(from as Record<string, unknown>)) {
      if (typeof argName === 'string' && argName.trim()) map[stage] = argName.trim();
    }
    if (Object.keys(map).length > 0) decl.from = map;
  }
  return decl.as || decl.from ? decl : undefined;
}

/** Wrap a call into a RelayNode (parse + collect its dependency stage names). */
export function relayNode(call: ToolCall): RelayNode {
  const decl = parseRelayDecl(call.function.arguments);
  return { call, decl, deps: decl?.from ? Object.keys(decl.from) : [] };
}

/** Validate the batch's relay graph and cut it into topological levels.
 * Fail-fast: a call whose declaration cannot be honored never runs; its
 * consumers are skipped transitively with a reason naming the upstream. */
export function planRelayLevels(nodes: RelayNode[]): RelayPlan {
  const errors: RelayPlan['errors'] = [];
  const invalid = new Set<RelayNode>();
  const stageOwner = new Map<string, RelayNode>();

  // Pass 1 — register stage names; a duplicate name errors the LATER call
  // (the earlier registration keeps the name: deterministic, order-stable).
  for (const node of nodes) {
    const as = node.decl?.as;
    if (!as) continue;
    if (stageOwner.has(as)) {
      invalid.add(node);
      errors.push({
        callId: node.call.id,
        toolName: node.call.function.name,
        message: `relay 阶段名 "${as}" 已被同批另一个调用占用，本调用不执行——换一个阶段名，或去掉 relay.as。`,
      });
    } else {
      stageOwner.set(as, node);
    }
  }

  // Pass 2 — every referenced stage must exist in this batch.
  for (const node of nodes) {
    if (invalid.has(node)) continue;
    const missing = node.deps.find((stage) => !stageOwner.has(stage));
    if (missing !== undefined) {
      invalid.add(node);
      errors.push({
        callId: node.call.id,
        toolName: node.call.function.name,
        message: `relay.from 引用的阶段 "${missing}" 在同一批调用里不存在（没有调用声明 relay.as: "${missing}"），本调用不执行。`,
      });
    }
  }

  // Pass 3 — transitive skip: an upstream that will not run takes its
  // consumers with it (fixpoint loop, because invalidation cascades forward).
  let changed = true;
  while (changed) {
    changed = false;
    for (const node of nodes) {
      if (invalid.has(node)) continue;
      const dead = node.deps.find((stage) => {
        const owner = stageOwner.get(stage);
        return owner !== undefined && invalid.has(owner);
      });
      if (dead !== undefined) {
        invalid.add(node);
        changed = true;
        errors.push({
          callId: node.call.id,
          toolName: node.call.function.name,
          message: `relay 上游阶段 "${dead}" 因声明问题不执行，本调用随之跳过。`,
        });
      }
    }
  }

  // Pass 4 — Kahn peel over what is left; anything that never peels is a
  // dependency cycle. A self-reference (relay.from naming its own relay.as)
  // keeps its self-edge forever (a node's own peel never decrements it), so
  // it lands here too instead of silently running without its input.
  const alive = nodes.filter((node) => !invalid.has(node));
  const indegree = new Map<RelayNode, number>();
  for (const node of alive) indegree.set(node, node.deps.length);
  const levels: RelayNode[][] = [];
  let frontier = alive.filter((node) => (indegree.get(node) ?? 0) === 0);
  let peeled = frontier.length;
  while (frontier.length > 0) {
    levels.push(frontier);
    const next: RelayNode[] = [];
    for (const node of frontier) {
      const as = node.decl?.as;
      if (!as) continue; // unregistered stages have no consumers by construction
      for (const other of alive) {
        if (invalid.has(other) || other === node) continue;
        if (other.deps.includes(as)) {
          const d = (indegree.get(other) ?? 1) - 1;
          indegree.set(other, d);
          if (d === 0) next.push(other);
        }
      }
    }
    frontier = next;
    peeled += next.length;
  }
  if (peeled < alive.length) {
    const cyclic = alive.filter((node) => !levels.some((level) => level.includes(node)));
    const names = cyclic.map((node) => node.decl?.as ?? node.call.function.name).join('", "');
    for (const node of cyclic) {
      invalid.add(node);
      errors.push({
        callId: node.call.id,
        toolName: node.call.function.name,
        message: `relay 依赖成环（涉及 "${names}"）——本调用不执行，请把链路改成单向的。`,
      });
    }
  }

  return { levels, errors };
}

/** Extract the text an upstream stage hands to its consumers: a string result
 * is itself; a SubagentResult-shaped object contributes its `output`; any
 * other object value is serialized. */
export function relayOutputText(tr: ExecutedToolResult): string {
  const value = tr.result.result;
  if (typeof value === 'string') return value;
  if (value && typeof value === 'object' && typeof (value as { output?: unknown }).output === 'string') {
    return (value as { output: string }).output;
  }
  if (value !== undefined && value !== null) {
    try {
      return JSON.stringify(value);
    } catch {
      return String(value);
    }
  }
  return '';
}

/** Rewrite a consumer's arguments before execution: each declared upstream
 * stage's output is injected verbatim into the named argument slot. Other
 * arguments (including the relay declaration itself) are preserved. */
export function applyRelaySubstitution(
  call: ToolCall,
  from: Record<string, string>,
  stageOutputs: Map<string, ExecutedToolResult>,
): ToolCall {
  let args: Record<string, unknown>;
  try {
    args = parseToolArguments(call.function.arguments) as Record<string, unknown>;
    if (!args || typeof args !== 'object' || Array.isArray(args)) args = {};
  } catch {
    args = {};
  }
  for (const [stage, argName] of Object.entries(from)) {
    const upstream = stageOutputs.get(stage);
    if (upstream) args[argName] = relayOutputText(upstream);
  }
  return { ...call, function: { ...call.function, arguments: JSON.stringify(args) } };
}

/** The reserved relay argument as exposed on every delegation tool's schema,
 * so the model declares pipelines with documented parameters instead of
 * out-of-band conventions. Description is model-facing. */
export const RELAY_INPUT_SCHEMA: Record<string, unknown> = {
  type: 'object',
  description: '接力声明（仅同批调用间生效）：as 把本调用的产出登记为一个阶段名；from 把上游阶段的产出直接灌进本调用的参数（阶段名→参数名）。串行依赖链用它一次性声明整条链，运行时按序执行并直传产出，不要逐跳经过主会话中转。',
  properties: {
    as: { type: 'string', description: '本调用产出的阶段名，供同批下游调用的 relay.from 引用' },
    from: {
      type: 'object',
      additionalProperties: { type: 'string' },
      description: '上游阶段名 → 本调用的参数名：该阶段的完整产出会直接写入该参数',
    },
  },
};

/** Clone a tool's input schema with the relay argument added. Definitions are
 * shared singletons — never mutate them; and a definition that already
 * documents its own relay argument keeps its version. */
export function withRelaySchema(inputSchema: Record<string, unknown>): Record<string, unknown> {
  const props = inputSchema.properties;
  const existing = props && typeof props === 'object' && !Array.isArray(props) ? props : {};
  if ('relay' in existing) return inputSchema;
  return { ...inputSchema, properties: { ...existing, relay: RELAY_INPUT_SCHEMA } };
}

/** The parent-visible receipt that replaces a consumed upstream's raw output:
 * the pipeline was the transport, so the main session gets one line instead
 * of the full text (which stays on the run's activity card and archives). */
export function relayReceipt(tr: ExecutedToolResult, consumerStages: string[]): ExecutedToolResult {
  const chars = relayOutputText(tr).length;
  const who = consumerStages.map((stage) => `"${stage}"`).join('、');
  const note = `[relay] 该阶段产出（约 ${chars} 字符）已直接交给下游阶段 ${who}，不再重复进主会话；完整内容见该子任务的活动卡与存档。`;
  const value = tr.result.result;
  if (typeof value === 'string') {
    return { ...tr, result: { ...tr.result, result: note } };
  }
  if (value && typeof value === 'object' && typeof (value as { output?: unknown }).output === 'string') {
    return { ...tr, result: { ...tr.result, result: { ...(value as Record<string, unknown>), output: note } } };
  }
  return { ...tr, result: { ...tr.result, result: note } };
}
