// src/__tests__/cli-permission.test.ts
// P1-8 — CLI direct-path permission helpers: answer parsing, prompt rendering,
// and the non-interactive fallback policy.

import { describe, it, expect } from 'bun:test';
import { formatPermissionRequest, parsePermissionAnswer, nonTtyDecision } from '../cli_permission';
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
