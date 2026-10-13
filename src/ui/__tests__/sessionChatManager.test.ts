import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { GlobalRegistrator } from '@happy-dom/global-registrator';
import { SessionChatManager } from '../chat';
import { resolvePathForOpen } from '../pathLink';

beforeAll(() => {
  GlobalRegistrator.register();
});

afterAll(() => {
  GlobalRegistrator.unregister();
});

beforeEach(() => {
  document.body.innerHTML = '<main id="chat"></main><div id="agent-activity-host"></div>';
});

function stubCancel(controller: { cancel: () => void }): { count(): number } {
  let cancelled = 0;
  const original = controller.cancel.bind(controller);
  controller.cancel = () => {
    cancelled += 1;
    original();
  };
  return { count: () => cancelled };
}

describe('session chat manager (multi-session background execution)', () => {
  it('opens a session and re-opens it warm without cancelling its controller', () => {
    const manager = new SessionChatManager();
    const first = manager.openSession('session-flight');

    expect(manager.getSessionId()).toBe('session-flight');
    expect(first.warm).toBe(false);
    expect(first.host.parentElement?.id).toBe('chat');
    expect(first.host.hidden).toBe(false);

    // The user starts the weather conversation while the flight session still
    // runs — switching NEVER cancels the flight controller.
    const cancelled = stubCancel(first.controller);

    const weather = manager.openSession('session-weather');
    expect(weather.warm).toBe(false);
    expect(first.host.hidden).toBe(true);
    expect(weather.host.hidden).toBe(false);
    expect(cancelled.count()).toBe(0);

    // Switching BACK to the flight session reattaches the SAME live
    // controller — nothing was interrupted, nothing was rebuilt from disk.
    const back = manager.openSession('session-flight');
    expect(back.warm).toBe(true);
    expect(back.controller).toBe(first.controller);
    expect(back.host).toBe(first.host);
    expect(first.host.hidden).toBe(false);
    expect(weather.host.hidden).toBe(true);
    expect(cancelled.count()).toBe(0);
  });

  it('renders each session into its own transcript host and only shows the active one', () => {
    const manager = new SessionChatManager();
    manager.openSession('s-a');
    manager.openSession('s-b');

    const hosts = document.querySelectorAll<HTMLElement>('#chat > .session-transcript');
    expect(hosts).toHaveLength(2);
    expect([...hosts].filter((host) => host.hidden).length).toBe(1);

    manager.openSession('s-a');
    const after = document.querySelectorAll<HTMLElement>('#chat > .session-transcript');
    expect(after[0]?.hidden).toBe(false);
    expect(after[1]?.hidden).toBe(true);
  });

  it('a hidden session keeps tracking activities without touching the shared rail', () => {
    const manager = new SessionChatManager();
    const flight = manager.openSession('session-flight');
    manager.openSession('session-weather');

    const railHost = document.getElementById('agent-activity-host')!;
    expect(railHost.hidden).toBe(true);

    // The hidden flight session reports a subagent starting: it must NOT
    // mount its panel on the shared rail while another session is visible.
    const flightCtl = flight.controller as any;
    flightCtl.agentActivities = [];
    flightCtl.scheduleAgentActivityPersistence = () => {};
    flightCtl.updateAgentActivity({
      callId: 'call-1',
      agentName: 'researcher',
      agentRole: '负责查机票',
      status: 'running',
      state: 'THINK',
      sequence: 1,
    });
    expect(railHost.querySelector('[data-agent-activity-rail="true"]')).toBeNull();
    expect(railHost.hidden).toBe(true);

    // Its activity list IS still tracked in memory so a return can show it.
    expect(flightCtl.agentActivities).toHaveLength(1);
    expect(flightCtl.agentActivities[0].callId).toBe('call-1');
  });

  it('new chat discards only the visible session and keeps hidden ones alive', () => {
    const manager = new SessionChatManager();
    const flight = manager.openSession('session-flight');
    const weather = manager.openSession('session-weather');

    const cancelled = stubCancel(weather.controller);

    manager.clear();

    expect(cancelled.count()).toBe(1); // explicit new chat stops the visible session
    expect(manager.getSessionId()).not.toBe('session-weather');
    // Hidden flight session is untouched and can still be returned to.
    expect(manager.openSession('session-flight').controller).toBe(flight.controller);
    expect(manager.hasOpenSession('session-weather')).toBe(false);
  });

  it('new chat parks a still-streaming visible session in the background instead of cancelling it', () => {
    const manager = new SessionChatManager();
    const flight = manager.openSession('session-flight');
    // Mid-run: the flight session is streaming when the user hits 新建对话.
    (flight.controller as any).setStreaming(true);
    const cancelled = stubCancel(flight.controller);

    manager.clear({ keepRunningSession: true });

    // The run is NOT interrupted; the fresh chat becomes active instead.
    expect(cancelled.count()).toBe(0);
    expect(manager.getSessionId()).not.toBe('session-flight');
    expect(manager.hasOpenSession('session-flight')).toBe(true);
    // Parked in the background: host still in the DOM, just hidden.
    expect(flight.host.hidden).toBe(true);
    // Switching back reattaches the SAME live controller, still mid-run.
    const back = manager.openSession('session-flight');
    expect(back.warm).toBe(true);
    expect(back.controller).toBe(flight.controller);
    expect(back.controller.isStreaming()).toBe(true);
  });

  it('new chat on an idle visible session still discards it (no controller buildup)', () => {
    const manager = new SessionChatManager();
    const idle = manager.openSession('session-idle');
    const cancelled = stubCancel(idle.controller);

    manager.clear({ keepRunningSession: true });

    expect(cancelled.count()).toBe(1);
    expect(manager.hasOpenSession('session-idle')).toBe(false);
  });

  it('forgetting a session cancels its run and removes its host', () => {
    const manager = new SessionChatManager();
    const entry = manager.openSession('session-ghost');

    const cancelled = stubCancel(entry.controller);
    manager.forgetSession('session-ghost');

    expect(cancelled.count()).toBe(1);
    expect(manager.hasOpenSession('session-ghost')).toBe(false);
    expect(document.querySelectorAll('#chat > .session-transcript')).toHaveLength(0);
  });

  it('warm re-open of a RUNNING session preserves its in-memory transcript state', () => {
    const manager = new SessionChatManager();
    const flight = manager.openSession('session-flight');
    const ctl = flight.controller as any;
    ctl.messages = [
      { role: 'user', content: '帮我查一下去东京的机票' },
      { role: 'assistant', content: '正在查询…' },
    ];
    manager.openSession('session-weather');

    const back = manager.openSession('session-flight');
    expect(back.warm).toBe(true);
    // The same controller object holds the live messages — nothing was
    // reloaded from disk over them.
    expect((back.controller as any).messages).toBe(ctl.messages);
    expect((back.controller as any).messages).toHaveLength(2);
  });

  it('getRunningLiveSessions lists only streaming sessions with their live title', () => {
    const manager = new SessionChatManager();
    const flight = manager.openSession('session-flight');
    (flight.controller as any).messages = [
      { role: 'user', content: '用canvas画一只会飞的小鸟' },
    ];
    (flight.controller as any).setStreaming(true);
    manager.openSession('session-weather'); // idle — must NOT be listed

    const running = manager.getRunningLiveSessions();
    expect(running).toHaveLength(1);
    expect(running[0].id).toBe('session-flight');
    // Same title rule persistence will apply (first 6 chars + ellipsis,
    // 2026-09-26 用户定调), so the live sidebar entry the user sees now
    // matches the disk row that replaces it later.
    expect(running[0].title).toBe('用canva…');

    (flight.controller as any).setStreaming(false);
    expect(manager.getRunningLiveSessions()).toHaveLength(0);
  });

  it('the visible session lighting up fires the active-session callback (sidebar highlight follows first send)', () => {
    // 2026-09-26 用户反馈：从 landing/新对话发出的第一回合不经过任何
    // makeActive，任务卡片冒进侧栏列表却没有选中态。锁死：可见会话开跑
    // 本身必须发 activeSession 回调，侧栏高亮随之点亮。
    const manager = new SessionChatManager();
    const seen: string[] = [];
    manager.onActiveSessionChanged((id) => seen.push(id));
    const a = manager.openSession('session-a'); // became current → callback
    expect(seen).toEqual(['session-a']);

    (a.controller as any).setStreaming(true);
    expect(seen).toEqual(['session-a', 'session-a']);
    // 停跑不发第二次（高亮已在其位，无需重复刷）。
    (a.controller as any).setStreaming(false);
    expect(seen).toHaveLength(2);
  });

  it('a background session starting to stream never steals the sidebar highlight', () => {
    const manager = new SessionChatManager();
    const seen: string[] = [];
    manager.onActiveSessionChanged((id) => seen.push(id));
    const a = manager.openSession('session-a');
    manager.openSession('session-b'); // now visible
    seen.length = 0;

    (a.controller as any).setStreaming(true); // background run
    expect(seen).toEqual([]); // visible session's highlight untouched
  });

  it('numbers same-name subagent delegations per task (ui_designer（1）（2）…)', () => {
    const manager = new SessionChatManager();
    const flight = manager.openSession('session-flight');
    const ctl = flight.controller as any;
    ctl.agentActivities = [];
    ctl.scheduleAgentActivityPersistence = () => {};

    // Four ui_designer delegations arrive as four distinct callIds.
    for (let i = 1; i <= 4; i++) {
      ctl.updateAgentActivity({
        callId: `call-ui-${i}`,
        agentName: 'ui_designer',
        agentRole: '负责界面设计',
        status: 'running',
        state: 'THINK',
        sequence: i,
      });
    }
    expect(ctl.agentActivities).toHaveLength(4);
    expect(ctl.agentActivities.map((a: any) => a.instanceNo)).toEqual([1, 2, 3, 4]);

    // Progress on the SAME call keeps its number instead of growing it.
    ctl.updateAgentActivity({
      callId: 'call-ui-2',
      agentName: 'ui_designer',
      status: 'running',
      state: 'ACT',
      sequence: 5,
    });
    const second = ctl.agentActivities.find((a: any) => a.callId === 'call-ui-2');
    expect(second.instanceNo).toBe(2);
    expect(ctl.agentActivities).toHaveLength(4);
  });

  it('switching back to a warm session re-syncs relative-path resolution to ITS workspace', () => {
    // Regression: warm switches bypass setWorkspace, so the module-level
    // resolver kept the PREVIOUS session's workspace and artifact cards opened
    // the wrong directory after returning to a background session.
    const manager = new SessionChatManager();
    const flight = manager.openSession('session-flight');
    flight.controller.setWorkspace('/ws/flight');
    const weather = manager.openSession('session-weather');
    weather.controller.setWorkspace('/ws/weather');
    expect(resolvePathForOpen('out.png')).toBe('/ws/weather/out.png');

    manager.openSession('session-flight'); // warm switch back
    expect(resolvePathForOpen('out.png')).toBe('/ws/flight/out.png');
  });
});

