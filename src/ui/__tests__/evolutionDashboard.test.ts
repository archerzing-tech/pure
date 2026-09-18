// src/ui/__tests__/evolutionDashboard.test.ts
// E4.2 — 渲染层的纯函数测试：趋势 SVG 的坐标/断点、空数据的"不假装成 0"、
// 错误簇与经验条目的转义、以及浏览器模式的观测统计提示。

import { describe, it, expect } from 'bun:test';
import {
  buildExperienceItems,
  buildTrendSvg,
  formatDuration,
  formatPercent,
  formatSteps,
  renderErrorClusters,
  renderExperienceList,
  renderObservationStats,
  renderTotals,
  renderTrendCards,
  relativeTime,
} from '../evolutionDashboard';
import type { MemoryEntry } from '../../adapter/memory/IMemoryStore';
import { buildEvolutionDashboard, startOfLocalDay, type TrendBucket } from '../../shared/evolutionDashboard';
import { parsePromptObservations, type AgentRunObservation, type PromptObservation } from '../../shared/promptObservability';

const NOW = startOfLocalDay(Date.now()) + 12 * 3600 * 1000;

function bucket(date: string, overrides: Partial<TrendBucket> = {}): TrendBucket {
  return {
    date,
    runs: 0,
    completed: 0,
    completionRate: null,
    interrupted: 0,
    verificationFailed: 0,
    interventions: 0,
    toolCalls: 0,
    toolFailures: 0,
    avgSteps: null,
    ...overrides,
  };
}

function entry(overrides: Partial<MemoryEntry> = {}): MemoryEntry {
  return {
    id: 'm1',
    type: 'procedure',
    content: 'Refactor: search the repo before editing',
    timestamp: NOW - 3600_000,
    sessionId: 's1',
    projectPath: '/tmp/project',
    ...overrides,
  };
}

function run(overrides: Partial<AgentRunObservation> = {}): AgentRunObservation {
  return {
    type: 'agent_run',
    traceId: `run_${Math.random().toString(36).slice(2, 8)}`,
    sessionId: 's1',
    startedAt: NOW - 3600_000,
    eventCounts: {},
    toolCalls: [],
    reasoningChars: 0,
    outputChars: 0,
    ...overrides,
  };
}

describe('JSONL → dashboard → chart (the real seam, no mocks)', () => {
  it('charts data that came in as persisted JSONL lines', () => {
    const lines = [
      // 跨两天：单点的窗口画不出折线（那是设计，不是 bug），要断言连段就得给两个日子。
      run({ startedAt: NOW - 86_400_000, outcome: { isComplete: true, interrupted: false }, toolCalls: [{ toolName: 'read_file', success: true, durationMs: 5 }], durationMs: 900 }),
      run({ outcome: { isComplete: false, interrupted: true }, toolCalls: [{ toolName: 'web_fetch', success: false, durationMs: 700, error: { kind: 'network', hash: 'h', chars: 3 } }], durationMs: 2100 }),
    ];
    const jsonl = lines.map((record) => JSON.stringify({ schemaVersion: 1, ...record })).join('\n');
    const dashboard = buildEvolutionDashboard(parsePromptObservations(jsonl), { range: 'week', now: NOW });

    expect(dashboard.totals.runs).toBe(2);
    expect(dashboard.totals.completionRate).toBe(50);
    // 有真实数据的窗口必须画出趋势线，而不是落进空状态。
    const html = renderTrendCards(dashboard);
    expect(html).toContain('<polyline');
    expect(html).not.toContain('evo-chart-empty');
    // 错误簇也跟着数据出现（JSONL 里的 error 字段没丢）。
    expect(renderErrorClusters(dashboard.errorClusters, NOW)).toContain('web_fetch');
  });
});

describe('format helpers', () => {
  it('renders percentages with one decimal and dashes for missing samples', () => {
    expect(formatPercent(75)).toBe('75%');
    expect(formatPercent(62.5)).toBe('62.5%');
    expect(formatPercent(null)).toBe('—');
    expect(formatPercent(undefined)).toBe('—');
  });

  it('renders steps and durations, dash for missing', () => {
    expect(formatSteps(1.5)).toBe('1.5');
    expect(formatSteps(2)).toBe('2');
    expect(formatSteps(null)).toBe('—');
    expect(formatDuration(450)).toBe('450ms');
    expect(formatDuration(1750)).toBe('1.8s');
    expect(formatDuration(125_000)).toBe('2m 5s');
    expect(formatDuration(null)).toBe('—');
  });

  it('labels relative time from the injected clock', () => {
    expect(relativeTime(NOW - 10_000, NOW)).toBe('刚刚');
    expect(relativeTime(NOW - 3 * 3600_000, NOW)).toContain('3');
    expect(relativeTime(NOW - 2 * 86_400_000, NOW)).toContain('2');
  });
});

