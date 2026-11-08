// src/shared/__tests__/taskRegistry.test.ts
import { describe, it, expect, beforeEach } from 'bun:test';
import { listTasks, registerTask, resetTasksForTests, taskCount, unregisterTask } from '../taskRegistry';

describe('taskRegistry', () => {
  beforeEach(() => {
    // persist 型单例纪律：每用例关死重灌通道（纯模块单例，无 IO）
    resetTasksForTests();
  });

  it('registers tasks and reports liveness via the injected probe', async () => {
    registerTask(100, 'bun run dev', '/tmp/a.log');
    registerTask(200, 'watcher', '/tmp/b.log');
    const views = await listTasks((pid) => pid === 100);
    expect(views).toHaveLength(2);
    const alive = views.find((v) => v.pid === 100)!;
    expect(alive.alive).toBe(true);
    expect(alive.command).toBe('bun run dev');
    expect(alive.logFile).toBe('/tmp/a.log');
    const dead = views.find((v) => v.pid === 200)!;
    expect(dead.alive).toBe(false);
  });

  it('prunes dead tasks so they stop occupying the list', async () => {
    registerTask(1, 'gone', '/tmp/x.log');
    registerTask(2, 'running', '/tmp/y.log');
    const views = await listTasks((pid) => pid === 2);
    expect(views.find((v) => v.pid === 1)!.alive).toBe(false);
    expect(taskCount()).toBe(1); // dead one pruned
  });

  it('treats a throwing probe as dead (never crashes the list)', async () => {
    registerTask(3, 'x', '/tmp/x.log');
    const views = await listTasks(() => {
      throw new Error('probe exploded');
    });
    expect(views[0]!.alive).toBe(false);
    expect(taskCount()).toBe(0);
  });

  it('unregisterTask removes entries; unknown pids are a no-op', () => {
    registerTask(5, 'x', '/tmp/l.log');
    unregisterTask(5);
    unregisterTask(999);
    expect(taskCount()).toBe(0);
  });

  it('rejects non-positive pids', () => {
    registerTask(0, 'x', '/tmp/l.log');
    registerTask(-3, 'x', '/tmp/l.log');
    expect(taskCount()).toBe(0);
  });
});
