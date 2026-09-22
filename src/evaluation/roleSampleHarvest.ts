// src/evaluation/roleSampleHarvest.ts
// 北极星第 6 步 13.3（part 3）/ 13.1 — 真实派发样本收割（纯函数，无 IO）。
//
// 为什么从会话存档而不是观测记录：E4.1 的 AgentRunObservation.toolCalls 只记
// toolName / success / durationMs / result(哈希) / error —— 不存 args 也不存
// 产出文本（E0.1 的设计原则就是"不存任何 prompt 文本"）。真实样本只能从会话
// 存档 ~/.pure/sessions/<id>/session.json 的 messages 回收：
//   - 一次子 agent 委派 = assistant 消息里一个 toolCall（function.name=角色，
//     function.arguments=委派 args）+ 一条 toolCallId 配对的 tool 消息
//     （content 是 ToolResult 的 JSON 串：{ id, agentName, success, output }）。
// 本模块对文件系统一无所知——宿主（脚本 scripts/harvest-role-samples.ts）读盘
// 把 messages 喂进来，Bun 测试因此能覆盖整条抽取逻辑而无需 mock IO。

import { KNOWN_SUBAGENT_ROLES } from '../shared/adaptiveControl';
import { NON_ROLE_SUBAGENTS } from '../shared/subagentAdvisory';

/** 默认可收割的角色面：可委派角色里去掉"穿了 agent 外壳的 shell 命令"
 *  （bash_executor）——与 E1.4 建议卡的裁决同源。 */
const DEFAULT_HARVEST_ROLES: ReadonlySet<string> = new Set(
  [...KNOWN_SUBAGENT_ROLES].filter((role) => !NON_ROLE_SUBAGENTS.has(role)),
);

export interface HarvestMessage {
  role: string;
  content?: unknown;
  toolCalls?: Array<{ id?: string; function?: { name?: string; arguments?: unknown } }>;
  toolCallId?: string;
  toolName?: string;
}

export interface HarvestSession {
  id: string;
  messages: HarvestMessage[];
}

export interface RoleDelegationSample {
  role: string;
  args: Record<string, unknown>;
  output: string;
  sessionId: string;
  /** assistant 消息在会话里的下标 —— 同一会话内唯一，用于稳定排序。 */
  messageIndex: number;
}

/** 被中断/失败的委派不是可用的"真实样本"：产出是错误串而不是子 agent 的答案。 */
const ABORT_RE = /^(Error:\s*tool\b[\s\S]*\baborted\b|\[RUN_FAILED\])/i;

/** args 在会话里是 JSON 字符串（function.arguments），但兼容已是对象的情形。 */
function parseArgs(raw: unknown): Record<string, unknown> | undefined {
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) return raw as Record<string, unknown>;
  if (typeof raw !== 'string' || !raw.trim()) return undefined;
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

interface ToolPayload {
  success?: unknown;
  output?: unknown;
}

/** tool 消息的 content 是 ToolResult 的 JSON 串；解析不出对象就没有产出可收。 */
function parseToolPayload(content: unknown): ToolPayload | undefined {
  let text: string | undefined;
  if (typeof content === 'string') {
    text = content;
  } else if (Array.isArray(content)) {
    const parts = content
      .map((part) => (part && typeof part === 'object' && typeof (part as { text?: unknown }).text === 'string'
        ? (part as { text: string }).text
        : ''))
      .filter(Boolean);
    if (parts.length > 0) text = parts.join('\n');
  }
  if (!text || !text.trim()) return undefined;
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === 'object' ? (parsed as ToolPayload) : undefined;
  } catch {
    return undefined;
  }
}

/** 可用的产出：非空、未被标记失败、且不是中断错误串。空产出（崩溃/超时）丢弃。 */
function usableOutput(payload: ToolPayload | undefined): string | undefined {
  if (!payload || payload.success === false) return undefined;
  const output = typeof payload.output === 'string' ? payload.output.trim() : '';
  if (!output || ABORT_RE.test(output)) return undefined;
  return output;
}

/**
 * 抽一个会话里全部真实角色委派样本。`roles` 缺省取内建可委派角色全集
 * （排除 bash_executor 之类的非角色——它不在 KNOWN_SUBAGENT_ROLES 里）。
 * 用 toolCallId 精确配对，不靠"下一条 tool 消息"的位置猜测。
 */
export function harvestRoleSamples(
  sessions: readonly HarvestSession[],
  roles: Iterable<string> = DEFAULT_HARVEST_ROLES,
): RoleDelegationSample[] {
  const wanted = new Set(roles);
  const samples: RoleDelegationSample[] = [];
  for (const session of sessions) {
    const byCallId = new Map<string, HarvestMessage>();
    for (const message of session.messages) {
      if (message.role === 'tool' && message.toolCallId) byCallId.set(message.toolCallId, message);
    }
    session.messages.forEach((message, index) => {
      if (message.role !== 'assistant' || !message.toolCalls) return;
      for (const call of message.toolCalls) {
        const name = call.function?.name;
        if (!name || !wanted.has(name)) continue;
        const args = parseArgs(call.function?.arguments);
        if (!args) continue;
        const result = call.id ? byCallId.get(call.id) : undefined;
        if (!result) continue;
        const output = usableOutput(parseToolPayload(result.content));
        if (!output) continue;
        samples.push({ role: name, args, output, sessionId: session.id, messageIndex: index });
      }
    });
  }
  return samples;
}

/** 去重键：同角色 + 同 args 的委派只算一例（真实语料里同一任务常被重派）。 */
export function sampleDedupeKey(sample: RoleDelegationSample): string {
  return `${sample.role}::${JSON.stringify(sample.args)}`;
}

/** 按去重键去重，保留首次出现的样本；顺序与输入一致（宿主已按时间读入）。 */
export function dedupeSamples(samples: readonly RoleDelegationSample[]): RoleDelegationSample[] {
  const seen = new Set<string>();
  const out: RoleDelegationSample[] = [];
  for (const sample of samples) {
    const key = sampleDedupeKey(sample);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(sample);
  }
  return out;
}

/** 按角色分组（角色名升序，组内保持输入顺序）——harvester 写 fixture 用。 */
export function groupSamplesByRole(samples: readonly RoleDelegationSample[]): Map<string, RoleDelegationSample[]> {
  const groups = new Map<string, RoleDelegationSample[]>();
  for (const sample of samples) {
    const group = groups.get(sample.role);
    if (group) group.push(sample);
    else groups.set(sample.role, [sample]);
  }
  return new Map([...groups.entries()].sort((a, b) => a[0].localeCompare(b[0])));
}
