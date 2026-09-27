// src/ui/__tests__/sessionSidebar.test.ts
// 侧栏会话卡片的纯函数测试：短 id 指纹的确定性、批内唯一性与格式；
// 外加 load() 的进入契约（2026-09-26 用户反馈：点 "New chat" 卡切不进去）
// 与列表形态（2026-09-27 用户定调：会话就是会话，不按工作区分组）。

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { GlobalRegistrator } from '@happy-dom/global-registrator';
import { assignShortIds, SessionSidebar } from '../sessionSidebar';
import type { SessionSidebarDeps } from '../sessionSidebar';

describe('SessionSidebar short id assignment', () => {
  it('每个可见卡片拿到确定的 6 位 base36 短 id', () => {
    const ids = ['session_1758472910342_1', 'session_1758472919999_2', 'session_1758472925000_3'];
    const first = assignShortIds(ids);
    const again = assignShortIds(ids);
    // 渲染顺序无关的确定性：同一批 id 两次指派结果一致。
    expect([...first.entries()]).toEqual([...again.entries()]);
    for (const s of first.values()) {
      expect(s).toMatch(/^[0-9a-z]{6}$/);
    }
  });

  it('批内唯一：同一批可见卡片绝不出现重复短 id', () => {
    // 结构相近的 id（同毫秒不同序号）是最容易碰撞的形状。
    const ids = Array.from({ length: 30 }, (_, i) => `session_1758472910342_${i}`);
    const map = assignShortIds(ids);
    const shorts = [...map.values()];
    expect(new Set(shorts).size).toBe(shorts.length);
  });

  it('不同批次互不影响：单独指派与批量指派结果一致（顺序无关）', () => {
    const ids = ['session_111_1', 'session_222_2'];
    const batch = assignShortIds(ids);
    const solo = assignShortIds([ids[1]]);
    expect(solo.get(ids[1])).toBe(batch.get(ids[1]));
  });
});

// makeSidebar 供本文件两个 describe 共用：load() 进入契约 + 列表形态。
interface FakeChatState {
  opened: string[];
  live: Set<string>;
  messagesOf: (id: string) => unknown[];
  streamingOf: (id: string) => boolean;
}

function makeSidebar(overrides: {
  disk?: (id: string) => unknown;
  chat?: Partial<SessionSidebarDeps['chat']>;
} = {}): { sidebar: SessionSidebar; state: FakeChatState; events: string[]; refreshes: number[] } {
  const state: FakeChatState = {
    opened: [],
    live: new Set<string>(),
    messagesOf: () => [],
    streamingOf: () => false,
  };
  const events: string[] = [];
  const refreshes: number[] = [];
  const chat: SessionSidebarDeps['chat'] = {
    clear: () => {},
    setWorkspace: () => {},
    syncEffectiveWorkspace: async () => {},
    openSession: (sessionId: string) => {
      state.opened.push(sessionId);
      return {
        controller: {
          getMessages: () => state.messagesOf(sessionId),
          isStreaming: () => state.streamingOf(sessionId),
        } as never,
        host: document.createElement('div'),
        warm: state.live.has(sessionId),
      };
    },
    forgetSession: () => {},
    clearAll: () => {},
    getRunningLiveSessions: () => [],
    hasOpenSession: (sessionId: string) => state.live.has(sessionId),
    ...overrides.chat,
  };
  const sidebar = new SessionSidebar({
    chat,
    pasteChips: { clear: () => events.push('chips') },
    confirm: async () => true,
    loadSession: async (id) => (overrides.disk ? (overrides.disk(id) as never) : null),
    renderMessages: async () => { events.push('rendered'); },
    focusPrompt: () => events.push('focusPrompt'),
    showSessionLoading: () => {},
    onSessionActivated: () => events.push('activated'),
    onChatCleared: () => events.push('landing'),
  });
  sidebar.refresh = () => refreshes.push(1);
  return { sidebar, state, events, refreshes };
}

