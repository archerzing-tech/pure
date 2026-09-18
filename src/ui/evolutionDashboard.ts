// src/ui/evolutionDashboard.ts
// E4.2 —— 进化仪表盘的渲染层。全部是"输入数据、输出 HTML 字符串"的纯函数：
// 没有 DOM 访问、没有存储读取、没有时钟（now 由调用方传入），所以设置页只
// 负责把数据喂进来 + 挂事件委托，图表口径可以在 bun 里直接断言。
//
// 为什么自己画 SVG 而不是用 echarts（src/ui/echartsChart.ts）：设置页是懒加载
// 的轻量 chunk，为三张小趋势图把 ~400KB 的 echarts 拖进来不划算；这里的图形
// 只有折线/柱状 + 两条坐标轴，60 行纯函数就够了，而且能逐坐标断言。
//
// 铁律：所有进入 innerHTML 的字符串（记忆内容、工具名、错误类）都过
// escapeHtml —— 记忆库是用户可编辑的本地数据，工具名来自第三方 MCP 服务器。

import { escapeHtml } from '../shared/html';
import { t } from '../shared/i18n';
import { formatBytes } from '../shared/format';
import { healthScore, lifecycleOf, type EvolutionConfig, type MemoryLifecycle } from '../adapter/memory/evolution';
import { isDraftEntry } from '../adapter/memory/correctionDrafts';
import type { MemoryEntry } from '../adapter/memory/IMemoryStore';
import type { DashboardTotals, ErrorCluster, EvolutionDashboard, TrendBucket } from '../shared/evolutionDashboard';
import type { RoleEffectSlice, RunEffectSlice, StrategyEffectSummary } from '../shared/strategyEffect';
import { toolDisplayName } from './toolRow';

// ── 数字格式化 ──

/** 百分比（一位小数；整数不带小数点）；null = 没有样本，显示破折号。 */
export function formatPercent(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—';
  return `${Number.isInteger(value) ? value : value.toFixed(1)}%`;
}

export function formatCount(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—';
  return String(value);
}

export function formatSteps(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—';
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
}

export function formatDuration(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms) || ms < 0) return '—';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const minutes = Math.floor(ms / 60_000);
  return `${minutes}m ${Math.round((ms - minutes * 60_000) / 1000)}s`;
}

/** 相对时间：复用记忆库那套文案（同一个用户感受，不另造词）。 */
export function relativeTime(ts: number, now: number): string {
  const diff = Math.max(0, now - ts);
  const MIN = 60_000;
  const HOUR = 3_600_000;
  const DAY = 86_400_000;
  if (diff < MIN) return t('memory.justNow', '刚刚');
  if (diff < HOUR) return t('memory.minAgo', '{n} 分钟前').replace('{n}', String(Math.floor(diff / MIN)));
  if (diff < DAY) return t('memory.hourAgo', '{n} 小时前').replace('{n}', String(Math.floor(diff / HOUR)));
  return t('memory.dayAgo', '{n} 天前').replace('{n}', String(Math.floor(diff / DAY)));
}

// ── 趋势图（纯 SVG）──

export type TrendMetric = 'completionRate' | 'avgSteps' | 'interventions' | 'toolFailures';

/** 图表纵轴上限：完成率固定 100%，其余按窗口内最大值取整（空窗口用 1 兜底）。 */
function axisMax(metric: TrendMetric, values: readonly number[]): number {
  if (metric === 'completionRate') return 100;
  const max = values.reduce((acc, v) => (v > acc ? v : acc), 0);
  if (max <= 0) return 1;
  if (max <= 5) return 5;
  if (max <= 10) return 10;
  return Math.ceil(max / 10) * 10;
}

/** 取某个桶的指标值。计数类指标在"那天根本没跑过"时按缺样本处理（null）而不是 0
 *  —— 聚合器里计数是真 0（确实没发生），但图上给没跑过的日子画一排零高柱子
 *  读起来像"跑了但一次都没干预"，是两回事。 */
