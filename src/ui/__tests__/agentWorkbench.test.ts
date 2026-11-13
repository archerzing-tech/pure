// src/ui/__tests__/agentWorkbench.test.ts
// Agent 工作台契约（2026-11-12 设计定稿 docs/agent-workbench-2026-11.md，随特性落）：
//   空间门谓词（宽度阈值 × context panel 态，纯函数）；
//   工作台开/关/chip 切换/callId 寻址/历史只读/会话更替关闭/空态关闭；
//   委派卡跨链入口幂等 + 点击进工作台；
//   源码锁：#agent-view 壳位、funnel 第二消费者、bottom sheet 退役、
//   markdown 渲染闸挂点、main.ts 互斥/Esc/联动接线、ToolExecMeta.callId。

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { GlobalRegistrator } from '@happy-dom/global-registrator';
import { AGENT_RAIL_MIN_VIEWPORT, agentRailSpaceGateHit } from '../agentActivityPanel';
import { agentWorkbench, attachWorkbenchEntry, initAgentWorkbench } from '../agentWorkbench';
import type { SessionAgentActivity } from '../store';

function activity(overrides: Partial<SessionAgentActivity> = {}): SessionAgentActivity {
  return {
    callId: 'call-1',
    agentName: 'researcher',
    agentRole: '负责资料调研',
    agentId: 'ag-1a2b3c4d',
    status: 'running',
    inputSnippet: '查找相关资料',
    startedAt: Date.now() - 30_000,
    ...overrides,
  };
}

beforeAll(() => {
  GlobalRegistrator.register();
  document.body.innerHTML =
    '<div id="chat-view"></div><div id="agent-view"></div>' +
    '<button id="sidebar-toggle"></button><button id="right-settings-btn"></button>' +
    '<button id="context-panel-reopen"></button>' +
    '<div id="agent-activity-host"></div>';
  initAgentWorkbench({});
});

beforeEach(() => {
  // 钩子重置：全文注入若残留会跨用例污染产出段（单例跨测试）。
  initAgentWorkbench({});
  const wb = agentWorkbench()!;
  wb.close();
  // 会话更替走「关闭」路径：换一个 sessionId 让 sync 的重置分支把上一测试
  // 的快照与 currentCallId 全部清掉（单例跨测试，状态必须从这里起步）。
  wb.sync([], { sessionId: `reset-${Math.random()}` });
});

afterAll(() => {
  GlobalRegistrator.unregister();
});

describe('空间门谓词（§2，纯函数）', () => {
  it('阈值为 1080（minWidth 1000 + ~11% 转写宽让位）', () => {
    expect(AGENT_RAIL_MIN_VIEWPORT).toBe(1080);
  });
  it('宽度不足即命中（含 1080 整数边界：>= 阈值放行）', () => {
    expect(agentRailSpaceGateHit(1079, false)).toBe(true);
    expect(agentRailSpaceGateHit(1080, false)).toBe(false);
    expect(agentRailSpaceGateHit(900, false)).toBe(true);
  });
  it('context panel 展开即命中（任一条件，OR 语义）', () => {
    expect(agentRailSpaceGateHit(1600, true)).toBe(true);
    expect(agentRailSpaceGateHit(1600, false)).toBe(false);
  });
});

