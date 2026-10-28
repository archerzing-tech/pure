// src/ui/__tests__/conversationSamples.test.ts
// 样本回放：/Users/ericever/Documents/samples.txt 里的理想对话案例，在宿主
// 侧（GUI 对话流）逐条跑通。回放的不是字符串，而是真链路——真
// DynamicInsertionCoordinator（三值判定唯一通路+passthrough 兜底）、真三臂
// 分流（inline 直投/sideline 旁答/new_task 排队，2026-10-28 刀 B）、真 DOM
// 回执（呈现层契约：回显气泡+普通助手气泡，队列卡已退役）；只有两处是假
// 的：分类 LLM（按样本剧本给三值判词）和引擎 send（记录派发载荷）。模型
// 回合的表达姿态（结论先行、子 Agent 摘要、变化点清单）不在宿主侧，不进本文件。

import { describe, expect, it, afterEach } from 'bun:test';
import { ChatController, setTimedInputSink, wireNewContentHint } from '../chat';
import { wireScrollPin, setPinnedToBottom, scrollChatToBottomIfPinned, setScrollPinObservers } from '../scrollPin';
import { SubagentOrchestrator } from '../../coding-agent/SubagentOrchestrator';

// ── 极小假 DOM：只为插话路径真正摸到的面负责 ─────────────────────────────

type Node = FakeElement | FakeText;

class FakeText {
  readonly nodeType = 3;
  parentNode: FakeElement | null = null;
  constructor(public data: string) {}
  get parentElement(): FakeElement | null {
    return this.parentNode;
  }
}

const FRAGMENT = Symbol('fragment');

class FakeElement {
  readonly nodeType = 1;
  parentNode: FakeElement | null = null;
  children: Node[] = [];
  dataset: Record<string, string> = {};
  title = '';
  private classes = new Set<string>();
  private readonly attrs = new Map<string, string>();
  private readonly listeners = new Map<string, unknown>();
  readonly [FRAGMENT] = false;

  constructor(private readonly tag: string, fragment = false) {
    (this as { [FRAGMENT]?: boolean })[FRAGMENT] = fragment;
  }

  get tagName(): string {
    return this.tag.toUpperCase();
  }
  get className(): string {
    return [...this.classes].join(' ');
  }
  set className(value: string) {
    this.classes = new Set(value.split(/\s+/).filter(Boolean));
  }
  get classList(): { add: (...names: string[]) => void; remove: (...names: string[]) => void; contains: (name: string) => boolean; toggle: (name: string) => void } {
    const classes = this.classes;
    return {
      add: (...names) => { for (const n of names) classes.add(n); },
      remove: (...names) => { for (const n of names) classes.delete(n); },
      contains: (name) => classes.has(name),
      toggle: (name) => { if (classes.has(name)) classes.delete(name); else classes.add(name); },
    };
  }
  get parentElement(): FakeElement | null {
    return this.parentNode;
  }
  get firstChild(): Node | null {
    return this.children[0] ?? null;
  }
  get isConnected(): boolean {
    let el: FakeElement | null = this;
    while (el) {
      if ((el as { _isRoot?: boolean })._isRoot) return true;
      el = el.parentNode;
    }
    return false;
  }
  get textContent(): string {
    return collectText(this);
  }
  set textContent(value: string) {
    for (const child of this.children) child.parentNode = null;
    this.children = [];
    if (value) {
      const text = new FakeText(value);
      text.parentNode = this;
      this.children.push(text);
    }
  }

  appendChild(node: Node): Node {
    if ((node as FakeElement)[FRAGMENT]) {
      for (const child of [...(node as FakeElement).children]) this.appendChild(child);
      (node as FakeElement).children = [];
      return node;
    }
    node.parentNode?.removeChild(node);
    node.parentNode = this;
    this.children.push(node);
    return node;
  }
  insertBefore(node: Node, ref: Node | null): Node {
    if (!ref) return this.appendChild(node);
    const at = this.children.indexOf(ref);
    if (at < 0) return this.appendChild(node);
    // 真 DOM 语义：insertBefore 是移动——先把节点从旧父摘除再插（同一父内
    // 重排也先摘，否则同一节点在 children 里出现两份；2026-10-09 续跑收执
    // 判例实证：回显行被 placeEchoBeforeAck 重排时在假 DOM 里复制成了两行）。
    node.parentNode?.removeChild(node);
    const atAfterDetach = this.children.indexOf(ref);
    if (atAfterDetach < 0) return this.appendChild(node);
    const incoming = (node as FakeElement)[FRAGMENT] ? [...(node as FakeElement).children] : [node];
    this.children.splice(atAfterDetach, 0, ...incoming);
    for (const child of incoming) child.parentNode = this;
    return node;
  }
  removeChild(node: Node): Node {
    const at = this.children.indexOf(node);
    if (at >= 0) {
      this.children.splice(at, 1);
      node.parentNode = null;
    }
    return node;
  }
  replaceChild(nu: Node, old: Node): Node {
    const at = this.children.indexOf(old);
    if (at < 0) return old;
    this.children.splice(at, 1);
    old.parentNode = null;
    if ((nu as FakeElement)[FRAGMENT]) {
      const incoming = [...(nu as FakeElement).children];
      this.children.splice(at, 0, ...incoming);
      for (const child of incoming) child.parentNode = this;
      (nu as FakeElement).children = [];
    } else {
      this.children.splice(at, 0, nu);
      nu.parentNode = this;
    }
    return old;
  }
  remove(): void {
    this.parentNode?.removeChild(this);
  }
  contains(node: Node | null): boolean {
    if (node === this) return true;
    for (const child of this.children) {
      if (child instanceof FakeElement ? child.contains(node) : child === node) return true;
    }
    return false;
  }
  addEventListener(name: string, listener: unknown): void {
    this.listeners.set(name, listener);
  }
  setAttribute(name: string, value: string): void {
    this.attrs.set(name, value);
  }
  getAttribute(name: string): string | null {
    return this.attrs.get(name) ?? null;
  }
  closest(selector: string): FakeElement | null {
    const parts = selector.split(',').map((p) => p.trim()).filter(Boolean);
    let el: FakeElement | null = this;
    while (el) {
      for (const part of parts) {
        if (part.startsWith('.') && el.classes.has(part.slice(1))) return el;
        if (/^[a-zA-Z][a-zA-Z0-9-]*$/.test(part) && el.tag === part.toLowerCase()) return el;
      }
      el = el.parentNode;
    }
    return null;
  }
  querySelectorAll(selector: string): FakeElement[] {
    const parts = selector.split(',').map((p) => p.trim()).filter(Boolean);
    const hits: FakeElement[] = [];
    const visit = (el: FakeElement): void => {
      for (const child of el.children) {
        if (!(child instanceof FakeElement)) continue;
        for (const part of parts) {
          if (part.startsWith('.') && part.slice(1).split('.').every((c) => child.classes.has(c))) hits.push(child);
        }
        visit(child);
      }
    };
    visit(this);
    return hits;
  }
}

function collectText(el: FakeElement | FakeText): string {
  if (el instanceof FakeText) return el.data;
  return el.children.map(collectText).join('');
}

function collectTextNodes(el: FakeElement): FakeText[] {
  const out: FakeText[] = [];
  const visit = (node: Node): void => {
    if (node instanceof FakeText) { out.push(node); return; }
    for (const child of node.children) visit(child);
  };
  for (const child of el.children) visit(child);
  return out;
}

// 安装到 globalThis 的这套全局，测试结束必须还原——别的测试文件不背这份假象。
let restoreDom: (() => void) | null = null;

function installDom(): FakeElement {
  const root = new FakeElement('div');
  (root as { _isRoot?: boolean })._isRoot = true;
  // 「有新内容」pill 的挂载点（真实 DOM 里是 #chat 的静态祖先，会话切换
  // 不重建它）——独立节点，不挂进 root 的父链，避免扰动既有用例的层级假设。
  const chatView = new FakeElement('div');
  const prev = {
    document: (globalThis as { document?: unknown }).document,
    window: (globalThis as { window?: unknown }).window,
    NodeFilter: (globalThis as { NodeFilter?: unknown }).NodeFilter,
    localStorage: (globalThis as { localStorage?: unknown }).localStorage,
  };
  const fakeDocument = {
    createElement: (tag: string): FakeElement => new FakeElement(tag),
    createTextNode: (data: string): FakeText => new FakeText(data),
    createDocumentFragment: (): FakeElement => new FakeElement('#fragment', true),
    createTreeWalker: (el: FakeElement): { nextNode: () => FakeText | null } => {
      const nodes = collectTextNodes(el);
      let at = -1;
      return { nextNode: () => { at += 1; return nodes[at] ?? null; } };
    },
    getElementById: (id: string): FakeElement | null => (id === 'chat' ? root : id === 'chat-view' ? chatView : null),
    contains: (el: unknown): boolean => {
      let cur = el as FakeElement | null;
      while (cur) {
        if (cur === chatView || cur === root) return true;
        cur = cur.parentNode;
      }
      return false;
    },
  };
  (globalThis as { document?: unknown }).document = fakeDocument;
  (globalThis as { window?: unknown }).window = {
    setTimeout: (fn: () => void, ms?: number) => setTimeout(fn, ms),
    getSelection: () => null,
  };
  (globalThis as { NodeFilter?: unknown }).NodeFilter = { SHOW_TEXT: 4 };
  (globalThis as { localStorage?: unknown }).localStorage = {
    getItem: () => null,
    setItem: () => {},
    removeItem: () => {},
  };
  restoreDom = () => {
    (globalThis as { document?: unknown }).document = prev.document;
    (globalThis as { window?: unknown }).window = prev.window;
    (globalThis as { NodeFilter?: unknown }).NodeFilter = prev.NodeFilter;
    (globalThis as { localStorage?: unknown }).localStorage = prev.localStorage;
    restoreDom = null;
  };
  return root;
}

afterEach(() => {
  setTimedInputSink(null);
  setScrollPinObservers({}); // 观察者是模块级单口，别让本文件的接线漏进别的用例
  restoreDom?.();
});

// ── 假分类 LLM：按剧本对插话文本给判定；旁路问答给固定答复 ────────────────

interface ScriptedClassification {
  /** 三值 verdict（A 刀权威分类面——classifyInsertion 真解析只认它，
   *  旧九类 relation JSON 一律当没解析出来走 passthrough）。 */
  verdict: 'inline' | 'sideline' | 'new_task';
  reason: string;
  confidence: number;
  /** 现场收执（§〇 呈现层契约）：剧本原样过解析面，只有必须即时确认处
   *  （整停/停支/排队新任务）才写；缺席 = 引擎沉默。 */
  receipt?: string;
  /** 整树停契约：action:"stop" 随判词来，宿主只留 abort 掐流的机械动作。 */
  action?: 'stop' | 'apply';
  /** 点名三形（模型判断、宿主核实执行，蛇形原样走真解析）。 */
  stop_branch?: { call_id: string };
  resumes_branch?: { call_id: string };
  call_id?: string;
}

/** 复核窄问题（<dedupe_conflict> 顶层块）的输出契约——蛇形原样走
 *  recheckCoveredInsertion 真解析（Planner 同名结构）。复核不分类：没有
 *  relation 字段，只裁「收掉在跑的」还是「真加活」。 */
interface RecheckScriptVerdict {
  reason: string;
  confidence: number;
  cancels_part?: boolean;
  stop_branch?: { call_id: string };
  receipt?: string;
}

interface ScriptedLlm {
  stream(messages: Array<{ content: string }>): AsyncGenerator<{ type: string; content: string }, void, void>;
  complete(messages: Array<{ content: string }>): Promise<{ content?: string }>;
  classifyCalls: string[];
}

