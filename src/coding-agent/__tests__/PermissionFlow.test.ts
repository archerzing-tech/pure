// src/coding-agent/__tests__/PermissionFlow.test.ts
// Covers the write-file confirmation flow: preview building (ToolRegistry)
// and passthrough of path/contentPreview to the request handler.

import { describe, it, expect } from 'bun:test';
import { buildWritePreview, isGitMutationCommand, Tags, ToolRegistry } from '../ToolRegistry';
import type { ToolAdapter, ToolCall, ToolResult, ToolDefinition } from '../../shared/types';
import type { PermissionMode } from '../types';
import type { TaggedTool } from '../types';
import { PermissionManager } from '../PermissionManager';
import type { PermissionContext, PermissionRequestInfo } from '../types';

describe('ToolRegistry command guard', () => {
  it('rejects guarded Git mutations without delegating to the shell', async () => {
    let executed = false;
    const tools: ToolDefinition[] = [{ name: 'execute_command', description: 'run', input_schema: { type: 'object' } }];
    const delegate: ToolAdapter = {
      getTools: () => tools,
      getMetadata: () => ({ sideEffects: true }),
      execute: async (): Promise<ToolResult> => {
        executed = true;
        return { id: 'delegated', toolName: 'execute_command', success: true, duration: 1 };
      },
    };
    const registry = new ToolRegistry(delegate);
    registry.setCommandGuard((command) => isGitMutationCommand(command) ? 'blocked' : null);
    for (const command of ['git init', 'git -C /tmp/demo init', 'command git add .', 'env GIT_DIR=x git commit -m x', "sh -c 'git reset --hard'"]) {
      const call: ToolCall = { id: `guarded-${command}`, index: 0, function: { name: 'execute_command', arguments: JSON.stringify({ command }) } };
      const result = await registry.execute(call);
      expect(result.success).toBe(false);
      expect(result.error).toBe('blocked');
    }
    expect(executed).toBe(false);
  });
});

describe('buildWritePreview', () => {  it('builds a full-content preview for write_file', () => {
    const preview = buildWritePreview('write_file', {
      path: 'src/foo.ts',
      content: 'export const a = 1;',
    });
    expect(preview).toEqual({ path: 'src/foo.ts', contentPreview: 'export const a = 1;' });
  });

  it('builds an old→new diff snippet for edit_file', () => {
    const preview = buildWritePreview('edit_file', {
      path: 'README.md',
      oldString: 'v0.1',
      newString: 'v0.2',
    });
    expect(preview?.path).toBe('README.md');
    expect(preview?.contentPreview).toContain('- v0.1');
    expect(preview?.contentPreview).toContain('+ v0.2');
  });

  it('returns undefined for non-write tools (nothing to preview)', () => {
    expect(buildWritePreview('read_file', { path: 'a.ts' })).toBeUndefined();
    expect(buildWritePreview('execute_command', { command: 'ls' })).toBeUndefined();
  });

  it('tolerates missing args without throwing', () => {
    expect(buildWritePreview('write_file', {})).toEqual({ path: undefined, contentPreview: '' });
    expect(buildWritePreview('edit_file', {})).toEqual({ path: undefined, contentPreview: '- \n+ ' });
  });
});

