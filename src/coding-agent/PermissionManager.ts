// src/coding-agent/PermissionManager.ts
// v0.3 — Manages tool execution permissions with risk levels and session caching.
// Wiring: ToolRegistry.execute() → askUser() → (UI) PermissionDialog.

import type { PermissionMode, PermissionContext, PermissionDecision, PermissionRequestHandler, PermissionRequestInfo } from './types';

export class PermissionManager {
  private mode: PermissionMode;
  private cache = new Map<string, PermissionDecision>();
  // In-flight user decisions keyed by cache key: when the engine fires the
  // SAME tool twice in one parallel batch, both askUser calls share a single
  // pending decision instead of stacking two confirmation cards. Cleared on
  // clearCache() so a stale card from a previous session can never leak into
  // the next session's cache.
  private pending = new Map<string, Promise<PermissionDecision>>();
  // Bumped by clearCache(): a card left open across a session switch captures
  // the old epoch and drops its approval instead of seeding the new session.
  private pendingEpoch = 0;
  private requestHandler?: PermissionRequestHandler;

  constructor(mode: PermissionMode = 'NORMAL', handler?: PermissionRequestHandler) {
    this.mode = mode;
    this.requestHandler = handler;
  }

  setMode(mode: PermissionMode): void {
    this.mode = mode;
  }

  getMode(): PermissionMode {
    return this.mode;
  }

  setRequestHandler(handler: PermissionRequestHandler): void {
    this.requestHandler = handler;
  }

  async askUser(ctx: PermissionContext): Promise<PermissionDecision> {
    // YOLO: auto-approve everything
    if (this.mode === 'YOLO') {
      return { allowed: true, autoApproved: true };
    }

    // PLAN: read-only, block all writes
    if (this.mode === 'PLAN' && !ctx.isRead) {
      return { allowed: false, reason: 'PLAN mode: read-only operations only' };
    }

    // DONT_ASK: allow reads, block writes silently
    if (this.mode === 'DONT_ASK') {
      return { allowed: ctx.isRead, reason: ctx.isRead ? undefined : 'DONT_ASK mode: write blocked' };
    }

    // Low risk: auto-approved, no dialog (nothing to cache — always approved)
    if (ctx.riskLevel === 'low') {
      return { allowed: true, autoApproved: true, reason: 'low-risk tool (auto-approved)' };
    }

    const cacheKey = this.buildCacheKey(ctx);

    // Cached only when the user explicitly chose "allow always this session"
    // (decision.remember). High risk is included — the user opted in, and the
    // cache is cleared on new chat — so shell commands don't re-prompt for
    // every call within a session.
    const cached = this.cache.get(cacheKey);
    if (cached) {
      return cached;
    }

    // Concurrent identical requests (same tool fired twice in one parallel
    // batch) share ONE user decision instead of stacking a second card —
    // without this, the GUI queues another permission card for the same tool
    // even after the first was approved ("点了始终允许还是会问").
    const inFlight = this.pending.get(cacheKey);
    if (inFlight) {
      return inFlight;
    }

    const epoch = this.pendingEpoch;
    const decision = this.request(cacheKey, ctx, epoch);
    this.pending.set(cacheKey, decision);
    try {
      return await decision;
    } finally {
      this.pending.delete(cacheKey);
    }
  }

  private async request(cacheKey: string, ctx: PermissionContext, epoch: number): Promise<PermissionDecision> {
    // NORMAL: ask the user via request handler (UI dialog / CLI prompt)
    if (this.requestHandler) {
      const info: PermissionRequestInfo = {
        tool: ctx.tool,
        command: ctx.command,
        description: ctx.description ?? ctx.tool,
        dangerLevel: this.dangerLevel(ctx),
        riskLevel: ctx.riskLevel ?? 'medium',
        serverName: ctx.serverName,
        path: ctx.path,
        contentPreview: ctx.contentPreview,
        signal: ctx.signal,
      };
      const decision = await this.requestHandler(info);

      // "Always allow" caches the decision for the rest of the session — this
      // applies to high-risk tools too when the user explicitly chose it.
      // The epoch guard drops the write when clearCache() ran while the card
      // was still open (session switch): that decision belongs to the OLD
      // session and must not seed the new session's cache.
      if (decision.allowed && decision.remember && epoch === this.pendingEpoch) {
        this.cache.set(cacheKey, decision);
      }
      return decision;
    }

    // No handler: default deny for writes, allow reads
    return { allowed: ctx.isRead, reason: ctx.isRead ? undefined : 'No permission handler available' };
  }

  clearCache(): void {
    this.cache.clear();
    // A pending card belongs to the session being left — drop it (and bump
    // the epoch so its late approval can't write into the new session) so the
    // next session re-prompts instead of inheriting a stale decision.
    this.pending.clear();
    this.pendingEpoch++;
  }

  /**
   * Cache key: `serverName?tool` — a session-scoped "始终允许(本次会话)"
   * approval covers ALL uses of that tool for the rest of the session, exactly
   * as the button promises. Args are deliberately NOT part of the key: models
   * re-emit the "same" call with subtly different JSON (key order, optional
   * fields, an added parameter), which previously produced a different hash
   * and re-prompted even after approval — MCP tools (the only medium-risk
   * reads) hit this on nearly every call.
   */
  private buildCacheKey(ctx: PermissionContext): string {
    return `${ctx.serverName ?? ''}:${ctx.tool}`;
  }

  private dangerLevel(ctx: PermissionContext): 'safe' | 'caution' | 'danger' {
    if (ctx.riskLevel === 'high') return 'danger';
    if (ctx.riskLevel === 'medium' || !ctx.isRead) return 'caution';
    return 'safe';
  }
}