function scriptedLlm(
  classifications: Array<{ match: string; cls: ScriptedClassification | RecheckScriptVerdict; during?: () => void }>,
  answers: { clarify?: string; question?: string } = {},
): ScriptedLlm {
  const classifyCalls: string[] = [];
  return {
    classifyCalls,
    async *stream(messages) {
      const user = String(messages[1]?.content ?? '');
      classifyCalls.push(user);
      const hit = classifications.find((c) => user.includes(c.match));
      hit?.during?.(); // 判定途中的副作用（模拟在飞回合往转写里流行内容）
      const payload: ScriptedClassification | RecheckScriptVerdict = hit?.cls
        ?? { verdict: 'new_task', reason: 'unmatched script line', confidence: 0.9 };
      const json = JSON.stringify(payload);
      yield { type: 'content', content: json };
      yield { type: 'done', content: json };
    },
    async complete(messages) {
      const system = String(messages[0]?.content ?? '');
      if (system.includes('genuinely unsure')) {
        return { content: answers.clarify ?? '' };
      }
      if (system.includes('WHILE you are mid-task')) {
        return { content: answers.question ?? '市场调研已完成大半，竞品分析进行中，周五中午前能给你。' };
      }
      return { content: '' };
    },
  };
}

// ── 回放 harness：主线任务在跑（streaming + 活回合），插话走真链路 ─────────

const MAIN_TASK = '帮我做一份 Q3 海外市场进入方案，生成 PPT，再写一封给老板的邮件，周五前要。';

function makeHarness(llm: ScriptedLlm): {
  chat: Record<string, any>;
  root: FakeElement;
  sends: string[];
  endTurn: () => void;
} {
  const root = installDom();
  const chat = new ChatController({ host: root as unknown as HTMLElement }) as unknown as Record<string, any>;
  const sends: string[] = [];
  chat.send = (text: string, _images?: unknown, displayText?: string) => {
    sends.push(displayText ?? text);
    return Promise.resolve();
  };
  // 主线任务的活回合：turn 已开、引擎在飞。
  const turn = chat.liveTranscript.startTurn(MAIN_TASK);
  chat.liveTurn = turn;
  chat.streaming = true;
  chat.abortController = new AbortController();
  // 1c：真实 run 路径随回合一并创建第二通道（升级硬停用），这里照装。
  chat.hardStopController = new AbortController();
  chat.turnLlm = llm;
  return {
    chat,
    root,
    sends,
    // 回合收尾：真实链路里 finalize 之后就是这一步派发。
    endTurn: () => {
      chat.streaming = false;
      chat.roundClose.dispatch();
    },
  };
}

// ── 断言帮手 ──────────────────────────────────────────────────────────────

function statusTexts(root: FakeElement): string[] {
  return root.querySelectorAll('.bubble-row.status').map((row) => row.textContent);
}
function statusJoined(root: FakeElement): string {
  return statusTexts(root).join('\n');
}
function userJoined(root: FakeElement): string {
  return root.querySelectorAll('.bubble-row.user').map((row) => row.textContent).join('\n');
}
function assistantJoined(root: FakeElement): string {
  return root.querySelectorAll('.bubble-row.assistant').map((row) => row.textContent).join('\n');
}
function queueCard(root: FakeElement): FakeElement | undefined {
  return root.querySelectorAll('.queue-card')[0];
}
function rowPending(root: FakeElement, needle: string): boolean {
  const row = root.querySelectorAll('.bubble-row.status').find((r) => r.textContent.includes(needle));
  return row?.classList.contains('pending') ?? false;
}
const flush = async (): Promise<void> => {
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));
};

// ── 样本回放 ──────────────────────────────────────────────────────────────

