// src/__tests__/cli-permission.test.ts
// P1-8 — CLI direct-path permission helpers: answer parsing, prompt rendering,
// and the non-interactive fallback policy.

import { afterAll, beforeAll, describe, it, expect } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { formatPermissionRequest, parsePermissionAnswer, nonTtyDecision, createCliPermissionHandler, parseHookApprovalAnswer, formatHookApprovalRequest, createCliHookGate } from '../cli_permission';
import { loadHookApprovals } from '../shared/userHookApprovals';
import type { PermissionRequestInfo } from '../coding-agent/types';

const baseInfo: PermissionRequestInfo = {
  tool: 'write_file',
  description: 'Create or overwrite a file in the workspace.',
  dangerLevel: 'caution',
  riskLevel: 'medium',
};

describe('parsePermissionAnswer', () => {
  it('accepts allow-once answers (y / yes / 是 / 允许)', () => {
    for (const raw of ['y', 'Y', 'yes', 'YES', '是', '允许']) {
      expect(parsePermissionAnswer(raw)).toEqual({ allowed: true, remember: false });
    }
  });

  it('accepts allow-always answers (a / always / 始终允许)', () => {
    for (const raw of ['a', 'A', 'always', 'Always', '始终允许']) {
      expect(parsePermissionAnswer(raw)).toEqual({ allowed: true, remember: true });
    }
  });

  it('accepts deny answers (n / no / 否 / 拒绝)', () => {
    for (const raw of ['n', 'N', 'no', 'NO', '否', '拒绝']) {
      expect(parsePermissionAnswer(raw)).toEqual({ allowed: false, remember: false });
    }
  });

  it('returns null for unrecognized input', () => {
    for (const raw of ['', '   ', 'maybe', '42', 'yep', 'always!']) {
      expect(parsePermissionAnswer(raw)).toBeNull();
    }
  });
});

describe('formatPermissionRequest', () => {
  it('renders tool, risk, path and a multi-line content preview', () => {
    const out = formatPermissionRequest({
      ...baseInfo,
      path: 'src/foo.ts',
      contentPreview: 'line one\nline two',
    });
    expect(out).toContain('write_file');
    expect(out).toContain('src/foo.ts');
    expect(out).toContain('line one');
    expect(out).toContain('line two');
  });

  it('renders the shell command for execute_command', () => {
    const out = formatPermissionRequest({
      tool: 'execute_command',
      description: 'Execute a shell command',
      dangerLevel: 'danger',
      riskLevel: 'high',
      command: 'rm -rf dist',
    });
    expect(out).toContain('rm -rf dist');
  });

  it('omits the preview block when no preview exists', () => {
    const out = formatPermissionRequest(baseInfo);
    expect(out).not.toContain('─'.repeat(38));
    expect(out).toContain('write_file');
  });

  it('caps overly long preview lines so the terminal does not flood', () => {
    const long = 'a'.repeat(300);
    const out = formatPermissionRequest({ ...baseInfo, path: 'big.ts', contentPreview: long });
    expect(out).toContain('a'.repeat(120) + '…');
    expect(out).not.toContain('a'.repeat(121));
  });
});

describe('nonTtyDecision', () => {
  it('auto-approves safe (read) tools on non-interactive stdin', () => {
    const d = nonTtyDecision({ ...baseInfo, dangerLevel: 'safe', riskLevel: 'low' });
    expect(d.allowed).toBe(true);
    expect(d.autoApproved).toBe(true);
  });

  it('denies caution-level writes on non-interactive stdin', () => {
    const d = nonTtyDecision({ ...baseInfo, dangerLevel: 'caution', riskLevel: 'medium', path: 'a.ts' });
    expect(d.allowed).toBe(false);
    expect(d.reason).toContain('TTY');
  });

  it('denies danger-level commands on non-interactive stdin', () => {
    const d = nonTtyDecision({
      tool: 'execute_command',
      description: 'x',
      dangerLevel: 'danger',
      riskLevel: 'high',
    });
    expect(d.allowed).toBe(false);
  });
});

describe('createCliPermissionHandler', () => {
  it('auto-approves every call (even danger-level) when autoApprove is true', async () => {
    const h = createCliPermissionHandler(true);
    const d = await h({ ...baseInfo, dangerLevel: 'danger', riskLevel: 'high' });
    expect(d.allowed).toBe(true);
    expect(d.autoApproved).toBe(true);
  });

  it('still denies aborted requests even when autoApprove is true', async () => {
    const h = createCliPermissionHandler(true);
    const ac = new AbortController();
    ac.abort();
    const d = await h({ ...baseInfo, signal: ac.signal, dangerLevel: 'safe' });
    expect(d.allowed).toBe(false);
    expect(d.reason).toContain('aborted');
  });
});

// ── 2.3: user-hook approval gate ──

describe('parseHookApprovalAnswer', () => {
  it('maps y / yes / 是 / 允许 to a session-only approval', () => {
    for (const raw of ['y', 'Y', 'yes', '是', '允许']) {
      expect(parseHookApprovalAnswer(raw)).toBe('once');
    }
  });

  it('maps a / always / 始终允许 to a persistent approval', () => {
    for (const raw of ['a', 'A', 'always', '始终允许']) {
      expect(parseHookApprovalAnswer(raw)).toBe('always');
    }
  });

  it('maps n / no / 否 / 拒绝 to deny and unknown input to null', () => {
    for (const raw of ['n', 'N', 'no', '否', '拒绝']) {
      expect(parseHookApprovalAnswer(raw)).toBe('deny');
    }
    for (const raw of ['', '   ', 'maybe', 'sure']) {
      expect(parseHookApprovalAnswer(raw)).toBeNull();
    }
  });
});

describe('formatHookApprovalRequest', () => {
  it('renders the event and the command to approve', () => {
    const out = formatHookApprovalRequest('bun run lint', 'on_pre_tool');
    expect(out).toContain('hook:on_pre_tool');
    expect(out).toContain('bun run lint');
  });
});

describe('createCliHookGate', () => {
  let dir: string;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'pure-hook-gate-'));
  });

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('allows hooks cached in the approval store without prompting', async () => {
    const store = await loadHookApprovals(dir);
    store.approve('bun run lint');
    await new Promise((resolve) => setTimeout(resolve, 25));
    const gate = createCliHookGate(await loadHookApprovals(dir));
    await expect(gate.check({ command: 'bun run lint' }, 'on_pre_tool')).resolves.toBe(true);
  });

  // First-enable prompts need a TTY; under `bun test` stdin is usually a pipe,
  // where the gate must deny (never hang, never run). Skip rather than hang
  // when someone runs the suite from a terminal with stdin attached.
  const itUnlessInteractive = process.stdin.isTTY ? it.skip : it;
  itUnlessInteractive('denies an unapproved hook on non-interactive stdin', async () => {
    const gate = createCliHookGate(await loadHookApprovals(dir));
    await expect(gate.check({ command: 'never-approved.sh' }, 'on_turn_complete')).resolves.toBe(false);
  });
});
