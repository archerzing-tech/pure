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
    expect(panel.el.textContent).toContain('2 个活动中');
    expect(panel.el.textContent).toContain('分析任务');

    panel.update([activity({ status: 'done', state: 'TERMINATE', output: '找到 8 个来源', durationMs: 4200 }), activity({ callId: 'call-2', state: 'VERIFY' })]);

    expect(panel.el.querySelectorAll('.agent-worker')).toHaveLength(2);
    expect(panel.el.querySelector('[data-call-id="call-1"]')?.className).toContain('agent-worker--done');
    expect(panel.el.querySelector('[data-call-id="call-1"]')?.textContent).toContain('已完成');
    expect(panel.el.querySelector('[data-call-id="call-2"]')?.textContent).toContain('验证中');
  });

  it('counts only explicit non-terminal lifecycle states as active', () => {
    expect(isAgentActivityActive(activity({ lifecycle: 'tool_running' }))).toBe(true);
    expect(isAgentActivityActive(activity({ lifecycle: 'verifying' }))).toBe(true);
    expect(isAgentActivityActive(activity({ lifecycle: 'done', status: 'done' }))).toBe(false);
    expect(isAgentActivityActive(activity({ lifecycle: 'failed', status: 'failed' }))).toBe(false);
    expect(isAgentActivityActive(activity({ lifecycle: 'cancelled', status: 'cancelled' }))).toBe(false);
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
    // Cards show the localized role name, not the raw tool id.
    expect(panel?.textContent).toContain('研究员');
    expect(panel?.textContent).toContain('已完成');
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
    // Cards carry only WHO is working + when it joined + a status — no
    // tool-call detail.
    expect(panel.el.textContent).toContain('执行工具');
    expect(panel.el.textContent).not.toContain('正在执行 read_file');
    expect(panel.el.textContent).not.toContain('rust retry best practices');
  });

  it('fades terminal cards out after a short dwell in live mode', async () => {
    const panel = createAgentActivityPanel('s1', { dismissDwellMs: 30, dismissFadeMs: 30 });
    document.body.appendChild(panel.el);
    panel.update([activity({ callId: 'a', agentName: 'code_editor', lifecycle: 'started', status: 'running', startedAt: Date.now() })]);
    expect(panel.el.querySelectorAll('.agent-worker')).toHaveLength(1);

    // Work finishes: the card dwells (still visible), then fades and leaves
    // the DOM — and stays gone even though the stream keeps reporting it.
    panel.update([activity({ callId: 'a', agentName: 'code_editor', lifecycle: 'done', status: 'done', startedAt: Date.now() })]);
    expect(panel.el.querySelectorAll('.agent-worker')).toHaveLength(1);
    await Bun.sleep(140);
    expect(panel.el.querySelectorAll('.agent-worker')).toHaveLength(0);
    panel.update([activity({ callId: 'a', agentName: 'code_editor', lifecycle: 'done', status: 'done', startedAt: Date.now() })]);
    expect(panel.el.querySelectorAll('.agent-worker')).toHaveLength(0);
    panel.el.remove();
  });

  it('keeps every card in the historical trace (no auto-dismiss)', async () => {
    const panel = createAgentActivityPanel('s1', { dismissDwellMs: 30, dismissFadeMs: 30 });
    document.body.appendChild(panel.el);
    panel.update([activity({ callId: 'a', agentName: 'code_editor', lifecycle: 'done', status: 'done', startedAt: Date.now() })], { historical: true });
    expect(panel.el.querySelectorAll('.agent-worker')).toHaveLength(1);
    await Bun.sleep(120);
    expect(panel.el.querySelectorAll('.agent-worker')).toHaveLength(1);
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

    expect(panel.el.textContent).toContain('2 个活动中');
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
    expect(panel.el.textContent).toContain('2 个活动中');
  });

  it('keeps active and completed agents in the same flat list', () => {
    const panel = createAgentActivityPanel();
    document.body.appendChild(panel.el);
    panel.update([activity({ lifecycle: 'tool_running', toolName: 'search_files' }), activity({ callId: 'call-2', lifecycle: 'done', status: 'done' })]);

    expect(panel.el.querySelectorAll('.agent-worker')).toHaveLength(2);
    expect(panel.el.querySelector('.agent-activity-history-list')).toBeNull();
    expect(panel.el.textContent).toContain('1 个活动中');

    panel.update([activity({ lifecycle: 'tool_running', toolName: 'search_files' })], { historical: true });
    expect(panel.el.textContent).toContain('协作记录');
    expect(panel.el.textContent).toContain('上次中断');
    // Historical cards are minimal too: who + status, no tool-call detail.
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
    expect(panel.el.textContent).toContain('研究员');

    // Switching the panel to a different session drops the previous session's
    // rows entirely — the flight agent card cannot animate or persist under
    // the weather conversation.
    panel.update([activity({ callId: 'weather-agent', agentName: 'deep_thinker', lifecycle: 'started', status: 'running' })], { sessionId: 's2' });
    expect(panel.el.textContent).not.toContain('研究员');
    expect(panel.el.textContent).toContain('深度思考专家');

    // Returning to the flight session re-shows only its own agent — no trace
    // of the weather conversation survives in this panel.
    panel.update([activity({ callId: 'flight-agent', lifecycle: 'started', status: 'running', agentName: 'researcher' })], { sessionId: 's1' });
    expect(panel.el.textContent).toContain('研究员');
    expect(panel.el.textContent).not.toContain('深度思考专家');
    expect(panel.el.querySelectorAll('.agent-worker')).toHaveLength(1);
  });
});
