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
    // Same title rule persistence will apply, so the live sidebar entry the
    // user sees now matches the disk row that replaces it later.
    expect(running[0].title).toBe('用canvas画一只会飞的小鸟');

    (flight.controller as any).setStreaming(false);
    expect(manager.getRunningLiveSessions()).toHaveLength(0);
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