describe('buildTrendSvg', () => {
  it('renders nothing when no bucket has a sample (no fake zero line)', () => {
    const buckets = [bucket('2026-09-16'), bucket('2026-09-17')];
    expect(buildTrendSvg(buckets, { metric: 'completionRate' })).toBe('');
    expect(buildTrendSvg(buckets, { metric: 'interventions', kind: 'bar' })).toBe('');
  });

  it('draws a polyline through the samples and labels both window ends', () => {
    const buckets = [
      bucket('2026-09-16', { completionRate: 50 }),
      bucket('2026-09-17', { completionRate: 100 }),
    ];
    const svg = buildTrendSvg(buckets, { metric: 'completionRate' });
    expect(svg).toContain('<polyline');
    expect(svg).toContain('evo-chart-dot');
    expect(svg).toContain('09-16');
    expect(svg).toContain('09-17');
    // 完成率固定 100% 纵轴。
    expect(svg).toContain('>100</text>');
  });

  it('breaks the line at a missing day instead of connecting across it', () => {
    const buckets = [
      bucket('2026-09-15', { completionRate: 50 }),
      bucket('2026-09-16'),
      bucket('2026-09-17', { completionRate: 80 }),
    ];
    const svg = buildTrendSvg(buckets, { metric: 'completionRate' });
    // 两个孤立点各成一段：没有 polyline（单点连线没有意义），但点都在。
    expect(svg.split('evo-chart-dot').length - 1).toBe(2);
    expect(svg).not.toContain('<polyline');
  });

  it('renders one bar per sample, skipping empty days', () => {
    const buckets = [
      bucket('2026-09-15', { runs: 2, interventions: 2 }),
      bucket('2026-09-16'),
      bucket('2026-09-17', { runs: 1, interventions: 1 }),
    ];
    const svg = buildTrendSvg(buckets, { metric: 'interventions', kind: 'bar' });
    expect(svg.split('<rect').length - 1).toBe(2);
    expect(svg).toContain('evo-chart-bar');
  });

  it('escapes nothing dangerous into the SVG (dates are labels, titles carry no markup)', () => {
    const buckets = [bucket('2026-09-17', { avgSteps: 3 })];
    const svg = buildTrendSvg(buckets, { metric: 'avgSteps' });
    expect(svg).not.toContain('<script');
  });
});

describe('renderTrendCards', () => {
  it('shows the empty hint for a window with no runs', () => {
    const dashboard = buildEvolutionDashboard([], { range: 'week', now: NOW });
    const html = renderTrendCards(dashboard);
    expect(html.split('evo-chart-card').length - 1).toBe(3);
    expect(html).toContain('evo-chart-empty');
  });

  it('shows the latest sample next to each chart title', () => {
    const dashboard = buildEvolutionDashboard([run({ outcome: { isComplete: true, interrupted: false } })], { range: 'week', now: NOW });
    const html = renderTrendCards(dashboard);
    expect(html).toContain('evo-chart-latest');
    expect(html).toContain('100%');
    expect(html).not.toContain('evo-chart-empty');
  });
});

describe('renderTotals', () => {
  it('renders dashes for a window with no samples', () => {
    const html = renderTotals(buildEvolutionDashboard([], { range: 'week', now: NOW }));
    expect(html.split('evo-tile-value').length - 1).toBe(7);
    expect(html).toContain('—');
  });

  it('renders the window numbers once runs exist', () => {
    const records: PromptObservation[] = [
      run({
        outcome: { isComplete: true, interrupted: false },
        verification: { status: 'passed', evidence: [] },
        toolCalls: [
          { toolName: 'read_file', success: true, durationMs: 10 },
          { toolName: 'write_file', success: true, durationMs: 20 },
        ],
        durationMs: 1500,
        cache: { hitTokens: 900, missTokens: 100, hitRate: 90 },
      }),
      run({ outcome: { isComplete: false, interrupted: true } }),
    ];
    const html = renderTotals(buildEvolutionDashboard(records, { range: 'week', now: NOW }));
    expect(html).toContain('50%'); // completion rate
    expect(html).toContain('90%'); // cache hit rate
    expect(html).toContain('evo-tile-label');
  });
});

