// src/shared/__tests__/tauriRuntime.test.ts
// 判例（2026-11-28 CI Linux 9 例全红）：isTauriRuntime 曾把「不是」也缓存下来。
// bun 单进程跑整包，先跑的用例文件在无宿主的环境里探过一次，之后 UI 用例即便
// 注入了 __TAURI_INTERNALS__ 也只会读到 false——resizeZones 一例热区都建不出来
// （本机单文件跑全绿、mac 全量也绿，只有按 CI 顺序才现形）。
//
// 这里用子进程隔离，是因为缓存就是进程级状态：同进程里它可能早被别人写成 true，
// 断言就跟库的实际行为无关了。

import { describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const TAURI_TS = join(import.meta.dir, '..', 'tauri.ts');

/** 探针落成文件再跑，不用 `bun -e <多行脚本>`。
 *
 *  Windows 上 `bun` 走 .cmd 垫片，带换行/引号的多行参数会被 cmd 的特殊字符保护
 *  直接拒绝（`The argument 'args[2]' contains a cmd.exe special character`），
 *  于是这条判例在 Windows 全量里必红——而它验的恰恰是「不同宿主上缓存行为一致」，
 *  在哪个平台都该跑得起来。用 process.execPath 同时绕开垫片解析。 */
function runProbe(lines: string[], env?: Record<string, string>): { stdout: string; stderr: string; exitCode: number | null } {
  const dir = mkdtempSync(join(tmpdir(), 'pure-tauri-probe-'));
  const fixture = join(dir, 'probe.mjs');
  writeFileSync(fixture, lines.join('\n'));
  try {
    const proc = Bun.spawnSync([process.execPath, 'run', fixture], { env, stdout: 'pipe', stderr: 'pipe' });
    return { stdout: proc.stdout.toString(), stderr: proc.stderr.toString(), exitCode: proc.exitCode };
  } finally {
    // Windows：刚退出的子进程句柄可能还没完全释放，退避重试。
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}

describe('isTauriRuntime', () => {
  it('无宿主时探过的「不是」不会钉死整个进程', () => {
    const proc = runProbe([
      `const { isTauriRuntime } = await import(${JSON.stringify(TAURI_TS)});`,
      'const before = isTauriRuntime();',
      'globalThis.window = { __TAURI_INTERNALS__: { invoke: () => Promise.resolve() } };',
      'console.log(JSON.stringify([before, isTauriRuntime()]));',
    ]);
    expect(proc.stderr).toBe('');
    expect(proc.exitCode).toBe(0);
    expect(JSON.parse(proc.stdout.trim())).toEqual([false, true]);
  });
});