function metricValue(bucket: TrendBucket, metric: TrendMetric): number | null {
  if (metric !== 'completionRate' && bucket.runs === 0) return null;
  return bucket[metric] as number | null;
}

function formatMetric(value: number, metric: TrendMetric): string {
  return metric === 'completionRate' ? formatPercent(value) : formatSteps(value);
}

export interface TrendChartOptions {
  metric: TrendMetric;
  kind?: 'line' | 'bar';
  /** viewBox 高度（宽度固定 360，交给 CSS 拉伸）。 */
  height?: number;
}

/**
 * 一张趋势图的 SVG。没有可画的数据时返回空字符串（调用方显示"暂无数据"），
 * 缺样本的桶（null）在折线里是断点、在柱状图里是空位 —— 不假装成 0。
 */
export function buildTrendSvg(buckets: readonly TrendBucket[], options: TrendChartOptions): string {
  const values = buckets.map((bucket) => metricValue(bucket, options.metric));
  const defined = values.filter((value): value is number => value !== null);
  if (defined.length === 0) return '';

  const width = 360;
  const height = options.height ?? 120;
  const padLeft = 40;
  const padRight = 12;
  const padTop = 12;
  const padBottom = 22;
  const plotWidth = width - padLeft - padRight;
  const plotHeight = height - padTop - padBottom;
  const max = axisMax(options.metric, defined);
  const count = values.length;
  const slot = plotWidth / Math.max(1, count);
  const xAt = (index: number): number => (count <= 1
    ? padLeft + plotWidth / 2
    : padLeft + (index * plotWidth) / (count - 1));
  const yAt = (value: number): number => padTop + plotHeight - (Math.max(0, Math.min(max, value)) / max) * plotHeight;

  const parts: string[] = [];
  // 基线 + 顶线 + 纵轴刻度
  parts.push(`<line x1="${padLeft}" y1="${padTop + plotHeight}" x2="${width - padRight}" y2="${padTop + plotHeight}" class="evo-chart-axis"/>`);
  parts.push(`<line x1="${padLeft}" y1="${padTop}" x2="${width - padRight}" y2="${padTop}" class="evo-chart-grid"/>`);
  parts.push(`<text x="${padLeft - 6}" y="${padTop + 4}" class="evo-chart-label evo-chart-label-y" text-anchor="end">${escapeHtml(String(max))}</text>`);
  parts.push(`<text x="${padLeft - 6}" y="${padTop + plotHeight}" class="evo-chart-label evo-chart-label-y" text-anchor="end">0</text>`);

  if (options.kind === 'bar') {
    const barWidth = Math.max(2, slot * 0.5);
    values.forEach((value, index) => {
      if (value === null) return;
      const top = yAt(value);
      const barHeight = padTop + plotHeight - top;
      const x = padLeft + slot * index + (slot - barWidth) / 2;
      parts.push(
        `<rect x="${x.toFixed(1)}" y="${top.toFixed(1)}" width="${barWidth.toFixed(1)}" height="${Math.max(0.6, barHeight).toFixed(1)}" rx="2" class="evo-chart-bar"><title>${escapeHtml(`${buckets[index].date} · ${formatMetric(value, options.metric)}`)}</title></rect>`,
      );
    });
  } else {
    // 折线按连续段画：null 断开的点不连线，避免把"没跑过"连成一条假趋势。
    let segment: string[] = [];
    const flush = () => {
      if (segment.length > 1) parts.push(`<polyline class="evo-chart-line" points="${segment.join(' ')}"/>`);
      segment = [];
    };
    values.forEach((value, index) => {
      if (value === null) {
        flush();
        return;
      }
      const x = xAt(index);
      const y = yAt(value);
      segment.push(`${x.toFixed(1)},${y.toFixed(1)}`);
      parts.push(`<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="2.5" class="evo-chart-dot"><title>${escapeHtml(`${buckets[index].date} · ${formatMetric(value, options.metric)}`)}</title></circle>`);
    });
    flush();
  }

  // x 轴只标首尾两天 —— 7/30 个日期标签挤在一起反而读不出来。
  const first = buckets[0];
  const last = buckets[count - 1];
  if (first) {
    parts.push(`<text x="${padLeft}" y="${height - 6}" class="evo-chart-label" text-anchor="start">${escapeHtml(first.date.slice(5))}</text>`);
  }
  if (last && count > 1) {
    parts.push(`<text x="${width - padRight}" y="${height - 6}" class="evo-chart-label" text-anchor="end">${escapeHtml(last.date.slice(5))}</text>`);
  }

  return `<svg class="evo-chart-svg" viewBox="0 0 ${width} ${height}" preserveAspectRatio="none" role="img" aria-label="${escapeHtml(t('evolution.chart.aria', '趋势图'))}">${parts.join('')}</svg>`;
}

