import { beforeAll, beforeEach, describe, expect, it, afterAll } from 'bun:test';
import { GlobalRegistrator } from '@happy-dom/global-registrator';
import { ChatController } from '../chat';
import type { SessionSnapshotV2 } from '../store';

beforeAll(() => {
  GlobalRegistrator.register();
});

beforeEach(() => {
  // transcriptElement() 的兜底宿主——showPausedResumeBar 把「继续」条铺在这里。
  document.body.innerHTML = '<main id="chat"></main>';
});

afterAll(() => {
  GlobalRegistrator.unregister();
});

function snapshotWith(uiState: SessionSnapshotV2['uiState']): SessionSnapshotV2 {
  return {
    version: 3,
    modelContext: { messages: [{ role: 'user', content: '跑一半的任务' }] },
    events: [{ id: 'user-1', type: 'user', content: '跑一半的任务' }],
    transcript: [],
    uiState,
  };
}

describe('paused resume bar restoration (第 3 期刀 2)', () => {
  it('rebuilds the paused resume bar after replay when the snapshot ended paused', () => {
    const chat = new ChatController();
    chat.loadFromStorage(snapshotWith({ paused: true }));
    chat.restorePausedAffordance();

    const bar = document.querySelector('.paused-resume-bar');
    expect(bar).not.toBeNull();
    expect(bar?.getAttribute('data-state')).toBe('paused');
    expect(bar?.querySelector('.paused-resume-btn')).not.toBeNull();
  });

  it('shows nothing for a snapshot that did not end paused', () => {
    const chat = new ChatController();
    chat.loadFromStorage(snapshotWith({}));
    chat.restorePausedAffordance();
    expect(document.querySelector('.paused-resume-bar')).toBeNull();
  });

  it('switching to a non-paused snapshot clears the flag so a later restore stays silent', () => {
    const chat = new ChatController();
    chat.loadFromStorage(snapshotWith({ paused: true }));
    // 切到另一个不带暂停标记的会话：标记清零，后续 restore 不得凭旧状态建条。
    chat.loadFromStorage(snapshotWith({}));
    chat.restorePausedAffordance();
    expect(document.querySelector('.paused-resume-bar')).toBeNull();
  });
});
