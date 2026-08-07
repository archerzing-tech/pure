// src/ui/permission.ts
// v0.2 — Promise-based permission dialog with serialized requests.
// The engine may fire parallel tool calls (Promise.all reads), so permission
// requests are queued: only one dialog is ever visible at a time.

import type { PermissionRequestInfo, PermissionDecision } from '../coding-agent/types';
import { t } from '../shared/i18n';

// Serialize concurrent permission requests — each dialog must be dismissed
// before the next one renders, otherwise listeners/DOM state would overlap.
let requestQueue: Promise<unknown> = Promise.resolve();

export function requestPermission(info: PermissionRequestInfo): Promise<PermissionDecision> {
  const run = requestQueue.then(() => showDialog(info));
  requestQueue = run.catch(() => {});
  return run;
}

/**
 * Render the permission dialog for a tool call and resolve once the user decides.
 * - Allow once   → { allowed: true }                  (not cached)
 * - Always allow → { allowed: true, remember: true }  (cached for this session, incl. high risk)
 * - Deny / Esc   → { allowed: false }
 */
function showDialog(info: PermissionRequestInfo): Promise<PermissionDecision> {
  return new Promise((resolve) => {
    const overlay = document.getElementById('permission-overlay') as HTMLDivElement;
    const titleEl = document.getElementById('permission-title') as HTMLSpanElement;
    const riskBadge = document.getElementById('permission-risk-badge') as HTMLSpanElement;
    const toolNameEl = document.getElementById('permission-tool-name') as HTMLDivElement;
    const descEl = document.getElementById('permission-description') as HTMLDivElement;
    const commandEl = document.getElementById('permission-command') as HTMLPreElement;
    const previewEl = document.getElementById('permission-preview') as HTMLDivElement;
    const previewPathEl = document.getElementById('permission-preview-path') as HTMLDivElement;
    const previewContentEl = document.getElementById('permission-preview-content') as HTMLPreElement;
    const denyBtn = document.getElementById('permission-deny') as HTMLButtonElement;
    const onceBtn = document.getElementById('permission-allow-once') as HTMLButtonElement;
    const alwaysBtn = document.getElementById('permission-allow-always') as HTMLButtonElement;
    const previouslyFocused = document.activeElement instanceof HTMLElement ? document.activeElement : null;

    const isHighRisk = info.riskLevel === 'high';

    // Title reflects danger level
    titleEl.textContent = isHighRisk ? t('permission.titleHigh') : t('permission.title');

    // Risk badge
    const riskKey = `permission.risk.${info.riskLevel}`;
    riskBadge.textContent = t(riskKey, info.riskLevel);
    riskBadge.className = `permission-risk-badge risk-${info.riskLevel}`;

    // Tool identity
    toolNameEl.textContent = info.serverName ? `${info.serverName} → ${info.tool}` : info.tool;
    descEl.textContent = info.description || '';

    // Command (if any)
    if (info.command) {
      commandEl.textContent = info.command;
      commandEl.classList.remove('hidden');
    } else {
      commandEl.classList.add('hidden');
    }

    // File preview (write_file / edit_file) — show exactly what will be written
    if (info.contentPreview) {
      previewPathEl.textContent = info.path ? `📄 ${info.path}` : '';
      previewContentEl.textContent = info.contentPreview;
      previewEl.classList.remove('hidden');
    } else {
      previewEl.classList.add('hidden');
    }

    // Every tool — including high-risk shell commands — offers the
    // session-scoped "始终允许(本次会话)" option. The decision is cached by
    // PermissionManager for the current chat session (cleared on new chat), so
    // commands don't re-prompt on every call. High-risk dialogs still default
    // focus to Deny below, so a stray Enter can't approve a destructive call.
    alwaysBtn.style.display = '';

    const cleanup = () => {
      overlay.classList.add('hidden');
      denyBtn.removeEventListener('click', onDeny);
      onceBtn.removeEventListener('click', onOnce);
      alwaysBtn.removeEventListener('click', onAlways);
      document.removeEventListener('keydown', onKeydown);
      if (previouslyFocused?.isConnected) previouslyFocused.focus();
    };

    const onDeny = () => {
      cleanup();
      resolve({ allowed: false, reason: 'denied by user' });
    };
    const onOnce = () => {
      cleanup();
      resolve({ allowed: true });
    };
    const onAlways = () => {
      cleanup();
      resolve({ allowed: true, remember: true });
    };
    const onKeydown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onDeny();
        return;
      }
      if (e.key !== 'Tab') return;
      const focusable = [denyBtn, onceBtn, alwaysBtn].filter((button) => button.style.display !== 'none' && !button.disabled && !button.hidden);
      if (focusable.length === 0) return;
      const current = focusable.indexOf(document.activeElement as HTMLButtonElement);
      const next = e.shiftKey
        ? (current <= 0 ? focusable.length - 1 : current - 1)
        : (current < 0 || current === focusable.length - 1 ? 0 : current + 1);
      e.preventDefault();
      focusable[next].focus();
    };

    denyBtn.addEventListener('click', onDeny);
    onceBtn.addEventListener('click', onOnce);
    alwaysBtn.addEventListener('click', onAlways);
    document.addEventListener('keydown', onKeydown);

    overlay.classList.remove('hidden');
    // High-risk operations default focus to Deny so a stray Enter/Esc can't
    // accidentally approve a destructive tool call. Safe/medium keep the
    // primary "Allow once" focused for fast approval.
    if (isHighRisk) denyBtn.focus();
    else onceBtn.focus();
  });
}
