// src/ui/permission.ts
// v0.3 — Inline permission card in the chat transcript (was a modal overlay).
// The engine may fire parallel tool calls (Promise.all reads), so permission
// requests are queued: only one card is ever pending at a time.

import type { PermissionRequestInfo, PermissionDecision } from '../coding-agent/types';
import { escapeHtml } from '../shared/html';
import { t } from '../shared/i18n';
import { showInlineCard } from './inlineCard';

// Serialize concurrent permission requests — each card must be decided before
// the next one renders, otherwise listeners/DOM state would overlap.
let requestQueue: Promise<unknown> = Promise.resolve();

export function requestPermission(info: PermissionRequestInfo): Promise<PermissionDecision> {
  const run = requestQueue.then(() => showDialog(info));
  requestQueue = run.catch(() => {});
  return run;
}

/**
 * Render the inline permission card for a tool call and resolve once the user decides.
 * - Allow once   → { allowed: true }                  (not cached)
 * - Always allow → { allowed: true, remember: true }  (cached for this session, incl. high risk)
 * - Deny / Esc   → { allowed: false }
 */
function showDialog(info: PermissionRequestInfo): Promise<PermissionDecision> {
  const isHighRisk = info.riskLevel === 'high';
  const riskKey = `permission.risk.${info.riskLevel}`;
  const riskBadge = `<span class="permission-risk-badge risk-${info.riskLevel}">${t(riskKey, info.riskLevel)}</span>`;
  const toolName = info.serverName
    ? `${escapeHtml(info.serverName)} → ${escapeHtml(info.tool)}`
    : escapeHtml(info.tool);
  const command = info.command
    ? `<pre class="permission-command">${escapeHtml(info.command)}</pre>`
    : '';
  const preview = info.contentPreview
    ? `<div class="permission-preview">
        <div class="permission-preview-path">📄 ${escapeHtml(info.path ?? '')}</div>
        <pre class="permission-preview-content">${escapeHtml(info.contentPreview)}</pre>
      </div>`
    : '';

  return showInlineCard({
    cardClass: 'permission',
    title: isHighRisk ? t('permission.titleHigh') : t('permission.title'),
    bodyHTML:
      `${riskBadge}` +
      `<div class="permission-tool-name">${toolName}</div>` +
      `<div class="permission-description">${escapeHtml(info.description || '')}</div>` +
      command + preview,
    // Every tool — including high-risk shell commands — offers the
    // session-scoped "始终允许(本次会话)" option.
    actions: [
      { label: t('permission.deny'), value: 'deny' },
      { label: t('permission.allowOnce'), value: 'once' },
      { label: t('permission.allowAlways'), value: 'always', kind: 'primary' },
    ],
    // High-risk operations default focus to Deny so a stray Enter/Esc can't
    // accidentally approve a destructive tool call. Safe/medium keep "Allow
    // once" focused for fast approval.
    focusIndex: isHighRisk ? 0 : 1,
    escValue: 'deny',
  }).then((choice): PermissionDecision => {
    if (choice === 'once') return { allowed: true };
    if (choice === 'always') return { allowed: true, remember: true };
    return { allowed: false, reason: 'denied by user' };
  });
}
