// E6（第 3 期最小核心）— 待办队列账随快照走的 UI 半边：loadFromStorage 收账
// → 派发等下一个自然收尾点。呈现层契约（2026-10-28）：队列卡退役——对话流
// 不再有机制卡可重建，restoreQueueAffordance 整链删除；这里改锁账本半边
// （hasPendingCloseWork 的队列/押账两笔），跨会话串账回归仍在锁死。
import { beforeAll, beforeEach, describe, expect, it, afterAll } from 'bun:test';
import { GlobalRegistrator } from '@happy-dom/global-registrator';
import { ChatController } from '../chat';
import type { QueuedTask } from '../../coding-agent/roundClosePlane';
import type { SessionSnapshotV2 } from '../store';

beforeAll(() => {
  GlobalRegistrator.register();
});

beforeEach(() => {
  document.body.innerHTML = '<main id="chat"></main>';
});

afterAll(() => {
  GlobalRegistrator.unregister();
});

const queued = (text: string): QueuedTask => ({ text, images: [], displayText: text, ts: 1 });

function snapshotWith(uiState: SessionSnapshotV2['uiState']): SessionSnapshotV2 {
  return {
    version: 3,
    modelContext: { messages: [{ role: 'user', content: '跑一半的任务' }] },
    events: [{ id: 'user-1', type: 'user', content: '跑一半的任务' }],
    transcript: [],
    uiState,
  };
}

describe('pending queue restoration (E6)', () => {
  it('restores the queue ledger after replay when the snapshot carries a pending queue', () => {
    const chat = new ChatController();
    chat.loadFromStorage(snapshotWith({
      pendingQueue: { queue: [queued('补一个知乎'), queued('再查一遍数据')], heldInsert: null },
    }));
    // 账在（收尾派发会消费）；对话流里无卡无队列旁白（呈现层契约）。
    expect(chat.hasPendingCloseWork()).toBe(true);
    expect(document.querySelector('.queue-card')).toBeNull();
    expect(document.getElementById('chat')?.textContent ?? '').not.toContain('待办队列');
  });

  it('restores nothing pending for a snapshot without a queue', () => {
    const chat = new ChatController();
    chat.loadFromStorage(snapshotWith({}));
    expect(chat.hasPendingCloseWork()).toBe(false);
    expect(document.querySelector('.queue-card')).toBeNull();
  });

  it('a held-insert-only snapshot restores as pending work (押账也是账)', () => {
    const chat = new ChatController();
    chat.loadFromStorage(snapshotWith({
      pendingQueue: { queue: [], heldInsert: queued('方向变了') },
    }));
    expect(chat.hasPendingCloseWork()).toBe(true);
    expect(document.querySelector('.queue-card')).toBeNull();
  });

  it('switching to a snapshot without a queue drops the old ledger (不跨会话串账)', () => {
    const chat = new ChatController();
    chat.loadFromStorage(snapshotWith({
      pendingQueue: { queue: [queued('上一会话排队的活')], heldInsert: null },
    }));
    expect(chat.hasPendingCloseWork()).toBe(true);
    // 切到不带队列的会话：旧账已随上一会话落盘，这里弃掉。
    chat.loadFromStorage(snapshotWith({}));
    expect(chat.hasPendingCloseWork()).toBe(false);
    // 新会话自己的账独立装回。
    chat.loadFromStorage(snapshotWith({
      pendingQueue: { queue: [queued('新会话自己的活')], heldInsert: null },
    }));
    expect(chat.hasPendingCloseWork()).toBe(true);
    expect(document.querySelector('.queue-card')).toBeNull();
  });
});
