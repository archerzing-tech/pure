// src/ui/__tests__/conversationSamples.test.ts
// 样本回放：/Users/ericever/Documents/samples.txt 里的理想对话案例，在宿主
// 侧（GUI 对话流）逐条跑通。回放的不是字符串，而是真链路——真
// DynamicInsertionCoordinator（含置信门/时刻解析/快路径正则）、真分发
// switch、真 DOM 回执与活队列卡；只有两处是假的：分类 LLM（按样本剧本
// 给判定）和引擎 send（记录派发载荷）。模型回合的表达姿态（结论先行、
// 子 Agent 摘要、变化点清单）不在宿主侧，不进本文件。

import { describe, expect, it, afterEach } from 'bun:test';
import { ChatController, setTimedInputSink, wireNewContentHint } from '../chat';
import { wireScrollPin, setPinnedToBottom, scrollChatToBottomIfPinned, setScrollPinObservers } from '../scrollPin';

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
    const incoming = (node as FakeElement)[FRAGMENT] ? [...(node as FakeElement).children] : [node];
    this.children.splice(at, 0, ...incoming);
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
  kind: string;
  reason: string;
  confidence: number;
  when?: string;
  /** 与真模型按提示词契约回的字段同名（蛇形）——剧本原样 JSON.stringify，
   *  走 classifyInsertion 的真解析，回放保真。 */
  cancels_part?: boolean;
}

interface ScriptedLlm {
  stream(messages: Array<{ content: string }>): AsyncGenerator<{ type: string; content: string }, void, void>;
  complete(messages: Array<{ content: string }>): Promise<{ content?: string }>;
  classifyCalls: string[];
}