describe('工作台开/关/寻址（§3）', () => {
  it('open(callId) 按头/徽标/段块寻址渲染', () => {
    const wb = agentWorkbench()!;
    wb.sync([activity(), activity({ callId: 'call-2', agentName: 'code_reviewer', inputSnippet: '检查实现' })], { sessionId: 's1' });
    wb.open('call-2');
    expect(wb.isVisible()).toBe(true);
    const view = document.getElementById('agent-view')!;
    expect(view.classList.contains('expanded')).toBe(true);
    // 寻址正确：标题是 call-2 的 agent，不是第一支
    expect(view.querySelector('.agent-wb-title')!.textContent).toBe('code_reviewer');
    expect(view.querySelector('.agent-wb-tasktext')!.textContent).toBe('检查实现');
    // 头部 id chip
    expect(view.querySelector('.agent-wb-idchip')!.textContent).toBe('ag-1a2b3c4d');
    // chip 切换条两支都在
    expect(view.querySelectorAll('.agent-wb-chip')).toHaveLength(2);
    // 高亮在当前
    expect(view.querySelector('.agent-wb-chip.active')!.textContent).toContain('code_reviewer');
    // 状态徽标：运行中
    expect(view.querySelector('.agent-wb-status')!.textContent).toContain('运行中');
    // chat 被挤压（settings 同款机制）
    expect(document.getElementById('chat-view')!.classList.contains('squeezed')).toBe(true);
  });

  it('close() 收页 + 解除挤压 + 焦点归还', () => {
    const wb = agentWorkbench()!;
    wb.sync([activity()], { sessionId: 's1' });
    // 焦点先落位，再首次 open（open 只在不可见→可见的沿上采 focusBeforeOpen，
    // 与 settings.ts focusBeforeOpen 模式同构）。
    const focusTarget = document.createElement('button');
    document.body.appendChild(focusTarget);
    focusTarget.focus();
    wb.open('call-1');
    wb.close();
    expect(wb.isVisible()).toBe(false);
    expect(document.getElementById('agent-view')!.classList.contains('expanded')).toBe(false);
    expect(document.getElementById('chat-view')!.classList.contains('squeezed')).toBe(false);
    expect(document.activeElement).toBe(focusTarget);
    focusTarget.remove();
  });

  it('callId 不在快照时落到第一支', () => {
    const wb = agentWorkbench()!;
    wb.sync([
      activity({ callId: 'a', startedAt: Date.now() - 30_000 }),
      activity({ callId: 'b', agentName: 'ui_designer', startedAt: Date.now() - 60_000 }),
    ], { sessionId: 's1' });
    wb.open('not-there');
    expect(document.querySelector('#agent-view .agent-wb-title')!.textContent).toBe('researcher');
  });

  it('chip 点击横跳换人，不回主页', () => {
    const wb = agentWorkbench()!;
    wb.sync([activity({ callId: 'a' }), activity({ callId: 'b', agentName: 'ui_designer' })], { sessionId: 's1' });
    wb.open('a');
    const chips = document.querySelectorAll<HTMLElement>('#agent-view .agent-wb-chip');
    (chips[1] as HTMLElement).click();
    expect(wb.isVisible()).toBe(true);
    expect(document.querySelector('#agent-view .agent-wb-title')!.textContent).toBe('ui_designer');
  });

  it('trace 段逐条渲染（≤20 条界内全量小重建）+ 空轨迹占位', () => {
    const wb = agentWorkbench()!;
    wb.sync([activity({
      callId: 'a',
      toolTrace: [
        { name: 'web_search', args: '"auth"', status: 'completed' },
        { name: 'read_file', status: 'running' },
      ],
    })], { sessionId: 's1' });
    wb.open('a');
    const lines = document.querySelectorAll('#agent-view .agent-wb-trace-line');
    expect(lines).toHaveLength(2);
    expect(lines[0].textContent).toContain('web_search');
    expect(lines[0].textContent).toContain('"auth"');
    // 空 trace 的 agent 不残留上一位的段（换人残留 bug 的回归锁）
    wb.sync([activity({ callId: 'a', toolTrace: [{ name: 'x', status: 'completed' }] }), activity({ callId: 'b', agentName: 'ui_designer', toolTrace: [] })], { sessionId: 's1' });
    wb.open('b');
    expect(document.querySelector('#agent-view .agent-wb-trace')!.textContent).toContain('暂无工具轨迹');
    expect(document.querySelectorAll('#agent-view .agent-wb-trace-line')).toHaveLength(0);
  });

  it('产出段增量追加（append 不重建）', () => {
    const wb = agentWorkbench()!;
    wb.sync([activity({ callId: 'a', output: '第一段' })], { sessionId: 's1' });
    wb.open('a');
    const out = document.querySelector('#agent-view .agent-wb-output')!;
    expect(out.textContent).toBe('第一段');
    wb.sync([activity({ callId: 'a', output: '第一段第二段' })], { sessionId: 's1' });
    // 同一节点续写（增量 append：子节点累加而非替换）
    expect(out.textContent).toBe('第一段第二段');
    expect(out.childNodes.length).toBeGreaterThanOrEqual(2);
  });

  it('历史快照只读开放：徽标亮、无实时计时语义', () => {
    const wb = agentWorkbench()!;
    wb.sync([activity()], { sessionId: 's1', historical: true });
    wb.open('call-1');
    const view = document.getElementById('agent-view')!;
    expect((view.querySelector('.agent-wb-historical') as HTMLElement).hidden).toBe(false);
    expect(view.querySelector('.agent-wb-historical')!.textContent).toContain('历史');
  });

  it('会话更替自动关闭（工作台跟会话走）', () => {
    const wb = agentWorkbench()!;
    wb.sync([activity()], { sessionId: 's1' });
    wb.open('call-1');
    expect(wb.isVisible()).toBe(true);
    wb.sync([activity()], { sessionId: 's2' });
    expect(wb.isVisible()).toBe(false);
  });

  it('活动清空（新会话/清除）自动关闭；空快照 open 显空态', () => {
    const wb = agentWorkbench()!;
    wb.sync([activity()], { sessionId: 's1' });
    wb.open('call-1');
    wb.sync([], { sessionId: 's1' });
    expect(wb.isVisible()).toBe(false);
    // 空态也能打开（显示「没有正在工作的 agent」）
    wb.open();
    expect(wb.isVisible()).toBe(true);
    expect(document.querySelector('#agent-view .agent-wb-empty')!.textContent).toContain('没有正在工作的 agent');
    expect((document.querySelector('#agent-view .agent-wb-content') as HTMLElement).hidden).toBe(true);
    wb.close();
  });

  it('流式渲染闸：半开不挂起，transitionend 后挂起，关闭解除', () => {
    const wb = agentWorkbench()!;
    wb.sync([activity()], { sessionId: 's1' });
    wb.open('call-1');
    // 半开过渡期（width 动画中）：不挂起
    expect(wb.shouldSuspendChatStreamingRender()).toBe(false);
    // width 过渡终了（happy-dom 无真实过渡，手动派发）
    const ev = new Event('transitionend');
    (ev as unknown as { propertyName: string }).propertyName = 'width';
    document.getElementById('agent-view')!.dispatchEvent(ev);
    expect(wb.shouldSuspendChatStreamingRender()).toBe(true);
    // 关闭即解除（追平由 markdown.ts 的重试拍兜底）
    wb.close();
    expect(wb.shouldSuspendChatStreamingRender()).toBe(false);
  });
});

