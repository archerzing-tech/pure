// src/ui/memoryTransfer.ts
// 记忆库导出/导入（Settings → Memory → 导出 / 导入，§12.9）。
// 纯函数模块：不触碰 DOM / store —— build/parse 逻辑可 headless 单测。
//
// 导出格式（JSON，迁移到新机器用）：
//   { app: 'pure', kind: 'memory-library', version: 1, exportedAt: ISO,
//     entries: [ { ...MemoryEntry, healthScore: 0.82, liveLifecycle: 'active' } ] }
//   - 保留原始 id / supersededBy / hitCount / lastUsedAt / decayScore 等字段，
//     迁移后取代链（supersededBy → 新 id）依然成立、使用频率信号不丢失。
//   - 每条额外附实时健康分（healthScore）与生命周期（liveLifecycle）——导出
//     时按当前生效阈值重算，JSON 里的 healthScore 是"导出那一刻"的快照。
// Markdown 导出：人类可读的报告，按生命周期分组，含健康分进度、取代标记。
// 导入：接受本模块导出的 JSON（app/kind/version 校验），也容忍裸数组。

import type { MemoryEntry, MemoryType } from '../adapter/memory/IMemoryStore';
import type { MemoryLifecycle } from '../shared/types';
import { healthScore, lifecycleOf, type EvolutionConfig } from '../adapter/memory/evolution';

export const MEMORY_EXPORT_APP = 'pure';
export const MEMORY_EXPORT_KIND = 'memory-library';
export const MEMORY_EXPORT_VERSION = 1;

export interface MemoryExportEnvelope {
  app: typeof MEMORY_EXPORT_APP;
  kind: typeof MEMORY_EXPORT_KIND;
  version: number;
  exportedAt: string;
  entries: MemoryEntry[];
}

/** 有效记忆类型全集（导入校验用；与 IMemoryStore 的 MemoryType 一致）。 */
const VALID_TYPES = new Set<MemoryType>([
  'user_preference', 'error_pattern', 'successful_pattern', 'project_convention', 'procedure',
]);

/** 把一条记忆渲染成 JSON 条目：原始字段 + 实时健康分/生命周期快照。 */
function exportEntry(e: MemoryEntry, cfg: Partial<EvolutionConfig> | undefined, now: number): Record<string, unknown> {
  const score = healthScore(e, now, cfg);
  return {
    ...e,
    // 快照字段显式列出（而非展开 e 后覆盖），保证导出文件可读性稳定。
    healthScore: Math.round(score * 10000) / 10000,
    liveLifecycle: lifecycleOf(score, cfg),
  };
}

/**
 * 构建 JSON 导出文本。entries 为全库（含所有项目）；cfg 为当前生效的进化
 * 阈值（用于重算实时健康分快照）；now 为导出时刻。
 */
export function buildMemoryExportJson(
  entries: MemoryEntry[],
  cfg?: Partial<EvolutionConfig>,
  now: number = Date.now(),
): string {
  const envelope: MemoryExportEnvelope = {
    app: MEMORY_EXPORT_APP,
    kind: MEMORY_EXPORT_KIND,
    version: MEMORY_EXPORT_VERSION,
    exportedAt: new Date(now).toISOString(),
    entries: entries.map(e => exportEntry(e, cfg, now) as unknown as MemoryEntry),
  };
  // healthScore/liveLifecycle 是快照字段（Record 展开后），转为 MemoryEntry
  // 时经 unknown 中转 —— 编译期无需逐字段证明，字段本就来自 MemoryEntry。
  return JSON.stringify(envelope, null, 2);
}

/** 人类可读的相对时间（与 settings.ts 仪表盘同一口径，避免重复依赖）。 */
function relativeTime(ts: number, now: number): string {
  const diff = Math.max(0, now - ts);
  const MIN = 60_000, HOUR = 3_600_000, DAY = 86_400_000;
  if (diff < MIN) return '刚刚';
  if (diff < HOUR) return `${Math.floor(diff / MIN)} 分钟前`;
  if (diff < DAY) return `${Math.floor(diff / HOUR)} 小时前`;
  return `${Math.floor(diff / DAY)} 天前`;
}