describe('样本回放：samples.txt 的对话流在宿主侧跑通', () => {
  it('无关排队型（打断案例2）：无关诉求进一张活待办卡，定时的提醒走排期，收尾逐件交接', async () => {
    const sinkCalls: Array<{ text: string; at: number }> = [];
    setTimedInputSink((request) => {
      sinkCalls.push({ text: request.text, at: request.at });
      return true;
    });
    const llm = scriptedLlm([
      { match: '北京天气', cls: { verdict: 'new_task', reason: 'unrelated errand', confidence: 0.9 } },
      { match: '东京的机票', cls: { verdict: 'new_task', reason: 'unrelated errand', confidence: 0.9 } },
      // 样本插话 4 是"今晚 19:30 提醒买牛奶"——带时刻的诉求不进队列，进排
      // 期。三值契约没有 when 字段：时刻从用户自己的话里推导（parseInputTiming
      // 的 TIMING_CUE + 时钟解析），裁决器只管走哪条线。
      { match: '买牛奶', cls: { verdict: 'new_task', reason: 'life reminder with a time', confidence: 0.9 } },
    ]);
    const h = makeHarness(llm);

    await h.chat.interject('对了，明天北京天气怎么样？');
    // 呈现层契约（2026-10-28）：队列卡退役——对话流里没有卡，用户原话回显
    // 上屏即确认；排队事实由账本（RoundClosePlane）+ 收尾模型自然话表达。
    expect(queueCard(h.root)).toBeUndefined();
    expect(statusJoined(h.root)).not.toContain('插话处理中');
    expect(userJoined(h.root)).toContain('北京天气');

    await h.chat.interject('顺便帮我看看上海到东京的机票。');
    // 第二件入队同样无卡：队列在账不在流。
    expect(h.root.querySelectorAll('.queue-card')).toHaveLength(0);
    expect(userJoined(h.root)).toContain('东京的机票');

    await h.chat.interject('提醒我今晚 19:30 买牛奶。');
    // 定时的走了宿主排期：用户的话上屏 + 已排期回执；不占待办队列。
    expect(sinkCalls).toHaveLength(1);
    expect(sinkCalls[0].text).toBe('提醒我今晚 19:30 买牛奶。');
    expect(sinkCalls[0].at).toBeGreaterThan(Date.now());
    expect(statusJoined(h.root)).toContain('已排期');
    expect(userJoined(h.root)).toContain('买牛奶');
    expect(queueCard(h.root)).toBeUndefined();

    // 主线收尾 → 从队头派发（交接话由收尾模型自然说，无机制旁白）。
    h.endTurn();
    expect(h.sends).toEqual(['对了，明天北京天气怎么样？']);
    expect(statusJoined(h.root)).not.toContain('队列：处理下一件');

    // 再收尾 → 最后一件照跑，全程无卡。
    h.endTurn();
    expect(h.sends).toEqual(['对了，明天北京天气怎么样？', '顺便帮我看看上海到东京的机票。']);
    expect(statusJoined(h.root)).not.toContain('队列：现在处理排下的那件。');
    expect(queueCard(h.root)).toBeUndefined();
  });

  it('打断修正型（打断案例1 插话1）：方向掀掉 → 原话直投主线，收尾后插话作为新回合开场重入', async () => {
    // 三值契约（刀 B）：掀方向不再有专属止损臂——判词落 inline，整句原话进
    // steerBus，主线模型下一轮自己消化；收尾没被 THINK 边界带走的按原话重入。
    const llm = scriptedLlm([
      { match: '读书会', cls: { verdict: 'inline', reason: 'the event itself was replaced', confidence: 0.9 } },
    ]);
    const h = makeHarness(llm);
    const insert = '等等，不是读书会了，改成 AI 工具实操工作坊，面向职场人，周日，30 人。';

    await h.chat.interject(insert);
    // 嘴/手分开（细化 1）：思考流不在飞（工具/判定期）不打断——不 abort，
    // 不落暂停账。原话已回显上屏（插话即回显，§〇）。
    expect(h.chat.abortController.signal.aborted).toBe(false);
    expect(userJoined(h.root)).toContain('实操工作坊');

    h.endTurn();
    expect(h.sends).toEqual([insert]);
    // 渲染一致性（重入静默化）：屏幕上用户原话只有一遍——重入只补历史账。
    expect(userJoined(h.root).split('实操工作坊').length - 1).toBe(1);
    expect(statusJoined(h.root)).not.toContain('方向变了');
  });

  it('打断修正型（打断案例1 插话3）：前提修正走同一条直投路', async () => {
    const llm = scriptedLlm([
      { match: '预算砍半', cls: { verdict: 'inline', reason: 'budget premise overturned', confidence: 0.85 } },
    ]);
    const h = makeHarness(llm);
    const insert = '预算砍半，不能请外部讲师，你自己出内容。';

    await h.chat.interject(insert);
    // 无在飞委派、思考流不在飞：原话直投，不掐流不落暂停账。
    expect(statusJoined(h.root)).not.toContain('方向变了');
    expect(h.chat.abortController.signal.aborted).toBe(false);

    h.endTurn();
    expect(h.sends).toEqual([insert]);
    expect(rowPending(h.root, '方向变了')).toBe(false);
  });

  it('开局插话的收执行不落会话最顶上：首回合消息未入账时锚在下一条消息之后', async () => {
    // 2026-09-29 用户报：开局插话改前提，翻历史会话第一行是收执标签，不是
    // 用户的输入。病根：首回合在飞时 this.messages 还是空的（用户消息收尾
    // 才入账），旧锚算法给 -1，flushStatuses(-1) 把行拼成事件流第 0 条。本
    // harness 就是这个窗口——全新控制器、零入账消息、回合在飞——修复后收
    // 执行锚 0（本回合用户消息将占的下标）。收执=receipt（裁决器现场写，
    // 随判词过河、steer 投递时落普通助手气泡），剧本带上 receipt 作锚定对象。
    const llm = scriptedLlm([
      { match: '预算砍半', cls: { verdict: 'inline', reason: 'budget premise overturned', confidence: 0.85, receipt: '对——讲师这条路不走了，我按你自己出内容重新安排。' } },
    ]);
    const h = makeHarness(llm);
    expect(h.chat.messages).toHaveLength(0);
    await h.chat.interject('预算砍半，不能请外部讲师，你自己出内容。');
    // 呈现层契约（2026-10-28）：收执是普通助手气泡（不再是 statusLines 里的
    // 状态行），回显气泡先落、收执锚在它后面。
    await flush();
    expect(assistantJoined(h.root)).toContain('讲师这条路不走了');
    expect(userJoined(h.root)).toContain('预算砍半');
    expect(statusJoined(h.root)).not.toContain('讲师这条路不走了');
  });

  it('模糊澄清型（澄清案例姿态 + 置信门）：破坏性判定没把握时先问一句，手头的活照跑', async () => {
    // 置信门消费面（细化 5）：三值后破坏性只剩整树停——低置信 + action:stop
    // 被 gate 降级 clarify，宿主先问不做。其余低置信 inline 照直投，不烦人。
    const llm = scriptedLlm(
      [{ match: '换个搞法', cls: { verdict: 'inline', reason: 'an overturn, but could also be a tweak', confidence: 0.35, action: 'stop' } }],
      { clarify: '你是想推倒当前方向重来吗？还是只是小调整？' },
    );
    const h = makeHarness(llm);

    await h.chat.interject('要不我们换个搞法？');
    // 门拦下了拆任务的动作：不 abort、不重排，先问。
    expect(h.chat.abortController.signal.aborted).toBe(false);
    expect(h.chat.streaming).toBe(true);
    // 用户的话上屏，问询按自己的读法问一句。
    expect(userJoined(h.root)).toContain('换个搞法');
    await flush();
    expect(assistantJoined(h.root)).toContain('推倒当前方向重来');
    // 临时回执的问题气泡接管对话——同一句话不留两行系统话。
    expect(statusJoined(h.root)).not.toContain('这句判定没把握');
  });

  it('主线相关追问（排队案例2 插话3）：老板问进度 → 边干边答，主线不动', async () => {
    const llm = scriptedLlm([
      { match: '老板', cls: { verdict: 'sideline', reason: 'status question, answer out-of-band', confidence: 0.9 } },
    ]);
    const h = makeHarness(llm);

    await h.chat.interject('我老板问报告什么时候好？');
    expect(h.chat.abortController.signal.aborted).toBe(false);
    expect(userJoined(h.root)).toContain('我老板问报告');
    // 旁答 = 普通助手气泡，答案本体直接上屏，无任何前缀/标签。
    expect(assistantJoined(h.root)).toContain('市场调研已完成大半');
    expect(assistantJoined(h.root)).not.toContain('（边干边答）');
    // 临时回执没留行（回答气泡本身就是反馈）。
    expect(statusJoined(h.root)).not.toContain('插话处理中');
  });

  it('1b question 入账：旁答后问答对折进运行回合（internal，重放不冒充用户）', async () => {
    const llm = scriptedLlm([
      { match: '老板', cls: { verdict: 'sideline', reason: 'status question, answer out-of-band', confidence: 0.9 } },
    ]);
    const h = makeHarness(llm);

    await h.chat.interject('我老板问报告什么时候好？');
    // 答案气泡无前缀（呈现层契约）；问答对已入账：internal 消息进 steer 队列，
    // 下个 THINK 边界模型读到，最终汇总与旁答口径一致；重放不把它渲染成用户
    // 气泡。
    expect(assistantJoined(h.root)).not.toContain('（边干边答）');
    const records = h.chat.steerBus.entries().filter((e: { message: { internal?: boolean } }) => e.message.internal);
    expect(records).toHaveLength(1);
    expect((records[0] as { message: { content: string } }).message.content).toContain('我老板问报告什么时候好');
    expect((records[0] as { message: { content: string } }).message.content).toContain('市场调研已完成大半');
    expect((records[0] as { displayText: string }).displayText).toBe('');
    // 回合就收尾：已答上的记录账已清——不再以任何形态重入。
    h.endTurn();
    expect(h.sends).toHaveLength(0);
  });

  it('1b 旁答失败：对话流沉默（无机制气泡），问题原话收尾重入（承诺兑现）', async () => {
    const llm = scriptedLlm([
      { match: '老板', cls: { verdict: 'sideline', reason: 'status question', confidence: 0.9 } },
    ], { question: '' });
    const h = makeHarness(llm);

    await h.chat.interject('我老板问报告什么时候好？');
    // 呈现层契约：失败改沉默——「旁答未完成」机制气泡退役，原话与空答案走
    // 账本回注。
    expect(statusJoined(h.root)).not.toContain('旁答未完成');
    const records = h.chat.steerBus.entries().filter((e: { message: { internal?: boolean } }) => e.message.internal);
    expect(records).toHaveLength(1);
    expect((records[0] as { displayText: string }).displayText).toBe('我老板问报告什么时候好？');
    // 回合收尾：没答上的问题按用户原话重入——「收尾时一并答」的承诺兑现。
    h.endTurn();
    expect(h.sends).toEqual(['我老板问报告什么时候好？']);
  });

  it('1c Esc 统一：第一下暂停（pause reason），暂停收尾期再按升级硬停', () => {
    const llm = scriptedLlm([]);
    const h = makeHarness(llm);

    // 第一档：暂停——abort 带 pause reason，出现「正在暂停」条。
    h.chat.escapeWhileStreaming();
    expect(h.chat.abortController.signal.aborted).toBe(true);
    expect(h.chat.abortController.signal.reason).toBe('pure:pause');
    expect(h.chat.pausedResumeBar?.dataset.state).toBe('pausing');

    // 第二档：收尾期里再按 = 升级硬停。主信号二次 abort 是 no-op（规范如此，
    // reason 换不掉），升级走第二通道：硬停信号立即点火，记账仍归暂停。
    h.chat.escapeWhileStreaming();
    expect(h.chat.hardStopController.signal.aborted).toBe(true);
    expect(h.chat.abortController.signal.reason).toBe('pure:pause');
  });

  it('1a 定向投递（判例1）：在飞时点名某支 → 直达那支（区分词点名），没点名才广播', async () => {
    // 剧本顺序=匹配语义：scriptedLlm 按数组序 find，而第二次 classify 的
    // 上下文里已带着第一次插话的历史（含「竞品」二字）——「方向」必须排在
    // 「竞品」前面，否则第二次判定会被历史命中拉回第一个剧本。
    const llm = scriptedLlm([
      { match: '方向', cls: { verdict: 'inline', reason: 'general tightening', confidence: 0.9, receipt: '两路在跑的调研都收到了——方向收紧这点，各自动作里带上。' } },
      { match: '竞品', cls: { verdict: 'inline', reason: 'redirect the competitor branch', confidence: 0.9, receipt: '竞品那路记下了，重点改看下沉市场的定价，其余的照跑。' } },
    ]);
    const h = makeHarness(llm);
    // 两支在飞（蓝本判例1 场景缩影），宿主唯一账本 agentActivities 供寻址。
    h.chat.agentActivities = [
      { callId: 'call_a', agentName: '市场调研员', agentRole: 'researcher', inputSnippet: '调研海外市场规模与增长趋势', status: 'running' },
      { callId: 'call_b', agentName: '竞品分析员', agentRole: 'analyst', inputSnippet: '分析主要竞品的定价策略', status: 'running' },
    ];

    // 点名：「竞品」「定价」只在竞品分析员的匹配面里 → 直达那支，其余照跑。
    // 收执=裁决器现场写的两句（2026-10-27 固定口径三族全废）。
    await h.chat.interject('竞品那支重点看下沉市场的定价。');
    expect(assistantJoined(h.root)).toContain('竞品那路记下了，重点改看下沉市场的定价，其余的照跑。');
    expect(h.chat.steerBus.entries()).toHaveLength(1);
    expect(h.chat.steerBus.entries()[0].target).toEqual({ branchCallId: 'call_b', branchName: '竞品分析员' });
    expect(h.chat.steerBus.entries()[0].displayText).toBe('竞品那支重点看下沉市场的定价。');

    // 没点名：候选词两边都不沾 → 分不清宁可广播，给在飞的全体。现场收执
    // 里的「两路」等于真实在飞数（2026-09-28 收执纪律：两支就说两路，不空说）。
    await h.chat.interject('方向都再收紧一点。');
    expect(assistantJoined(h.root)).toContain('两路在跑的调研都收到了——方向收紧这点，各自动作里带上。');
    expect(h.chat.steerBus.entries()).toHaveLength(2);
    expect(h.chat.steerBus.entries()[1].target).toBe('all');
  });

  it('约束转达与叫停：steer 沉默转达；停也是裁决器的判定', async () => {
    // 剧本顺序=匹配语义：scriptedLlm 按数组序 find，第二次分类的上下文里
    // 已带着第一次插话的历史（含「口语」二字）——「停下」必须排在前面。
    const llm = scriptedLlm([
      { match: '停下', cls: { verdict: 'inline', reason: 'user halts everything', confidence: 0.95, action: 'stop' } },
      { match: '口语', cls: { verdict: 'inline', reason: 'style tweak', confidence: 0.9 } },
    ]);
    const h = makeHarness(llm);

    await h.chat.interject('报告文案再口语一点。');
    // 单任务场景（无委派在飞）：话进 pure 自己下个 THINK 边界。沉默化
    // （2026-10-28 刀 2）：steerFallbackReceipt 固定句族已删——剧本没写
    // receipt 就沉默退场，原话进引擎上下文本身就是兑现，绝不出机械腔。
    expect(assistantJoined(h.root) + statusJoined(h.root)).not.toContain('手头的活不停');
    expect(h.chat.abortController.signal.aborted).toBe(false);
    // 回合收尾时没被 THINK 边界带走的 steer，作为下一回合开场——不丢。
    // 1a + 渲染一致性（2026-09-25）：重入是用户原话，不是引擎框架文——
    // 框架只在插话真被 THINK 边界注入时才存在，重开回合是用户自己的新指令。
    h.endTurn();
    expect(h.sends).toHaveLength(1);
    expect(h.sends[0]).toContain('报告文案再口语一点。');
    expect(h.sends[0]).not.toContain('【用户插话·顺路带上】');
    // 渲染一致性（2026-10-27 重入静默化）：残留重入只补历史账不再画气泡
    // ——插话时 echoUser 已显示过，屏幕上用户原话始终只有一遍。
    expect(userJoined(h.root).split('报告文案再口语一点。').length - 1).toBe(1);

    // 停也是裁决器的判定（2026-10-28 刀 1：STOP_RE 字面快路径已删）——
    // 剧本判 action:"stop"，宿主只留 abort 掐流的机械动作。
    const classifyCount = llm.classifyCalls.length;
    h.chat.streaming = true;
    h.chat.abortController = new AbortController();
    await h.chat.interject('停下');
    expect(llm.classifyCalls.length).toBe(classifyCount + 1);
    // 停的收执随裁决走（刀 2 沉默化）：剧本没写 receipt→引擎沉默退场，
    // abort 掐流本身由状态呈现，宿主不出固定停腔。
    expect(statusJoined(h.root)).not.toContain('收到，停');
    expect(h.chat.abortController.signal.aborted).toBe(true);
    // 沉默退场：ack 行摘掉，账自始平。
    expect(rowPending(h.root, '收到，停')).toBe(false);
    h.endTurn();
    expect(rowPending(h.root, '收到，停')).toBe(false);
  });

  it('委派在飞时加活（澄清案例的姿态）：排队收尾后跑，不再折入汇合轮', async () => {
    // 刀 B：加活的专属铺排（折入/早派链）随 new_task 臂退役——判词落
    // new_task 就排队，当前回合收尾后自动开新轮消化。
    const llm = scriptedLlm([]);
    const h = makeHarness(llm);
    h.chat.agentActivities.push({ role: '市场 Agent', status: 'running' });

    // 裁决器判新活（new_task=收齐后补的第二项），宿主排队。
    await h.chat.interject('再加一个爱奇艺平台');
    expect(llm.classifyCalls.length).toBe(1);
    // 沉默化：裁决器没写 receipt 就不出机械腔（队列在账不在流）。
    expect(assistantJoined(h.root) + statusJoined(h.root)).not.toContain('收齐后先补这项');
    expect(userJoined(h.root)).toContain('爱奇艺平台');
    // 排队在账：折入账干净（早派/折入铺排已退役），收尾派发从队头走。
    expect(h.chat.folds.entries()).toHaveLength(0);
    expect(h.chat.roundClose.queueView()).toHaveLength(1);
    expect(queueCard(h.root)).toBeUndefined();
  });

  it('早派链退役（刀 2.2 早派随 new_task 臂清场）：加活一律排队，不再当场派出', async () => {
    // 旧路径（折入汇合轮/早派并行补跑）整链退役：编排器在不在都不再当场
    // 派出——加活的执行时点统一为「当前回合收尾后」。锁退役面：执行账空、
    // 折入账空、排队账恰一件。
    const h = makeHarness(scriptedLlm([]));
    h.chat.agentActivities.push({ callId: 'call_a', agentName: '平台调研员', status: 'running', inputSnippet: '调研平台技术栈' });
    const executed: Array<{ id: string; function: { name: string; arguments: string } }> = [];
    h.chat.codingAgentRef = {
      subagentOrchestrator: {
        execute: (call: { id: string; function: { name: string; arguments: string } }) => {
          executed.push(call);
          return Promise.resolve({ success: true, result: { output: '' } });
        },
      },
    };
    h.chat.activeTurnUserText = '调研三大视频平台的技术栈';

    await h.chat.interject('再加一个小红书');
    // 呈现层沉默 + 无机械旁白（反向锁照旧）。
    expect(assistantJoined(h.root) + statusJoined(h.root)).not.toContain('已经直接派出去补跑了');
    expect(assistantJoined(h.root)).not.toContain('收齐后先补这项');
    // 早派退役的铁证：当场没派出（哪怕编排器在场），活进排队账。
    expect(executed).toHaveLength(0);
    expect(h.chat.folds.entries()).toHaveLength(0);
    expect(h.chat.roundClose.queueView()).toHaveLength(1);
    expect(h.chat.roundClose.queueView()[0].displayText).toBe('再加一个小红书');
  });

  it('早派补跑失败链退役：失败报告通道不复存在，加活照排队', async () => {
    // 早派链的失败报告（prepareFoldDelivery 注入「补跑没有成功」）随整链退
    // 役——排队路没有"当场跑失败"这个形态，活由收尾后的新轮自己跑。
    const h = makeHarness(scriptedLlm([]));
    h.chat.agentActivities.push({ callId: 'call_a', agentName: '平台调研员', status: 'running', inputSnippet: '调研平台技术栈' });
    h.chat.codingAgentRef = {
      subagentOrchestrator: {
        execute: () => Promise.reject(new Error('分支已中断')),
      },
    };
    h.chat.activeTurnUserText = '调研三大视频平台的技术栈';

    await h.chat.interject('再加一个小红书');
    expect(h.chat.folds.entries()).toHaveLength(0);
    expect(h.chat.roundClose.queueView()).toHaveLength(1);
    expect(assistantJoined(h.root) + statusJoined(h.root)).not.toContain('补跑没有成功');
  });

  it('委派在飞时收掉一项（2026-09-24 取消案例）：无点名取消话原话直投主线，不折入不排队', async () => {
    // 三值契约（刀 B）：cancelsPart 不再过河——宿主不再从判词里抠「这是
    // 取消」另走折入臂；取消话判 inline 就整句直投，主线模型下一轮消化
    // （「先没停」的坦白与「停掉 XX 那支」的指引改由提示词收执纪律承担）。
    const llm = scriptedLlm([
      { match: '就不调研', cls: { verdict: 'inline', reason: 'removes the named part from the join', confidence: 0.95 } },
    ]);
    const h = makeHarness(llm);
    h.chat.agentActivities.push({ role: '调研 Agent', status: 'running' });

    await h.chat.interject('jev 这个就不调研了');
    expect(llm.classifyCalls.length).toBe(1);
    // 固定取消口径已退役（反向锁）：不出「这项不做了」机械腔。
    expect(assistantJoined(h.root)).not.toContain('这项不做了');
    expect(userJoined(h.root)).toContain('jev 这个就不调研了');
    // 折入账干净：取消话不再折入守汇报步（该账只服务点名停支没停成的落点）。
    expect(h.chat.folds.entries()).toHaveLength(0);
    expect(queueCard(h.root)).toBeUndefined();
    // 直投兑现：话在转向通道里（委派在飞、未点名 → 广播全体）。
    expect(h.chat.steerBus.entries()).toHaveLength(1);
    expect(h.chat.steerBus.entries()[0].target).toBe('all');
    // 收尾没被 THINK 边界带走的按原话重入——话绝不丢。
    h.endTurn();
    expect(h.sends).toEqual(['jev 这个就不调研了']);
  });

  it('委派在飞时点名停一支（第 2 期分支中断）：点名归裁决器，宿主按确切 id 暂停', async () => {
    // 2026-10-28 刀 1 后「停哪支」的判断全在裁决器：分类上下文带
    // <live_branches> 花名册，判词点名确切 call_id，宿主只核实执行——
    // 单支集合兜底与聚焦窄问是字面快路径的宿主侧残留，随刀 1 一并清。
    const llm = scriptedLlm([
      { match: '竞品', cls: { verdict: 'inline', reason: 'user names the branch to stop', confidence: 0.95, stop_branch: { call_id: 'call_a' }, receipt: '明白——「竞品分析员」那支先停了，断点留着，随时说一声就续上。' } },
    ]);
    const h = makeHarness(llm);
    h.chat.agentActivities.push({ callId: 'call_a', agentName: '竞品分析员', status: 'running', inputSnippet: '调研竞品定价策略' });
    const paused: string[] = [];
    h.chat.codingAgentRef = {
      subagentOrchestrator: {
        branchView: () => [{ callId: 'call_a', agentName: '竞品分析员', state: 'running' }],
        pauseBranch: (callId: string) => { paused.push(callId); return true; },
        abortBranch: () => false,
      },
    };

    await h.chat.interject('停掉竞品那支。');
    expect(llm.classifyCalls.length).toBe(1); // 停哪支是理解，判定一次完成
    expect(paused).toEqual(['call_a']); // 宿主照裁决器指认的 id 暂停（收掉一项=暂停口径）
    // 收执随裁决走（2026-10-28 刀 2：branchStopReceipt 固定话术已删——
    // 剧本写了就转达，缺席沉默）。
    expect(assistantJoined(h.root)).toContain('明白——「竞品分析员」那支先停了');
    expect(userJoined(h.root)).toContain('停掉竞品那支');
    // 真停不走折入/投递账：汇合轮没有这笔，steer 池也是空的。
    expect(h.chat.folds.entries()).toHaveLength(0);
    expect(h.chat.steerBus.entries()).toHaveLength(0);
  });

  it('多支在飞：停哪支归裁决器；指认不出的取消话原话直投主线（不机械停支）', async () => {
    // 「停掉那支」有锚无名——两支都可能是"那支"。三值契约（刀 B）：无
    // stop_branch 点名的取消话 = inline 直投，宿主零机械动作（既不停也不
    // 折入）——「stopping it is never your move」的提示词锚 + 主线模型带
    // 现场消化是唯一防线，宿主绝不广播停支（每支都可能把自己当"那支"，
    // 反向执行最伤）。
    const llm = scriptedLlm([
      { match: '停掉', cls: { verdict: 'inline', reason: 'wants one specific branch gone but cannot name it', confidence: 0.95 } },
    ]);
    const h = makeHarness(llm);
    h.chat.agentActivities.push(
      { callId: 'call_a', agentName: '竞品分析员', status: 'running', inputSnippet: '调研竞品定价策略' },
      { callId: 'call_b', agentName: '平台调研员', status: 'running', inputSnippet: '调研平台技术栈' },
    );
    const aborted: string[] = [];
    h.chat.codingAgentRef = {
      subagentOrchestrator: {
        branchView: () => [
          { callId: 'call_a', agentName: '竞品分析员', state: 'running' },
          { callId: 'call_b', agentName: '平台调研员', state: 'running' },
        ],
        abortBranch: (callId: string) => { aborted.push(callId); return true; },
      },
    };

    await h.chat.interject('停掉那支。');
    expect(llm.classifyCalls.length).toBe(1);
    expect(aborted).toHaveLength(0); // 指认不出绝不停支（宿主零词表零猜测）
    expect(h.chat.folds.entries()).toHaveLength(0);
    expect(assistantJoined(h.root)).not.toContain('这项不做了');
    // 原话直投：话进主线消化（未点名 → 广播），不在停支/折入账里。
    expect(h.chat.steerBus.entries()).toHaveLength(1);
    expect(h.chat.steerBus.entries()[0].target).toBe('all');
  });

  it('裁决器从花名册指认被停支（2026-10-10 症状：不要评审了）→ 宿主按确切 id 真停', async () => {
    // 真实症状：代码评审阶段唯一一支在飞，用户「不要评审了，直接给我看接
    // 轨」。旧链路宿主拿用户话去匹配任务书，措辞差一点就点不中，在飞支
    // 全程不停。新链路：分类上下文带 <live_branches> 花名册，裁决器指认
    // 确切 callId，宿主只执行——判断在模型，动作在宿主。
    const llm = scriptedLlm([
      { match: '评审', cls: { verdict: 'inline', reason: 'removes the review part from the plan', confidence: 0.95, stop_branch: { call_id: 'call_review' }, receipt: '明白——「审查员」那路我先暂停了，其余照常。' } },
    ]);
    const h = makeHarness(llm);
    h.chat.agentActivities.push({ callId: 'call_review', agentName: '审查员', agentRole: '代码评审', status: 'running', inputSnippet: '对照规范逐条审查代码' });
    const paused: string[] = [];
    h.chat.codingAgentRef = {
      subagentOrchestrator: {
        branchView: () => [
          { callId: 'call_review', agentName: '审查员', state: 'running', inputSnippet: '对照规范逐条审查代码' },
        ],
        pauseBranch: (callId: string) => { paused.push(callId); return true; },
        abortBranch: () => false,
      },
    };

    await h.chat.interject('不要评审了，直接给我看接轨');
    expect(llm.classifyCalls.length).toBe(1); // 判定一次完成，点名随判定带回
    expect(paused).toEqual(['call_review']); // 宿主照 id 执行
    // 收执随裁决走（2026-10-28 刀 2：branchStopReceipt 固定话术已删）。
    expect(assistantJoined(h.root)).toContain('明白——「审查员」那路我先暂停了');
    expect(h.chat.folds.entries()).toHaveLength(0);
  });

  it('裁决器指认的支已结算：不硬停，退回取消折入并如实说没停', async () => {
    // 花名册有迟滞（agentActivities 投影 vs 编排器权威账）：指认的 id 在
    // branchView 里已不在飞时，宿主拒绝执行——宁可折入如实说，绝不拿错
    // id 停错支。
    const llm = scriptedLlm([
      { match: '评审', cls: { verdict: 'inline', reason: 'removes the review part', confidence: 0.95, stop_branch: { call_id: 'call_gone' } } },
    ]);
    const h = makeHarness(llm);
    h.chat.agentActivities.push({ callId: 'call_gone', agentName: '审查员', status: 'running' });
    const touched: string[] = [];
    h.chat.codingAgentRef = {
      subagentOrchestrator: {
        branchView: () => [], // 那支刚好结算：权威账里已无在飞支
        pauseBranch: (callId: string) => { touched.push(callId); return true; },
        abortBranch: (callId: string) => { touched.push(callId); return true; },
      },
    };

    await h.chat.interject('不要评审了');
    expect(touched).toHaveLength(0);
    expect(h.chat.folds.entries()).toHaveLength(1);
    expect(h.chat.folds.entries()[0].cancels).toBe(true);
    expect(assistantJoined(h.root)).toContain('先没停');
  });

  it('复测案例一（2026-09-25）：加的活某支已经在跑——回「已经在跑着了」，不重复派', async () => {
    // 真实事故：三路并行调研里爱奇艺本来就在跑，用户「新增一个平台，爱奇艺」
    // 被当加活折入，收齐后还真派了第四支重跑一遍。不重复做：加活先对在飞/
    // 已收工的支认一遍，认得出覆盖就如实回话，不折入不排队。
    const llm = scriptedLlm([]); // 分类器按剧本默认判 task（真实链路同款）
    const h = makeHarness(llm);
    h.chat.agentActivities.push(
      { callId: 'call_a', agentName: '优酷调研员', status: 'running', inputSnippet: '调研优酷最新国漫上新信息' },
      { callId: 'call_b', agentName: 'B站调研员', status: 'running', inputSnippet: '调研B站最新国漫上新信息' },
      { callId: 'call_c', agentName: '爱奇艺调研员', status: 'running', inputSnippet: '调研爱奇艺最新国漫上新信息' },
    );

    await h.chat.interject('新增一个平台，爱奇艺');
    expect(assistantJoined(h.root)).toContain('您说的这个正在「爱奇艺调研员」那路跑着，不重复派——收齐后一并汇总给您。');
    expect(userJoined(h.root)).toContain('新增一个平台，爱奇艺');
    // 重复的那支永远不该被派出去：折入账是空的，排队也不发生。
    expect(h.chat.folds.entries()).toHaveLength(0);
    expect(queueCard(h.root)).toBeUndefined();
  });

  it('复测案例二（2026-09-25）：收掉一项 = 裁决器点名暂停那一支，不烧完不空折入', async () => {
    // 真实事故：「不要调研"未来三年的爆发点"这个了」被折入等汇合——支照跑
    // 算力照烧，最后才从结果里删。2026-10-10 起点名是模型的事（模型判断、
    // 宿主执行）：分类上下文带着 <live_branches> 花名册，裁决器指认确切
    // call_id，宿主按 id 真停（不落中止），其余照跑——宿主不再做任何文本匹配。
    const llm = scriptedLlm([
      { match: '爆发点', cls: { verdict: 'inline', reason: 'removes the named research item', confidence: 0.95, stop_branch: { call_id: 'call_burst' }, receipt: '明白——「爆发点分析员」那路我先暂停了，它的产出不进最终汇总；其余照常跑，想续上随时说。' } },
    ]);
    const h = makeHarness(llm);
    h.chat.agentActivities.push(
      { callId: 'call_trend', agentName: '趋势调研员', status: 'running', inputSnippet: '探索 agent 开发技术趋势' },
      { callId: 'call_llm', agentName: '方向调研员', status: 'running', inputSnippet: 'LLM 的发展方向研判' },
      { callId: 'call_burst', agentName: '爆发点分析员', status: 'running', inputSnippet: '研判未来三年的爆发点' },
    );
    const paused: string[] = [];
    h.chat.codingAgentRef = {
      subagentOrchestrator: {
        branchView: () => [
          { callId: 'call_trend', agentName: '趋势调研员', state: 'running', inputSnippet: '探索 agent 开发技术趋势' },
          { callId: 'call_llm', agentName: '方向调研员', state: 'running', inputSnippet: 'LLM 的发展方向研判' },
          { callId: 'call_burst', agentName: '爆发点分析员', state: 'running', inputSnippet: '研判未来三年的爆发点' },
        ],
        pauseBranch: (callId: string) => { paused.push(callId); return true; },
        abortBranch: () => false,
      },
    };

    await h.chat.interject('不要调研"未来三年的爆发点"这个了');
    expect(llm.classifyCalls.length).toBe(1); // 取消裁决来自裁决器，不再走正则
    expect(paused).toEqual(['call_burst']);   // 按裁决器指认的 id 暂停那一支
    // 收执随裁决走（2026-10-28 刀 2：branchStopReceipt 固定话术已删——
    // 剧本写了就转达，缺席沉默）。
    expect(assistantJoined(h.root)).toContain('明白——「爆发点分析员」那路我先暂停了，它的产出不进最终汇总');
    // 真停了就不再折入：汇合轮没有这笔账。
    expect(h.chat.folds.entries()).toHaveLength(0);
    expect(h.chat.steerBus.entries()).toHaveLength(0);
  });

  it('复测案例二串台（2026-09-25）：取消话被判成 task、但报上了 cancels_part——仍真停，绝不回「不重复派」', async () => {
    // 真机串台形态：取消话被分类器判成 task，宿主若只看 kind 就会把它送进
    // 去重检查，回出「已经在调研着了，不重复派」——答非所问，支还在烧。
    // 契约驱动：kind 错了不要紧，cancels_part + stop_branch 在就不会反向执行
    // ——2026-10-10 起连「停哪支」也在契约里（裁决器指认 call_id）。
    const llm = scriptedLlm([
      { match: '取消', cls: { verdict: 'new_task', reason: 'misjudged as an addition, flag still set', confidence: 0.9, stop_branch: { call_id: 'call_burst' }, receipt: '明白——「爆发点分析员」那路我先暂停了，它的产出不进最终汇总。' } },
    ]);
    const h = makeHarness(llm);
    h.chat.agentActivities.push(
      { callId: 'call_trend', agentName: '趋势调研员', status: 'running', inputSnippet: '探索 agent 开发技术趋势' },
      { callId: 'call_burst', agentName: '爆发点分析员', status: 'running', inputSnippet: '研判未来三年的爆发点' },
    );
    const paused: string[] = [];
    h.chat.codingAgentRef = {
      subagentOrchestrator: {
        branchView: () => [
          { callId: 'call_trend', agentName: '趋势调研员', state: 'running', inputSnippet: '探索 agent 开发技术趋势' },
          { callId: 'call_llm', agentName: '方向调研员', state: 'running', inputSnippet: 'LLM 的发展方向研判' },
          { callId: 'call_burst', agentName: '爆发点分析员', state: 'running', inputSnippet: '研判未来三年的爆发点' },
        ],
        pauseBranch: (callId: string) => { paused.push(callId); return true; },
        abortBranch: () => false,
      },
    };

    await h.chat.interject('把"未来三年的爆发点"这个调研取消掉');
    expect(llm.classifyCalls.length).toBe(1); // 不走快路径——正是分类器判 task 的串台形态
    expect(paused).toEqual(['call_burst']);   // 仍按裁决器指认的 id 真停
    const status = statusJoined(h.root) + assistantJoined(h.root);
    // 收执随裁决走：复核/主判的现场 receipt 是停支收执唯一来源。
    expect(status).toContain('明白——「爆发点分析员」那路我先暂停了');
    expect(status).not.toContain('不重复派'); // 去重回执绝不准碰取消话
    expect(h.chat.folds.entries()).toHaveLength(0);
    expect(h.chat.steerBus.entries()).toHaveLength(0);
  });

  it('宿主不再嗅关键词：task 判定没带 cancels_part 时，取消味也不改道（2026-09-28 定调）', async () => {
    // 旧行为：话里只要带取消味（CANCELISH_RE 的 不需/不用/不要/取消/停…），task
    // 判定就被改成取消路。那条粗筛已删——宿主不在裁决器之外另立一套判断，
    // 否则同一个句子在两边可能被读成相反的两件事。
    // 契约的代价在这里如实地钉住：分类器漏报 cancels_part 时，这句会按普通
    // task 处理（排队），提示词里那句「即使判成 task 也必须报」是唯一防线。
    const llm = scriptedLlm([
      { match: '取消', cls: { verdict: 'new_task', reason: 'read as an addition, no flag', confidence: 0.9 } },
    ]);
    const h = makeHarness(llm);
    // 委派不在飞：判定落在队列路径，才好断言“没被改道成取消”。

    await h.chat.interject('把「市场格局」这份调研取消掉');
    const said = assistantJoined(h.root) + statusJoined(h.root);
    expect(said).not.toContain('收掉了');
    expect(h.chat.folds.entries()).toHaveLength(0);
    expect(queueCard(h.root)).toBeUndefined(); // 呈现层契约：排队无卡，账在 roundClose
  });

  it('混着加活的取消话整句直投主线：停支零动作，要加的活不被一并停掉', async () => {
    // 「B站那支别查了，再加一个爱奇艺」——三值契约把多部分消息当一句判
    // （最远的部分定 verdict，其余主线自然消化）。判 inline = 整句原话到主
    // 线，宿主零机械动作：不停支（cancelsPart 闸随 A 刀退役，宿主本就无停
    // 支词表）、不折入、不排队——怎么拆「收掉的一半 + 加上的一半」是主线
    // 模型的理解活。
    const llm = scriptedLlm([
      { match: 'B站', cls: { verdict: 'inline', reason: 'removes one part while adding another', confidence: 0.9 } },
    ]);
    const h = makeHarness(llm);
    h.chat.agentActivities.push({ callId: 'call_price', agentName: '价格调研员', status: 'running', inputSnippet: '调研各平台均价' });
    const paused: string[] = [];
    h.chat.codingAgentRef = {
      subagentOrchestrator: {
        branchView: () => [
          { callId: 'call_price', agentName: '价格调研员', state: 'running', inputSnippet: '调研各平台均价' },
        ],
        pauseBranch: (callId: string) => { paused.push(callId); return true; },
        abortBranch: () => false,
      },
    };

    await h.chat.interject('B站那支别查了，再加一个爱奇艺');
    expect(paused).toHaveLength(0); // 一句混话不停支
    expect(h.chat.folds.entries()).toHaveLength(0);
    expect(assistantJoined(h.root)).not.toContain('这项不做了');
    // 整句直投（未点名 → 广播），主线下一轮连收带加一起消化。
    expect(h.chat.steerBus.entries()).toHaveLength(1);
    expect(h.chat.steerBus.entries()[0].target).toBe('all');
  });

  it('同名多支时收执带序号：researcher·2号，用户对得上号', async () => {
    // 真机观感：两支同名 researcher，收执里裸的「researcher」指不清是哪支。
    // 同名不止一支时收执引用带 instanceNo（researcher·2号）。复核剧本给
    // cancels_part:false——真加活（补一个新平台）由复核明确背书，配「不
    // 重复派」终稿；复核没结论时的兜底是暂停（见下一条），不能混在这里。
    const llm = scriptedLlm([
      { match: 'dedupe_conflict', cls: { verdict: 'new_task', reason: 'genuinely adds a new platform, iqiyi', confidence: 0.9, cancels_part: false } },
    ]);
    const h = makeHarness(llm);
    h.chat.agentActivities.push(
      { callId: 'call_r1', agentName: 'researcher', instanceNo: 1, status: 'running', inputSnippet: '调研优酷最新国漫上新' },
      { callId: 'call_r2', agentName: 'researcher', instanceNo: 2, status: 'running', inputSnippet: '调研爱奇艺最新国漫上新' },
    );

    await h.chat.interject('新增一个平台，爱奇艺');
    expect(assistantJoined(h.root)).toContain('您说的这个正在「researcher·2号」那路跑着，不重复派——收齐后一并汇总给您。');
  });

  it('复测三连击（2026-10-20 真机）：裁决器漏报 cancels_part 的取消话撞上去重——复核裁决接住，绝不回「不重复派」', async () => {
    // 真机形态：四路平台调研在飞，用户三句取消（「去掉优酷的调研」「我说
    // 不需要优酷的」「暂停优酷」）全被裁决器判成 task 且没报 cancels_part
    // ——掉进去重终稿「不重复派——收齐后一并汇总」，同一句逐字顶回三次，
    // 支烧完汇总还带着用户明确去掉的东西。
    // 复核裁决（同日，替换试过的词表闸——取消措辞穷举不尽）：判成 task 却
    // 撞上"已在跑"是矛盾信号，宿主把现场事实喂给复核。2026-10-21 真机二连
    // 后复核走独立窄问题提示词（decider.recheckCovered）——剧本第二遍命
    // 中 user 消息里的 <dedupe_conflict> 顶层块，按复核输出契约报
    // cancels_part——走取消落地臂折入守汇报步。真加活照旧终稿：「新增一
    // 个平台，爱奇艺」上一条测试锁死。
    const llm = scriptedLlm([
      { match: 'dedupe_conflict', cls: { verdict: 'new_task', reason: 'recheck: the wording removes a running branch', confidence: 0.9, cancels_part: true } },
      { match: '优酷', cls: { verdict: 'new_task', reason: 'read as an addition, no flag', confidence: 0.9 } },
      { match: '暂停', cls: { verdict: 'new_task', reason: 'read as an addition, no flag', confidence: 0.9 } },
    ]);
    const h = makeHarness(llm);
    h.chat.agentActivities.push(
      { callId: 'call_r1', agentName: 'researcher', instanceNo: 1, status: 'running', inputSnippet: '调研腾讯视频国漫剧集' },
      { callId: 'call_r2', agentName: 'researcher', instanceNo: 2, status: 'running', inputSnippet: '调研优酷国漫剧集' },
      { callId: 'call_r3', agentName: 'researcher', instanceNo: 3, status: 'running', inputSnippet: '调研B站国漫剧集' },
      { callId: 'call_r4', agentName: 'researcher', instanceNo: 4, status: 'running', inputSnippet: '调研芒果TV国漫剧集' },
    );
    // 复核没点名 stop_branch 时宿主不机械停支——话折给模型终裁。
    const paused: string[] = [];
    h.chat.codingAgentRef = {
      subagentOrchestrator: {
        branchView: () => [],
        pauseBranch: (callId: string) => { paused.push(callId); return true; },
        abortBranch: () => false,
      },
    };

    for (const line of ['去掉 优酷的调研', '我说不需要优酷的', '暂停优酷']) {
      await h.chat.interject(line);
    }
    const said = assistantJoined(h.root) + statusJoined(h.root);
    expect(said).not.toContain('不重复派');
    expect(paused).toEqual([]); // 无点名：折入守汇报步，不机械停
    const folds = h.chat.folds.entries();
    expect(folds).toHaveLength(3);
    for (const fold of folds) expect(fold.cancels).toBe(true);
    // 双气泡防回归（2026-10-20 真机「不要优酷了」×2）：fold 自带回显，闸臂
    // 手动 echo 会出两份用户气泡。三句输入各恰一份。
    expect(h.root.querySelectorAll('.bubble-row.user')).toHaveLength(3);
  });

  it('复核点名 stop_branch 时真停那支：带现场重判让漏报的取消精确落地', async () => {
    // 复核的价值不止"不吞话"：带着「哪支在跑」的事实单独问一遍（独立窄问
    // 题提示词），模型能点名 call_id——宿主直接暂停那一支，比无目标折入更
    // 早止损。
    const llm = scriptedLlm([
      { match: 'dedupe_conflict', cls: { verdict: 'new_task', reason: 'recheck: removal of the named branch', confidence: 0.9, cancels_part: true, stop_branch: { call_id: 'call_r2' }, receipt: '明白——「researcher·2号」那路我先暂停了，其余照常。' } },
      { match: '优酷', cls: { verdict: 'new_task', reason: 'read as an addition, no flag', confidence: 0.9 } },
    ]);
    const h = makeHarness(llm);
    h.chat.agentActivities.push(
      { callId: 'call_r2', agentName: 'researcher', instanceNo: 2, status: 'running', inputSnippet: '调研优酷国漫剧集' },
      { callId: 'call_r3', agentName: 'researcher', instanceNo: 3, status: 'running', inputSnippet: '调研B站国漫剧集' },
    );
    const paused: string[] = [];
    h.chat.codingAgentRef = {
      subagentOrchestrator: {
        branchView: () => [
          { callId: 'call_r2', agentName: 'researcher', state: 'running', inputSnippet: '调研优酷国漫剧集' },
          { callId: 'call_r3', agentName: 'researcher', state: 'running', inputSnippet: '调研B站国漫剧集' },
        ],
        pauseBranch: (callId: string) => { paused.push(callId); return true; },
        abortBranch: () => false,
      },
    };

    await h.chat.interject('去掉 优酷的调研');
    expect(paused).toEqual(['call_r2']); // 复核点名→精确暂停
    // 收执随裁决走：复核现场写的 receipt 是这条停支收执的唯一来源。
    expect(assistantJoined(h.root)).toContain('明白——「researcher·2号」那路我先暂停了');
    expect(assistantJoined(h.root) + statusJoined(h.root)).not.toContain('不重复派');
    expect(h.chat.folds.entries()).toHaveLength(0);
  });

  it('复核没结论（超时/失败）时兜底反转：暂停 covered 那支，绝不任其继续（2026-10-21 真机三连，方向性）', async () => {
    // 真机账本：主判定→终稿恰 8003ms = 复核 8s 超时 → null → 旧兜底回「不
    // 重复派」终稿，用户说了「不需要」的活继续烧。用户定调「方向性问题，
    // 大 bug」：拿不准要选可逆的一边——误停一支说一声就续上；该停不停是
    // 当着用户的面背叛。复核 null + covered running → 宿主直接暂停命中那
    // 支（callId 是 covered 命中给的宿主事实，不需要模型点名），收执诚实
    // 交代没拿准+给出恢复口。scriptedLlm 的 fallback 会给复核喂回一个成功
    // 的 task 判定（那走的是「明确判加活」路），所以这里用局部 llm 让复核
    // 调用输出非 JSON——真模拟解析失败 → null。
    const classifyCalls: string[] = [];
    const llm = {
      classifyCalls,
      async *stream(messages: Array<{ content: unknown }>) {
        const user = String(messages[1]?.content ?? '');
        classifyCalls.push(user);
        const payload = user.includes('dedupe_conflict')
          ? '模型这回合没说出人话' // 复核调用：解析失败 → null
          : JSON.stringify({ verdict: 'new_task', reason: 'misread as addition', confidence: 0.9 });
        yield { type: 'content', content: payload };
        yield { type: 'done', content: payload };
      },
      async complete() { return { content: '' }; },
    } as never;
    const h = makeHarness(llm);
    h.chat.agentActivities.push(
      { callId: 'call_r2', agentName: 'researcher', instanceNo: 2, status: 'running', inputSnippet: '调研优酷国漫剧集' },
      { callId: 'call_r3', agentName: 'researcher', instanceNo: 3, status: 'running', inputSnippet: '调研B站国漫剧集' },
    );
    const paused: string[] = [];
    h.chat.codingAgentRef = {
      subagentOrchestrator: {
        branchView: () => [
          { callId: 'call_r2', agentName: 'researcher', state: 'running', inputSnippet: '调研优酷国漫剧集' },
          { callId: 'call_r3', agentName: 'researcher', state: 'running', inputSnippet: '调研B站国漫剧集' },
        ],
        pauseBranch: (callId: string) => { paused.push(callId); return true; },
        abortBranch: () => false,
      },
    };

    await h.chat.interject('不需要优酷的调研');
    expect(paused).toEqual(['call_r2']); // 拿不准：暂停命中的那支，可逆
    const said = assistantJoined(h.root) + statusJoined(h.root);
    expect(said).not.toContain('不重复派');
    expect(said).toContain('没拿准'); // 诚实收执：不装「明白」
    expect(said).toContain('researcher·2号');
    expect(said).toContain('接着跑'); // 给出恢复口
    expect(h.root.querySelectorAll('.bubble-row.user')).toHaveLength(1); // 单气泡（2026-10-20 双气泡判例）
  });

  it('分类器把取消误判成普通话时：无点名取消话照 inline 直投，绝不排队（2026-09-28 定调）', async () => {
    // 宿主不嗅关键词的代价面在刀 B 落到提示词防线：cancelsPart 不再过河，
    // 判词落 inline 就整句直投主线——取消味的话绝不会因为「没带信号」而
    // 被当活排队；宿主照旧零词表零改道。
    const llm = scriptedLlm([
      { match: '收掉', cls: { verdict: 'inline', reason: 'misjudge', confidence: 0.9 } },
    ]);
    const h = makeHarness(llm);
    h.chat.agentActivities.push({ role: '调研 Agent', status: 'running' });

    await h.chat.interject('知乎那项也收掉吧');
    expect(llm.classifyCalls.length).toBe(1);
    expect(assistantJoined(h.root)).not.toContain('这项不做了');
    expect(h.chat.folds.entries()).toHaveLength(0);
    // 直投兑现：话进转向通道（未点名 → 广播），绝不在队列里。
    expect(h.chat.roundClose.queueView()).toHaveLength(0);
    expect(h.chat.steerBus.entries()).toHaveLength(1);
    expect(queueCard(h.root)).toBeUndefined();
    h.endTurn();
    expect(h.sends).toEqual(['知乎那项也收掉吧']);
  });

  it('第 2 期第三刀：点名把一支已暂停的委派接着跑完——同参重派命中存档，回执说清从哪轮接', async () => {
    // 用户真机诉求：「把 jev 那支接着跑完」。名字是代号，点名靠区分词；
    // 关键在"用原始参数"——稳定 sessionId 命中 checkpoint，子引擎 continue。
    // 点名归裁决器（2026-10-28 刀 1：RESUME_BRANCH_RE 快路径已删）——判词
    // 点 resumes_branch 的 call_id，宿主只核实执行。
    const llm = scriptedLlm([
      { match: '竞品那支', cls: { verdict: 'inline', reason: 'resume the named paused branch', confidence: 0.95, resumes_branch: { call_id: 'call_b' } } },
    ]);
    const h = makeHarness(llm);
    h.chat.agentActivities = [
      { callId: 'call_b', agentName: '竞品分析员', agentRole: 'analyst', inputSnippet: '分析主要竞品的定价策略', status: 'paused' },
      { callId: 'call_a', agentName: '市场调研员', agentRole: 'researcher', inputSnippet: '调研海外市场规模', status: 'running' },
    ];
    // 原始参数在委派批次起飞时被 gateDelegations 捕获（同参重派的唯一凭据）。
    h.chat.delegationControl.delegationArgs.set('call_b', { name: 'competitor_analyst', args: '{"prompt":"分析主要竞品的定价策略"}' });
    // 判例 14 端到端：真存档真的在——编排器 stableSessionId 同口径落一份
    // checkpoint（persist-before-settle 的手工等价），probe 预检才有东西可读。
    const resumeArgs = { prompt: '分析主要竞品的定价策略' };
    const archiveId = SubagentOrchestrator.stableSessionId(h.chat.sessionId, 'competitor_analyst', resumeArgs);
    await h.chat.subagentStore.saveCheckpoint(archiveId, {
      version: 1,
      label: 'subagent_interrupted',
      createdAt: Date.now(),
      state: { messages: [{ role: 'user', content: '分析主要竞品的定价策略' }], turnCount: 12 },
    });

    // 裁决器点名 resumes_branch：判定一次往返，宿主核实后同参重派。
    await h.chat.interject('把竞品那支接着跑完。');
    expect(llm.classifyCalls.length).toBe(1);
    // 回执诚实二分（判例 14 验收语）：命中存档必须说清从哪轮接的。
    expect(assistantJoined(h.root)).toContain('续跑：「竞品分析员」从存档断点（第 12 轮）接上。等手头这批收齐接上。');
    expect(assistantJoined(h.root)).not.toContain('没找到存档');
    expect(userJoined(h.root)).toContain('把竞品那支接着跑完');
    // 排上了同参重派：**原始参数**原样，不是新任务。
    expect(h.chat.delegationControl.pendingResumesView()).toHaveLength(1);
    expect(h.chat.delegationControl.pendingResumesView()[0].name).toBe('competitor_analyst');
    expect(h.chat.delegationControl.pendingResumesView()[0].args).toBe('{"prompt":"分析主要竞品的定价策略"}');
    // 凭据随记录走：排队记录里的预检读数与收执同源。
    expect(h.chat.delegationControl.pendingResumesView()[0].checkpoint).toEqual({ hit: true, turns: 12 });
    // 续跑既不是折入也不是普通 steer：两个池子都干净。
    expect(h.chat.folds.entries()).toHaveLength(0);
    expect(h.chat.steerBus.entries()).toHaveLength(0);
  });

  it('第 2 期第三刀：续跑点名但存档不在（store 空）——回执明说没存档会重跑，不许预支断点承诺', async () => {
    // 反面对照（判例 14 下半句）：「resume 找不到断点不许悄悄从头跑——
    // 明说『没找到存档，重新跑了』」。收执不能比机制许的愿更多。
    // 点名归裁决器（刀 1 后 resumes_branch 随判词来）：store 空，probe 必 miss。
    const llm = scriptedLlm([
      { match: '竞品那支', cls: { verdict: 'inline', reason: 'resume the named paused branch', confidence: 0.95, resumes_branch: { call_id: 'call_b' } } },
    ]);
    const h = makeHarness(llm); // subagentStore 是空镜像（测试无 Tauri invoker）：probe 必 miss
    h.chat.agentActivities = [
      { callId: 'call_b', agentName: '竞品分析员', agentRole: 'analyst', inputSnippet: '分析主要竞品的定价策略', status: 'paused' },
    ];
    h.chat.delegationControl.delegationArgs.set('call_b', { name: 'competitor_analyst', args: '{"prompt":"分析主要竞品的定价策略"}' });

    await h.chat.interject('把竞品那支接着跑完。');
    // 无在飞委派 → 收执不带「等手头这批」尾巴（诚实二分的 pending 半边）。
    expect(assistantJoined(h.root)).toContain('续跑：「竞品分析员」——没找到存档，会重新跑一遍。');
    expect(assistantJoined(h.root)).not.toContain('断点'); // 没命中绝不预支断点承诺
    // 照排不误：话不丢，重派照做（只是收执诚实）。
    expect(h.chat.delegationControl.pendingResumesView()).toHaveLength(1);
    expect(h.chat.delegationControl.pendingResumesView()[0].checkpoint).toEqual({ hit: false, turns: 0 });
  });

  it('第 2 期第三刀：同参重派没赶上 THINK 边界——收尾转成排队的新指令，话绝不丢', async () => {
    // 点名归裁决器（刀 1 后 resumes_branch 随判词来），宿主核实排队。
    const llm = scriptedLlm([
      { match: '竞品那支', cls: { verdict: 'inline', reason: 'resume the named paused branch', confidence: 0.95, resumes_branch: { call_id: 'call_b' } } },
    ]);
    const h = makeHarness(llm);
    h.chat.agentActivities = [
      { callId: 'call_b', agentName: '竞品分析员', status: 'paused', inputSnippet: '分析主要竞品的定价策略' },
    ];
    h.chat.delegationControl.delegationArgs.set('call_b', { name: 'competitor_analyst', args: '{"prompt":"分析主要竞品的定价策略"}' });

    await h.chat.interject('把竞品那支接着跑完。');
    expect(h.chat.delegationControl.pendingResumesView()).toHaveLength(1);
    // 回合在落地前就收尾了：兜底把它当用户的新指令重入（父从上下文重派）。
    h.endTurn();
    expect(h.chat.delegationControl.pendingResumesView()).toHaveLength(0);
    expect(h.sends).toHaveLength(1);
    expect(h.sends[0]).toContain('把竞品那支接着跑完');
  });

  it('第 2 期第三刀：点不出具体支（无暂停支/打平）——退回普通 steer，让父模型重派', async () => {
    // 裁决器照样点名（resumes_branch 随判词来），但宿主核实不过——
    // stoppedBranches 投影是空的，callId 点不到停止面花名册 = 按普通插话
    // 落回 steer，宿主不猜、不越权改判。
    const llm = scriptedLlm([
      { match: '竞品那支', cls: { verdict: 'inline', reason: 'resume the named paused branch', confidence: 0.95, resumes_branch: { call_id: 'call_b' } } },
    ]);
    const h = makeHarness(llm);
    h.chat.agentActivities = []; // 没有可续跑的候补

    await h.chat.interject('把竞品那支接着跑完。');
    expect(h.chat.delegationControl.pendingResumesView()).toHaveLength(0);
    // 退回 steer（转达父引擎），话不丢。
    expect(h.chat.steerBus.entries()).toHaveLength(1);
  });
});

