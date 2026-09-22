// src/ui/__tests__/inputHistory.test.ts
// 输入历史 GUI 半边（happy-dom）：↑/↓ 接管边界（首行/末行、弹层让路、组字
// 让路、空历史不接手）、翻阅回到草稿、发送后重置；以及仓库语义——按会话
// 分桶（A 会话翻不到 B 会话的）、两个输入框共享同一份桶（landing 发出的
// 首条消息主输入框也翻得回来）、桶未就绪时先让路。持久化半边依赖 Tauri，
// 这里用 enabled:()=>false 模拟浏览器模式（桶只在内存，照样按会话隔离）。

import { describe, expect, it, beforeAll, afterAll } from 'bun:test';
import { GlobalRegistrator } from '@happy-dom/global-registrator';
import { ComposerInputHistory, SessionInputHistoryStore } from '../inputHistory';

beforeAll(() => {
  GlobalRegistrator.register();
});
afterAll(() => {
  GlobalRegistrator.unregister();
});

function makeTextarea(initial = ''): HTMLTextAreaElement {
  const el = document.createElement('textarea');
  el.value = initial;
  document.body.appendChild(el);
  return el;
}

function key(type: 'up' | 'down'): KeyboardEvent {
  // cancelable: preventDefault 只对可取消事件生效（happy-dom 与浏览器一致），
  // 否则断言 defaultPrevented 毫无意义。
  return new KeyboardEvent('keydown', { key: type === 'up' ? 'ArrowUp' : 'ArrowDown', bubbles: true, cancelable: true });
}

/** 消化 remember() 的 fire-and-forget 微任务链（桶变更落在微任务里）。 */
function flush(): Promise<void> {
  return new Promise<void>((resolve) => setTimeout(resolve, 0));
}

/** 一个测试会话面：共享 store + 可切换的当前会话。 */
function makeHarness(initialSession = 's1') {
  const store = new SessionInputHistoryStore(() => false); // 浏览器模式：不碰盘
  let session = initialSession;
  return {
    store,
    composer(input: HTMLTextAreaElement) {
      return new ComposerInputHistory(input, store, () => session);
    },
    setSession(id: string) {
      session = id;
    },
  };
}