describe('PermissionManager write preview passthrough', () => {
  it('passes path + contentPreview to the request handler for medium-risk writes', async () => {
    let received: PermissionRequestInfo | null = null;
    const pm = new PermissionManager('NORMAL', (info) => {
      received = info;
      return Promise.resolve({ allowed: true });
    });

    const decision = await pm.askUser({
      tool: 'write_file',
      isRead: false,
      riskLevel: 'medium',
      description: 'Create or overwrite a file',
      path: 'src/new.ts',
      contentPreview: 'export const x = 1;',
    });

    expect(decision.allowed).toBe(true);
    expect(received).not.toBeNull();
    expect(received!.path).toBe('src/new.ts');
    expect(received!.contentPreview).toBe('export const x = 1;');
    expect(received!.dangerLevel).toBe('caution');
  });

  it('keeps the preview absent for read tools (dialog shows no preview block)', async () => {
    let received: PermissionRequestInfo | null = null;
    const pm = new PermissionManager('NORMAL', (info) => {
      received = info;
      return Promise.resolve({ allowed: true });
    });

    await pm.askUser({
      tool: 'read_file',
      isRead: true,
      riskLevel: 'medium',
      description: 'Read a file',
      argsHash: 'h',
    });

    expect(received!.path).toBeUndefined();
    expect(received!.contentPreview).toBeUndefined();
  });

  it('caches an explicit "allow always this session" decision even for high-risk tools', async () => {
    let handlerCalls = 0;
    const pm = new PermissionManager('NORMAL', async () => {
      handlerCalls++;
      return { allowed: true, remember: true };
    });

    const ctx: PermissionContext = {
      tool: 'execute_command',
      command: 'rm -rf node_modules',
      description: 'Execute a shell command',
      isRead: false,
      riskLevel: 'high',
    };

    const first = await pm.askUser(ctx);
    const second = await pm.askUser(ctx);
    expect(first.allowed).toBe(true);
    expect(second.allowed).toBe(true);
    // Cached → the dialog/handler must not fire a second time.
    expect(handlerCalls).toBe(1);
  });

  it('caches by tool name, not by args hash — same MCP call re-emitted with different JSON still hits the session cache', async () => {
    let handlerCalls = 0;
    const pm = new PermissionManager('NORMAL', async () => {
      handlerCalls++;
      return { allowed: true, remember: true };
    });

    // Models re-emit the "same" call with different JSON key order / optional
    // fields. The args-hash cache key previously split these into two keys and
    // re-prompted even after the user clicked 始终允许 — "点了还是问".
    const ctxA: PermissionContext = {
      tool: 'run',
      serverName: 'shell',
      description: 'MCP run',
      isRead: true,
      riskLevel: 'medium',
      argsHash: '{"command":"ls","cwd":"/"}',
    };
    const ctxB: PermissionContext = {
      ...ctxA,
      argsHash: '{"cwd":"/","command":"ls"}',
    };

    const first = await pm.askUser(ctxA);
    const second = await pm.askUser(ctxB);
    expect(first.allowed).toBe(true);
    expect(second.allowed).toBe(true);
    expect(handlerCalls).toBe(1);
  });

  it('dedupes concurrent same-key requests — one card, one decision, both callers approved', async () => {
    let handlerCalls = 0;
    const pm = new PermissionManager('NORMAL', async () => {
      handlerCalls++;
      return { allowed: true, remember: true };
    });

    const ctx: PermissionContext = {
      tool: 'execute_command',
      command: 'ls',
      description: 'Execute a shell command',
      isRead: false,
      riskLevel: 'high',
    };

    // Parallel batch: the engine fires the same tool twice concurrently.
    const [a, b] = await Promise.all([pm.askUser(ctx), pm.askUser(ctx)]);
    expect(a.allowed).toBe(true);
    expect(b.allowed).toBe(true);
    expect(handlerCalls).toBe(1);
  });

  it('clearCache during an open card prevents the stale decision from seeding the next session', async () => {
    let resolveCard: (d: { allowed: boolean; remember: boolean }) => void = () => {};
    const pm = new PermissionManager('NORMAL', () => new Promise((resolve) => { resolveCard = resolve; }));

    const ctx: PermissionContext = {
      tool: 'execute_command',
      command: 'ls',
      description: 'Execute a shell command',
      isRead: false,
      riskLevel: 'high',
    };

    const pending = pm.askUser(ctx);
    // Session switch while the card is still open: cache + pending are dropped.
    pm.clearCache();
    // The user's late click on the OLD card must not leak into the NEW session.
    resolveCard({ allowed: true, remember: true });
    await pending;

    let handlerCalls = 0;
    pm.setRequestHandler(async () => { handlerCalls++; return { allowed: true, remember: true }; });
    await pm.askUser(ctx);
    // Fresh session re-asks (the old approval did not seed the new cache).
    expect(handlerCalls).toBe(1);
  });

  it('does not cache a one-shot "allow once" decision, even for high risk', async () => {
    let handlerCalls = 0;
    const pm = new PermissionManager('NORMAL', async () => {
      handlerCalls++;
      return { allowed: true, remember: false };
    });

    const ctx: PermissionContext = {
      tool: 'execute_command',
      command: 'ls',
      description: 'Execute a shell command',
      isRead: false,
      riskLevel: 'high',
    };

    await pm.askUser(ctx);
    await pm.askUser(ctx);
    // Every use re-asks — only explicit session approvals are cached.
    expect(handlerCalls).toBe(2);
  });

  it('clearCache resets remembered approvals for a new chat session', async () => {
    let handlerCalls = 0;
    const pm = new PermissionManager('NORMAL', async () => {
      handlerCalls++;
      return { allowed: true, remember: true };
    });

    const ctx: PermissionContext = {
      tool: 'execute_command',
      command: 'ls',
      description: 'Execute a shell command',
      isRead: false,
      riskLevel: 'high',
    };

    await pm.askUser(ctx);
    pm.clearCache();
    await pm.askUser(ctx);
    expect(handlerCalls).toBe(2);
  });

  it('passes the abort signal through to the request handler', async () => {
    let received: PermissionRequestInfo | null = null;
    const pm = new PermissionManager('NORMAL', (info) => {
      received = info;
      return Promise.resolve({ allowed: true });
    });

    const ac = new AbortController();
    await pm.askUser({
      tool: 'write_file',
      isRead: false,
      riskLevel: 'medium',
      description: 'Create or overwrite a file',
      path: 'src/new.ts',
      signal: ac.signal,
    });

    expect(received!.signal).toBe(ac.signal);
  });
});