// 审计批 4①：暖控制器无界累积。openSession 永远保留、forgetSession 只在
// 侧栏删除时走——20 个来回就是几百 MB。冷会话回收在帽内挤出最老的闲会话；
// 流式中的、当前可见的、有队列活的（reapGuard 否决）一律不逐。
describe('session chat manager cold-session reap (审计批 4①)', () => {
  it('caps warm controllers at 6, evicting the oldest idle sessions first', () => {
    const manager = new SessionChatManager();
    for (let i = 1; i <= 8; i++) manager.openSession(`s-${i}`);

    expect(manager.hasOpenSession('s-1')).toBe(false); // 最老的先走
    expect(manager.hasOpenSession('s-2')).toBe(false);
    expect(manager.hasOpenSession('s-3')).toBe(true);
    expect(manager.hasOpenSession('s-8')).toBe(true); // 当前会话永远在
    expect(document.querySelectorAll('#chat > .session-transcript')).toHaveLength(6);

    // 被逐会话重开：新 controller 冷启动，不复活死对象。
    const reopened = manager.openSession('s-1');
    expect(reopened.warm).toBe(false);
    expect(reopened.controller).not.toBe(undefined);
  });

  it('parallel runs may exceed the cap and re-drain as each stops (the audit sweep)', () => {
    // 8 个并行跑：谁也不能逐，帽让位给运行中的会话。
    const manager = new SessionChatManager();
    const stopped: Array<{ stop: () => void }> = [];
    for (let i = 1; i <= 8; i++) {
      const entry = manager.openSession(`s-${i}`);
      (entry.controller as any).setStreaming(true);
      stopped.push({ stop: () => (entry.controller as any).setStreaming(false) });
    }
    for (let i = 1; i <= 8; i++) expect(manager.hasOpenSession(`s-${i}`)).toBe(true);

    // 审计点名的缺口：clear({keepRunningSession:true}) 停扫之后，流式→false
    // 的瞬间必须补收——每停一个收一个，回到帽内。
    stopped[0].stop();
    expect(manager.hasOpenSession('s-1')).toBe(false);
    expect(manager.hasOpenSession('s-2')).toBe(true);
    stopped[1].stop();
    expect(manager.hasOpenSession('s-2')).toBe(false);
    for (let i = 3; i <= 8; i++) expect(manager.hasOpenSession(`s-${i}`)).toBe(true);
  });

  it('onReapGuard vetoes eviction for a session with live queue work', () => {
    const manager = new SessionChatManager();
    manager.onReapGuard((id) => id === 's-1'); // 该会话队列还有 pending/running
    for (let i = 1; i <= 8; i++) manager.openSession(`s-${i}`);

    expect(manager.hasOpenSession('s-1')).toBe(true); // 有活：逐了就搁浅
    expect(manager.hasOpenSession('s-2')).toBe(false); // 没活：照挤
    expect(manager.hasOpenSession('s-3')).toBe(false);
  });

  it('a hidden streaming session is never evicted while it runs', () => {
    const manager = new SessionChatManager();
    const flight = manager.openSession('s-1');
    (flight.controller as any).setStreaming(true);
    for (let i = 2; i <= 8; i++) manager.openSession(`s-${i}`);

    expect(manager.hasOpenSession('s-1')).toBe(true);
    expect(flight.controller.isStreaming()).toBe(true);
    expect(flight.host.isConnected).toBe(true);
    // 被挤掉的是它后面的冷会话。
    expect(manager.hasOpenSession('s-2')).toBe(false);
    expect(manager.hasOpenSession('s-3')).toBe(false);
  });
});