describe('委派卡跨链（刀 3）', () => {
  it('attachWorkbenchEntry：dataset + 幂等 + 点击进工作台（卡上纯 ↗ 图标，语义走 title）', () => {
    const wb = agentWorkbench()!;
    wb.sync([activity({ callId: 'call-9' })], { sessionId: 's1' });
    const row = document.createElement('div');
    row.innerHTML = '<details class="tool-row"><summary class="tool-row-summary"><span class="tool-row-name">researcher</span></summary></details>';
    attachWorkbenchEntry(row, 'call-9');
    expect(row.dataset.agentCallId).toBe('call-9');
    const btn = row.querySelector('.tool-row-workbench-link')!;
    // 2026-11-12 真机反馈：卡上不显示「工作台」三个字，只留 ↗
    expect(btn.textContent).toBe('↗');
    expect(btn.getAttribute('title')).toContain('工作台');
    // summary 内 stopPropagation：click 不冒泡触发展开（details 默认行为被拦）
    (btn as HTMLElement).click();
    expect(wb.isVisible()).toBe(true);
    expect(document.querySelector('#agent-view .agent-wb-title')!.textContent).toBe('researcher');
    // 幂等：重复 attach 不重复挂按钮
    attachWorkbenchEntry(row, 'call-9');
    expect(row.querySelectorAll('.tool-row-workbench-link')).toHaveLength(1);
    wb.close();
  });

  it('工作台打开期间 chrome 隐藏（角钮×2 + 侧栏把手 + rail），关闭恢复', () => {
    const wb = agentWorkbench()!;
    wb.sync([activity()], { sessionId: 's1' });
    wb.open('call-1');
    for (const sel of ['#sidebar-toggle', '#right-settings-btn', '#context-panel-reopen', '#agent-activity-host']) {
      expect(document.querySelector(sel)!.classList.contains('wb-chrome-hidden')).toBe(true);
    }
    wb.close();
    for (const sel of ['#sidebar-toggle', '#right-settings-btn', '#context-panel-reopen', '#agent-activity-host']) {
      expect(document.querySelector(sel)!.classList.contains('wb-chrome-hidden')).toBe(false);
    }
  });

  it('产出全文：钩子命中时显示全文（突破 2000 存档镜像），不再有「跳去委派卡」死胡同', () => {
    // 2026-11-12 用户定案：对话委派卡=主要内容摘要，工作台=详情页显示全部。
    const full = 'A'.repeat(2400) + 'TAIL';
    initAgentWorkbench({ getFullOutput: (callId) => (callId === 'call-1' ? full : null) });
    const wb = agentWorkbench()!;
    wb.sync([activity({ callId: 'call-1', output: full.slice(0, 2000) })], { sessionId: 's1' });
    wb.open('call-1');
    const out = document.querySelector('#agent-view .agent-wb-output')!;
    expect(out.textContent).toBe(full);
    // 全文可达时截断 note 与「跳过去」按钮都不出现（工作台就是终点）。
    expect((document.querySelector('#agent-view .agent-wb-output-note') as HTMLElement).hidden).toBe(true);
    expect(document.querySelector('#agent-view .agent-wb-jump')).toBeNull();
    wb.close();
  });

  it('钩子未命中（历史回退）显示 2000 存档镜像 + 如实提示，无「跳过去」按钮', () => {
    const stored = 'B'.repeat(2200);
    const wb = agentWorkbench()!;
    wb.sync([activity({ callId: 'call-1', output: stored })], { sessionId: 's1' });
    wb.open('call-1');
    const out = document.querySelector('#agent-view .agent-wb-output')!;
    expect(out.textContent!.length).toBe(2200); // 存档镜像原样显示
    const note = document.querySelector('#agent-view .agent-wb-output-note') as HTMLElement;
    expect(note.hidden).toBe(false);
    expect(note.textContent).toContain('2000');
    // 「完整产出见对话委派卡，跳过去 ↗」退役（2026-11-12：详情页不踢皮球）。
    expect(note.querySelector('.agent-wb-jump')).toBeNull();
    wb.close();
  });
});

