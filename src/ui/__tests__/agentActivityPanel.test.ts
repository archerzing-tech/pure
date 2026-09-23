import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { GlobalRegistrator } from '@happy-dom/global-registrator';
import { ChatController } from '../chat';
import { createAgentActivityPanel, isAgentActivityActive, mergeAgentActivity } from '../agentActivityPanel';
import type { SessionAgentActivity, SessionSnapshotV2 } from '../store';

beforeAll(() => {
  GlobalRegistrator.register();
});

beforeEach(() => {
  document.body.innerHTML = '<div id="agent-activity-host"></div><main id="chat"></main>';
});

afterAll(() => {
  GlobalRegistrator.unregister();
});

function activity(overrides: Partial<SessionAgentActivity> = {}): SessionAgentActivity {
  return {
    callId: 'call-1',
    agentName: 'researcher',
    agentRole: '负责资料调研',
    status: 'running',
    state: 'THINK',
    inputSnippet: '查找相关资料',
    ...overrides,
  };
}

describe('agent activity panel', () => {
  it('shows multiple agents and updates their current status without removing completed rows', () => {
    const panel = createAgentActivityPanel();
    document.body.appendChild(panel.el);
    panel.update([
      activity(),
      activity({ callId: 'call-2', agentName: 'code_reviewer', state: 'ACT', inputSnippet: '检查实现' }),
    ]);

    expect(panel.el.querySelectorAll('.agent-worker')).toHaveLength(2);
    expect(panel.el.querySelectorAll('.agent-worker')).toHaveLength(2);
    // Cards are minimal: the Agent badge + machine id + start time only.
    expect(panel.el.textContent).toContain('Agent');

    panel.update([activity({ status: 'done', state: 'TERMINATE', output: '找到 8 个来源', durationMs: 4200 }), activity({ callId: 'call-2', state: 'VERIFY' })]);

    expect(panel.el.querySelectorAll('.agent-worker')).toHaveLength(2);
    expect(panel.el.querySelector('[data-call-id="call-1"]')?.className).toContain('agent-worker--done');
    // Terminal state is conveyed by the badge color (row state class), not text.
    expect(panel.el.querySelector('[data-call-id="call-1"]')?.querySelector('.agent-worker-badge')?.textContent).toBe('Agent');
  });

  it('counts only explicit non-terminal lifecycle states as active', () => {
    expect(isAgentActivityActive(activity({ lifecycle: 'tool_running' }))).toBe(true);
    expect(isAgentActivityActive(activity({ lifecycle: 'verifying' }))).toBe(true);
    expect(isAgentActivityActive(activity({ lifecycle: 'done', status: 'done' }))).toBe(false);
    expect(isAgentActivityActive(activity({ lifecycle: 'failed', status: 'failed' }))).toBe(false);
    expect(isAgentActivityActive(activity({ lifecycle: 'cancelled', status: 'cancelled' }))).toBe(false);
  });

  it('keeps the quotable run id as a chip on the floating card (the transcript card carries none)', () => {
    const panel = createAgentActivityPanel();
    document.body.appendChild(panel.el);
    panel.update([activity({ agentId: 'ag-493f7261' })]);

    const chip = panel.el.querySelector('[data-call-id="call-1"] .agent-worker-id');
    expect(chip?.textContent).toBe('ag-493f7261');
    panel.el.remove();
  });

  it('carries the SESSION id on the rail, and follows a session switch', () => {
    // 2026-09-23 user request: the floating rail must show the conversation's
    // own id so a card can be quoted together with its session.
    const panel = createAgentActivityPanel('session_1758624000000');
    document.body.appendChild(panel.el);
    panel.update([activity()], { sessionId: 'session_1758624000000' });
    const chip = panel.el.querySelector<HTMLElement>('.agent-activity-session');
    expect(chip?.textContent).toBe('session_1758624000000');

    // Switching sessions swaps the id in place (and drops the old cards —
    // covered by the leak test below).
    panel.update([activity({ callId: 'w', agentName: 'deep_thinker' })], { sessionId: 'session_999' });
    expect(panel.el.querySelector<HTMLElement>('.agent-activity-session')?.textContent).toBe('session_999');
    panel.el.remove();
  });

  it('hides the session chip while the panel has no session id yet', () => {
    const panel = createAgentActivityPanel('');
    document.body.appendChild(panel.el);
    panel.update([activity()]);
    const chip = panel.el.querySelector<HTMLElement>('.agent-activity-session');
    expect(chip).toBeTruthy();
    expect(chip?.textContent).toBe('');
    expect(chip?.style.display).toBe('none');
    panel.el.remove();
  });

  it('keeps task context when a later activity update only changes the state', () => {
    const initial = activity({ inputSnippet: '检查权限边界', startedAt: 1234, timeoutMs: 60000 });
    const merged = mergeAgentActivity(initial, { callId: initial.callId, agentName: initial.agentName, state: 'VERIFY' });
    expect(merged.state).toBe('VERIFY');
    expect(merged.inputSnippet).toBe('检查权限边界');
    expect(merged.startedAt).toBe(1234);
    expect(merged.timeoutMs).toBe(60000);
  });

  it('keeps the newest sequenced lifecycle state authoritative', () => {
    const initial = activity({ sequence: 2, lifecycle: 'tool_running', toolName: 'read_file' });
    const stale = activity({ sequence: 1, lifecycle: 'started', toolName: undefined });
    const current = mergeAgentActivity(initial, stale);
    expect(current.lifecycle).toBe('tool_running');
    expect(current.toolName).toBe('read_file');
  });

  it('bounds the carried output and tool trace so one delegation cannot bloat every save', () => {
    const trace = Array.from({ length: 50 }, (_, i) => ({ name: `tool-${i}`, status: 'completed' as const }));
    const merged = mergeAgentActivity(undefined, {
      callId: 'call-bounded',
      agentName: 'researcher',
      output: 'x'.repeat(5_000),
      toolTrace: trace,
    });
    expect(merged.output).toHaveLength(2_000);
    expect(merged.toolTrace).toHaveLength(20);
    // The tail survives — the newest tool calls are the ones a reader needs.
    expect(merged.toolTrace?.at(-1)?.name).toBe('tool-49');

    // A payload already inside the bound is passed through untouched.
    const small = mergeAgentActivity(undefined, { callId: 'call-small', agentName: 'researcher', output: '找到 4 个来源' });
    expect(small.output).toBe('找到 4 个来源');
    expect(mergeAgentActivity(small, { callId: 'call-small', agentName: 'researcher', state: 'VERIFY' }).output).toBe('找到 4 个来源');
  });

  it('mounts the saved activity trace when a session is restored', () => {
    const snapshot: SessionSnapshotV2 = {
      version: 3,
      modelContext: { messages: [{ role: 'user', content: '执行多步任务' }] },
      events: [{ id: 'user-1', type: 'user', content: '执行多步任务' }],
      transcript: [],
      uiState: {
        agentActivities: [activity({ status: 'done', output: '已完成第一部分' })],
      },
    };
    const chat = new ChatController();
    chat.loadFromStorage(snapshot);
    chat.mountAgentActivityPanel();

    const panel = document.querySelector('[data-agent-activity-rail="true"]');
    expect(panel).not.toBeNull();
    // Cards show the machine id in full, no status text.
    expect(panel?.textContent).toContain('researcher');
    expect(panel?.textContent).toContain('Agent');
    expect(panel?.textContent).not.toContain('已完成第一部分');
    expect(panel?.querySelector('.agent-worker-trace')).toBeNull();
    expect(panel?.querySelector('.agent-activity-history')).toBeNull();
  });

  it('keeps tool details out of the activity roster', () => {
    const panel = createAgentActivityPanel();
    document.body.appendChild(panel.el);
    panel.update([activity({
      lifecycle: 'tool_running',
      toolName: 'read_file',
      toolTrace: [
        { name: 'read_file', args: 'src/ui/chat.ts', status: 'completed' },
        { name: 'web_search', args: 'rust retry best practices', status: 'running' },
      ],
    })]);

    expect(panel.el.querySelector('.agent-worker-trace')).toBeNull();
    expect(panel.el.querySelectorAll('.agent-worker')).toHaveLength(1);
    // Cards carry only WHO is working + when it joined — no status or
    // tool-call detail.
    expect(panel.el.textContent).toContain('Agent');
    expect(panel.el.textContent).not.toContain('执行工具');
    expect(panel.el.textContent).not.toContain('正在执行 read_file');
    expect(panel.el.textContent).not.toContain('rust retry best practices');
  });

  it('never shows tool-like roles (bash_executor) as agent cards', () => {
    const panel = createAgentActivityPanel();
    document.body.appendChild(panel.el);
    // bash_executor is a TOOL the model delegates to — the agent roster is
    // for agents/subagents only.
    panel.update([activity({ callId: 't', agentName: 'bash_executor', lifecycle: 'started', status: 'running' })]);
    expect(panel.el.querySelectorAll('.agent-worker')).toHaveLength(0);
    panel.el.remove();
  });

  it('keeps a terminal card in live mode — the roster shows every dispatched agent', async () => {
    const panel = createAgentActivityPanel('s1');
    document.body.appendChild(panel.el);
    panel.update([activity({ callId: 'a', agentName: 'code_editor', lifecycle: 'started', status: 'running', startedAt: Date.now() })]);
    expect(panel.el.querySelectorAll('.agent-worker')).toHaveLength(1);

    // Work finishes: the card STAYS (marked done). It used to fade after a
    // 2s dwell, which hid a serial delegation queue — the user only ever saw
    // the currently-running agent, never the ones already finished.
    panel.update([activity({ callId: 'a', agentName: 'code_editor', lifecycle: 'done', status: 'done', startedAt: Date.now() })]);
    expect(panel.el.querySelectorAll('.agent-worker')).toHaveLength(1);
    await Bun.sleep(140);
    expect(panel.el.querySelectorAll('.agent-worker')).toHaveLength(1);
    expect(panel.el.querySelector('[data-call-id="a"]')?.className).toContain('agent-worker--done');
    // A repeated terminal report does not duplicate or resurrect anything.
    panel.update([activity({ callId: 'a', agentName: 'code_editor', lifecycle: 'done', status: 'done', startedAt: Date.now() })]);
    expect(panel.el.querySelectorAll('.agent-worker')).toHaveLength(1);
    panel.el.remove();
  });

  it('keeps every card in the historical trace', async () => {
    const panel = createAgentActivityPanel('s1');
    document.body.appendChild(panel.el);
    panel.update([activity({ callId: 'a', agentName: 'code_editor', lifecycle: 'done', status: 'done', startedAt: Date.now() })], { historical: true });
    expect(panel.el.querySelectorAll('.agent-worker')).toHaveLength(1);
    await Bun.sleep(120);
    expect(panel.el.querySelectorAll('.agent-worker')).toHaveLength(1);
    panel.el.remove();
  });

  it('renders repeated delegations of the same agent under the bare name (no （1）（2）… suffixes)', () => {
    const panel = createAgentActivityPanel();
    document.body.appendChild(panel.el);
    panel.update([
      activity({ callId: 'd1', agentName: 'ui_designer', instanceNo: 1, lifecycle: 'done', status: 'done' }),
      activity({ callId: 'd2', agentName: 'ui_designer', instanceNo: 2, lifecycle: 'tool_running' }),
      activity({ callId: 'd3', agentName: 'ui_designer', instanceNo: 3, lifecycle: 'started', status: 'running' }),
      activity({ callId: 's1', agentName: 'code_editor', lifecycle: 'started', status: 'running' }),
    ]);

    expect(panel.el.querySelectorAll('.agent-worker')).toHaveLength(4);
    const nameOf = (id: string): string =>
      panel.el.querySelector(`[data-call-id="${id}"] .agent-worker-name`)?.textContent ?? '';
    // The instance number stays dispatch-order bookkeeping — the card itself
    // shows the plain agent name, however many times it was delegated.
    expect(nameOf('d1')).toBe('ui_designer');
    expect(nameOf('d2')).toBe('ui_designer');
    expect(nameOf('d3')).toBe('ui_designer');
    expect(nameOf('s1')).toBe('code_editor');
    panel.el.remove();
  });

  it('keeps one flat row per active agent without a parallel sub-view', () => {
    const now = Date.now();
    const panel = createAgentActivityPanel();
    document.body.appendChild(panel.el);
    panel.update([
      activity({ callId: 'a', agentName: 'researcher', startedAt: now }),
      activity({ callId: 'b', agentName: 'deep_thinker', startedAt: now + 300 }),
    ]);

    expect(panel.el.querySelectorAll('.agent-worker')).toHaveLength(2);
    expect(panel.el.querySelectorAll('.agent-worker')).toHaveLength(2);
    expect(panel.el.querySelectorAll('.agent-activity-parallel')).toHaveLength(0);
    expect(panel.el.querySelector('[data-call-id="a"]')?.className).toContain('agent-worker--active');
  });

  it('does not create extra markup for agents started at different times', () => {
    const now = Date.now();
    const panel = createAgentActivityPanel();
    document.body.appendChild(panel.el);
    panel.update([
      activity({ callId: 'a', agentName: 'researcher', startedAt: now }),
      activity({ callId: 'b', agentName: 'deep_thinker', startedAt: now + 60_000 }),
    ]);

    expect(panel.el.querySelectorAll('.agent-worker')).toHaveLength(2);
    expect(panel.el.querySelectorAll('.agent-activity-parallel')).toHaveLength(0);
    expect(panel.el.querySelectorAll('.agent-worker')).toHaveLength(2);
  });

  it('keeps active and completed agents in the same flat list', () => {
    const panel = createAgentActivityPanel();
    document.body.appendChild(panel.el);
    panel.update([activity({ lifecycle: 'tool_running', toolName: 'search_files' }), activity({ callId: 'call-2', lifecycle: 'done', status: 'done' })]);

    expect(panel.el.querySelectorAll('.agent-worker')).toHaveLength(2);
    expect(panel.el.querySelector('.agent-activity-history-list')).toBeNull();

    panel.update([activity({ lifecycle: 'tool_running', toolName: 'search_files' })], { historical: true });
    // No rail header anymore — and historical cards are minimal too: who +
    // start time, no tool-call detail.
    expect(panel.el.textContent).not.toContain('协作记录');
    expect(panel.el.textContent).not.toContain('上次停留在 search_files');
    expect(panel.el.textContent).not.toContain('search_files');
  });

  it('keeps the activity rail outside the conversation stream', () => {
    const host = document.getElementById('agent-activity-host')!;
    const chat = document.getElementById('chat')!;
    const panel = createAgentActivityPanel();
    host.appendChild(panel.el);
    panel.update([activity({ lifecycle: 'tool_running', toolName: 'read_file' })]);

    expect(host.contains(panel.el)).toBe(true);
    expect(chat.contains(panel.el)).toBe(false);
    expect(panel.el.querySelector('.agent-activity-list')).not.toBeNull();
  });

  it('slides in a newly activated agent exactly once per session (mail-like entry)', () => {
    const panel = createAgentActivityPanel('s1');
    document.body.appendChild(panel.el);
    panel.update([activity({ callId: 'a', lifecycle: 'started', status: 'running' })], { sessionId: 's1' });

    // First activation animates in from the rail edge like a new mail card.
    expect(panel.el.querySelector('[data-call-id="a"]')?.className).toContain('agent-worker--entering');

    // Progressing the SAME agent (state/tool updates) never replays the entry.
    panel.update([activity({ callId: 'a', lifecycle: 'tool_running', toolName: 'read_file' })], { sessionId: 's1' });
    expect(panel.el.querySelector('[data-call-id="a"]')?.className).not.toContain('agent-worker--entering');

    // A genuinely NEW agent still arrives with the animation.
    panel.update([
      activity({ callId: 'a', lifecycle: 'tool_running', toolName: 'read_file' }),
      activity({ callId: 'b', lifecycle: 'started', status: 'running', agentName: 'code_editor' }),
    ], { sessionId: 's1' });
    expect(panel.el.querySelector('[data-call-id="a"]')?.className).not.toContain('agent-worker--entering');
    expect(panel.el.querySelector('[data-call-id="b"]')?.className).toContain('agent-worker--entering');
  });

  it('never animates restored (historical) activity', () => {
    const panel = createAgentActivityPanel('s1');
    document.body.appendChild(panel.el);
    panel.update([activity({ lifecycle: 'tool_running', toolName: 'read_file' })], { historical: true, sessionId: 's1' });
    expect(panel.el.querySelector('[data-call-id="call-1"]')?.className).not.toContain('agent-worker--entering');
  });

  it('never leaks an agent card across sessions on a shared panel', () => {
    const panel = createAgentActivityPanel('s1');
    document.body.appendChild(panel.el);
    panel.update([activity({ callId: 'flight-agent', agentName: 'researcher', lifecycle: 'started', status: 'running' })], { sessionId: 's1' });
    expect(panel.el.textContent).toContain('researcher');

    // Switching the panel to a different session drops the previous session's
    // rows entirely — the flight agent card cannot animate or persist under
    // the weather conversation.
    panel.update([activity({ callId: 'weather-agent', agentName: 'deep_thinker', lifecycle: 'started', status: 'running' })], { sessionId: 's2' });
    expect(panel.el.textContent).not.toContain('researcher');
    expect(panel.el.textContent).toContain('deep_thinker');

    // Returning to the flight session re-shows only its own agent — no trace
    // of the weather conversation survives in this panel.
    panel.update([activity({ callId: 'flight-agent', lifecycle: 'started', status: 'running', agentName: 'researcher' })], { sessionId: 's1' });
    expect(panel.el.textContent).toContain('researcher');
    expect(panel.el.textContent).not.toContain('deep_thinker');
    expect(panel.el.querySelectorAll('.agent-worker')).toHaveLength(1);
  });
});