// ── 思考窗吸收 + 推倒重想（2026-09-27 画鸟排队事故 + 用户定调）──────────────
// 用户在预检思考还活着时补一句"背景上加一些会动的云朵"——这是往正在产出的
// 那一张图里加内容，不是第二件活。排队把它拆成两件事（先画鸟、再单独补云），
// 而队列的活还会丢（真实事故：排队的活没派发，图上永远没有云）。正确
// 动作：趁模型还在想，把话并进请求一起想，而且不是旧思考接着用——约束类的
// 话（"诗句里一定要出现明月"）必须长进构图里，吸收即置重启请求掐掉在飞的
// 思考流，send() 用并账后的请求推倒重想。

describe('思考窗吸收：正在产出的那一件东西改了构图', () => {
  it('画鸟时补云（steer+supplements_current）：不排队、不折入——并进请求一起想', async () => {
    const llm = scriptedLlm([
      { match: '云朵', cls: { verdict: 'inline', reason: 'adds elements INSIDE the one picture being produced', confidence: 0.9 } },
    ]);
    const h = makeHarness(llm);
    h.chat.interjectOrchestrator.openPreflightWindow(); // 预检思考（planByThinking）还在流式进行

    await h.chat.interject('背景上加一些会动的云朵');
    // 回执走系统腔，不是排队的话术；排队无卡（呈现层契约）。
    expect(assistantJoined(h.root)).toContain('已并入补充，重新规划…');
    expect(queueCard(h.root)).toBeUndefined();
    expect(h.chat.roundClose.queueView()).toHaveLength(0);
    expect(h.chat.folds.entries()).toHaveLength(0);
    // 重启请求已挂号：send() 的重启循环看到它 + 暂存非空，就用并账后的
    // 请求重开一轮思考（约束长进构图里，不是旧思考上后贴）。
    expect(h.chat.interjectOrchestrator.wasPreflightRestarted()).toBe(true);
    // 用户原话上屏（转写对得上谁说了什么），临时回执不留状态行。
    expect(userJoined(h.root)).toContain('云朵');
    expect(statusJoined(h.root)).not.toContain('推倒');

    // 落进思考窗暂存，等 planByThinking 返回时并进请求正文。
    expect(h.chat.interjectOrchestrator.pendingPreflightCount()).toBe(1);
    const merged = h.chat.applyPreflightSupplements('给我画一个动态的图片，图片内容是一只小鸟在天空飞翔', []);
    expect(merged).toContain('一只小鸟在天空飞翔');
    expect(merged).toContain('【你在思考时补充】背景上加一些会动的云朵');
    // 并账即清账：同一段补充不会并两次（引擎第一轮 + canonical 各看一遍是
    // 同一份合并文本，不是两次拼接）。
    expect(h.chat.interjectOrchestrator.pendingPreflightCount()).toBe(0);
    expect(h.chat.applyPreflightSupplements('再来一句', [])).toBe('再来一句');
  });

  it('分类器把构图内补充误判成新活：吸收集合是封闭的——不吸收，照排队回告', async () => {
    // 画鸟事故的防线换了位置：三值提示词把构图内加内容判 inline（上一条锁
    // 死吸收路）。吸收判据 = verdict inline 且无专门信号——误路由成新活就
    // 照排队并回告，绝不静默吞进思考窗。吸收越权吞新活与排队拆构图是同一
    // 枚硬币的两面，这条锁住反面。
    const llm = scriptedLlm([
      { match: '云朵', cls: { verdict: 'new_task', reason: 'scope addition, but INSIDE the current deliverable', confidence: 0.9 } },
    ]);
    const h = makeHarness(llm);
    h.chat.interjectOrchestrator.openPreflightWindow();

    await h.chat.interject('背景上加一些会动的云朵');
    expect(llm.classifyCalls.length).toBe(1);
    // 没被吸收：暂存空，进排队账——绝不静默吞进思考窗。沉默化（刀 2）：
    // 「这句排上了」固定话术已删；呈现层契约（2026-10-28）队列卡也退役，
    // 排队事实在 roundClose 账里（queueView 仍有这件）。
    expect(h.chat.interjectOrchestrator.pendingPreflightCount()).toBe(0);
    expect(queueCard(h.root)).toBeUndefined();
    expect(h.chat.roundClose.queueView()).toHaveLength(1);
    expect(assistantJoined(h.root) + statusJoined(h.root)).not.toContain('排上了');
  });

  it('取消话不是加内容：思考窗开着也不吸收，照走取消路', async () => {
    // "云朵那个就不要了"——吸收判据要求无专门信号；带 stop_branch 点名的
    // 取消话在吸收检查之前就被机械臂消费（专门宿主信号比语义分流精确），
    // 图上该消失的云不会因为被吸收进构图而留下。
    const llm = scriptedLlm([
      { match: '云朵', cls: { verdict: 'inline', reason: 'removes one element', confidence: 0.9, stop_branch: { call_id: 'call_cloud' } } },
    ]);
    const h = makeHarness(llm);
    h.chat.interjectOrchestrator.openPreflightWindow();

    await h.chat.interject('云朵那个就不要了');
    expect(h.chat.interjectOrchestrator.pendingPreflightCount()).toBe(0);
    // 取消路照走：stop_branch 点名（roster 空核实不过）→ 起飞闸挂号 + 转达父引擎。
    expect(h.chat.delegationControl.pendingCancelCount()).toBe(1);
    expect(queueCard(h.root)).toBeUndefined();
  });

  it('思考窗内事实纠错（premise-change）：吸收推倒重想，绝不拆回合（2026-09-28 jev 案例）', async () => {
    // 真实事故：调研三个热点思考中，用户看见 pure 把 jev 当成 JEPA，纠正
    // "你对jev的理解是错误的，jev是2026年9月新发布的模型"——三个子 agent
    // 照旧按错前提派出。premise-change 的原路是拆回合重入：思考期原请求
    // 还没落账，新回合只剩纠错这一句，要重做的事反而丢了。窗内纠错的正确
    // 动作只有一种：并进请求、推倒重想。
    const llm = scriptedLlm([
      { match: 'jev', cls: { verdict: 'inline', reason: 'corrects a fact the plan is built on', confidence: 0.9 } },
    ]);
    const h = makeHarness(llm);
    h.chat.interjectOrchestrator.openPreflightWindow();

    await h.chat.interject('你对jev的理解是错误的，jev是2026年9月新发布的模型');
    expect(assistantJoined(h.root)).toContain('已并入补充，重新规划…');
    expect(h.chat.interjectOrchestrator.pendingPreflightCount()).toBe(1);
    expect(h.chat.interjectOrchestrator.wasPreflightRestarted()).toBe(true);
    // 不拆回合：重入通道没被占用、回合没被掐——思考流由重启请求掐，重开
    // 时带着原始请求 + 并账的纠正。
    expect(h.chat.roundClose.hasHeldInsert()).toBe(false);
    expect(h.chat.roundClose.queueView()).toHaveLength(0);
    expect(queueCard(h.root)).toBeUndefined();
    const merged = h.chat.applyPreflightSupplements('从多个方面调研一下当前AI的三个热点', []);
    expect(merged).toContain('jev是2026年9月新发布的模型');
  });

  it('窗内普通 steer（分类器没给 supplements_current）也吸收：窗内没有别的活，思考就是唯一兑现点', async () => {
    // 事故直因：纠错被分类器判成 steer 落 pendingSteers——"下个动作带上"
    // 的承诺在思考期没有别的兑现点，等计划定型后才被看见就晚了。窗内
    // steer 一律吸收，不再赌分类器记得打标记。
    const llm = scriptedLlm([
      { match: 'jev', cls: { verdict: 'inline', reason: 'a correction to carry forward', confidence: 0.9 } },
    ]);
    const h = makeHarness(llm);
    h.chat.interjectOrchestrator.openPreflightWindow();

    await h.chat.interject('你对jev的理解是错误的，jev是2026年9月新发布的模型');
    expect(h.chat.interjectOrchestrator.pendingPreflightCount()).toBe(1);
    expect(h.chat.interjectOrchestrator.wasPreflightRestarted()).toBe(true);
    expect(h.chat.steerBus.entries()).toHaveLength(0);
  });

  it('窗内方向推翻（goal-change）：吸收重想，不拆回合', async () => {
    // 思考期"推翻重来" = 带着新方向重新想。原路拆回合会把原请求丢在
    // 落账前（首回合 canonical 是空的）——吸收重想一样兑现，还更省。
    const llm = scriptedLlm([
      { match: '换个思路', cls: { verdict: 'inline', reason: 'overturns the approach', confidence: 0.9 } },
    ]);
    const h = makeHarness(llm);
    h.chat.interjectOrchestrator.openPreflightWindow();

    await h.chat.interject('换个思路，别做俄罗斯方块了，做贪吃蛇');
    expect(assistantJoined(h.root)).toContain('已并入补充，重新规划…');
    expect(h.chat.interjectOrchestrator.pendingPreflightCount()).toBe(1);
    expect(h.chat.roundClose.hasHeldInsert()).toBe(false);
  });

  it('刀 3.1 攒批：重想在飞时新补充只入暂存不掐流；开窗复位后照走原路', async () => {
    // 事件驱动攒批（附-5 事件版）：第一句补充已并账重开（markPreflightRethink
    // 挂号）后，重想流在飞期间再到的补充只入暂存——在飞的重想流完，宿主一次
    // 带上全部。N 句补充不再 N 次废生成 N 次重启。
    const llm = scriptedLlm([
      { match: '晚霞', cls: { verdict: 'inline', reason: 'adds elements INSIDE the one picture being produced', confidence: 0.9 } },
    ]);
    const h = makeHarness(llm);
    h.chat.interjectOrchestrator.openPreflightWindow();
    h.chat.interjectOrchestrator.markPreflightRethink();
    const ac = new AbortController();
    h.chat.interjectOrchestrator.beginPreflightThought(ac);

    await h.chat.interject('天上再补一缕晚霞');
    expect(h.chat.interjectOrchestrator.pendingPreflightCount()).toBe(1);
    // 攒批的铁证：流没被掐、重启请求不挂号——收口靠 planByThinking 的暂存检查。
    expect(ac.signal.aborted).toBe(false);
    expect(h.chat.interjectOrchestrator.wasPreflightRestarted()).toBe(false);
    expect(assistantJoined(h.root)).toContain('已并入补充，重新规划…');

    // 开窗复位：新窗第一轮是原思考轮——同样的话照走原路（置重启请求 + 掐流）。
    h.chat.interjectOrchestrator.closePreflightWindow();
    h.chat.interjectOrchestrator.openPreflightWindow();
    await h.chat.interject('云朵再加一朵');
    expect(h.chat.interjectOrchestrator.pendingPreflightCount()).toBe(2);
    expect(h.chat.interjectOrchestrator.wasPreflightRestarted()).toBe(true);
    expect(ac.signal.aborted).toBe(true);
  });

  it('思考窗关了（思考已完、产出已在跑）：同样的补充不吸收，走普通 steer', async () => {
    // planByThinking 已经返回，请求正文并不进去了——此刻的补充只能转达给
    // 在跑的回合（下个 THINK 边界带上），收尾没被带走的按用户原话重入。
    const llm = scriptedLlm([
      { match: '云朵', cls: { verdict: 'inline', reason: 'supplement, but the window is closed', confidence: 0.9 } },
    ]);
    const h = makeHarness(llm);
    // planPreflightActive 默认 false：真实链路里 applyPreflightSupplements
    // 的 finally 已把它关上。

    await h.chat.interject('背景上加一些会动的云朵');
    expect(h.chat.interjectOrchestrator.pendingPreflightCount()).toBe(0);
    expect(h.chat.steerBus.entries()).toHaveLength(1);
    expect(queueCard(h.root)).toBeUndefined();
  });

  it('排队事故的兜底不回归：不相关的新活照样排队（账在，无卡）', async () => {
    // 吸收只管"正在产出的那一件东西"；第二件活（画完图后要一份年报）还是
    // 走队列——这是一条路上的两件事，不是一件东西的构图变了。
    const llm = scriptedLlm([
      { match: '年报', cls: { verdict: 'new_task', reason: 'a second, unrelated deliverable', confidence: 0.9 } },
    ]);
    const h = makeHarness(llm);
    h.chat.interjectOrchestrator.openPreflightWindow();

    await h.chat.interject('顺便再帮我写一份 Q4 年报。');
    expect(h.chat.interjectOrchestrator.pendingPreflightCount()).toBe(0);
    // 排队无卡（呈现层契约）：账在 roundClose，队列里恰好一件。
    expect(queueCard(h.root)).toBeUndefined();
    expect(h.chat.roundClose.queueView()).toHaveLength(1);
  });

  it('分类上下文看得到正在跑的请求：第一回合 canonical 还空着，活回合手里有原话', async () => {
    // 事故根因之一：分类器当时看到的"当前任务"是一句占位——canonical 要等
    // 回合结束才落账，第一回合插话时它就是空的，"加几朵云"自然被判成新任务。
    // 修后 buildInsertionContext 优先读 liveTurn.userText。
    const h = makeHarness(scriptedLlm([]));
    const ctx = h.chat.buildInsertionContext([]);
    expect(ctx).toContain('Q3 海外市场进入方案'); // liveTurn.userText（beginLiveTurn 存的）
    expect(ctx).not.toContain('用户当前诉求：（当前任务）');
    expect(ctx).not.toContain('用户当前诉求：\n');
    // 思考窗开着时，分类器要知道手头的活是"正在想"——premise-change vs
    // steer 的时机判据就靠这一行（jev 纠错案例）。
    h.chat.interjectOrchestrator.openPreflightWindow();
    expect(h.chat.buildInsertionContext([])).toContain('正在思考这个任务的规划');
    h.chat.interjectOrchestrator.closePreflightWindow();
  });

  it('空闲即扫除：setStreaming(false) 自己触发派发——收尾代码断了队列也不丢', async () => {
    // 事故根因之三：派发定时器只在 send() finally 末尾一处装上，前面任何
    // 一步抛出就永远不装了。修后"落到空闲"这个事实本身就是扫除信号。
    const llm = scriptedLlm([
      { match: '云朵', cls: { verdict: 'new_task', reason: 'unrelated errand', confidence: 0.9 } },
    ]);
    const h = makeHarness(llm);

    await h.chat.interject('背景上加一些会动的云朵');
    expect(queueCard(h.root)).toBeUndefined(); // 排队无卡（呈现层契约）
    // 不调 endTurn（不手动收尾派发）：只把流态置空。
    h.chat.setStreaming(false);
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(h.sends).toEqual(['背景上加一些会动的云朵']);
    expect(queueCard(h.root)).toBeUndefined();
  });

  it('排队路的临时回执不留幽灵账：摘行的同时销账，回放不再凭空多一句', async () => {
    // 真实会话实证：画图会话的事件流第 0 条就是一条插话即时回执（旧文案
    // "收到——看一下这句话怎么安排…"）——ack 行被直接 remove() 后账本里的
    // 记录还在，快照把它拼回去。
    const llm = scriptedLlm([
      { match: '云朵', cls: { verdict: 'new_task', reason: 'unrelated errand', confidence: 0.9 } },
    ]);
    const h = makeHarness(llm);

    await h.chat.interject('背景上加一些会动的云朵');
    const ghosts = (h.chat.statusLines as Array<{ text: string }>).filter((l) => l.text.includes('插话处理中'));
    expect(ghosts).toHaveLength(0);
    // 屏上也确实没有这行（沉默退场）。
    expect(statusJoined(h.root)).not.toContain('插话处理中');
  });
});