interface TrendCardSpec {
  metric: TrendMetric;
  kind: 'line' | 'bar';
  titleKey: string;
  titleDefault: string;
}

const TREND_CARDS: readonly TrendCardSpec[] = [
  { metric: 'completionRate', kind: 'line', titleKey: 'evolution.chart.completion', titleDefault: '完成率' },
  { metric: 'avgSteps', kind: 'line', titleKey: 'evolution.chart.steps', titleDefault: '平均步数' },
  { metric: 'interventions', kind: 'bar', titleKey: 'evolution.chart.interventions', titleDefault: '干预次数' },
];

/** 三张趋势卡片（完成率 / 步数 / 干预）。 */
export function renderTrendCards(dashboard: EvolutionDashboard): string {
  return TREND_CARDS.map((spec) => {
    const latest = [...dashboard.buckets].reverse().find((bucket) => metricValue(bucket, spec.metric) !== null);
    const latestValue = latest ? metricValue(latest, spec.metric) : null;
    const svg = buildTrendSvg(dashboard.buckets, { metric: spec.metric, kind: spec.kind });
    const body = svg || `<div class="evo-chart-empty">${escapeHtml(t('evolution.chart.empty', '这段时间还没有记录'))}</div>`;
    return `<div class="evo-chart-card">
      <div class="evo-chart-head">
        <span class="evo-chart-title">${escapeHtml(t(spec.titleKey, spec.titleDefault))}</span>
        <b class="evo-chart-latest">${escapeHtml(latestValue === null ? '—' : formatMetric(latestValue, spec.metric))}</b>
      </div>
      ${body}
    </div>`;
  }).join('');
}

// ── 汇总数字 ──

interface TileSpec {
  labelKey: string;
  labelDefault: string;
  value: string;
  hintKey?: string;
  hintDefault?: string;
}

const TILE = (spec: TileSpec): string => `<div class="evo-tile"${spec.hintKey ? ` title="${escapeHtml(t(spec.hintKey, spec.hintDefault ?? ''))}"` : ''}>
  <span class="evo-tile-value">${escapeHtml(spec.value)}</span>
  <span class="evo-tile-label">${escapeHtml(t(spec.labelKey, spec.labelDefault))}</span>
</div>`;

/** 顶部数字块：窗口内的总量口径。 */
export function renderTotals(dashboard: EvolutionDashboard): string {
  const totals: DashboardTotals = dashboard.totals;
  return [
    TILE({ labelKey: 'evolution.tile.runs', labelDefault: '运行次数', value: formatCount(totals.runs), hintKey: 'evolution.tile.runs.hint', hintDefault: '窗口内完成的 agent run 数' }),
    TILE({ labelKey: 'evolution.tile.completion', labelDefault: '完成率', value: formatPercent(totals.completionRate), hintKey: 'evolution.tile.completion.hint', hintDefault: '跑完并给出结果的 run 占比' }),
    TILE({ labelKey: 'evolution.tile.steps', labelDefault: '平均步数', value: formatSteps(totals.avgSteps), hintKey: 'evolution.tile.steps.hint', hintDefault: '每个 run 的工具调用数' }),
    TILE({ labelKey: 'evolution.tile.interventions', labelDefault: '干预', value: formatCount(totals.interventions), hintKey: 'evolution.tile.interventions.hint', hintDefault: '被中断或验证未通过的 run 数' }),
    TILE({ labelKey: 'evolution.tile.toolFailures', labelDefault: '工具失败', value: formatCount(totals.toolFailures), hintKey: 'evolution.tile.toolFailures.hint', hintDefault: '失败的工具调用次数（去重前）' }),
    TILE({ labelKey: 'evolution.tile.duration', labelDefault: '平均耗时', value: formatDuration(totals.avgDurationMs), hintKey: 'evolution.tile.duration.hint', hintDefault: '只统计记了时长的 run' }),
    TILE({ labelKey: 'evolution.tile.cache', labelDefault: '缓存命中', value: formatPercent(totals.cacheHitRate), hintKey: 'evolution.tile.cache.hint', hintDefault: 'provider 上下文缓存命中率；没报的 provider 显示 —' }),
  ].join('');
}

