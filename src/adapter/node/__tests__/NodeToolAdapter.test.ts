// src/adapter/node/__tests__/NodeToolAdapter.test.ts

import { describe, expect, it, beforeAll, afterAll } from 'bun:test';
import { mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NodeToolAdapter } from '../NodeToolAdapter';
import type { ToolCall, ToolResult } from '../../../shared/types';

function makeCall(command: string): ToolCall {
  return {
    id: 'call-1',
    index: 0,
    function: { name: 'execute_command', arguments: JSON.stringify({ command }) },
  };
}

function resultOf(r: ToolResult): { stdout: string; stderr: string; exitCode: number } {
  return r.result as { stdout: string; stderr: string; exitCode: number };
}

describe('NodeToolAdapter execute_command', () => {
  let workspace: string;
  let adapter: NodeToolAdapter;

  beforeAll(() => {
    workspace = mkdtempSync(join(tmpdir(), 'pure-node-tool-'));
    adapter = new NodeToolAdapter({ workspace, commandTimeout: 10000 });
  });

  afterAll(() => {
    rmSync(workspace, { recursive: true, force: true });
  });

  it('reports success with exitCode 0 for a clean command', async () => {
    const r = await adapter.execute(makeCall('echo hello'));
    expect(r.success).toBe(true);
    expect(r.error).toBeUndefined();
    expect(resultOf(r).exitCode).toBe(0);
    expect(resultOf(r).stdout).toContain('hello');
  });

  it('reports failure with a non-zero exit code and stderr in the error', async () => {
    const r = await adapter.execute(makeCall('echo boom >&2; exit 3'));
    expect(r.success).toBe(false);
    expect(r.error).toContain('exit code 3');
    expect(r.error).toContain('boom'); // stderr visible in the failure message
    expect(resultOf(r).exitCode).toBe(3);
    expect(resultOf(r).stderr).toContain('boom');
  });

  it('keeps stdout in the result even when the command fails', async () => {
    const r = await adapter.execute(makeCall('echo partial; exit 2'));
    expect(r.success).toBe(false);
    expect(r.error).toContain('exit code 2');
    expect(resultOf(r).stdout).toContain('partial');
  });

  it('reports failure when the command is not found', async () => {
    const r = await adapter.execute(makeCall('definitely-not-a-real-command-xyz'));
    expect(r.success).toBe(false);
    // sh reports the failure on stderr; the exit code must be non-zero.
    expect(resultOf(r).exitCode).not.toBe(0);
  });

  it('rejects reads through a symlink that escapes the workspace', async () => {
    const outside = mkdtempSync(join(tmpdir(), 'pure-node-outside-'));
    try {
      symlinkSync(outside, join(workspace, 'linked'));
      const r = await adapter.execute({
        id: 'call-symlink',
        index: 0,
        function: { name: 'read_file', arguments: JSON.stringify({ path: 'linked/secret.txt' }) },
      });
      expect(r.success).toBe(false);
      expect(r.error).toContain('Path escapes workspace');
    } finally {
      rmSync(outside, { recursive: true, force: true });
      rmSync(join(workspace, 'linked'), { force: true });
    }
  });
});
