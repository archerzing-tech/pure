// src/adapter/node/__tests__/NodeToolBackground.test.ts
// Integration coverage for execute_command background:true — a long-lived
// process must start detached, return immediately with a PID + log file, keep
// running after the tool call returns, and be stoppable by that PID. This is
// the regression for "启动一个服务" dying at the 30s command timeout.

import { describe, expect, it } from 'bun:test';
import { readFileSync, existsSync } from 'node:fs';
import { NodeToolAdapter } from '../NodeToolAdapter';

const PORT = 18000 + Math.floor(Math.random() * 2000);

function call(command: string) {
  const adapter = new NodeToolAdapter({ workspace: process.cwd() });
  return adapter.execute({
    id: 'bg-test',
    index: 0,
    function: { name: 'execute_command', arguments: JSON.stringify({ command, background: true }) },
  });
}

describe('execute_command background:true (real detached server)', () => {
  it('returns immediately with a pid, writes to the log, and keeps the server up', async () => {
    // A tiny HTTP server: long-lived by construction (never exits on its own).
    const command = `bun -e 'Bun.serve({ port: ${PORT}, fetch: () => new Response("pure-bg-ok") })'`;
    const t0 = Date.now();
    const result = await call(command);

    // The tool call itself returned FAST (no waiting for the server to exit).
    expect(result.success).toBe(true);
    expect(Date.now() - t0).toBeLessThan(5000);

    const payload = JSON.parse(String(result.result)) as { kind: string; pid: number; logFile: string };
    expect(payload.kind).toBe('background');
    expect(payload.pid).toBeGreaterThan(0);

    try {
      // The server must actually answer on its port.
      let body = '';
      for (let i = 0; i < 30 && !body; i++) {
        await new Promise((r) => setTimeout(r, 200));
        body = await fetch(`http://127.0.0.1:${PORT}/`).then((r) => r.text()).catch(() => '');
      }
      expect(body).toBe('pure-bg-ok');

      // The log file appears as soon as the wrapper's shell sets up the
      // redirection — poll, don't race it right after the immediate return.
      let logged = false;
      for (let i = 0; i < 15 && !logged; i++) {
        await new Promise((r) => setTimeout(r, 200));
        logged = existsSync(payload.logFile);
      }
      expect(logged).toBe(true);
    } finally {
      // Stop the whole detached process group (the reported PID is the wrapper
      // shell; the server is its child — killing only the shell orphans bun).
      try { process.kill(-payload.pid, 'SIGKILL'); } catch { /* already gone */ }
      try { process.kill(payload.pid, 'SIGKILL'); } catch { /* already gone */ }
    }
    // Give the OS a beat; then the port must be free again.
    await new Promise((r) => setTimeout(r, 300));
    const dead = await fetch(`http://127.0.0.1:${PORT}/`).then(() => true).catch(() => false);
    expect(dead).toBe(false);
  });

  it('log file captures output written before detach (wrapper redirection)', async () => {
    const marker = `bg-marker-${Date.now()}`;
    const result = await call(`echo ${marker}; sleep 60`);
    const payload = JSON.parse(String(result.result)) as { pid: number; logFile: string };
    expect(result.success).toBe(true);
    try {
      let content = '';
      for (let i = 0; i < 20 && !content.includes(marker); i++) {
        await new Promise((r) => setTimeout(r, 200));
        if (existsSync(payload.logFile)) {
          content = readFileSync(payload.logFile, 'utf8');
        }
      }
      expect(content).toContain(marker);
    } finally {
      try { process.kill(-payload.pid, 'SIGKILL'); } catch {}
      try { process.kill(payload.pid, 'SIGKILL'); } catch {}
    }
  });
});
