// TauriCheckpointStore 判例（第 3 期持久性）。
// 镜像语义对齐 FSStore 的 v%03d.json（同 version 覆写、version 升序取尾）、
// 盘 IO 全走注入 invoker（不 mock.module——仓纪律禁止进程级污染）、null
// invoker = 非 Tauri 环境的纯镜像退化（conversationSamples 的运行底座）。

import { describe, expect, it } from 'bun:test';
import { TauriCheckpointStore, type CheckpointInvoker } from '../TauriCheckpointStore';
import type { Checkpoint } from '../../../shared/types';

function makeCheckpoint(version: number, turnCount = 3): Checkpoint {
  return {
    version,
    label: `checkpoint-${version}`,
    state: { messages: [{ role: 'user', content: `turn ${version}` }], turnCount },
    createdAt: 1700000000000 + version,
  };
}

/** 录调用 + 可编程回包的假 invoker。 */
function makeFakeInvoker(respond?: (cmd: string, args: Record<string, unknown>) => unknown) {
  const calls: Array<{ cmd: string; args: Record<string, unknown> }> = [];
  const invoker: CheckpointInvoker = async (cmd, args) => {
    calls.push({ cmd, args: args ?? {} });
    return respond?.(cmd, args ?? {});
  };
  return { calls, invoker };
}

describe('TauriCheckpointStore', () => {
  it('warm 把 Rust 回包灌进镜像：loadSession 同步命中最新态', async () => {
    const { invoker } = makeFakeInvoker(() => [
      { sessionId: 'sub_p_tool_1', checkpoint: makeCheckpoint(1) },
      { sessionId: 'sub_p_tool_1', checkpoint: makeCheckpoint(2) },
    ]);
    const store = new TauriCheckpointStore(invoker);
    await store.warm('p');
    const loaded = store.loadSession('sub_p_tool_1');
    expect(loaded).not.toBeNull();
    expect(loaded!.state.turnCount).toBe(3);
    expect(loaded!.checkpoints).toHaveLength(2);
    expect(loaded!.checkpoints[0]!.version).toBe(1);
    expect(loaded!.checkpoints[1]!.version).toBe(2);
  });

  it('没预热到的键诚实 miss（loadSession 返回 null，不编造空态）', () => {
    const { invoker } = makeFakeInvoker();
    const store = new TauriCheckpointStore(invoker);
    expect(store.loadSession('sub_never_warm_1')).toBeNull();
  });

  it('warm 失败不炸：warn 后镜像留空，续跑路径按 miss 处理', async () => {
    const { invoker } = makeFakeInvoker(() => {
      throw new Error('ipc down');
    });
    const store = new TauriCheckpointStore(invoker);
    await expect(store.warm('p')).resolves.toBeUndefined();
    expect(store.loadSession('sub_p_tool_1')).toBeNull();
  });

  it('saveCheckpoint 双发：镜像先同步落（loadSession 立即可见），盘上带参调用', async () => {
    const { calls, invoker } = makeFakeInvoker();
    const store = new TauriCheckpointStore(invoker);
    const cp = makeCheckpoint(1);
    const promise = store.saveCheckpoint('sub_p_tool_1', cp);
    // 镜像同步更新发生在 await 之前：persist-before-settle 依赖这一点
    expect(store.loadSession('sub_p_tool_1')!.state.turnCount).toBe(3);
    await promise;
    expect(calls).toEqual([
      { cmd: 'save_checkpoint', args: { sessionId: 'sub_p_tool_1', checkpoint: cp } },
    ]);
  });

  it('同 version 覆写不追加（FSStore v%03d.json 语义），最新态取尾', async () => {
    const { invoker } = makeFakeInvoker();
    const store = new TauriCheckpointStore(invoker);
    await store.saveCheckpoint('sub_p_tool_1', makeCheckpoint(1, 3));
    await store.saveCheckpoint('sub_p_tool_1', makeCheckpoint(1, 12));
    const loaded = store.loadSession('sub_p_tool_1')!;
    expect(loaded.checkpoints).toHaveLength(1);
    expect(loaded.state.turnCount).toBe(12);
  });

  it('异 version 按 version 升序排，loadSession 取排尾为最新态', async () => {
    const { invoker } = makeFakeInvoker();
    const store = new TauriCheckpointStore(invoker);
    await store.saveCheckpoint('sub_p_tool_1', makeCheckpoint(2, 8));
    await store.saveCheckpoint('sub_p_tool_1', makeCheckpoint(1, 4));
    const loaded = store.loadSession('sub_p_tool_1')!;
    expect(loaded.checkpoints.map((c) => c.version)).toEqual([1, 2]);
    expect(loaded.state.turnCount).toBe(8);
  });

  it('deleteSession 双发：镜像删 + 盘上按支清理', async () => {
    const { calls, invoker } = makeFakeInvoker();
    const store = new TauriCheckpointStore(invoker);
    await store.saveCheckpoint('sub_p_tool_1', makeCheckpoint(1));
    await store.deleteSession('sub_p_tool_1');
    expect(store.loadSession('sub_p_tool_1')).toBeNull();
    expect(calls[1]).toEqual({ cmd: 'delete_session_checkpoints', args: { sessionId: 'sub_p_tool_1' } });
  });

  it('null invoker（非 Tauri）：纯镜像全流程可跑，零盘调用', async () => {
    const store = new TauriCheckpointStore(null);
    await store.saveCheckpoint('sub_p_tool_1', makeCheckpoint(1));
    expect(store.loadSession('sub_p_tool_1')!.state.turnCount).toBe(3);
    await store.deleteSession('sub_p_tool_1');
    expect(store.loadSession('sub_p_tool_1')).toBeNull();
  });

  it('clear 只丢镜像不动盘（换会话不是删会话）', async () => {
    const { calls, invoker } = makeFakeInvoker();
    const store = new TauriCheckpointStore(invoker);
    await store.saveCheckpoint('sub_p_tool_1', makeCheckpoint(1));
    store.clear();
    expect(store.loadSession('sub_p_tool_1')).toBeNull();
    expect(calls).toHaveLength(1); // 只有 save，没有 delete
  });

  it('warm 忽略畸形回包行（坏 sessionId / 坏 checkpoint 不进镜像）', async () => {
    const { invoker } = makeFakeInvoker(() => [
      { sessionId: 'sub_p_tool_1', checkpoint: makeCheckpoint(1) },
      { sessionId: '', checkpoint: makeCheckpoint(2) },
      { sessionId: 'sub_p_tool_2', checkpoint: null as unknown as Checkpoint },
      null,
    ] as unknown as Array<{ sessionId: string; checkpoint: Checkpoint }>);
    const store = new TauriCheckpointStore(invoker);
    await store.warm('p');
    expect(store.loadSession('sub_p_tool_1')).not.toBeNull();
    expect(store.loadSession('sub_p_tool_2')).toBeNull();
  });
});
