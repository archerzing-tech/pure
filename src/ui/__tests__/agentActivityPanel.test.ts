import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { GlobalRegistrator } from '@happy-dom/global-registrator';
import { ChatController } from '../chat';
import { createAgentActivityPanel, isAgentActivityActive, mergeAgentActivity } from '../agentActivityPanel';
import type { SessionAgentActivity, SessionSnapshotV2 } from '../store';

beforeAll(() => {
  GlobalRegistrator.register();
});

beforeEach(() => {
  document.body.innerHTML = '<div id="agent-console-host"></div><div id="chat"></div>';
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

    expect(panel.el.querySelectorAll('.agent-activity-agent')).toHaveLength(2);
    expect(panel.el.textContent).toContain('2 个 agent');
    expect(panel.el.textContent).toContain('思考中');

    panel.update([activity({ status: 'done', state: 'TERMINATE', output: '找到 8 个来源', durationMs: 4200 }), activity({ callId: 'call-2', state: 'VERIFY' })]);

    expect(panel.el.querySelectorAll('.agent-activity-agent')).toHaveLength(2);
    expect(panel.el.querySelector('[data-call-id="call-1"]')?.className).toContain('agent-activity-agent--done');
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

    const panel = document.querySelector('[data-agent-activity-panel="true"]');
    expect(panel).not.toBeNull();
    expect(panel?.textContent).toContain('researcher');
    expect(panel?.textContent).toContain('已完成');
    expect(panel?.textContent).toContain('已完成第一部分');
    expect(panel?.querySelector('.agent-console-history')).not.toBeNull();
  });

  it('keeps active agents in the fixed console and marks restored active rows as historical', () => {
    const panel = createAgentActivityPanel();
    document.body.appendChild(panel.el);
    panel.update([activity({ lifecycle: 'tool_running', toolName: 'search_files' }), activity({ callId: 'call-2', lifecycle: 'done', status: 'done' })]);

    expect(panel.el.querySelector('.agent-console-active-list')?.textContent).toContain('researcher');
    expect(panel.el.querySelectorAll('.agent-console-history-list .agent-activity-agent')).toHaveLength(1);
    expect(panel.el.textContent).toContain('1 个 agent 正在工作');

    panel.update([activity({ lifecycle: 'tool_running', toolName: 'search_files' })], { historical: true });
    expect(panel.el.textContent).toContain('上次协作摘要');
    expect(panel.el.textContent).toContain('上次未完成');
    expect(panel.el.textContent).toContain('上次停留在工具：search_files');
  });
});
