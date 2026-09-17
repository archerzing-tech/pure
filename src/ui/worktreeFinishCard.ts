// src/ui/worktreeFinishCard.ts
// Roadmap 4.4 — the wrap-up card: when the visible session works in one of
// OUR auto-created worktrees (4.1) and holds unmerged work, this card sits
// between the transcript and the composer with a diff preview and the two
// exits — merge back into the main workspace, or discard the worktree.
//
// Lifecycle, deliberately event-driven (no ticker, unlike 4.3's dock): the
// app shell calls refresh() on session activation, on running-state changes
// (the "session finished" moment) and after the queue drains; the card also
// refreshes itself after its own merge/discard actions. It never shows while
// the session is streaming — half-done work is not reviewable work.
//
// Exit semantics (shared/worktreeFinish.ts): merge auto-commits leftover
// edits and rolls back on conflict; discard is the confirmed destructive
// path. Either way, once the worktree is gone the session is released back
// onto the repo root via onReleased — main.ts routes that through the normal
// workspace commit, so the usual auto-worktree rule (4.1) still applies if
// another session owns the root.

import { escapeHtml } from '../shared/html';
import { t } from '../shared/i18n';
import type { WorktreeBinding } from '../shared/worktreeBinding';
import { isSessionWorktree, type WorktreeDiscardResult, type WorktreeFinishResult, type WorktreeFinishStatus } from '../shared/worktreeFinish';

export interface WorktreeFinishCardState {
  status: WorktreeFinishStatus | null;
  busy: 'merge' | 'discard' | null;
}

/** The card's population rule: a session worktree with something to settle.
 * Exported + tested because "no card for a plain (primary) checkout" and
 * "no card when everything is merged and clean" are the acceptance edges. */
export function showableWorktreeFinish(status: WorktreeFinishStatus | null): status is WorktreeFinishStatus {
  return !!status
    && isSessionWorktree(status.binding)
    && (status.commits.length > 0 || status.uncommitted > 0);
}

export function renderWorktreeFinish(state: WorktreeFinishCardState): string {
  const status = state.status;
  if (!status) return '';
  const chips = [
    status.commits.length > 0 ? `<span class="wf-chip">${escapeHtml(t('worktreeFinish.commits').replace('{n}', String(status.commits.length)))}</span>` : '',
    status.filesChanged > 0 ? `<span class="wf-chip">${escapeHtml(t('worktreeFinish.files').replace('{n}', String(status.filesChanged)))}</span>` : '',
    status.uncommitted > 0 ? `<span class="wf-chip wf-chip-warn">${escapeHtml(t('worktreeFinish.uncommitted').replace('{n}', String(status.uncommitted)))}</span>` : '',
  ].join('');
  const commitLines = status.commits.map((c) => `
        <li class="wf-commit"><span class="wf-commit-hash">${escapeHtml(c.hash)}</span>${escapeHtml(c.subject)}</li>`).join('');
  const mergeLabel = state.busy === 'merge' ? t('worktreeFinish.mergeBusy') : t('worktreeFinish.merge');
  return `
    <div class="wf-card${state.busy ? ' wf-busy' : ''}">
      <div class="wf-head">
        <span class="wf-title">${escapeHtml(t('worktreeFinish.title'))}</span>
        <span class="wf-chips">${chips}</span>
      </div>
      <div class="wf-subtitle">
        <span class="wf-branch">${escapeHtml(status.binding.branch)}</span>
        <span>${escapeHtml(t('worktreeFinish.subtitle'))}</span>
      </div>
      ${status.stat || commitLines ? `
      <details class="wf-diff">
        <summary>${escapeHtml(t('worktreeFinish.diffTitle'))}</summary>
        ${status.stat ? `<pre class="wf-diff-stat">${escapeHtml(status.stat)}</pre>` : ''}
        ${commitLines ? `<ul class="wf-commits">${commitLines}
        </ul>` : ''}
      </details>` : ''}
      <div class="wf-actions">
        <button class="wf-merge" data-wf-merge title="${escapeHtml(t('worktreeFinish.mergeTitle'))}" ${state.busy ? 'disabled' : ''}>${escapeHtml(mergeLabel)}</button>
        <button class="wf-discard" data-wf-discard title="${escapeHtml(t('worktreeFinish.discardTitle'))}" ${state.busy ? 'disabled' : ''}>${escapeHtml(t('worktreeFinish.discard'))}</button>
      </div>
    </div>`;
}

/** The retention notice for the sidebar's delete confirmation (4.4's "未合并
 * 就关闭时有留存提示"): names what stays behind and where. */
export function retentionMessage(status: WorktreeFinishStatus): string {
  const details = [
    status.commits.length > 0 ? t('worktreeFinish.commits').replace('{n}', String(status.commits.length)) : '',
    status.uncommitted > 0 ? t('worktreeFinish.uncommitted').replace('{n}', String(status.uncommitted)) : '',
  ].filter(Boolean).join('、');
  return t('worktreeFinish.retentionConfirm')
    .replace('{detail}', details)
    .replace('{path}', status.binding.worktreePath);
}