// ── 错误簇 ──

/** 错误类的中文标签（promptObservability.errorKind 的六个取值）。 */
export function errorKindLabel(kind: string): string {
  return t(`evolution.kind.${kind}`, kind);
}

/** 工具 × 错误类 聚簇列表（窗口内，按次数降序）。 */
export function renderErrorClusters(clusters: readonly ErrorCluster[], now: number): string {
  if (clusters.length === 0) {
    return `<div class="evo-empty">${escapeHtml(t('evolution.errors.empty', '这段时间没有失败的工具调用'))}</div>`;
  }
  const rows = clusters.map((cluster) => `<div class="evo-cluster-row">
    <span class="evo-cluster-tool">${escapeHtml(cluster.tool)}</span>
    <span class="memory-badge memory-type-error_pattern">${escapeHtml(errorKindLabel(cluster.kind))}</span>
    <span class="evo-cluster-count">${escapeHtml(t('evolution.errors.count', '{n} 次').replace('{n}', String(cluster.count)))}</span>
    <span class="evo-cluster-meta">${escapeHtml(t('evolution.errors.sessions', '{n} 个会话').replace('{n}', String(cluster.sessions)))}</span>
    <span class="evo-cluster-meta">${escapeHtml(relativeTime(cluster.lastSeen, now))}</span>
  </div>`).join('');
  return `<div class="evo-cluster-list">${rows}</div>`;
}

// ── 策略 / 角色切片（E4.1）──

function sliceCompletion(slice: RunEffectSlice): number | null {
  return slice.runs > 0 ? Math.round((slice.completed / slice.runs) * 1000) / 10 : null;
}

function sliceAvgSteps(slice: RunEffectSlice): number | null {
  return slice.runs > 0 ? Math.round((slice.toolCalls / slice.runs) * 10) / 10 : null;
}

function renderSliceTable(rows: Array<[string, RunEffectSlice]>, title: string): string {
  if (rows.length === 0) return '';
  const body = rows.map(([level, slice]) => `<tr>
    <td class="evo-table-key">${escapeHtml(t(`evolution.level.${level}`, level))}</td>
    <td>${escapeHtml(formatCount(slice.runs))}</td>
    <td>${escapeHtml(formatPercent(sliceCompletion(slice)))}</td>
    <td>${escapeHtml(formatSteps(sliceAvgSteps(slice)))}</td>
    <td>${escapeHtml(formatCount(slice.toolFailures))}</td>
  </tr>`).join('');
  return `<div class="evo-table-wrap">
    <div class="evo-table-title">${escapeHtml(title)}</div>
    <table class="evo-table">
      <thead><tr>
        <th>${escapeHtml(t('evolution.table.level', '档位'))}</th>
        <th>${escapeHtml(t('evolution.table.runs', 'run'))}</th>
        <th>${escapeHtml(t('evolution.table.completion', '完成率'))}</th>
        <th>${escapeHtml(t('evolution.table.steps', '步数'))}</th>
        <th>${escapeHtml(t('evolution.table.failures', '失败'))}</th>
      </tr></thead>
      <tbody>${body}</tbody>
    </table>
  </div>`;
}

