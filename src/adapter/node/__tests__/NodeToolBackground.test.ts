// src/adapter/node/__tests__/NodeToolBackground.test.ts
// Integration coverage for execute_command background:true — a long-lived
// process must start detached, return immediately with a PID + log file, keep
// running after the tool call returns, and be stoppable by that PID. This is
// the regression for "启动一个服务" dying at the 30s command timeout.
//
// Runs on ALL platforms (the release pipeline executes bun test on
// windows-latest too). The payload commands are written to temp .js files and
// launched via `<bun> <script>` — inline `bun -e '...'` snippets would break on
// Windows where cmd.exe strips no single quotes and `( ) "` inside a batch
// group are parsing hazards.

import { describe, expect, it } from 'bun:test';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NodeToolAdapter } from '../NodeToolAdapter';

const PORT = 18000 + Math.floor(Math.random() * 2000);
const BUN = process.execPath;

interface BackgroundPayload {
  kind: string;
  pid: number;
  logFile: string;
}

function call(command: string) {
  const adapter = new NodeToolAdapter({ workspace: process.cwd() });
  return adapter.execute({
    id: 'bg-test',
    index: 0,
    function: { name: 'execute_command', arguments: JSON.stringify({ command, background: true }) },
  });
}

/** Kill the detached wrapper AND its children (POSIX group signal; Windows
 *  needs taskkill's /T tree walk — killing only the wrapper orphans bun). */
function killTree(pid: number): void {
  if (process.platform === 'win32') {
    try { Bun.spawnSync(['taskkill', '/PID', String(pid), '/T', '/F']); } catch { /* already gone */ }
    return;
  }
  try { process.kill(-pid, 'SIGKILL'); } catch { /* already gone */ }
  try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ }
}

/** Materialize a payload script so the launched command stays quote-free. */
function writeScript(body: string): string {
  const file = join(tmpdir(), `pure-bg-test-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}.js`);
  writeFileSync(file, body, 'utf8');
  return file;
}

describe('execute_command background:true (real detached server)', () => {
  it('returns immediately with a pid, writes to the log, and keeps the server up', async () => {
    // A tiny HTTP server: long-lived by construction (never exits on its own).
    const server = writeScript(`Bun.serve({ port: ${PORT}, fetch: () => new Response("pure-bg-ok") });\n`);
    const command = `"${BUN}" ${JSON.stringify(server)}`;
    const t0 = Date.now();
    const result = await call(command);

    // The tool call itself returned FAST (no waiting for the server to exit).
    expect(result.success).toBe(true);
    expect(Date.now() - t0).toBeLessThan(5000);

    const payload = JSON.parse(String(result.result)) as BackgroundPayload;
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
      killTree(payload.pid);
      try { rmSync(server, { force: true }); } catch { /* best effort */ }
    }
    // Give the OS a beat; then the port must be free again (poll — teardown
    // can lag a moment behind the kill, especially on Windows).
    let dead = false;
    for (let i = 0; i < 15 && !dead; i++) {
      await new Promise((r) => setTimeout(r, 200));
      dead = await fetch(`http://127.0.0.1:${PORT}/`).then(() => false).catch(() => true);
    }
    expect(dead).toBe(true);
  });

  it('log file captures output written before detach (wrapper redirection)', async () => {
    const marker = `bg-marker-${Date.now()}`;
    // Print the marker immediately, then idle — proves early output lands in
    // the log while the process is still running detached.
    const script = writeScript(`console.log("${marker}"); setInterval(function () {}, 60000);\n`);
    const result = await call(`"${BUN}" ${JSON.stringify(script)}`);
    const payload = JSON.parse(String(result.result)) as BackgroundPayload;
    expect(result.success).toBe(true);
    try {
      let content = '';
      for (let i = 0; i < 20 && !content.includes(marker); i++) {
        await new Promise((r) => setTimeout(r, 200));
        if (existsSync(payload.logFile)) {
          content = readLog(payload.logFile);
        }
      }
      expect(content).toContain(marker);
    } finally {
      killTree(payload.pid);
      try { rmSync(script, { force: true }); } catch { /* best effort */ }
    }
  });
});

/** Read a log file tolerating concurrent writes (a partial trailing line must
 *  not crash the poll loop). */
function readLog(file: string): string {
  try {
    return readFileSync(file, 'utf8');
  } catch {
    return '';
  }
}