const TYPE_LABEL: Record<MemoryType, string> = {
  user_preference: '偏好',
  error_pattern: '错误教训',
  successful_pattern: '成功经验',
  project_convention: '项目惯例',
  procedure: '流程',
};

const LIFECYCLE_LABEL: Record<MemoryLifecycle, string> = {
  active: '活跃',
  degraded: '降级',
  dormant: '休眠',
};

function lifecycleCounts(entries: MemoryEntry[], cfg: Partial<EvolutionConfig> | undefined, now: number) {
  const counts = { active: 0, degraded: 0, dormant: 0 };
  for (const e of entries) counts[lifecycleOf(healthScore(e, now, cfg), cfg)]++;
  return counts;
}

/**
 * 构建 Markdown 导出文本：头部摘要 + 按生命周期分组的逐条报告。
 */
export function buildMemoryExportMarkdown(
  entries: MemoryEntry[],
  cfg?: Partial<EvolutionConfig>,
  now: number = Date.now(),
): string {
  const counts = lifecycleCounts(entries, cfg, now);
  const lines: string[] = [
    '# Pure 记忆库导出',
    '',
    `- **导出时间**: ${new Date(now).toLocaleString()}`,
    `- **记忆总数**: ${entries.length}`,
    `- **活跃**: ${counts.active} · **降级**: ${counts.degraded} · **休眠**: ${counts.dormant}`,
    '',
  ];

  const byId = new Map(entries.map(e => [e.id, e]));
  const order: MemoryLifecycle[] = ['active', 'degraded', 'dormant'];
  // 内容可能含 markdown 结构字符（# > 等），内联代码引号包裹保证报告结构不被
  // 破坏；内容里的反引号换成撇号（内联代码里不能嵌套反引号）。
  const mdInline = (s: string): string => s
    .replace(/`/g, "'")
    .replace(/\n/g, ' ')
    .slice(0, 200);
  let shown = 0;
  for (const lifecycle of order) {
    const group = entries
      .map(e => ({ e, score: healthScore(e, now, cfg) }))
      .filter(x => lifecycleOf(x.score, cfg) === lifecycle)
      .sort((a, b) => b.score - a.score || b.e.timestamp - a.e.timestamp);
    if (group.length === 0) continue;
    lines.push(`## ${LIFECYCLE_LABEL[lifecycle]}（${group.length}）`, '');
    for (const { e, score } of group) {
      shown++;
      const pct = Math.min(100, Math.max(0, Math.round(score * 100)));
      const type = TYPE_LABEL[e.type] ?? e.type;
      const project = e.projectPath ? `（${e.projectPath}）` : '';
      const superseded = e.supersededBy
          ? (() => {
              const replacer = byId.get(e.supersededBy!);
              return `> ⚠️ **被取代** — 被 \`${mdInline(replacer ? replacer.content : e.supersededBy!)}\` 取代，正在加速降级。`;
            })()
          : '';
      lines.push(
        `### ${shown}. [${type}] \`${mdInline(e.content)}\`${project}`,
        '',
        `- **健康分**: ${pct}%（${LIFECYCLE_LABEL[lifecycle]}）`,
        `- **创建**: ${new Date(e.timestamp).toLocaleString()} · **上次使用**: ${e.lastUsedAt ? relativeTime(e.lastUsedAt, now) : '从未'}`,
        `- **检索次数**: ${e.hitCount ?? 0} · **会话**: ${e.sessionId}`,
        ...(superseded ? [superseded, ''] : []),
        '',
      );
    }
  }
  if (shown === 0) lines.push('_暂无记忆。_', '');
  return lines.join('\n');
}

/**
 * 解析导入文本 → MemoryEntry[]。接受：
 *   1. 本模块导出的 JSON 信封（app=pure / kind=memory-library / version 兼容）。
 *   2. 裸 MemoryEntry 数组（容忍旧格式/手工构造）。
 * 每条做最小字段校验（type 合法、content 为字符串、timestamp 为有限数），
 * 不合法条目跳过。整体不是有效 JSON / 信封类型不对 → throw（调用方 toast）。
 */