// ── 插话回执的次序与形态（2026-09-25 用户实测）────────────────────────────

describe('插话回执次序与形态', () => {
  it('判定期间有流式行插进来：用户原话仍在回执前面（多 agent 在飞必现的顺序倒挂）', async () => {
    // 真实事故：ack 先上屏，秒级判定期间在飞回合不断往转写末尾流行内容，
    // 回显走末尾追加 → 用户的话沉到流式行下面、回执压在原话头上。修后回显
    // 插队到 ack 行正前，不管中间落了多少行，顺序永远是【原话 → 回话】。
    let chat: Record<string, any> | null = null;
    const llm = scriptedLlm([
      { match: '爱奇艺', during: () => chat?.addStatusBubble('（在飞回合插进来的流式行）正在整理B站数据…', false), cls: { verdict: 'new_task', reason: 'r', confidence: 0.9 } },
    ]);
    const h = makeHarness(llm);
    chat = h.chat;
    h.chat.agentActivities.push(
      { callId: 'call_a', agentName: '爱奇艺调研员', status: 'running', inputSnippet: '调研爱奇艺最新国漫上新信息' },
    );

    await h.chat.interject('新增一个平台，爱奇艺');
    const rows = h.root.querySelectorAll('.bubble-row');
    const texts = rows.map((r) => r.textContent);
    const userIdx = texts.findIndex((t) => t.includes('新增一个平台'));
    const receiptIdx = rows.findIndex((r) => String(r.className).includes('assistant') && r.textContent.includes('不重复派'));
    expect(userIdx).toBeGreaterThan(-1);
    expect(receiptIdx).toBeGreaterThan(userIdx); // 原话在前，pure 在后
  });

  it('终稿回执是普通助手气泡，不再是状态行', async () => {
    const llm = scriptedLlm([]);
    const h = makeHarness(llm);
    h.chat.agentActivities.push({ callId: 'call_a', agentName: '爱奇艺调研员', status: 'running', inputSnippet: '调研爱奇艺最新国漫上新信息' });

    await h.chat.interject('新增一个平台，爱奇艺');
    const receiptRow = h.root.querySelectorAll('.bubble-row.assistant').find((r) => r.textContent.includes('不重复派'));
    expect(receiptRow).toBeTruthy();
    // 收执带 pure 名（正常气泡的标签），且不再以状态行的样子出现。
    expect(receiptRow!.textContent).toContain('pure');
    expect(statusJoined(h.root)).not.toContain('不重复派');
  });
});

