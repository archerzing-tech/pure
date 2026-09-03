import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { GlobalRegistrator } from '@happy-dom/global-registrator';
import { SessionChatManager } from '../chat';

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
});