function scriptedLlm(
  classifications: Array<{ match: string; cls: ScriptedClassification }>,
  answers: { clarify?: string; question?: string } = {},
): ScriptedLlm {
  const classifyCalls: string[] = [];
  return {
    classifyCalls,
    async *stream(messages) {
      const user = String(messages[1]?.content ?? '');
      classifyCalls.push(user);
      const hit = classifications.find((c) => user.includes(c.match));
      const payload: ScriptedClassification = hit?.cls
        ?? { kind: 'task', reason: 'unmatched script line', confidence: 0.9 };
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
      chat.dispatchDeferred();
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
      { match: '北京天气', cls: { kind: 'task', reason: 'unrelated errand', confidence: 0.9 } },
      { match: '东京的机票', cls: { kind: 'task', reason: 'unrelated errand', confidence: 0.9 } },
      // 样本插话 4 是"提醒我今晚买牛奶"——带时刻的诉求不进队列，进排期。
      { match: '买牛奶', cls: { kind: 'task', reason: 'life reminder with a time', confidence: 0.9, when: '今晚 19:30' } },
    ]);
    const h = makeHarness(llm);

    await h.chat.interject('对了，明天北京天气怎么样？');
    // 队列卡上屏；临时回执没留行，用户的话也没有二次回显——卡就是回执。
    const card = queueCard(h.root);
    expect(card).toBeDefined();
    expect(card!.textContent).toContain('待办队列（1 件）');
    expect(card!.textContent).toContain('明天北京天气');
    expect(statusJoined(h.root)).not.toContain('收到——看一下这句话怎么安排');
    expect(userJoined(h.root)).not.toContain('北京天气');

    await h.chat.interject('顺便帮我看看上海到东京的机票。');
    // 同一张卡就地重渲染（永远只有一张），顺序保持。
    expect(h.root.querySelectorAll('.queue-card')).toHaveLength(1);
    const text = queueCard(h.root)!.textContent;
    expect(text).toContain('待办队列（2 件）');
    expect(text.indexOf('北京天气')).toBeGreaterThan(-1);
    expect(text.indexOf('东京的机票')).toBeGreaterThan(text.indexOf('北京天气'));

    await h.chat.interject('提醒我今晚买牛奶。');
    // 定时的走了宿主排期：用户的话上屏 + 已排期回执；不占待办队列。
    expect(sinkCalls).toHaveLength(1);
    expect(sinkCalls[0].text).toBe('提醒我今晚买牛奶。');
    expect(sinkCalls[0].at).toBeGreaterThan(Date.now());
    expect(statusJoined(h.root)).toContain('已排期');
    expect(userJoined(h.root)).toContain('买牛奶');
    expect(queueCard(h.root)!.textContent).toContain('待办队列（2 件）');

    // 主线收尾 → 交接先说一声，再从队头派发；卡同步掉到 1 件。
    h.endTurn();
    expect(h.sends).toEqual(['对了，明天北京天气怎么样？']);
    expect(statusJoined(h.root)).toContain('手头的活收尾了——先处理排队的，这后面还排着 1 件。');
    expect(queueCard(h.root)!.textContent).toContain('待办队列（1 件）');

    // 再收尾 → 最后一件照跑，卡撤掉。
    h.endTurn();
    expect(h.sends).toEqual(['对了，明天北京天气怎么样？', '顺便帮我看看上海到东京的机票。']);
    expect(statusJoined(h.root)).toContain('手头的活收尾了——现在处理刚才排下的那件。');
    expect(queueCard(h.root)).toBeUndefined();
  });

  it('打断修正型（打断案例1 插话1）：方向掀掉 → 认下+止损回执，收尾后插话作为新回合开场重入', async () => {
    const llm = scriptedLlm([
      { match: '读书会', cls: { kind: 'goal-change', reason: 'the event itself was replaced', confidence: 0.9 } },
    ]);
    const h = makeHarness(llm);
    const insert = '等等，不是读书会了，改成 AI 工具实操工作坊，面向职场人，周日，30 人。';

    await h.chat.interject(insert);
    // 认下 + 定性 + 影响面 + 下一步，一行回执原行定格；abort 还在收尾，微光撑着。
    expect(statusJoined(h.root)).toContain('方向变了——在跑的先停下止损，已完成的不丢，马上按新的方向来。');
    expect(h.chat.abortController.signal.aborted).toBe(true);
    expect(rowPending(h.root, '方向变了')).toBe(true);
    // 不预回显：重入 send() 时作为新回合开场气泡上屏，先回显 = 同句话两遍。
    expect(userJoined(h.root)).not.toContain('实操工作坊');

    h.endTurn();
    expect(h.sends).toEqual([insert]);
    // 承诺兑现（新方向已开跑），微光停。
    expect(rowPending(h.root, '方向变了')).toBe(false);
  });

  it('打断修正型（打断案例1 插话3）：前提修正走同一条止损链', async () => {
    const llm = scriptedLlm([
      { match: '预算砍半', cls: { kind: 'premise-change', reason: 'budget premise overturned', confidence: 0.85 } },
    ]);
    const h = makeHarness(llm);
    const insert = '预算砍半，不能请外部讲师，你自己出内容。';

    await h.chat.interject(insert);
    expect(statusJoined(h.root)).toContain('前提变了——按旧前提跑下去只会白跑，先停下止损，马上按纠正后的事实重新来。');
    expect(h.chat.abortController.signal.aborted).toBe(true);

    h.endTurn();
    expect(h.sends).toEqual([insert]);
    expect(rowPending(h.root, '前提变了')).toBe(false);
  });

  it('模糊澄清型（澄清案例姿态 + 置信门）：破坏性判定没把握时先问一句，手头的活照跑', async () => {
    const llm = scriptedLlm(
      [{ match: '换个搞法', cls: { kind: 'goal-change', reason: 'an overturn, but could also be a tweak', confidence: 0.35 } }],
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
    expect(statusJoined(h.root)).not.toContain('先不动手——这句话我拿不准');
  });

  it('主线相关追问（排队案例2 插话3）：老板问进度 → 边干边答，主线不动', async () => {
    const llm = scriptedLlm([
      { match: '老板', cls: { kind: 'question', reason: 'status question, answer out-of-band', confidence: 0.9 } },
    ]);
    const h = makeHarness(llm);

    await h.chat.interject('我老板问报告什么时候好？');
    expect(h.chat.abortController.signal.aborted).toBe(false);
    expect(userJoined(h.root)).toContain('我老板问报告');
    expect(assistantJoined(h.root)).toContain('（边干边答）市场调研已完成大半');
    // 临时回执没留行（回答气泡本身就是反馈）。
    expect(statusJoined(h.root)).not.toContain('看一下这句话怎么安排');
  });

  it('1b question 入账：旁答后问答对折进运行回合（internal，重放不冒充用户）', async () => {
    const llm = scriptedLlm([
      { match: '老板', cls: { kind: 'question', reason: 'status question, answer out-of-band', confidence: 0.9 } },
    ]);
    const h = makeHarness(llm);

    await h.chat.interject('我老板问报告什么时候好？');
    expect(assistantJoined(h.root)).toContain('（边干边答）');
    // 问答对已入账：internal 消息进 steer 队列，下个 THINK 边界模型读到，
    // 最终汇总与旁答口径一致；重放不把它渲染成用户气泡。
    const records = h.chat.pendingSteers.filter((e: { message: { internal?: boolean } }) => e.message.internal);
    expect(records).toHaveLength(1);
    expect((records[0] as { message: { content: string } }).message.content).toContain('我老板问报告什么时候好');
    expect((records[0] as { message: { content: string } }).message.content).toContain('市场调研已完成大半');
    expect((records[0] as { displayText: string }).displayText).toBe('');
    // 回合就收尾：已答上的记录账已清——不再以任何形态重入。
    h.endTurn();
    expect(h.sends).toHaveLength(0);
  });

  it('1b 旁答失败不静默：明说没答上，问题原话收尾重入（承诺兑现）', async () => {
    const llm = scriptedLlm([
      { match: '老板', cls: { kind: 'question', reason: 'status question', confidence: 0.9 } },
    ], { question: '' });
    const h = makeHarness(llm);

    await h.chat.interject('我老板问报告什么时候好？');
    expect(statusJoined(h.root)).toContain('这个问题我暂时没答上来');
    const records = h.chat.pendingSteers.filter((e: { message: { internal?: boolean } }) => e.message.internal);
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
    const llm = scriptedLlm([
      { match: '竞品', cls: { kind: 'steer', reason: 'redirect the competitor branch', confidence: 0.9 } },
      { match: '方向', cls: { kind: 'steer', reason: 'general tightening', confidence: 0.9 } },
    ]);
    const h = makeHarness(llm);
    // 两支在飞（蓝本判例1 场景缩影），宿主唯一账本 agentActivities 供寻址。
    h.chat.agentActivities = [
      { callId: 'call_a', agentName: '市场调研员', agentRole: 'researcher', inputSnippet: '调研海外市场规模与增长趋势', status: 'running' },
      { callId: 'call_b', agentName: '竞品分析员', agentRole: 'analyst', inputSnippet: '分析主要竞品的定价策略', status: 'running' },
    ];

    // 点名：「竞品」「定价」只在竞品分析员的匹配面里 → 直达那支，其余照跑。
    await h.chat.interject('竞品那支重点看下沉市场的定价。');
    expect(statusJoined(h.root)).toContain('已直接转给「竞品分析员」那一路——它下个动作就带上，其余照跑。');
    expect(h.chat.pendingSteers).toHaveLength(1);
    expect(h.chat.pendingSteers[0].target).toEqual({ branchCallId: 'call_b', branchName: '竞品分析员' });
    expect(h.chat.pendingSteers[0].displayText).toBe('竞品那支重点看下沉市场的定价。');

    // 没点名：候选词两边都不沾 → 分不清宁可广播，给在飞的全体。
    await h.chat.interject('方向都再收紧一点。');
    expect(statusJoined(h.root)).toContain('在跑的几路都收到了——各自下个动作就带上。');
    expect(h.chat.pendingSteers).toHaveLength(2);
    expect(h.chat.pendingSteers[1].target).toBe('all');
  });

  it('约束转达与叫停：steer 承诺一句话；停走正则直判不占分类往返', async () => {
    const llm = scriptedLlm([
      { match: '口语', cls: { kind: 'steer', reason: 'style tweak', confidence: 0.9 } },
    ]);
    const h = makeHarness(llm);

    await h.chat.interject('报告文案再口语一点。');
    expect(statusJoined(h.root)).toContain('已转达——手头的活不停，下个动作就带上。');
    expect(h.chat.abortController.signal.aborted).toBe(false);
    // 回合收尾时没被 THINK 边界带走的 steer，作为下一回合开场——不丢。
    // 1a + 渲染一致性（2026-09-25）：重入是用户原话，不是引擎框架文——
    // 框架只在插话真被 THINK 边界注入时才存在，重开回合是用户自己的新指令。
    h.endTurn();
    expect(h.sends).toHaveLength(1);
    expect(h.sends[0]).toContain('报告文案再口语一点。');
    expect(h.sends[0]).not.toContain('【用户插话·顺路带上】');

    // 停是快路径：正则直判，一次 LLM 都不花。（steer 的回合已收尾，
    // 现在是下一个正在跑的回合里叫停。）
    const classifyCount = llm.classifyCalls.length;
    h.chat.streaming = true;
    h.chat.abortController = new AbortController();
    await h.chat.interject('停下');
    expect(llm.classifyCalls.length).toBe(classifyCount);
    expect(statusJoined(h.root)).toContain('收到，停——正在收尾当前任务，已经跑完的部分都留着。');
    expect(h.chat.abortController.signal.aborted).toBe(true);
    // 收尾派发点把回执的账结掉：微光不再宣称活还在收。
    expect(rowPending(h.root, '收到，停')).toBe(true);
    h.endTurn();
    expect(rowPending(h.root, '收到，停')).toBe(false);
  });

  it('委派在飞时加活（澄清案例的姿态）：折入汇合轮先补这项再汇总，不进队列', async () => {
    const llm = scriptedLlm([]);
    const h = makeHarness(llm);
    h.chat.agentActivities.push({ role: '市场 Agent', status: 'running' });

    // SCOPE_ADD_RE 快路径：不经 LLM 直判加活。
    await h.chat.interject('再加一个爱奇艺平台');
    expect(llm.classifyCalls.length).toBe(0);
    expect(statusJoined(h.root)).toContain('已收到——正在跑的活收齐后先补这项，再合并出一份覆盖全部的汇总。');
    expect(userJoined(h.root)).toContain('爱奇艺平台');
    // 折入进 pendingFoldIns 等收尾核验，不占待办队列。
    expect(h.chat.pendingFoldIns).toHaveLength(1);
    expect(queueCard(h.root)).toBeUndefined();
  });

  it('委派在飞时收掉一项（2026-09-24 取消案例）：折入按取消口径，不按加活', async () => {
    const llm = scriptedLlm([]);
    const h = makeHarness(llm);
    h.chat.agentActivities.push({ role: '调研 Agent', status: 'running' });

    // CANCEL_PART_RE 快路径：不经 LLM 直判"收掉一部分"。
    await h.chat.interject('jev 这个就不调研了');
    expect(llm.classifyCalls.length).toBe(0);
    // 回执必须说"拿掉"——案例里正是"先补这项"这句与意图相反的回执。
    expect(statusJoined(h.root)).toContain('收到——这项收掉了，不进最终汇总；其余照跑，收齐后只合并剩下的。');
    expect(statusJoined(h.root)).not.toContain('先补这项');
    expect(userJoined(h.root)).toContain('jev 这个就不调研了');
    expect(h.chat.pendingFoldIns).toHaveLength(1);
    expect(h.chat.pendingFoldIns[0].mechanical).toBe(false);
    expect(h.chat.pendingFoldIns[0].cancels).toBe(true);
    expect(queueCard(h.root)).toBeUndefined();
    // 取消型折入不做"补跑"兜底：没被汇合轮照办也不把"取消"当活重跑。
    h.endTurn();
    expect(h.sends).toHaveLength(0);
  });

  it('委派在飞时点名停一支（第 2 期分支中断）：直达 abortBranch 真停，不折入不广播', async () => {
    const llm = scriptedLlm([]);
    const h = makeHarness(llm);
    h.chat.agentActivities.push({ role: '竞品分析员', status: 'running' });
    // 编排器是分支生死的权威账（第 2 期）：宿主经 branchView() 看在飞支、
    // abortBranch() 只停点名那一支。假编排器锁的是宿主半边的寻址与回执。
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

    // BRANCH_STOP_RE 快路径：不经 LLM 直判「现在就停那一支」。
    await h.chat.interject('停掉竞品那支。');
    expect(llm.classifyCalls.length).toBe(0);
    expect(aborted).toEqual(['call_a']); // 点名直达，兄弟支照跑
    expect(statusJoined(h.root)).toContain('已停掉「竞品分析员」那支——进度留了断点，随时可以让它接着跑，其余照常。');
    expect(userJoined(h.root)).toContain('停掉竞品那支');
    // 真停不走折入/投递账：汇合轮没有这笔，steer 池也是空的。
    expect(h.chat.pendingFoldIns).toHaveLength(0);
    expect(h.chat.pendingSteers).toHaveLength(0);
  });

  it('点名停却点不出具体支：退回取消折入，绝不把「停掉」广播给所有在飞支', async () => {
    // 「停掉那支」有锚无名——两支都可能是"那支"。打平宁可不停（1a 同款
    // 纪律），但绝不能按普通 steer 广播：每支都可能把自己当成"那支"自己
    // 停。兜底是取消折入——汇合轮按用户原话收掉那一项，产出不入账。
    const llm = scriptedLlm([]);
    const h = makeHarness(llm);
    h.chat.agentActivities.push({ role: '竞品分析员', status: 'running' });
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
    expect(llm.classifyCalls.length).toBe(0);
    expect(aborted).toHaveLength(0); // 打平宁可不停，绝不误杀
    expect(h.chat.pendingFoldIns).toHaveLength(1);
    expect(h.chat.pendingFoldIns[0].cancels).toBe(true);
    expect(h.chat.pendingFoldIns[0].mechanical).toBe(false);
    expect(statusJoined(h.root)).toContain('收到——这项收掉了，不进最终汇总；其余照跑，收齐后只合并剩下的。');
    expect(h.chat.pendingSteers).toHaveLength(0);
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
    expect(statusJoined(h.root)).toContain('您说的这个已经在「爱奇艺调研员」那路调研着了，不重复派——收齐后一并汇总给您。');
    expect(userJoined(h.root)).toContain('新增一个平台，爱奇艺');
    // 重复的那支永远不该被派出去：折入账是空的，队列卡也不出现。
    expect(h.chat.pendingFoldIns).toHaveLength(0);
    expect(queueCard(h.root)).toBeUndefined();
  });

  it('复测案例二（2026-09-25）：收掉一项 = 按任务书片段点名暂停那一支，不烧完不空折入', async () => {
    // 真实事故：「不要调研"未来三年的爆发点"这个了」被折入等汇合——支照跑
    // 算力照烧，最后才从结果里删。名字是代号（爆发点未必在名字上），点名
    // 靠任务书片段；认出支 = 真暂停（不落中止），其余照跑。
    const llm = scriptedLlm([]);
    const h = makeHarness(llm);
    h.chat.agentActivities.push({ role: '洞察报告', status: 'running' });
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
    expect(llm.classifyCalls.length).toBe(0); // CANCEL_PART_RE 快路径
    expect(paused).toEqual(['call_burst']);   // 片段点名，暂停那一支
    expect(statusJoined(h.root)).toContain('明白——「爆发点分析员」那路我先暂停了，它已经查到的部分不进最终汇总；其余照常跑，想续上随时说。');
    // 真停了就不再折入：汇合轮没有这笔账。
    expect(h.chat.pendingFoldIns).toHaveLength(0);
    expect(h.chat.pendingSteers).toHaveLength(0);
  });

  it('复测案例二串台（2026-09-25）：取消话被判成 task 又没带 cancels_part——仍真停，绝不回「不重复派」', async () => {
    // 真机串台形态：取消话被分类器判成 task 且没带 cancels_part，宿主只认
    // cancelsPart，这句就落进去重检查，回出「已经在调研着了，不重复派」——
    // 答非所问，支还在烧。宿主兜底加宽：话里有取消味（CANCELISH_RE）就走
    // 取消路，去重只给真正的加活用。
    const llm = scriptedLlm([]); // 剧本默认判 task、不带 cancels_part——串台同款
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
    expect(paused).toEqual(['call_burst']);   // 仍按任务书片段点名真停
    const status = statusJoined(h.root);
    expect(status).toContain('明白——「爆发点分析员」那路我先暂停了');
    expect(status).not.toContain('不重复派'); // 去重回执绝不准碰取消话
    expect(h.chat.pendingFoldIns).toHaveLength(0);
    expect(h.chat.pendingSteers).toHaveLength(0);
  });

  it('混着加活的取消话永不停支：整句按取消折入，不能把要加的活一并停掉', async () => {
    // 「不要只查均价了，把区间也查一下」——停支有闸（stoppable）：SCOPE_ADD_RE
    // 在场就只取消折入，否则"把区间也查了"的活会被一并停掉。
    const llm = scriptedLlm([]);
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

    await h.chat.interject('不要只查均价了，把区间也查一下');
    expect(paused).toHaveLength(0); // 闸生效：一句混话不停支
    expect(h.chat.pendingFoldIns).toHaveLength(1);
    expect(h.chat.pendingFoldIns[0].cancels).toBe(true);
    expect(statusJoined(h.root)).toContain('收到——这项收掉了，不进最终汇总；其余照跑，收齐后只合并剩下的。');
  });

  it('同名多支时收执带序号：researcher·2号，用户对得上号', async () => {
    // 真机观感：两支同名 researcher，收执里裸的「researcher」指不清是哪支。
    // 同名不止一支时收执引用带 instanceNo（researcher·2号）。
    const llm = scriptedLlm([]);
    const h = makeHarness(llm);
    h.chat.agentActivities.push(
      { callId: 'call_r1', agentName: 'researcher', instanceNo: 1, status: 'running', inputSnippet: '调研优酷最新国漫上新' },
      { callId: 'call_r2', agentName: 'researcher', instanceNo: 2, status: 'running', inputSnippet: '调研爱奇艺最新国漫上新' },
    );

    await h.chat.interject('新增一个平台，爱奇艺');
    expect(statusJoined(h.root)).toContain('您说的这个已经在「researcher·2号」那路调研着了，不重复派——收齐后一并汇总给您。');
  });

  it('分类器把取消误判成 task 时宿主兜底：取消永不排队，按取消型折入走', async () => {
    // 案例的真实形态：LLM 把"收掉一项"判成加活。提示词已教正；这里锁宿
    // 主兜底——signals.cancelsPart 为真时 task 判定被改道，绝不进队列、
    // 绝不机械折入。剧本用蛇形 cancels_part，走真解析。
    const llm = scriptedLlm([
      { match: '收掉', cls: { kind: 'task', reason: 'misjudge', confidence: 0.9, cancels_part: true } },
    ]);
    const h = makeHarness(llm);
    h.chat.agentActivities.push({ role: '调研 Agent', status: 'running' });

    await h.chat.interject('知乎那项也收掉吧');
    expect(llm.classifyCalls.length).toBe(1);
    expect(statusJoined(h.root)).toContain('收到——这项收掉了，不进最终汇总；其余照跑，收齐后只合并剩下的。');
    expect(h.chat.pendingFoldIns).toHaveLength(1);
    expect(h.chat.pendingFoldIns[0].cancels).toBe(true);
    expect(h.chat.pendingFoldIns[0].mechanical).toBe(false);
    expect(queueCard(h.root)).toBeUndefined();
    h.endTurn();
    expect(h.sends).toHaveLength(0);
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
