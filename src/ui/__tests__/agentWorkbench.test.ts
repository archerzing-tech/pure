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
import { agentWorkbench, initAgentWorkbench } from '../agentWorkbench';
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
    // 起止时间在任务卡上（2026-11-16 用户定案：时间从 rail 移进工作台）：
    // 活跃支只报起点 + 已运行，不造假终点。
    const timeRow = view.querySelector<HTMLElement>('.agent-wb-timerow')!;
    expect(timeRow.hidden).toBe(false);
    expect(timeRow.textContent).toContain('起 ');
    expect(timeRow.textContent).toContain('已运行');
    expect(timeRow.textContent).not.toContain('止');
    // 2026-11-19 转场改造：工作台是滑入覆盖层，不再挤压对话列（宽度收缩会
    // 让整条转写每帧重排，长会话切回来时可见顿挫）。
    expect(document.getElementById('chat-view')!.classList.contains('squeezed')).toBe(false);
  });

  it('终态把起止时刻都报出来（止 = 起点 + 时长，用时同源折算）', () => {
    const wb = agentWorkbench()!;
    const start = new Date(2026, 10, 16, 12, 3, 4).getTime();
    wb.sync([activity({
      callId: 'call-1',
      lifecycle: 'done',
      status: 'done',
      success: true,
      startedAt: start,
      durationMs: 6 * 60_000 + 29_000,
    })], { sessionId: 's1' });
    wb.open('call-1');
    const row = document.getElementById('agent-view')!.querySelector('.agent-wb-timerow')!;
    expect(row.textContent).toContain('起 12:03:04');
    expect(row.textContent).toContain('止 12:09:33');
    expect(row.textContent).toContain('用时 06:29');
  });

  it('老存档没有 startedAt 时整行隐藏——不造假时刻', () => {
    const wb = agentWorkbench()!;
    wb.sync([activity({ callId: 'call-1', startedAt: undefined })], { sessionId: 's1' });
    wb.open('call-1');
    const row = document.getElementById('agent-view')!.querySelector<HTMLElement>('.agent-wb-timerow')!;
    expect(row.hidden).toBe(true);
    expect(row.textContent).toBe('');
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
    // 半开过渡期（transform 滑入中）：不挂起
    expect(wb.shouldSuspendChatStreamingRender()).toBe(false);
    // 滑入过渡终了（happy-dom 无真实过渡，手动派发）
    const ev = new Event('transitionend');
    (ev as unknown as { propertyName: string }).propertyName = 'transform';
    document.getElementById('agent-view')!.dispatchEvent(ev);
    expect(wb.shouldSuspendChatStreamingRender()).toBe(true);
    // 关闭即解除（追平由 markdown.ts 的重试拍兜底）
    wb.close();
    expect(wb.shouldSuspendChatStreamingRender()).toBe(false);
  });
});