export interface WorktreeFinishCardDeps {
  host: HTMLElement;
  /** Narrow facade over SessionChatManager — only the visible session matters
   * here (the card lives in the chat view). */
  chat: {
    currentId(): string;
    isRunning(sessionId: string): boolean;
    workspaceOf(sessionId: string): string;
  };
  inspect(worktreePath: string): Promise<WorktreeFinishStatus | null>;
  merge(status: WorktreeFinishStatus): Promise<WorktreeFinishResult>;
  discard(binding: WorktreeBinding): Promise<WorktreeDiscardResult>;
  confirm(message: string): Promise<boolean>;
  notify(message: string): void;
  /** The worktree is gone (merged or discarded) — hand the session a live
   * workspace again. main.ts re-commits the repo root. */
  onReleased(repoRoot: string): void;
}

export class WorktreeFinishCard {
  private readonly deps: WorktreeFinishCardDeps;
  private status: WorktreeFinishStatus | null = null;
  private busy: 'merge' | 'discard' | null = null;
  private lastKey = '';
  // refresh() coalescing: concurrent triggers (activation + running-change
  // fire together on a session switch) collapse into one inspect pass, with
  // a trailing re-run so a trigger during the git round-trip is not lost.
  private inFlight = false;
  private rerun = false;

  constructor(deps: WorktreeFinishCardDeps) {
    this.deps = deps;
  }

  async refresh(): Promise<void> {
    if (this.inFlight) {
      this.rerun = true;
      return;
    }
    this.inFlight = true;
    try {
      do {
        this.rerun = false;
        await this.inspectNow();
      } while (this.rerun);
    } finally {
      this.inFlight = false;
    }
  }

  private async inspectNow(): Promise<void> {
    const sessionId = this.deps.chat.currentId();
    const ws = sessionId ? this.deps.chat.workspaceOf(sessionId) : '';
    let status: WorktreeFinishStatus | null = null;
    // A streaming session's worktree is mid-flight — never preview it.
    if (ws && !this.deps.chat.isRunning(sessionId)) {
      try {
        status = await this.deps.inspect(ws);
      } catch {
        status = null;
      }
    }
    const showable = showableWorktreeFinish(status) ? status : null;
    const key = showable
      ? JSON.stringify([showable.binding.branch, showable.commits.length, showable.filesChanged, showable.uncommitted])
      : '';
    this.status = showable;
    if (key !== this.lastKey) {
      this.lastKey = key;
      this.render();
    }
  }

  private render(): void {
    this.deps.host.innerHTML = renderWorktreeFinish({ status: this.status, busy: this.busy });
    this.deps.host.hidden = !this.status;
  }

  async mergeNow(): Promise<void> {
    const status = this.status;
    if (!status || this.busy) return;
    const commitCount = status.commits.length;
    this.busy = 'merge';
    this.render();
    try {
      const result = await this.deps.merge(status);
      if (result.ok) {
        if (result.worktreeRemoved) {
          this.deps.notify(result.autoCommitted
            ? t('worktreeFinish.mergedToastAutocommit').replace('{n}', String(commitCount))
            : t('worktreeFinish.mergedToast').replace('{n}', String(commitCount)));
        } else {
          // Merged, but the worktree itself would not go away — say where it
          // is instead of pretending the click did full cleanup.
          this.deps.notify(t('worktreeFinish.cleanupKept').replace('{path}', status.binding.worktreePath));
        }
        this.deps.onReleased(status.binding.repoRoot);
      } else {
        this.deps.notify(this.failureMessage(result));
      }
    } catch (err) {
      this.deps.notify(String(err));
    } finally {
      this.busy = null;
      await this.refresh();
    }
  }

  async discardNow(): Promise<void> {
    const status = this.status;
    if (!status || this.busy) return;
    if (!(await this.deps.confirm(t('worktreeFinish.confirmDiscard')))) return;
    this.busy = 'discard';
    this.render();
    try {
      const result = await this.deps.discard(status.binding);
      if (result.ok) {
        this.deps.notify(t('worktreeFinish.discardToast'));
        this.deps.onReleased(status.binding.repoRoot);
      } else if (result.message) {
        this.deps.notify(result.message);
      }
    } catch (err) {
      this.deps.notify(String(err));
    } finally {
      this.busy = null;
      await this.refresh();
    }
  }

  private failureMessage(result: Extract<WorktreeFinishResult, { ok: false }>): string {
    if (result.stage === 'main-dirty') return t('worktreeFinish.mainDirty');
    if (result.stage === 'detached') return t('worktreeFinish.detached');
    if (result.stage === 'merge') return t('worktreeFinish.conflict').replace('{branch}', this.status?.binding.branch ?? '');
    // The auto-commit step (missing git identity etc.) — the raw git error is
    // the honest message here; anything paraphrased would hide the cause.
    return result.message;
  }
}

/** DOM event wiring, bound once by the app shell. */
export function bindWorktreeFinishCard(host: HTMLElement, card: WorktreeFinishCard): void {
  host.addEventListener('click', (event) => {
    const target = event.target as HTMLElement;
    if (target.closest('[data-wf-merge]')) {
      event.preventDefault();
      void card.mergeNow();
      return;
    }
    if (target.closest('[data-wf-discard]')) {
      event.preventDefault();
      void card.discardNow();
    }
  });
}