// 3.3, simplified by product decision: the owner finds per-commit confirmation
// cards more costly than the risk, so the dedicated git write tools run at
// riskLevel 'low' — auto-approved in NORMAL, still blocked by PLAN/DONT_ASK
// through the WRITE tag. No new command guard; remote/history-rewriting git
// keeps living on execute_command's existing high-risk path.
describe('git write tools permission flow', () => {
  function ctxOf(tool: string): PermissionContext {
    return { tool, isRead: false, riskLevel: 'low' };
  }

  it('NORMAL auto-approves git_commit / git_branch without prompting', async () => {
    let asked = 0;
    const pm = new PermissionManager('NORMAL', async () => {
      asked++;
      return { allowed: false };
    });
    for (const tool of ['git_commit', 'git_branch']) {
      const decision = await pm.askUser(ctxOf(tool));
      expect(decision.allowed).toBe(true);
      expect(decision.autoApproved).toBe(true);
    }
    expect(asked).toBe(0);
  });

  it('PLAN still blocks them via the WRITE classification', async () => {
    const pm = new PermissionManager('PLAN');
    const decision = await pm.askUser(ctxOf('git_commit'));
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toContain('PLAN');
  });

  it('medium-risk writes still prompt in NORMAL (contrast)', async () => {
    let asked = 0;
    const pm = new PermissionManager('NORMAL', async () => {
      asked++;
      return { allowed: true };
    });
    const decision = await pm.askUser({ tool: 'write_file', isRead: false, riskLevel: 'medium' });
    expect(decision.allowed).toBe(true);
    expect(asked).toBe(1);
  });
});