// 评审批 4 P1：收尾派发账（RoundClosePlane 待办/押账）不在 reapGuard 的
// 感知里——逐出一个还有收尾活的会话，40ms 后 dispatch 照跑在被逐
// controller 上，LLM/工具/写盘全在脱离 DOM 的宿主里进行（僵尸回合），
// 插话「被记得执行而非忘掉」的主轴被打破。收尾活必须与队列活一样否决。
describe('session chat manager reap vetoes (评审 P1/P2)', () => {
  it('a session with queued close work is never reaped', () => {
    const manager = new SessionChatManager();
    const first = manager.openSession('s-1');
    (first.controller as any).roundClose.queueTask({ text: '稍后办', images: [], displayText: '稍后办', ts: Date.now() });
    const second = manager.openSession('s-2');
    (second.controller as any).roundClose.holdInsert({ text: '押着的', images: [], displayText: '押着的', ts: Date.now() });
    for (let i = 3; i <= 8; i++) manager.openSession(`s-${i}`);

    expect(manager.hasOpenSession('s-1')).toBe(true); // 有待办：逐了就是僵尸回合
    expect(manager.hasOpenSession('s-2')).toBe(true); // 押着插话同理
    expect(manager.hasOpenSession('s-3')).toBe(false); // 没活的照挤
    expect(manager.hasOpenSession('s-4')).toBe(false);
    expect(manager.hasOpenSession('s-8')).toBe(true);
  });

  it('a session mid-persist is not reaped; the persist-settled beat re-drains', async () => {
    const manager = new SessionChatManager();
    const first = manager.openSession('s-1');
    const ctl = first.controller as any;
    // 真实装置：替换私有 doPersistSession 押住写盘，走公开 persistSession
    // 包装（深度计数 + 落定回调都在里面）。
    let releasePersist!: () => void;
    const gate = new Promise<void>((resolve) => { releasePersist = resolve; });
    ctl.doPersistSession = () => gate;
    void ctl.persistSession([], new Map(), []);
    await Promise.resolve(); // 让包装进入在飞态

    // s-2..s-7 也在写盘（直接置深度；包装装置已由 s-1 端到端验证）。
    const parked: any[] = [];
    for (let i = 2; i <= 7; i++) {
      const entry = manager.openSession(`s-${i}`);
      (entry.controller as any).persistDepth = 1;
      parked.push(entry.controller);
    }
    manager.openSession('s-8'); // 当前可见
    // 在册 8 > 帽 6：7 个在写盘全被否决，谁也动不了——超帽在飞是合法态。
    for (let i = 1; i <= 8; i++) expect(manager.hasOpenSession(`s-${i}`)).toBe(true);

    // s-1 落盘落定：这一拍补收把它逐出（最旧且不再在飞）。
    releasePersist();
    await gate;
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(manager.hasOpenSession('s-1')).toBe(false);
    expect(manager.hasOpenSession('s-2')).toBe(true); // 还在写的照样否决

    // 其余逐个落定：第一拍收走最旧的，其余落回帽内即停（回收只治超帽）。
    for (const c of parked) {
      c.persistDepth = 0;
      c.persistSettledCb?.();
    }
    expect(manager.hasOpenSession('s-2')).toBe(false);
    expect(manager.hasOpenSession('s-3')).toBe(true);
    for (let i = 4; i <= 8; i++) expect(manager.hasOpenSession(`s-${i}`)).toBe(true);
  });
});