export function parseMemoryImport(text: string): MemoryEntry[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error('invalid-json');
  }

  const rawEntries: unknown[] = Array.isArray(parsed)
    ? parsed
    : (parsed && typeof parsed === 'object' && Array.isArray((parsed as { entries?: unknown[] }).entries))
      ? (parsed as { entries: unknown[] }).entries
      : [];

  // 是信封但不是我们导出的 → 拒绝（裸数组跳过该检查，保持宽容）。
  if (!Array.isArray(parsed) && parsed && typeof parsed === 'object') {
    const obj = parsed as { app?: unknown; kind?: unknown; version?: unknown };
    if (obj.app !== undefined || obj.kind !== undefined) {
      if (obj.app !== MEMORY_EXPORT_APP || obj.kind !== MEMORY_EXPORT_KIND) {
        throw new Error('unsupported-envelope');
      }
      // 前向兼容：未来更高版本的导出可能改变条目结构 —— 拒绝而非静默误解析。
      if (typeof obj.version === 'number' && obj.version > MEMORY_EXPORT_VERSION) {
        throw new Error('unsupported-version');
      }
    }
  }

  const out: MemoryEntry[] = [];
  for (const raw of rawEntries) {
    if (!raw || typeof raw !== 'object') continue;
    const e = raw as Partial<MemoryEntry> & Record<string, unknown>;
    if (typeof e.content !== 'string' || !e.content.trim()) continue;
    if (typeof e.type !== 'string' || !VALID_TYPES.has(e.type as MemoryType)) continue;
    const timestamp = typeof e.timestamp === 'number' && Number.isFinite(e.timestamp) ? e.timestamp : Date.now();
    const id = typeof e.id === 'string' && e.id ? e.id : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
    // 显式白名单字段 —— 导入文件只携带存储字段，绝不引入任意键。
    const entry: MemoryEntry = {
      id,
      type: e.type as MemoryType,
      content: e.content,
      timestamp,
      sessionId: typeof e.sessionId === 'string' ? e.sessionId : '',
      projectPath: typeof e.projectPath === 'string' ? e.projectPath : '',
    };
    // 钳制到 0..1 契约（恶意/损坏文件里的 99 等值不污染健康分语义）。
    if (typeof e.decayScore === 'number' && Number.isFinite(e.decayScore)) {
      entry.decayScore = Math.min(1, Math.max(0, e.decayScore));
    }
    if (typeof e.lifecycle === 'string' && (e.lifecycle === 'active' || e.lifecycle === 'degraded' || e.lifecycle === 'dormant')) {
      entry.lifecycle = e.lifecycle;
    }
    if (typeof e.hitCount === 'number' && Number.isFinite(e.hitCount) && e.hitCount >= 0) entry.hitCount = Math.floor(e.hitCount);
    if (typeof e.lastUsedAt === 'number' && Number.isFinite(e.lastUsedAt)) entry.lastUsedAt = e.lastUsedAt;
    if (typeof e.supersededBy === 'string' && e.supersededBy) entry.supersededBy = e.supersededBy;
    if (typeof e.dedupeKey === 'string' && e.dedupeKey) entry.dedupeKey = e.dedupeKey;
    // 结构化教训（error_pattern 携带）：迁移往返不丢 lesson（保真承诺的
    // 一部分）。MemoryLesson 五个必需字段必须都是字符串才保留 —— 缺任一
    // 字段视为损坏，整条 lesson 丢弃（而非导入残缺数据）。
    const l = e.lesson as Record<string, unknown> | undefined;
    if (l && typeof l === 'object') {
      const symptom = l.symptom, rootCause = l.rootCause, recoveryPath = l.recoveryPath,
        verification = l.verification, avoidNextTime = l.avoidNextTime;
      if ([symptom, rootCause, recoveryPath, verification, avoidNextTime].every(v => typeof v === 'string')) {
        // every() 不向单个变量传播收窄 —— 逐个断言（值已在上方验证为 string）。
        const str = (v: unknown): string => v as string;
        const lesson: NonNullable<MemoryEntry['lesson']> = {
          symptom: str(symptom), rootCause: str(rootCause), recoveryPath: str(recoveryPath),
          verification: str(verification), avoidNextTime: str(avoidNextTime),
        };
        if (Array.isArray(l.tools) && l.tools.every(t => typeof t === 'string')) {
          lesson.tools = l.tools;
        }
        entry.lesson = lesson;
      }
    }
    out.push(entry);
  }
  return out;
}
