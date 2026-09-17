// src/ui/notify.ts
// Roadmap 5.2 — system notifications for background session events:
// turn done / waiting for your confirmation / failed. The window may be
// hidden in the tray (5.1) while sessions keep working; without this, the
// only trace of a finished background turn was the parallel-task card
// silently disappearing.
//
// The detection edge is the running-set transition (chat's
// onRunningSessionsChanged): a session LEAVING the set = its turn settled.
// What it settled INTO is read off the transcript tail — the transcript is
// the state (an error row at the tail is a failure; a plan-pause row is a
// confirmation wait; anything else is a normal finish). Gating rules keep
// the noise down: the visible session in a visible window never notifies
// (the user is already watching it), and a session whose controller is gone
// (deleted/forgotten mid-run) stays silent.
//
// The click → jump half lives in Rust (send_turn_notification emits
// `notification-clicked` with the session id — notify-rust's body-click
// callback is the only reliable click signal on macOS) and in main.ts
// (listen → show windows + setSessionId).

import { t } from '../shared/i18n';

export type SettleKind = 'done' | 'failed' | 'needs-confirm';

/** Classify a settled session by what its transcript ENDS with: the tail row
 * decides, because old markers deeper in the transcript say nothing about the
 * settle that just happened (an error from two turns ago must not turn this
 * finish into a failure). Walks back over at most a few empty rows a render
 * pass may have left; a pause row beats an error row when both sit in the
 * tail group (pause → confirm first, then anything else). */
export function classifySettleHost(host: HTMLElement | null): SettleKind {
  if (!host) return 'done';
  let node: Element | null = host.lastElementChild;
  for (let hop = 0; node && hop < 5 && !node.textContent?.trim(); hop++) {
    node = node.previousElementSibling;
  }
  if (!node) return 'done';
  if (node.classList.contains('plan-pause-message') || node.querySelector('.plan-pause-message')) {
    return 'needs-confirm';
  }
  if (node.classList.contains('error') || node.querySelector('.error')) return 'failed';
  return 'done';
}

/** The human line under the notification title: the task the session was
 * working on — the most recent non-internal user message, whitespace
 * collapsed, capped at `max` chars. */
export function extractTaskExcerpt(
  messages: ReadonlyArray<{ role: string; content: string; internal?: boolean }>,
  max = 80,
): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (message.role !== 'user' || message.internal) continue;
    const text = message.content.replace(/\s+/g, ' ').trim();
    if (!text) continue;
    return text.length > max ? `${text.slice(0, max)}…` : text;
  }
  return '';
}

/** The visible session in a visible window is already being watched — the
 * other two cases (background session, any session while the window is in
 * the tray) are exactly who notifications are for. */
export function shouldNotifyFor(sessionId: string, currentSessionId: string, windowVisible: boolean): boolean {
  return sessionId !== currentSessionId || !windowVisible;
}

function kindLabel(kind: SettleKind): string {
  if (kind === 'failed') return t('notify.failed');
  if (kind === 'needs-confirm') return t('notify.needsConfirm');
  return t('notify.done');
}

export interface SettleNotifierDeps {
  runningIds(): string[];
  currentId(): string;
  /** Native visibility (tauri isVisible), falling back to the DOM. */
  windowVisible(): Promise<boolean>;
  /** The settled session's transcript host; null when not live. */
  hostOf(sessionId: string): HTMLElement | null;
  /** Live messages — null means the controller is gone (deleted mid-run);
   * the session then stays silent, there is nothing left to jump to. */
  messagesOf(sessionId: string): Array<{ role: string; content: string; internal?: boolean }> | null;
  /** Display title: session title, else the workspace basename. */
  titleOf(sessionId: string): Promise<string>;
  notify(payload: { title: string; body: string; sessionId: string }): Promise<void>;
}

export class SettleNotifier {
  private readonly deps: SettleNotifierDeps;
  private previousRunning = new Set<string>();

  constructor(deps: SettleNotifierDeps) {
    this.deps = deps;
  }

  /** Call on every running-set change. Only the EDGE notifies: sessions that
   * were running and now are not. A session that starts and finishes between
   * two refreshes is treated as settled too (it left the set). */
  refresh(): void {
    const now = new Set(this.deps.runningIds());
    for (const sessionId of this.previousRunning) {
      if (!now.has(sessionId)) void this.handleSettle(sessionId);
    }
    this.previousRunning = now;
  }

  private async handleSettle(sessionId: string): Promise<void> {
    try {
      const messages = this.deps.messagesOf(sessionId);
      if (messages === null) return;
      const visible = await this.deps.windowVisible();
      if (!shouldNotifyFor(sessionId, this.deps.currentId(), visible)) return;
      const title = `${await this.deps.titleOf(sessionId)} · ${kindLabel(classifySettleHost(this.deps.hostOf(sessionId)))}`;
      const body = extractTaskExcerpt(messages) || t('notify.bodyFallback');
      await this.deps.notify({ title, body, sessionId });
    } catch (err) {
      // A notification must never break the session lifecycle that produced it.
      console.error('[pure] settle notification failed:', err);
    }
  }
}