describe('reap veto · dispatch 消费的同族账（评审 P1 续）', () => {
  it('a session with fold-in ledger or pending resumes is never reaped', () => {
    const manager = new SessionChatManager();
    const a = manager.openSession('s-1');
    (a.controller as any).folds.add('追加一件事', [], '追加一件事', true, false);
    const b = manager.openSession('s-2');
    (b.controller as any).delegationControl.queueResume({
      callId: 'call_a', name: 'researcher', args: '{}', label: 'researcher',
      text: '把竞品那支接着跑完', images: [], checkpoint: { hit: true, turns: 7 },
    });
    for (let i = 3; i <= 8; i++) manager.openSession(`s-${i}`);

    expect(manager.hasOpenSession('s-1')).toBe(true);  // 折入账：settle 残差会转排队重入
    expect(manager.hasOpenSession('s-2')).toBe(true);  // 续跑凭据：兜底会转排队重入
    expect(manager.hasOpenSession('s-3')).toBe(false);
    expect(manager.hasOpenSession('s-4')).toBe(false);
  });

  it('a session with a pending auto-continue chain is never reaped (终审遗留)', () => {
    const manager = new SessionChatManager();
    const a = manager.openSession('s-1');
    const ctl = a.controller as any;
    // 计划第 2/20 轮收尾，续跑定时器在飞（1.2s 回合间隙）——此刻超帽逐出，
    // forgetSession 的 cancel 掐断 token，计划半途静默停摆。链在飞必须否决。
    const scheduled = ctl.autoContinue.schedule(
      { planActive: true, cleanEnd: true, asksForInput: false, hasToolSuccess: true, currentPlan: 2, currentTodo: 3, planTerminal: false },
      20, 30_000, () => ctl.fireAutoContinue(),
    );
    expect(scheduled).toBe(true);
    for (let i = 2; i <= 8; i++) manager.openSession(`s-${i}`);

    expect(manager.hasOpenSession('s-1')).toBe(true);  // 链在飞：逐出 = 计划早停
    expect(manager.hasOpenSession('s-2')).toBe(false); // 没活的照挤
    // 清账（fire 后由 streaming 否决接棒；这里直接收尾）再逐——否决不永挂。
    ctl.autoContinue.cancel();
    manager.openSession('s-0');
    expect(manager.hasOpenSession('s-1')).toBe(false);
  });

  it('forgetSession still severs the chain via the token guard (评审批 4 实证钉住)', async () => {
    // 探针实证的防线：显式 forget（删会话）走 controller.cancel() →
    // autoContinue.cancel() 递增 token，定时器 fire 被 myToken !== token
    // 拦下——链死在明处且不产僵尸回合。钉住它，防止未来有人给
    // forgetSession 摘 cancel 时无声破坏这道防线。
    const manager = new SessionChatManager();
    const a = manager.openSession('s-1');
    const ctl = a.controller as any;
    let sent = 0;
    ctl.send = () => { sent += 1; };
    ctl.autoContinue.schedule(
      { planActive: true, cleanEnd: true, asksForInput: false, hasToolSuccess: true, currentPlan: 1, currentTodo: 1, planTerminal: false },
      20, 30, () => ctl.fireAutoContinue(),
    );
    manager.forgetSession('s-1');
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(sent).toBe(0);
  });
});
