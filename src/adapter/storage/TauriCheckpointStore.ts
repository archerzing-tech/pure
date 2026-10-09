// src/adapter/storage/TauriCheckpointStore.ts
// 第 3 期持久性（2026-10-09）：GUI 的持久 IStateStore。子代理 checkpoint
// 原先住 MemoryStateStore（进程内 Map，重启即丢——判例 5 的「跑一半→暂停
// →重开→续」中间任何一步重启断点就没了）；现在落盘 ~/.pure/checkpoints/
// （Rust 三命令，目录布局与 CLI 的 FSStore 同构），WebView 没有 node:fs，
// 盘 IO 只能走 Tauri 命令（src-tauri lib.rs save/load/delete_session_checkpoints）。
//
// 结的扣：IStateStore.loadSession 是同步签名，invoke 是异步的。解法是
// openSession 预热——一次把本会话名下（本名 + sub_ 前缀支）的断点拉进内
// 存镜像，同步读全走镜像；没预热到的键诚实 miss（续跑收执明说「没找到存
// 档」）。写路径双发：镜像同步更新（本回合内的续跑预检立即命中），盘上
// await（编排器 persist-before-settle 在等这个 Promise，落盘完成才结算）。
// 非 Tauri 环境（纯浏览器 dev / 单测）invoker 为 null：镜像照常工作，只是
// 没有盘上那份——单测正好踩这一点当假件用。

import {
  type AgentLoopState,
  type Checkpoint,
  type IStateStore,
} from '../../shared/types';
import { isTauriRuntime, tauriInvoke } from '../../shared/tauri';

/** Rust 命令的单点调用（测试注入假件用）。返回 unknown，调用处自行收窄。 */
export type CheckpointInvoker = (cmd: string, args?: Record<string, unknown>) => Promise<unknown>;

/** Rust 侧 load_session_checkpoints 的行形状。 */
interface CheckpointFileRecord {
  sessionId: string;
  checkpoint: Checkpoint;
}

const tauriInvoker: CheckpointInvoker | null = isTauriRuntime() ? tauriInvoke : null;

export class TauriCheckpointStore implements IStateStore {
  /** 支 sessionId → 断点数组（version 升序，排尾最新）。 */
  private mirror = new Map<string, Checkpoint[]>();

  constructor(private readonly invoker: CheckpointInvoker | null = tauriInvoker) {}

  /** openSession 预热：把父会话名下的全部断点一次拉进镜像。失败不炸——
   *  镜像留空就是诚实 miss，续跑路径明说「没找到存档」。 */
  async warm(parentSessionId: string): Promise<void> {
    if (!this.invoker || !parentSessionId) return;
    try {
      const entries = (await this.invoker('load_session_checkpoints', { parentSessionId })) as CheckpointFileRecord[] | null;
      for (const entry of entries ?? []) {
        if (entry && typeof entry.sessionId === 'string' && entry.checkpoint && typeof entry.checkpoint === 'object') {
          this.append(entry.sessionId, entry.checkpoint);
        }
      }
    } catch (error) {
      console.warn('[checkpointStore] 预热失败（断点将按 miss 处理）:', error);
    }
  }

  loadSession(sessionId: string): { state: AgentLoopState; checkpoints: Checkpoint[] } | null {
    const list = this.mirror.get(sessionId);
    if (!list || list.length === 0) return null;
    const latest = list[list.length - 1]!;
    return { state: latest.state, checkpoints: [...list] };
  }

  async saveCheckpoint(sessionId: string, checkpoint: Checkpoint): Promise<void> {
    this.append(sessionId, checkpoint);
    if (!this.invoker) return;
    await this.invoker('save_checkpoint', { sessionId, checkpoint });
  }

  async deleteSession(sessionId: string): Promise<void> {
    this.mirror.delete(sessionId);
    if (!this.invoker) return;
    await this.invoker('delete_session_checkpoints', { sessionId });
  }

  /** 会话切换时丢镜像（盘上那份不动——换会话不是删会话）。 */
  clear(): void {
    this.mirror.clear();
  }

  /** 同键同 version 覆写（FSStore 的 v%03d.json 语义），异 version 排序追加。 */
  private append(sessionId: string, checkpoint: Checkpoint): void {
    const list = this.mirror.get(sessionId) ?? [];
    const at = list.findIndex((c) => c.version === checkpoint.version);
    if (at >= 0) list[at] = checkpoint;
    else list.push(checkpoint);
    list.sort((a, b) => (a.version - b.version) || (a.createdAt - b.createdAt));
    this.mirror.set(sessionId, list);
  }
}