// 审计批 5①：写性未知 ≠ 只读。MCP 工具注册恒 [Tags.MCP]、外部脚本工具缺省
// [SHELL, EXTERNAL]——两者此前都被 isRead=!isWrite 判成读，PLAN/DONT_ASK
// 硬只读档放行 MCP 服务的写工具和任意脚本执行（外部执行器把翻译出的
// execute_command 直打裸 adapter，没有第二道闸）。缺省改判非读；显式声明
// Tags.READ 的外部工具仍算读；NORMAL 照旧弹卡不收紧。
describe('unknown-side-effect families never count as reads (审计批 5①)', () => {
  function registryWith(tool: TaggedTool, mode: PermissionMode): { registry: ToolRegistry; ran: () => boolean } {
    let executed = false;
    const executor: ToolAdapter = {
      getTools: () => [],
      getMetadata: () => ({}),
      execute: async (): Promise<ToolResult> => {
        executed = true;
        return { id: 'ran', toolName: tool.name, result: 'ok', success: true, duration: 0 };
      },
    };
    const registry = new ToolRegistry(executor);
    registry.register(tool);
    registry.setPermissionManager(new PermissionManager(mode));
    return { registry, ran: () => executed };
  }

  function call(name: string): ToolCall {
    return { id: 'c1', index: 0, function: { name, arguments: '{}' } };
  }

  it('PLAN blocks an undeclared external script tool (its executor never runs)', async () => {
    const { registry, ran } = registryWith({
      name: 'my_script', description: 'user-authored script tool',
      input_schema: { type: 'object' },
      tags: [Tags.SHELL, Tags.EXTERNAL], riskLevel: 'medium',
    }, 'PLAN');
    const result = await registry.execute(call('my_script'));
    expect(result.success).toBe(false);
    expect(result.error).toContain('PLAN');
    expect(ran()).toBe(false);
  });

  it('DONT_ASK blocks an undeclared external script tool too', async () => {
    const { registry, ran } = registryWith({
      name: 'my_script', description: 'user-authored script tool',
      input_schema: { type: 'object' },
      tags: [Tags.SHELL, Tags.EXTERNAL], riskLevel: 'medium',
    }, 'DONT_ASK');
    const result = await registry.execute(call('my_script'));
    expect(result.success).toBe(false);
    expect(ran()).toBe(false);
  });

  it('an external tool explicitly declared READ stays a read under PLAN', async () => {
    const { registry, ran } = registryWith({
      name: 'log_tail', description: 'read-only log viewer',
      input_schema: { type: 'object' },
      tags: [Tags.SHELL, Tags.EXTERNAL, Tags.READ], riskLevel: 'medium',
    }, 'PLAN');
    const result = await registry.execute(call('log_tail'));
    expect(result.success).toBe(true);
    expect(ran()).toBe(true);
  });

  it('PLAN blocks MCP tools (write-ness unknowable client-side)', async () => {
    const { registry, ran } = registryWith({
      name: 'srv__write_note', description: 'MCP tool that may write',
      input_schema: { type: 'object' },
      tags: [Tags.MCP], riskLevel: 'medium', serverName: 'srv',
    }, 'PLAN');
    const result = await registry.execute(call('srv__write_note'));
    expect(result.success).toBe(false);
    expect(result.error).toContain('PLAN');
    expect(ran()).toBe(false);
  });

  it('NORMAL still prompts for MCP/external tools (no over-blocking)', async () => {
    let asked = 0;
    const executor: ToolAdapter = {
      getTools: () => [],
      getMetadata: () => ({}),
      execute: async (): Promise<ToolResult> => ({ id: 'ran', toolName: 'srv__read', result: 'ok', success: true, duration: 0 }),
    };
    const registry = new ToolRegistry(executor);
    registry.register({
      name: 'srv__read', description: 'MCP tool',
      input_schema: { type: 'object' },
      tags: [Tags.MCP], riskLevel: 'medium', serverName: 'srv',
    });
    registry.setPermissionManager(new PermissionManager('NORMAL', async () => {
      asked++;
      return { allowed: true };
    }));
    const result = await registry.execute(call('srv__read'));
    expect(result.success).toBe(true);
    expect(asked).toBe(1);
  });
});
