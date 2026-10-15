// E6（第 3 期最小核心）— 待办队列账随快照走的 UI 半边：loadFromStorage 收账
// → 回放铺完 restoreQueueAffordance 重建队列卡；派发不在这里发生（无 send、
// 无 timer武装）。切换会话 = 旧账弃、新账收、旧卡引用作废（跨会话串账与
// 脱管节点渲染两个回归都在这里锁死）。
import { beforeAll, beforeEach, describe, expect, it, afterAll } from 'bun:test';
import { GlobalRegistrator } from '@happy-dom/global-registrator';
import { ChatController } from '../chat';
import type { QueuedTask } from '../../coding-agent/roundClosePlane';
import type { SessionSnapshotV2 } from '../store';

beforeAll(() => {
  GlobalRegistrator.register();
});

beforeEach(() => {
  // transcriptElement() 的兜底宿主——队列卡与「继续」条都铺在这里。
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
  it('rebuilds the queue card after replay when the snapshot carries a pending queue', () => {
    const chat = new ChatController();
    chat.loadFromStorage(snapshotWith({
      pendingQueue: { queue: [queued('补一个知乎'), queued('再查一遍数据')], heldInsert: null },
    }));
    chat.restoreQueueAffordance();

    const card = document.querySelector('.queue-card');
    expect(card).not.toBeNull();
    expect(card?.querySelector('.queue-card-title')?.textContent).toContain('待办队列（2 件）');
    const items = card?.querySelectorAll('.queue-card-items li');
    expect(items).toHaveLength(2);
    expect(items?.[0].textContent).toBe('补一个知乎');
    expect(items?.[1].textContent).toBe('再查一遍数据');
  });

  it('renders nothing for a snapshot without a pending queue', () => {
    const chat = new ChatController();
    chat.loadFromStorage(snapshotWith({}));
    chat.restoreQueueAffordance();
    expect(document.querySelector('.queue-card')).toBeNull();
  });

  it('a held-insert-only snapshot restores without a card (押账无需卡)', () => {
    const chat = new ChatController();
    chat.loadFromStorage(snapshotWith({
      pendingQueue: { queue: [], heldInsert: queued('方向变了') },
    }));
    chat.restoreQueueAffordance();
    expect(document.querySelector('.queue-card')).toBeNull();
  });

  it('switching to a snapshot without a queue drops the old ledger and card (不跨会话串账)', () => {
    const chat = new ChatController();
    chat.loadFromStorage(snapshotWith({
      pendingQueue: { queue: [queued('上一会话排队的活')], heldInsert: null },
    }));
    chat.restoreQueueAffordance();
    expect(document.querySelector('.queue-card')).not.toBeNull();
    // 切到不带队列的会话：旧账已随上一会话落盘，这里弃掉；旧卡引用作废。
    chat.loadFromStorage(snapshotWith({}));
    chat.restoreQueueAffordance();
    expect(document.querySelector('.queue-card')).toBeNull();
    // 新会话里再入队（经公开面无法直达私有账，但收尾派发读同一账本——这里
    // 至少锁 DOM 面：重建的卡不落在已脱管的旧节点上）。
    chat.loadFromStorage(snapshotWith({
      pendingQueue: { queue: [queued('新会话自己的活')], heldInsert: null },
    }));
    chat.restoreQueueAffordance();
    const card = document.querySelector('.queue-card');
    expect(card?.textContent).toContain('新会话自己的活');
    expect(card?.closest('main')).not.toBeNull(); // 活卡活在当前转写宿主里
  });
});