// ── 「有新内容」tip（2026-09-25 用户实测串台）──────────────────────────────

describe('「有新内容」tip 会话串台', () => {
  it('切走会话时 pill 就地收掉，不替下一个会话串台', () => {
    // 真实事故：多会话来回切，A 会话滚出底部后亮起的 tip 在切到 B 后还挂
    // 在静态 #chat-view 上——替 B 串台。pill 只属于可见会话：切走即收。
    const h = makeHarness(scriptedLlm([]));
    const doc = (globalThis as { document?: { getElementById: (id: string) => FakeElement | null } }).document!;
    const chatEl = doc.getElementById('chat')!;
    const chatView = doc.getElementById('chat-view')!;
    expect(chatView.children).toHaveLength(0);

    // 真实链路的接线（send() 同款）：滚动框 + pill 观察。
    wireScrollPin(chatEl as unknown as HTMLElement);
    wireNewContentHint(chatEl as unknown as HTMLElement);
    setPinnedToBottom(chatEl as unknown as HTMLElement, false); // 用户上翻读历史
    scrollChatToBottomIfPinned(chatEl as unknown as HTMLElement); // 内容到达 → 应亮

    const pill = chatView.children.find((c) => String((c as FakeElement).className).includes('new-content-hint'));
    expect(pill).toBeTruthy();

    // 切走（setViewActive 是所有会话切换的公共口）：pill 必须跟着走。
    h.chat.setViewActive(false);
    expect(chatView.children.filter((c) => String((c as FakeElement).className).includes('new-content-hint'))).toHaveLength(0);
  });
});