describe('SessionSidebar load() 进入契约', () => {
  beforeAll(() => {
    GlobalRegistrator.register();
  });

  afterAll(() => {
    GlobalRegistrator.unregister();
  });

  beforeEach(() => {
    document.body.innerHTML = '<div id="sidebar-session-list"></div>';
  });

  it('空内容磁盘卡（"New chat"）：点击必须切进去，落点是 landing（2026-09-26 用户反馈）', async () => {
    const { sidebar, state, events } = makeSidebar({
      disk: (id) => id === 'session_empty_1'
        ? { snapshot: { modelContext: { messages: [] } }, workspace: '/ws/x', updatedAt: 1, messageCount: 0, sessionId: id }
        : null,
    });

    await sidebar.load('session_empty_1');

    expect(state.opened).toEqual(['session_empty_1']);
    // 空白会话的自然视图就是 landing，焦点随之落进 landing 输入框——
    // 而不是毫无可见变化的静默 return。
    expect(events).toContain('landing');
    expect(events).toContain('activated');
    expect(events).not.toContain('focusPrompt');
  });

  it('live 空白卡（磁盘没有、本实例持有）：切进去同样呈现 landing；首跑在途的 live 卡保留转写', async () => {
    const first = makeSidebar({ chat: { hasOpenSession: (id) => id === 'session_live_blank' } });
    first.state.live.add('session_live_blank');
    await first.sidebar.load('session_live_blank');
    expect(first.state.opened).toEqual(['session_live_blank']);
    expect(first.events).toContain('landing');

    // 正在跑第一回合的 live 会话没有磁盘快照但有内容——必须留在转写视图，
    // 绝不能被 landing 盖掉。
    const second = makeSidebar({ chat: { hasOpenSession: (id) => id === 'session_live_running' } });
    second.state.live.add('session_live_running');
    second.state.messagesOf = (id) => (id === 'session_live_running' ? [{ role: 'user', content: '调研三家公司' }] : []);
    await second.sidebar.load('session_live_running');
    expect(second.state.opened).toEqual(['session_live_running']);
    expect(second.events).toContain('focusPrompt');
    expect(second.events).not.toContain('landing');
  });

  it('预检窗口切回（无消息但在跑）：留在转写视图，绝不能被 landing 盖掉（2026-09-26 用户反馈）', async () => {
    // send() 里用户消息要等引擎交接才进 modelContext——路由/预检的几秒里
    // getMessages() 为空但回合已在跑。这时切走再切回，空白判定必须看
    // isStreaming()，否则转写被 landing 顶掉。
    const { sidebar, state, events } = makeSidebar({
      chat: { hasOpenSession: (id) => id === 'session_preflight' },
    });
    state.live.add('session_preflight');
    state.streamingOf = (id) => id === 'session_preflight';

    await sidebar.load('session_preflight');

    expect(state.opened).toEqual(['session_preflight']);
    expect(events).toContain('focusPrompt');
    expect(events).not.toContain('landing');
  });

  it('死卡（磁盘无、live 无）：点击触发列表刷新，把死条目清掉而不是永久无响应', async () => {
    const { sidebar, state, refreshes } = makeSidebar();

    await sidebar.load('session_ghost_1');

    expect(state.opened).toEqual([]);
    expect(refreshes).toHaveLength(1);
  });

  it('有内容的磁盘卡照旧冷恢复：渲染转写 + composer 焦点，不进 landing', async () => {
    const { sidebar, events } = makeSidebar({
      disk: (id) => id === 'session_real_1'
        ? {
            snapshot: { modelContext: { messages: [{ role: 'user', content: '帮我查机票' }] } },
            workspace: '/ws/real', updatedAt: 1, messageCount: 1, sessionId: id,
          }
        : null,
    });

    await sidebar.load('session_real_1');

    expect(events).toContain('rendered');
    expect(events).toContain('activated');
    expect(events).toContain('focusPrompt');
    expect(events).not.toContain('landing');
  });
});

// 列表形态（2026-09-27 用户定调）：「会话就是会话，跟放在哪个工作空间无关」
// ——列表一律按最近更新时间平铺，不再按工作区分组建组头、不再可折叠。
describe('SessionSidebar 列表不按工作区分组', () => {
  // happy-dom 全局注册是进程级单例：本 describe 自己注册就必须自己注销，
  // 否则注册被本文件攥着，后面的测试文件 register 时直接炸
  // （「already globally registered」）。前一个 describe 注销过，这里重新注册。
  let registeredHere = false;
  beforeAll(() => {
    if (!(globalThis as any).document?.body) {
      GlobalRegistrator.register();
      registeredHere = true;
    }
  });

  afterAll(() => {
    if (registeredHere) {
      GlobalRegistrator.unregister();
      registeredHere = false;
    }
  });

  const meta = (id: string, title: string, updatedAt: number, workspace?: string) => ({
    id, title, createdAt: updatedAt - 1000, updatedAt, messageCount: 3,
    ...(workspace ? { workspace } : {}),
  });

  it('不同工作区的会话按最近更新平铺：新会话在上，没有组头没有折叠', async () => {
    localStorage.setItem('pure_sessions', JSON.stringify([
      meta('session_1000_1', '旧会话·工作区A', 1000, '/ws/a'),
      meta('session_2000_1', '新会话·无工作区', 2000),
      meta('session_3000_1', '最新会话·工作区B', 3000, '/ws/b'),
      meta('session_2500_1', '次新会话·工作区A', 2500, '/ws/a'),
    ]));

    const { sidebar } = makeSidebar();
    document.body.innerHTML = '<div id="sidebar-session-list"></div>';
    await (sidebar as unknown as { renderList(): Promise<void> }).renderList();

    const container = document.getElementById('sidebar-session-list')!;
    // 没有组头、没有折叠容器：会话卡片是列表的直接子元素。
    expect(container.querySelectorAll('.sidebar-session-group').length).toBe(0);
    expect(container.querySelectorAll('.sidebar-session-group-label').length).toBe(0);
    // 四张卡片全部在场，顺序 = updatedAt 降序——跨工作区交错，不被分组重排。
    const sids = [...container.querySelectorAll('.sidebar-session-item')]
      .map((el) => el.getAttribute('data-sid'));
    expect(sids).toEqual(['session_3000_1', 'session_2500_1', 'session_2000_1', 'session_1000_1']);
  });

  it('卡片信息一个不少：id 章、删除按钮照旧（平铺不砍功能）', async () => {
    localStorage.setItem('pure_sessions', JSON.stringify([
      meta('session_1000_1', '某个会话', 1000, '/ws/a'),
    ]));

    const { sidebar } = makeSidebar();
    document.body.innerHTML = '<div id="sidebar-session-list"></div>';
    await (sidebar as unknown as { renderList(): Promise<void> }).renderList();

    const container = document.getElementById('sidebar-session-list')!;
    expect(container.querySelectorAll('.sidebar-session-item').length).toBe(1);
    expect(container.querySelector('.sidebar-session-item-id')).toBeTruthy();
    expect(container.querySelector('.sidebar-session-delete')).toBeTruthy();
    expect(container.querySelector('.sidebar-session-item-time')).toBeTruthy();
  });
});