describe('源码锁（接线与退役断言）', () => {
  const read = (p: string): string => readFileSync(`${import.meta.dir}/../${p}`, 'utf8');

  it('index.html：#agent-view 与 #settings-view 同排（view-container 内、其后）', () => {
    const html = read('../../index.html');
    const atSettings = html.indexOf('id="settings-view"');
    const atAgent = html.indexOf('id="agent-view"');
    expect(atAgent).toBeGreaterThan(atSettings);
    // 顺序：agent-view 在 settings-view 收口之后、view-container 收口之前
    const afterAgent = html.slice(atAgent);
    const settingsClose = html.slice(atSettings).indexOf('</div>\n        <!-- Agent');
    expect(settingsClose).toBeGreaterThan(0);
  });

  it('chat.ts：funnel 第二消费者单点接线 + 门禁接线 + 跨链三落点', () => {
    const src = read('chat.ts');
    // 2026-11-13 P1-2a 去重：updateAgentActivity 的显式第二遍 update+sync
    // 删除（每事件双跑 DOM 全量刷新），funnel 的 workbench.sync 由
    // mountAgentActivityPanel 一处承载（带全参数 historical/sessionId）。
    expect(src.split('agentWorkbench()?.sync(').length - 1).toBe(1);
    // updateAgentActivity 必须经 mount 间接喂 workbench（第二消费者不得漏接）。
    expect(src).toMatch(/if \(this\.viewActive\) \{\s*[^}]*this\.mountAgentActivityPanel\(\);\s*\}\s*this\.scheduleAgentActivityPersistence/);
    expect(src.split('attachWorkbenchEntry(').length - 1).toBeGreaterThanOrEqual(4); // import + 3 落点
    expect(src).toContain("window.addEventListener('resize', applyAgentRailSpaceGate)");
    expect(src).toContain('onOpenAgent: (callId) => agentWorkbench()?.open(callId)');
  });

  it('bottom sheet 退役：两处 720px agent 规则不复存在，gate 规则在位', () => {
    const styles = read('styles.css');
    const critical = read('critical.css');
    expect(styles).not.toContain('agent-activity-host { bottom: 0');
    expect(critical).not.toContain('max-height: 40vh');
    expect(critical).toContain('#agent-activity-host.gate-hidden');
    // 工作台打开期间的 chrome 隐藏口（角钮×2 + rail，与 gate 正交）
    expect(styles).toContain('.wb-chrome-hidden');
    // 「跳去委派卡」按钮退役（2026-11-12 用户定案：工作台=全文详情页，
    // 详情页不踢皮球）；header/chips 面板底色与 body 分层。
    expect(styles).not.toContain('agent-wb-jump');
    const headerBlock = styles.slice(styles.indexOf('.agent-wb-header {'), styles.indexOf('.agent-wb-heading'));
    expect(headerBlock).toContain('var(--bg-card)');
    const chipsBlock = styles.slice(styles.indexOf('.agent-wb-chips {'), styles.indexOf('.agent-wb-chip {'));
    expect(chipsBlock).toContain('var(--bg-card)');
    // critical.css 的 720px 块仍在（通用窄窗规则），且 agent 两规则已摘
    expect(critical).toContain('@media (max-width: 720px)');
    expect(critical.slice(critical.indexOf('@media (max-width: 720px)'))).not.toContain('agent-activity');
  });

  it('markdown.ts：渲染闸出口两处（doRender 空转 + 预排重试拍）', () => {
    const src = read('markdown.ts');
    expect(src.split('export function setStreamingRenderGate').length - 1).toBe(1);
    expect(src.split('streamingRenderGate?.()').length - 1).toBe(2);
    expect(src).toContain('RENDER_GATE_RETRY_MS');
  });

  it('main.ts：闸注册 + 双整页互斥 + Esc 分支 + context 联动 + 恢复跨链', () => {
    const src = read('main.ts');
    expect(src).toContain('setStreamingRenderGate(() => agentWorkbench()?.shouldSuspendChatStreamingRender() ?? false)');
    expect(src).toContain('agentWorkbench()?.close();'); // settings onOpen 互斥
    expect(src).toContain('agentWorkbench()?.isVisible()'); // Esc 分支
    expect(src).toContain('applyAgentRailSpaceGate();'); // context 联动
    expect(src).toContain('if (item.exec.callId) attachWorkbenchEntry(row.el, item.exec.callId);');
    expect(src).toContain('requestCloseSettings');
  });

  it('store.ts：ToolExecMeta.callId 向后兼容字段在位', () => {
    const src = read('store.ts');
    expect(src).toContain('callId?: string;');
  });
});