describe('ComposerInputHistory', () => {
  it('leaves ↑ alone when there is no history yet', async () => {
    const { store, composer } = makeHarness();
    await store.load('s1');
    const input = makeTextarea('draft');
    const controller = composer(input);
    void controller.load();
    const event = key('up');
    expect(controller.handleArrowKeyDown(event)).toBe(false);
    expect(input.value).toBe('draft');
  });

  it('recalls sent inputs on ↑, returns to the draft on ↓', async () => {
    const { store, composer } = makeHarness();
    await store.load('s1');
    const input = makeTextarea('draft');
    const controller = composer(input);
    void controller.load();
    controller.remember('older task');
    await flush();
    controller.remember('newer task');
    await flush();

    const up1 = key('up');
    expect(controller.handleArrowKeyDown(up1)).toBe(true);
    expect(up1.defaultPrevented).toBe(true); // 接管时必须挡住光标移动
    expect(input.value).toBe('newer task');

    const up2 = key('up');
    expect(controller.handleArrowKeyDown(up2)).toBe(true);
    expect(input.value).toBe('older task');

    const down1 = key('down');
    expect(controller.handleArrowKeyDown(down1)).toBe(true);
    expect(input.value).toBe('newer task');

    const down2 = key('down');
    expect(controller.handleArrowKeyDown(down2)).toBe(true);
    expect(input.value).toBe('draft'); // 翻过最新回到草稿
  });

  it('stops at the oldest entry without wrapping', async () => {
    const { store, composer } = makeHarness();
    await store.load('s1');
    const input = makeTextarea('');
    const controller = composer(input);
    void controller.load();
    controller.remember('only');
    await flush();
    expect(controller.handleArrowKeyDown(key('up'))).toBe(true);
    const stuck = key('up');
    expect(controller.handleArrowKeyDown(stuck)).toBe(true);
    expect(input.value).toBe('only'); // 停在原地
  });

  it('saves the live draft the first time ↑ is pressed', async () => {
    const { store, composer } = makeHarness();
    await store.load('s1');
    const input = makeTextarea('my draft');
    const controller = composer(input);
    void controller.load();
    controller.remember('a');
    await flush();
    controller.remember('b');
    await flush();
    controller.handleArrowKeyDown(key('up')); // → 'b'，草稿已存底
    controller.handleArrowKeyDown(key('up')); // → 'a'
    controller.handleArrowKeyDown(key('down'));
    controller.handleArrowKeyDown(key('down')); // 回草稿
    expect(input.value).toBe('my draft');
  });

  it('ignores ↑ when the caret sits below the first line (multi-line draft)', async () => {
    const { store, composer } = makeHarness();
    await store.load('s1');
    const input = makeTextarea('line1\nline2');
    const controller = composer(input);
    void controller.load();
    controller.remember('a');
    await flush();
    input.setSelectionRange(9, 9); // 末行行尾
    expect(controller.handleArrowKeyDown(key('up'))).toBe(false); // 光标移动
    expect(input.value).toBe('line1\nline2');
    input.setSelectionRange(2, 2); // 首行
    expect(controller.handleArrowKeyDown(key('up'))).toBe(true); // 接管
    expect(input.value).toBe('a');
  });

  it('yields to an earlier handler that already prevented the event (autocomplete popup)', async () => {
    const { store, composer } = makeHarness();
    await store.load('s1');
    const input = makeTextarea('');
    const controller = composer(input);
    void controller.load();
    controller.remember('a');
    await flush();
    const event = key('up');
    event.preventDefault(); // InlineAutocomplete 的监听器先注册、先 preventDefault
    expect(controller.handleArrowKeyDown(event)).toBe(false);
    expect(input.value).toBe('');
  });

  it('resets the cycle when a new input is sent', async () => {
    const { store, composer } = makeHarness();
    await store.load('s1');
    const input = makeTextarea('');
    const controller = composer(input);
    void controller.load();
    controller.remember('a');
    await flush();
    controller.handleArrowKeyDown(key('up')); // index=0
    controller.remember('fresh task');
    await flush();
    expect(controller.handleArrowKeyDown(key('up'))).toBe(true);
    expect(input.value).toBe('fresh task'); // ↑ 从最新一条开始
  });

  it('never touches the disk in browser mode (silent in-memory degradation)', async () => {
    const { store, composer } = makeHarness();
    const input = makeTextarea('');
    const controller = composer(input);
    await store.load('s1'); // 无 Tauri：不抛错、桶为空起步
    controller.remember('memory only');
    await flush();
    expect(controller.handleArrowKeyDown(key('up'))).toBe(true);
    expect(input.value).toBe('memory only');
  });
});

describe('会话分桶（串台回归）', () => {
  it("session A's entries never recall inside session B", async () => {
    const harness = makeHarness('sA');
    const { store, composer, setSession } = harness;
    const input = makeTextarea('');
    const controller = composer(input);
    await store.load('sA');
    controller.remember('A 会话的任务');
    await flush();

    // 切到 B 会话：翻阅状态作废，桶里没有 A 的任何内容。
    setSession('sB');
    controller.onSessionChanged('sB');
    await store.load('sB');
    expect(controller.handleArrowKeyDown(key('up'))).toBe(false);
    expect(input.value).toBe('');

    // 切回 A：那句话还在。
    setSession('sA');
    controller.onSessionChanged('sA');
    expect(controller.handleArrowKeyDown(key('up'))).toBe(true);
    expect(input.value).toBe('A 会话的任务');
  });

  it('two composers on the same session share one bucket (landing 的首句也翻得回来)', async () => {
    const { store, composer } = makeHarness('s1');
    const landingInput = makeTextarea('');
    const mainInput = makeTextarea('');
    const landing = composer(landingInput);
    const main = composer(mainInput);
    await store.load('s1');
    // 首条消息从 landing 发出（记进共享桶），之后在主输入框按 ↑。
    landing.remember('第一句话');
    await flush();
    expect(main.handleArrowKeyDown(key('up'))).toBe(true);
    expect(mainInput.value).toBe('第一句话');
  });

  it('yields ↑ while the session bucket is still loading, works once ready', async () => {
    const harness = makeHarness('sX');
    const { store, composer } = harness;
    const input = makeTextarea('');
    const controller = composer(input);
    // 桶还没预热（等价于刚切会话、磁盘读取未返回）：第一下 ↑ 让路。
    expect(controller.handleArrowKeyDown(key('up'))).toBe(false);
    expect(input.value).toBe('');
    await store.load('sX');
    await store.remember('sX', '从盘里回来的内容'); // 模拟磁盘灌入
    expect(controller.handleArrowKeyDown(key('up'))).toBe(true);
    expect(input.value).toBe('从盘里回来的内容');
  });
});