function renderRoleTable(byRole: Record<string, RoleEffectSlice>): string {
  const rows = Object.entries(byRole).sort((a, b) => b[1].delegations - a[1].delegations);
  if (rows.length === 0) return '';
  const body = rows.map(([role, slice]) => `<tr>
    <td class="evo-table-key">${escapeHtml(toolDisplayName(role))}</td>
    <td>${escapeHtml(formatCount(slice.delegations))}</td>
    <td>${escapeHtml(formatPercent(slice.delegations > 0 ? Math.round((slice.successes / slice.delegations) * 1000) / 10 : null))}</td>
    <td>${escapeHtml(formatDuration(slice.avgDurationMs ?? null))}</td>
  </tr>`).join('');
  return `<div class="evo-table-wrap">
    <div class="evo-table-title">${escapeHtml(t('evolution.roles.title', '子 Agent 角色'))}</div>
    <table class="evo-table">
      <thead><tr>
        <th>${escapeHtml(t('evolution.table.role', '角色'))}</th>
        <th>${escapeHtml(t('evolution.table.delegations', '派发'))}</th>
        <th>${escapeHtml(t('evolution.table.success', '成功率'))}</th>
        <th>${escapeHtml(t('evolution.table.avgDuration', '平均耗时'))}</th>
      </tr></thead>
      <tbody>${body}</tbody>
    </table>
  </div>`;
}

/** 策略维度（验证 / 委派）+ 角色切片。没数据时给一句"还在攒"而不是空表格。 */
export function renderStrategySection(strategy: StrategyEffectSummary): string {
  const verification = Object.entries(strategy.byDimension.verification).sort((a, b) => b[1].runs - a[1].runs);
  const delegation = Object.entries(strategy.byDimension.delegation).sort((a, b) => b[1].runs - a[1].runs);
  const tables = [
    renderSliceTable(verification, t('evolution.table.verification', '验证档位')),
    renderSliceTable(delegation, t('evolution.table.delegation', '委派档位')),
    renderRoleTable(strategy.byRole),
  ].filter(Boolean).join('');
  if (!tables) {
    return `<div class="evo-empty">${escapeHtml(t('evolution.strategy.empty', '还没有带策略标记的运行记录 —— 攒够几次再看结论'))}</div>`;
  }
  return `<div class="evo-tables">${tables}</div>`;
}

// ── 经验条目（直达清理）──

export interface ExperienceItem {
  entry: MemoryEntry;
  score: number;
  lifecycle: MemoryLifecycle;
}

/** 演示/展示上限：仪表盘是"扫一眼 + 顺手清"，不是完整记忆库（那在记忆页）。 */
export const MAX_EXPERIENCE_ROWS = 50;

/** 进化产物：反思器/失败学到的经验，以及待确认的草稿。 */
function isExperienceEntry(entry: MemoryEntry): boolean {
  if (entry.type === 'error_pattern' || entry.type === 'procedure' || entry.type === 'successful_pattern') return true;
  if (entry.lesson) return true;
  return isDraftEntry(entry);
}

/** 挑出进化产出的经验条目，按时间倒序取前 N 条，附带实时健康分/生命周期。 */
export function buildExperienceItems(
  entries: readonly MemoryEntry[],
  now: number,
  cfg?: Partial<EvolutionConfig>,
  limit = MAX_EXPERIENCE_ROWS,
): ExperienceItem[] {
  return entries
    .filter(isExperienceEntry)
    .map((entry) => ({ entry, score: healthScore(entry, now, cfg), lifecycle: lifecycleOf(healthScore(entry, now, cfg), cfg) }))
    .sort((a, b) => b.entry.timestamp - a.entry.timestamp)
    .slice(0, limit);
}

