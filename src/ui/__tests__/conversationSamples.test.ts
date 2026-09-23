// src/ui/__tests__/conversationSamples.test.ts
// 样本回放：/Users/ericever/Documents/samples.txt 里的理想对话案例，在宿主
// 侧（GUI 对话流）逐条跑通。回放的不是字符串，而是真链路——真
// DynamicInsertionCoordinator（含置信门/时刻解析/快路径正则）、真分发
// switch、真 DOM 回执与活队列卡；只有两处是假的：分类 LLM（按样本剧本
// 给判定）和引擎 send（记录派发载荷）。模型回合的表达姿态（结论先行、
// 子 Agent 摘要、变化点清单）不在宿主侧，不进本文件。

import { describe, expect, it, afterEach } from 'bun:test';
import { ChatController, setTimedInputSink } from '../chat';

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
    getElementById: (id: string): FakeElement | null => (id === 'chat' ? root : null),
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
  restoreDom?.();
});

// ── 假分类 LLM：按剧本对插话文本给判定；旁路问答给固定答复 ────────────────

interface ScriptedClassification {
  kind: string;
  reason: string;
  confidence: number;
  when?: string;
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

  it('约束转达与叫停：steer 承诺一句话；停走正则直判不占分类往返', async () => {
    const llm = scriptedLlm([
      { match: '口语', cls: { kind: 'steer', reason: 'style tweak', confidence: 0.9 } },
    ]);
    const h = makeHarness(llm);

    await h.chat.interject('报告文案再口语一点。');
    expect(statusJoined(h.root)).toContain('已转达——手头的活不停，下个动作就带上。');
    expect(h.chat.abortController.signal.aborted).toBe(false);
    // 回合收尾时没被 THINK 边界带走的 steer，作为下一回合开场——不丢。
    h.endTurn();
    expect(h.sends).toEqual(['报告文案再口语一点。']);

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
});
