// src/shared/__tests__/tauriRuntime.test.ts
// 判例（2026-11-28 CI Linux 9 例全红）：isTauriRuntime 曾把「不是」也缓存下来。
// bun 单进程跑整包，先跑的用例文件在无宿主的环境里探过一次，之后 UI 用例即便
// 注入了 __TAURI_INTERNALS__ 也只会读到 false——resizeZones 一例热区都建不出来
// （本机单文件跑全绿、mac 全量也绿，只有按 CI 顺序才现形）。
//
// 这里用子进程隔离，是因为缓存就是进程级状态：同进程里它可能早被别人写成 true，
// 断言就跟库的实际行为无关了。

import { describe, expect, it } from 'bun:test';

const PROBE = `
  const { isTauriRuntime } = await import('./src/shared/tauri.ts');
  const before = isTauriRuntime();
  globalThis.window = { __TAURI_INTERNALS__: { invoke: () => Promise.resolve() } };
  console.log(JSON.stringify([before, isTauriRuntime()]));
`;

describe('isTauriRuntime', () => {
  it('无宿主时探过的「不是」不会钉死整个进程', () => {
    const proc = Bun.spawnSync(['bun', '-e', PROBE], { stdout: 'pipe', stderr: 'pipe' });
    expect(proc.stderr.toString()).toBe('');
    expect(proc.exitCode).toBe(0);
    expect(JSON.parse(proc.stdout.toString().trim())).toEqual([false, true]);
  });
});
