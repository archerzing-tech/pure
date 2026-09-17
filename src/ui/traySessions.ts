// src/ui/traySessions.ts
// Roadmap 5.3 — the tray's running-session list. The frontend owns session
// state and pushes a snapshot to Rust (update_tray_sessions) on every
// running-set change; Rust only renders the menu and reports clicks back.
// This module is just the payload builder, kept pure for tests: title
// resolution order and the menu-length cap are the only behavior worth
// pinning (a session whose title is unknown still names itself after its
// workspace, and a runaway fleet must not turn the menu into a scroll fest).

export interface TraySessionItem {
  id: string;
  title: string;
}

/** One menu entry per running session, titles resolved, capped at `cap`. */
export function buildTraySessionItems(
  sessionIds: readonly string[],
  titleOf: (sessionId: string) => string,
  cap = 12,
): TraySessionItem[] {
  return sessionIds.slice(0, cap).map((id) => ({ id, title: titleOf(id) }));
}