describe('renderErrorClusters', () => {
  it('explains an empty window', () => {
    expect(renderErrorClusters([], NOW)).toContain('evo-empty');
  });

  it('renders the cluster with count, sessions and relative time', () => {
    const html = renderErrorClusters([
      { tool: 'web_fetch', kind: 'network', count: 3, lastSeen: NOW - 3 * 3600_000, sessions: 2 },
    ], NOW);
    expect(html).toContain('web_fetch');
    expect(html).toContain('3');
    expect(html).toContain('evo-cluster-row');
  });

  it('escapes tool names coming from third-party MCP servers', () => {
    const html = renderErrorClusters([
      { tool: '<img src=x onerror=alert(1)>', kind: 'tool_error', count: 1, lastSeen: NOW, sessions: 1 },
    ], NOW);
    expect(html).not.toContain('<img');
    expect(html).toContain('&lt;img');
  });
});

describe('buildExperienceItems / renderExperienceList', () => {
  it('keeps evolution-produced entries only (and sorts newest first)', () => {
    const items = buildExperienceItems([
      entry({ id: 'a', type: 'procedure', timestamp: NOW - 5000 }),
      entry({ id: 'b', type: 'user_preference', timestamp: NOW - 1000 }), // not an evolution product
      entry({ id: 'c', type: 'error_pattern', timestamp: NOW - 100 }),
      entry({ id: 'd', type: 'successful_pattern', lesson: { symptom: 's', rootCause: 'r', recoveryPath: 'p', verification: 'v', avoidNextTime: 'a' }, timestamp: NOW - 9000 }),
      entry({ id: 'e', type: 'project_convention', confidence: 'low', timestamp: NOW - 50 }), // E3.1 draft
    ], NOW);
    expect(items.map((item) => item.entry.id)).toEqual(['e', 'c', 'a', 'd']);
    expect(items[0].lifecycle).toBeDefined();
    expect(items[0].score).toBeGreaterThan(0);
  });

  it('caps the list length', () => {
    const many = Array.from({ length: 60 }, (_, index) => entry({ id: `m${index}`, timestamp: NOW - index * 1000 }));
    expect(buildExperienceItems(many, NOW).length).toBeLessThanOrEqual(50);
  });

  it('renders a delete button per row and a draft badge for unconfirmed corrections', () => {
    const items = buildExperienceItems([
      entry({ id: 'draft-1', type: 'project_convention', confidence: 'low' }),
      entry({ id: 'proc-1', type: 'procedure', confidence: 'low' }), // E1.1 low-confidence, not a draft
    ], NOW);
    const html = renderExperienceList(items, NOW);
    expect(html).toContain('data-evo-del="draft-1"');
    expect(html).toContain('data-evo-del="proc-1"');
    expect(html).toContain('memory-badge-draft');
    expect(html).toContain('evo-badge-low'); // 草稿之外的低可信度条目也要能看出来
  });

  it('escapes memory content and explains an empty list', () => {
    const html = renderExperienceList(buildExperienceItems([entry({ content: '<b>x</b>' })], NOW), NOW);
    expect(html).not.toContain('<b>x</b>');
    expect(html).toContain('&lt;b&gt;');
    expect(renderExperienceList([], NOW)).toContain('evo-empty');
  });
});

describe('renderObservationStats', () => {
  const stats = { total: 12, runs: 9, assemblies: 3, oldestAt: NOW - 6 * 86_400_000, newestAt: NOW - 3600_000 };

  it('tells browser users where the data lives instead of showing an empty panel', () => {
    const html = renderObservationStats(stats, { available: false, totalBytes: 0, readBytes: 0, truncated: false, path: '' }, NOW);
    expect(html).toContain('evo-empty');
    expect(html).toContain('~/.pure/observations/');
  });

  it('reports counts, size and the storage path', () => {
    const html = renderObservationStats(stats, { available: true, totalBytes: 2048, readBytes: 2048, truncated: false, path: '/home/u/.pure/observations/app.jsonl' }, NOW);
    expect(html).toContain('12');
    expect(html).toContain('/home/u/.pure/observations/app.jsonl');
    expect(html).not.toContain('evo-stat-note');
  });

  it('says so when the tail read was truncated', () => {
    const html = renderObservationStats(stats, { available: true, totalBytes: 70_000_000, readBytes: 16_000_000, truncated: true, path: '/p/app.jsonl' }, NOW);
    expect(html).toContain('evo-stat-note');
  });
});