/** 经验条目列表：每条一个删除按钮（✕），确认后从记忆库移除。 */
export function renderExperienceList(items: readonly ExperienceItem[], now: number): string {
  if (items.length === 0) {
    return `<div class="evo-empty">${escapeHtml(t('evolution.experience.empty', '还没有沉淀下来的经验 —— 跑几个多步任务就有了'))}</div>`;
  }
  const rows = items.map(({ entry, score, lifecycle }) => {
    const pct = Math.min(100, Math.max(0, Math.round(score * 100)));
    // 徽章视觉复用记忆页的那套 class（同一种记忆在两张页面上应该长得一样）。
    const draft = isDraftEntry(entry)
      ? `<span class="memory-badge memory-badge-draft">${escapeHtml(t('memory.draft', '草稿'))}</span>`
      : '';
    const confidence = entry.confidence === 'low' && !draft
      ? `<span class="memory-badge evo-badge-low">${escapeHtml(t('evolution.experience.lowConfidence', '低可信度'))}</span>`
      : '';
    const content = entry.content.length > 140 ? `${entry.content.slice(0, 140)}…` : entry.content;
    return `<div class="evo-experience-row">
      <div class="evo-experience-head">
        <span class="memory-badge memory-badge-type memory-type-${escapeHtml(entry.type)}">${escapeHtml(t(`memory.type.${entry.type}`, entry.type))}</span>
        <span class="memory-badge memory-life-${lifecycle}">${escapeHtml(t(`memory.lifecycle.${lifecycle}`, lifecycle))}</span>
        ${draft}${confidence}
        <span class="evo-experience-score" title="${escapeHtml(t('memory.health', '健康分'))}">${pct}%</span>
        <button type="button" class="memory-delete-btn" data-evo-del="${escapeHtml(entry.id)}" title="${escapeHtml(t('evolution.experience.deleteTitle', '从记忆库删除这条经验'))}" aria-label="${escapeHtml(t('evolution.experience.deleteTitle', '从记忆库删除这条经验'))}">✕</button>
      </div>
      <div class="evo-experience-content" title="${escapeHtml(entry.content)}">${escapeHtml(content)}</div>
      <div class="evo-experience-meta">${escapeHtml(relativeTime(entry.timestamp, now))}</div>
    </div>`;
  }).join('');
  return `<div class="evo-experience-list">${rows}</div>`;
}

// ── 观测存储统计（E0.1 的统计 UI，并入本页）──

/** 观测日志概览：记录构成 + 存储占用 + 截断提示。 */
export function renderObservationStats(
  stats: EvolutionDashboard['observations'],
  file: { available: boolean; totalBytes: number; readBytes: number; truncated: boolean; path: string },
  now: number,
): string {
  if (!file.available) {
    return `<div class="evo-empty">${escapeHtml(t('evolution.stats.browser', '浏览器模式下没有本地观测数据；桌面版会把每次运行记到 ~/.pure/observations/'))}</div>`;
  }
  const span = stats.oldestAt !== undefined && stats.newestAt !== undefined
    ? `${new Date(stats.oldestAt).toLocaleDateString()} – ${new Date(stats.newestAt).toLocaleDateString()} (${relativeTime(stats.newestAt, now)})`
    : '—';
  const rows = [
    [t('evolution.stats.total', '记录总数'), formatCount(stats.total)],
    [t('evolution.stats.runs', '运行记录'), formatCount(stats.runs)],
    [t('evolution.stats.assemblies', '提示词组装'), formatCount(stats.assemblies)],
    [t('evolution.stats.span', '时间跨度'), span],
    [t('evolution.stats.size', '日志大小'), formatBytes(file.totalBytes)],
  ].map(([label, value]) => `<div class="evo-stat-row"><span>${escapeHtml(label)}</span><b>${escapeHtml(value)}</b></div>`).join('');
  const truncated = file.truncated
    ? `<div class="evo-stat-note">${escapeHtml(t('evolution.stats.truncated', '日志较大，本次只统计了最近 {n} —— 更早的数据仍是完整的，只是没进这张图。').replace('{n}', formatBytes(file.readBytes)))}</div>`
    : '';
  return `${rows}${truncated}<div class="evo-stat-path" title="${escapeHtml(file.path)}">${escapeHtml(t('evolution.stats.path', '存储位置'))}: ${escapeHtml(file.path)}</div>`;
}
