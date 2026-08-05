// src/coding-agent/PermissionManager.ts
// v0.2 — Manages tool execution permissions with risk levels and session caching.
// Wiring: ToolRegistry.execute() → askUser() → (UI) PermissionDialog.

import type { PermissionMode, PermissionContext, PermissionDecision, PermissionRequestHandler, PermissionRequestInfo } from './types';

export class PermissionManager {
  private mode: PermissionMode;
  private cache = new Map<string, PermissionDecision>();
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
      if (decision.allowed && decision.remember) {
        this.cache.set(cacheKey, decision);
      }
      return decision;
    }

    // No handler: default deny for writes, allow reads
    return { allowed: ctx.isRead, reason: ctx.isRead ? undefined : 'No permission handler available' };
  }

  clearCache(): void {
    this.cache.clear();
  }

  /**
   * Cache key per design: `serverName?toolName:argsHash`.
   * - Write tools: tool-level key (session "allow always" covers all uses of the tool).
   * - Read tools: key includes an args/command hash so only identical calls are cached.
   */
  private buildCacheKey(ctx: PermissionContext): string {
    const base = `${ctx.serverName ?? ''}:${ctx.tool}`;
    if (!ctx.isRead) return base;
    const argsHash = ctx.argsHash ?? 'any';
    return `${base}:${argsHash}`;
  }

  private dangerLevel(ctx: PermissionContext): 'safe' | 'caution' | 'danger' {
    if (ctx.riskLevel === 'high') return 'danger';
    if (ctx.riskLevel === 'medium' || !ctx.isRead) return 'caution';
    return 'safe';
  }
}
