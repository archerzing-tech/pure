// src/coding-agent/subagentMemory.ts
// P0-3（2026-09-30，两柱焊点）— 子代理记忆注入的纯核。
// 洞：编排器直接驱动 engine.run，baseCtx 里从来没有 IMemoryStore —— 进化产物
// 里数量最大的 lessons/procedures 只到父 agent，到不了干活的人；子代理唯一吃到
// 的进化物是 persona overlay。本模块把「检索 → 分组 → 定容 → 格式化」做成可注入
// 的纯逻辑，编排器只在 spawn 时调一次：
//   - 查询 = 角色 + 委派参数（干活的人最相关的语义面）；
//   - 每支只 compose 一次、运行中不刷新（与父会话「会话内冻结」同一决策，
//     子代理本来就每支新 prompt，不存在打穿缓存断点的问题）；
//   - 检索失败 / 超时降级为不注入（记忆绝不能挡委派起飞）；
//   - confidence:'low' 不注入（E1.1 防幻觉纪律，与父侧同一把尺）。
// 开关与归因不在这层：编排器按 evolutionEnabled 决定是否调用，注入的条目 id 由
// SubagentResult.memoryInjected 随结果上抛（DelegationObservation 记账）。

import type { IMemoryStore, MemoryEntry } from '../shared/types';

/** 检索条数：远小于父会话的 k=12 —— 子代理上下文预算紧，且只需要与这一件活
 *  直接相关的经验，不是会话身份层。 */
export const SUBAGENT_MEMORY_K = 6;

/** 检索超时：父会话首搜可能触发 embedder 冷启动（WASM + 模型加载），但那是
 *  父 run() 早已付过的成本；这里只兜异常慢的查询，超时即放弃注入。 */
export const SUBAGENT_MEMORY_SEARCH_TIMEOUT_MS = 2_000;

/** 各组注入上限：procedures 是对干活的人最有用的（已验证的打法），给两条；
 *  错误教训两条；已验证成功做法一条；工具注意一条。总共 ≤6 条，与 k 对齐。 */
const GROUP_CAPS: Partial<Record<MemoryEntry['type'], number>> = {
  procedure: 2,
  error_pattern: 2,
  successful_pattern: 1,
  tool_preference: 1,
};

/** 整块硬上限（字符）：注入是增益不是义务，超限从尾部裁条目，绝不让记忆
 *  挤占委派本身的工作空间。 */
export const SUBAGENT_MEMORY_MAX_CHARS = 1_600;

const GROUP_LABELS: Partial<Record<MemoryEntry['type'], string>> = {
  procedure: 'Proven procedure',
  error_pattern: 'Known error to avoid',
  successful_pattern: 'Verified approach',
  tool_preference: 'Tool note (verified on this machine)',
};

/** 单一写手：条目 → 进块的行 + 对应条目 id（同步产出，归因与模型实际看到的
 *  永远对齐 —— 不做事后反推匹配，重复内容/子串误命中没有缝）。 */
function selectDelegationMemory(entries: readonly MemoryEntry[]): { lines: string[]; entryIds: string[] } {
  const lines: string[] = [];
  const entryIds: string[] = [];
  const seenContent = new Set<string>();
  for (const entry of entries) {
    const cap = GROUP_CAPS[entry.type];
    const label = GROUP_LABELS[entry.type];
    if (!cap || !label) continue; // 用户偏好/项目约定是父会话身份层，不进子代理
    if (entry.confidence === 'low') continue; // E1.1：无证据教训不注入
    const content = entry.content.trim();
    if (!content || seenContent.has(content)) continue;
    seenContent.add(content);
    const used = lines.filter(l => l.startsWith(`- ${label}`)).length;
    if (used >= cap) continue;
    const line = `- ${label}: ${content}`;
    if ([...lines, line].join('\n').length > SUBAGENT_MEMORY_MAX_CHARS) break; // 上限是硬边界，不做半行截断
    lines.push(line);
    entryIds.push(entry.id);
  }
  return { lines, entryIds };
}

/** 纯格式化：把（已检索、已过滤的）条目编成拼在子代理 system prompt 尾部的
 *  记忆块。空组 / 全裁 ⇒ 空串（调用方拼 '' 即无块）。导出供单测直接喂条目。 */
export function formatDelegationMemoryBlock(entries: readonly MemoryEntry[]): string {
  const { lines } = selectDelegationMemory(entries);
  if (lines.length === 0) return '';
  return [
    '',
    '<delegated_task_memory>',
    'Relevant experience retrieved for this delegation. Proven procedures come first; error entries are avoid-lists from earlier runs, not facts to reproduce:',
    ...lines,
    '</delegated_task_memory>',
  ].join('\n');
}

export interface DelegationMemoryInput {
  store: IMemoryStore;
  /** 查询语义面：角色 + 委派参数摘要（调用方拼好）。 */
  query: string;
  /** 项目域（与父 Harness 的 projectPath 同源 —— 记忆按项目隔离）。 */
  projectPath?: string;
  /** 可注入超时（测试用）。 */
  timeoutMs?: number;
}

export interface DelegationMemory {
  /** 拼接用记忆块；空串 = 不注入。 */
  block: string;
  /** 实际进块的条目 id（归因用，随 SubagentResult 上抛）。 */
  entryIds: string[];
}

/** 检索并编排一次子代理记忆。永不 reject：任何失败（含超时）都降级为
 *  「不注入」—— 记忆是增益，绝不能挡委派起飞。 */
export async function retrieveDelegationMemory(input: DelegationMemoryInput): Promise<DelegationMemory> {
  let entries: MemoryEntry[] = [];
  try {
    entries = await Promise.race([
      input.store.search(input.query, {
        k: SUBAGENT_MEMORY_K,
        ...(input.projectPath ? { projectPath: input.projectPath } : {}),
      }),
      new Promise<MemoryEntry[]>((resolve) =>
        setTimeout(() => resolve([]), input.timeoutMs ?? SUBAGENT_MEMORY_SEARCH_TIMEOUT_MS)),
    ]);
  } catch {
    return { block: '', entryIds: [] };
  }
  const { lines, entryIds } = selectDelegationMemory(entries);
  if (lines.length === 0) return { block: '', entryIds: [] };
  const block = [
    '',
    '<delegated_task_memory>',
    'Relevant experience retrieved for this delegation. Proven procedures come first; error entries are avoid-lists from earlier runs, not facts to reproduce:',
    ...lines,
    '</delegated_task_memory>',
  ].join('\n');
  return { block, entryIds };
}
