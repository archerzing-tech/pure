// src/adapter/node/__tests__/NodeToolTaskControl.test.ts
// execute_command 强化（电脑端操作能力 P1）+ task_list/task_kill 的 CLI 集成。
import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NodeToolAdapter } from '../NodeToolAdapter';
import { resetTasksForTests, taskCount } from '../../../shared/taskRegistry';
import type { ToolCall } from '../../../shared/types';

// Windows 上 sh 语法用例跳过（同 NodeToolAdapter.test.ts 的 shOnly 纪律：
// PowerShell 的 redirect/quoting 形态不同，跨平台用例仍全跑）。
const shOnly = process.platform === 'win32';

function safeRm(p: string, tries = 5): void {
  for (let i = 0; i < tries; i++) {
    try {
      rmSync(p, { recursive: true, force: true });
      return;
    } catch {
      /* EBUSY retry */
    }
  }
}

describe('execute_command cwd / timeoutMs / benign exit / spill + task tools', () => {
  let workspace: string;
  let adapter: NodeToolAdapter;

  beforeAll(() => {
    // realpathSync：macOS 的 tmpdir 在 /var/... 而 spawn 后 process.cwd() 报
    // real path /private/var/...（symlink）——期望值与实际同源归一。
    workspace = realpathSync(mkdtempSync(join(tmpdir(), 'pure-taskctl-')));
    adapter = new NodeToolAdapter({ workspace });
  });

  afterAll(() => {
    resetTasksForTests();
    safeRm(workspace);
  });

  const call = (name: string, args: Record<string, unknown>) =>
    adapter.execute({ id: `t_${name}_${Math.random().toString(36).slice(2)}`, index: 0, function: { name, arguments: JSON.stringify(args) } } as ToolCall);

  it('cwd: relative path resolves against the workspace', async () => {
    if (shOnly) return;
    mkdirSync(join(workspace, 'sub'), { recursive: true });
    const r = await call('execute_command', { command: 'node -p "process.cwd()"', cwd: 'sub' });
    expect(r.success).toBe(true);
    expect(String((r.result as any).stdout).trim()).toBe(join(workspace, 'sub'));
  });

  it('cwd: absolute path is used as-is', async () => {
    if (shOnly) return;
    const r = await call('execute_command', { command: 'node -p "process.cwd()"', cwd: workspace });
    expect(r.success).toBe(true);
    expect(String((r.result as any).stdout).trim()).toBe(workspace);
  });

  it('cwd: nonexistent directory reports a validation failure', async () => {
    const r = await call('execute_command', { command: 'echo hi', cwd: join(workspace, 'nope') });
    expect(r.success).toBe(false);
    expect(String(r.error)).toContain('cwd does not exist');
  });

  it('timeoutMs: a sleeper is killed at the requested bound', async () => {
    if (shOnly) return;
    const r = await call('execute_command', { command: 'sleep 30', timeoutMs: 1000 });
    expect(r.success).toBe(false);
    expect(String(r.error)).toContain('timed out after 1000ms');
  }, 15000);

  it('benign exit 1: grep no-match counts as success with a note', async () => {
    if (shOnly) return;
    const f = join(workspace, 'sample.txt');
    writeFileSync(f, 'hello world\n');
    const r = await call('execute_command', { command: `grep "zzz_no_such" "${f}"` });
    expect(r.success).toBe(true);
    expect((r.result as any).exitCode).toBe(1);
    expect(String((r.result as any).note)).toContain('no-match');
  });

  it('exit >= 2 is still a real failure even for whitelisted families', async () => {
    if (shOnly) return;
    const r = await call('execute_command', { command: `grep x "${join(workspace, '__missing__.txt')}"` });
    expect(r.success).toBe(false);
  });

  it('oversize stdout spills to a file with head/tail preview', async () => {
    if (shOnly) return;
    const r = await call('execute_command', { command: `node -e "console.log('x'.repeat(40000))"` });
    expect(r.success).toBe(true);
    const stdout = String((r.result as any).stdout);
    expect(stdout.length).toBeLessThan(10_000);
    expect(stdout).toContain('full output saved to');
    const files = (r.result as any).outputFiles as string[];
    expect(files).toHaveLength(1);
    expect(existsSync(files[0]!)).toBe(true);
  }, 15000);

  it('task_list/task_kill roundtrip on a real background task', async () => {
    if (shOnly) return;
    resetTasksForTests();
    const bg = await call('execute_command', { command: 'sleep 30', background: true });
    expect(bg.success).toBe(true);
    const pid = JSON.parse(String(bg.result)).pid as number;
    expect(pid).toBeGreaterThan(0);
    expect(taskCount()).toBe(1);

    const list = await call('task_list', {});
    const tasks = (list.result as any).tasks as Array<{ pid: number; alive: boolean; command: string }>;
    expect(tasks.some((t) => t.pid === pid && t.alive)).toBe(true);

    const kill = await call('task_kill', { pid });
    expect(kill.success).toBe(true);
    expect((kill.result as any).killed).toBe(true);
    expect(taskCount()).toBe(0); // task_kill clears the registry entry

    // 进程真的死了（探活回落）
    const list2 = await call('task_list', {});
    expect(((list2.result as any).tasks as unknown[]).some((t: any) => t.pid === pid)).toBe(false);
  }, 15000);

  it('task_kill on an already-dead pid reports success (cleanup semantics)', async () => {
    const r = await call('task_kill', { pid: 999_999_999 });
    expect(r.success).toBe(true);
    expect((r.result as any).killed).toBe(false);
  });

  it('task_kill validates the pid argument', async () => {
    const r = await call('task_kill', { pid: 'abc' });
    expect(r.success).toBe(false);
    expect(String(r.error)).toContain('positive integer pid');
  });

  // ── read_file 图片视觉输入（电脑端操作能力 P2）──

  it('read_file returns an image attachment for png paths', async () => {
    // 标准 1x1 透明 PNG
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
    const f = join(workspace, 'pixel.png');
    writeFileSync(f, png);
    const r = await call('read_file', { path: f });
    expect(r.success).toBe(true);
    const images = (r as any).images as Array<{ dataUrl: string; mimeType: string }>;
    expect(images).toHaveLength(1);
    expect(images[0]!.mimeType).toBe('image/png');
    expect(images[0]!.dataUrl.startsWith('data:image/png;base64,')).toBe(true);
    expect(String(r.result)).toContain('visible image attachment');
  });

  it('read_file rejects oversize images with a compression hint', async () => {
    const big = join(workspace, 'huge.png');
    writeFileSync(big, Buffer.alloc(5 * 1024 * 1024 + 1, 0x89));
    const r = await call('read_file', { path: big });
    expect(r.success).toBe(false);
    expect(String(r.error)).toContain('视觉读取上限');
    expect(String(r.error)).toContain('sips');
  });
});
