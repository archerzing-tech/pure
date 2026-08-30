// src/ui/usageStats.ts
// 用量统计 settings page: loads every persisted session's stats, aggregates
// them user-level (shared/usageAggregate), and renders the dashboard. Pure
// aggregation lives in shared so it unit-tests without DOM/localStorage; this
// file is a thin read-store → render layer.

import { loadSessionList, loadSessionStats } from './store';
import { aggregateUsage, type UserUsageAggregate } from '../shared/usageAggregate';
import { formatTokens, formatCostUsd } from '../shared/usage';
import { t } from '../shared/i18n';

/** Render the user-level usage dashboard into `container`. Async: it reads the
 * session list first, then syncs stats for every session. */
export async function renderUsageDashboard(container: HTMLElement): Promise<void> {
  const metas = await loadSessionList();
  const entries = metas.map((meta) => ({
    sessionId: meta.id,
    createdAt: meta.createdAt,
    updatedAt: meta.updatedAt,
    stats: loadSessionStats(meta.id),
  }));
  const agg = aggregateUsage(entries);
  container.innerHTML = usageDashboardHtml(agg);
}

function stat(label: string, value: string): string {
  return `<div class="usage-stat"><span>${label}</span><b>${value}</b></div>`;
}

function providerRows(agg: UserUsageAggregate): string {
  if (agg.providers.length === 0) return `<div class="usage-empty">${t('usage.noData')}</div>`;
  return agg.providers
    .map(
      (p) => `<div class="usage-row">
        <span class="usage-row-name">${p.provider}</span>
        <span class="usage-row-sub">${p.sessions} ${t('usage.sessionUnit')} · ${formatCostUsd(p.costUsd)}</span>
        <span class="usage-row-bar"><i style="width:${Math.max(4, (p.sessions / agg.sessionCount) * 100)}%"></i></span>
      </div>`,
    )
    .join('');
}

function commandRows(agg: UserUsageAggregate): string {
  if (agg.topCommands.length === 0) return `<div class="usage-empty">${t('usage.noData')}</div>`;
  const maxCount = Math.max(1, agg.topCommands[0].count);
  return agg.topCommands
    .map(
      (c) => `<div class="usage-row">
        <span class="usage-row-name usage-cmd" title="${escapeAttr(c.command)}">${escapeHtml(c.command)}</span>
        <span class="usage-row-sub">${c.count}× · ${Math.round(c.successRate * 100)}%</span>
        <span class="usage-row-bar"><i style="width:${Math.round((c.count / maxCount) * 100)}%"></i></span>
      </div>`,
    )
    .join('');
}

function activityBars(agg: UserUsageAggregate): string {
  if (agg.sessionCount === 0) return `<div class="usage-empty">${t('usage.noData')}</div>`;
  const max = Math.max(1, ...agg.last14Days.map((d) => d.sessions));
  return `<div class="usage-activity">
    ${agg.last14Days
      .map(
        (d) => `<div class="usage-day" title="${d.day} · ${d.sessions} ${t('usage.sessionUnit')}">
          <i style="height:${Math.max(8, (d.sessions / max) * 100)}%"></i>
          <span>${d.day.slice(5)}</span>
        </div>`,
      )
      .join('')}
  </div>`;
}

function usageDashboardHtml(agg: UserUsageAggregate): string {
  const cmdRate = agg.commandTotal > 0 ? `${Math.round(agg.commandSuccessRate * 100)}%` : '—';
  return `
    <div class="usage-stats">
      <div class="usage-stat-grid">
        ${stat(t('usage.sessions'), String(agg.sessionCount))}
        ${stat(t('usage.turns'), formatTokens(agg.totalTurns))}
        ${stat(t('usage.cost'), formatCostUsd(agg.totalCostUsd))}
        ${stat(t('usage.commandRate'), cmdRate)}
      </div>
      <div class="usage-token-line">
        <span>${t('usage.input')} ${formatTokens(agg.totalInputTokens)}</span>
        <span>${t('usage.output')} ${formatTokens(agg.totalOutputTokens)}</span>
        <span>${t('usage.fileWrites')} ${formatTokens(agg.fileWriteTotal)}</span>
      </div>
      <h3 class="usage-section-title">${t('usage.providers')}</h3>
      <div class="usage-rows">${providerRows(agg)}</div>
      <h3 class="usage-section-title">${t('usage.topCommands')}</h3>
      <div class="usage-rows">${commandRows(agg)}</div>
      <h3 class="usage-section-title">${t('usage.activity')}</h3>
      ${activityBars(agg)}
    </div>`;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]!);
}
function escapeAttr(s: string): string {
  return escapeHtml(s).replaceAll('`', '&#96;');
}