describe('委派卡跨链（刀 3）', () => {
  // 委派卡不再挂「工作台 ↗」入口 chip（rail 卡整卡点击已能进入工作台）；
  // 入口断言改为 rail：onOpenAgent: (callId) => agentWorkbench()?.open(callId)。
  it('工作台打开期间 chrome 隐藏（角钮×2 + 侧栏把手 + rail），关闭立即恢复角钮', () => {
    const wb = agentWorkbench()!;
    wb.sync([activity()], { sessionId: 's1' });
    wb.open('call-1');
    for (const sel of ['#sidebar-toggle', '#right-settings-btn', '#context-panel-reopen', '#agent-activity-host']) {
      expect(document.querySelector(sel)!.classList.contains('wb-chrome-hidden')).toBe(true);
    }
    wb.close();
    for (const sel of ['#sidebar-toggle', '#right-settings-btn', '#context-panel-reopen']) {
      expect(document.querySelector(sel)!.classList.contains('wb-chrome-hidden')).toBe(false);
    }
  });

  it('关闭时 rail 等对话列展开完再放回（不能先浮在空对话区上）', () => {
    // 2026-11-19 真机反馈：切回主界面时 rail 卡先出现、正文后到。#chat-view
    // 从 0 宽展开有 0.4s 过渡，rail 是绝对定位浮层，必须先压住。
    const wb = agentWorkbench()!;
    const agentView = document.getElementById('agent-view')!;
    const rail = document.getElementById('agent-activity-host')!;
    wb.sync([activity()], { sessionId: 's1' });
    wb.open('call-1');
    wb.close();
    // 过渡还没走完：rail 仍在让位
    expect(rail.classList.contains('wb-chrome-hidden')).toBe(true);
    // 滑出过渡终了（happy-dom 无真实过渡，手动派发）→ 放回。
    // 信号挂在 #agent-view 的 transform：它是这段转场里唯一插值的属性。
    const ev = new Event('transitionend');
    (ev as unknown as { propertyName: string }).propertyName = 'transform';
    agentView.dispatchEvent(ev);
    expect(rail.classList.contains('wb-chrome-hidden')).toBe(false);
  });

  it('过渡中途重新打开：挂起的 rail 放回作废，rail 继续让位', async () => {
    const wb = agentWorkbench()!;
    const rail = document.getElementById('agent-activity-host')!;
    wb.sync([activity()], { sessionId: 's1' });
    wb.open('call-1');
    wb.close();
    wb.open('call-1');
    // 等过定时器兜底窗口（过渡时长 400ms + 80ms），rail 仍应隐藏。
    await new Promise(resolve => setTimeout(resolve, 560));
    expect(rail.classList.contains('wb-chrome-hidden')).toBe(true);
    wb.close();
    const ev = new Event('transitionend');
    (ev as unknown as { propertyName: string }).propertyName = 'transform';
    document.getElementById('agent-view')!.dispatchEvent(ev);
    expect(rail.classList.contains('wb-chrome-hidden')).toBe(false);
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
    // 委派卡不再挂「工作台 ↗」入口 chip（rail 卡整卡点击进入）。
    expect(src).not.toContain('attachWorkbenchEntry(');
    expect(src).toContain("window.addEventListener('resize', applyAgentRailSpaceGate)");
    expect(src).toContain('onOpenAgent: (callId) => agentWorkbench()?.open(callId)');
    // 2026-11-19：工作台盖住对话期间不画 rail 卡（不显示的页面停渲染），
    // 快照仍喂给它；关闭后由 onClosed 补画。
    expect(src).toMatch(/const workbench = agentWorkbench\(\);\s*if \(workbench\?\.isVisible\(\)\) \{\s*host\.hidden = true;\s*workbench\.sync\(this\.agentActivities/);
  });

  it('styles.css：#agent-view 是 transform 滑入的覆盖层，不再挤压对话列', () => {
    const styles = read('styles.css');
    // 取最后一处：标题栏那段也有一个 `#agent-view` 规则（透明标题栏留位）。
    const block = styles.slice(styles.lastIndexOf('#agent-view {'), styles.lastIndexOf('#agent-view.expanded'));
    expect(block).toContain('position: absolute');
    expect(block).toContain('transform: translateX(100%)');
    expect(block).toContain('visibility: hidden');
    expect(block).not.toContain('width: 0%');
    const expandedAt = styles.lastIndexOf('#agent-view.expanded');
    const expanded = styles.slice(expandedAt, expandedAt + 220);
    expect(expanded).toContain('transform: translateX(0)');
    expect(expanded).toContain('visibility: visible');
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
    // main.ts 恢复重放不再挂 chip（rail 卡整卡点击进入）。
    expect(src).not.toContain('attachWorkbenchEntry(row.el, item.exec.callId)');
    expect(src).toContain('requestCloseSettings');
    // rail 挂起后的补画钩子（朝向 chat 的唯一出口）。
    expect(src).toContain('onClosed: () => chat.mountAgentActivityPanel()');
  });

  it('store.ts：ToolExecMeta.callId 向后兼容字段在位', () => {
    const src = read('store.ts');
    expect(src).toContain('callId?: string;');
  });
});
