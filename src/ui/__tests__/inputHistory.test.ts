// src/ui/__tests__/inputHistory.test.ts
// ComposerInputHistory 的浏览器级行为（happy-dom）：↑/↓ 接管边界（首行/末行、
// 弹层让路、组字让路、空历史不接手）、翻阅回到草稿、发送后重置。持久化半边
// 依赖 Tauri，这里天然是浏览器模式（isTauriRuntime=false），断言它静默退化。

import { describe, expect, it, beforeAll, afterAll } from 'bun:test';
import { GlobalRegistrator } from '@happy-dom/global-registrator';
import { ComposerInputHistory } from '../inputHistory';

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

describe('ComposerInputHistory', () => {
  it('leaves ↑ alone when there is no history yet', () => {
    const input = makeTextarea('draft');
    const controller = new ComposerInputHistory(input);
    const event = key('up');
    expect(controller.handleArrowKeyDown(event)).toBe(false);
    expect(input.value).toBe('draft');
  });

  it('recalls sent inputs on ↑, returns to the draft on ↓', () => {
    const input = makeTextarea('draft');
    const controller = new ComposerInputHistory(input);
    controller.remember('older task');
    controller.remember('newer task');

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

  it('stops at the oldest entry without wrapping', () => {
    const input = makeTextarea('');
    const controller = new ComposerInputHistory(input);
    controller.remember('only');
    expect(controller.handleArrowKeyDown(key('up'))).toBe(true);
    const stuck = key('up');
    expect(controller.handleArrowKeyDown(stuck)).toBe(true);
    expect(input.value).toBe('only'); // 停在原地
  });

  it('saves the live draft the first time ↑ is pressed', () => {
    const input = makeTextarea('my draft');
    const controller = new ComposerInputHistory(input);
    controller.remember('a');
    controller.remember('b');
    controller.handleArrowKeyDown(key('up')); // → 'b'，草稿已存底
    controller.handleArrowKeyDown(key('up')); // → 'a'
    controller.handleArrowKeyDown(key('down'));
    controller.handleArrowKeyDown(key('down')); // 回草稿
    expect(input.value).toBe('my draft');
  });

  it('ignores ↑ when the caret sits below the first line (multi-line draft)', () => {
    const input = makeTextarea('line1\nline2');
    const controller = new ComposerInputHistory(input);
    controller.remember('a');
    input.setSelectionRange(9, 9); // 末行行尾
    expect(controller.handleArrowKeyDown(key('up'))).toBe(false); // 光标移动
    expect(input.value).toBe('line1\nline2');
    input.setSelectionRange(2, 2); // 首行
    expect(controller.handleArrowKeyDown(key('up'))).toBe(true); // 接管
    expect(input.value).toBe('a');
  });

  it('yields to a earlier handler that already prevented the event (autocomplete popup)', () => {
    const input = makeTextarea('');
    const controller = new ComposerInputHistory(input);
    controller.remember('a');
    const event = key('up');
    event.preventDefault(); // InlineAutocomplete 的监听器先注册、先 preventDefault
    expect(controller.handleArrowKeyDown(event)).toBe(false);
    expect(input.value).toBe('');
  });

  it('resets the cycle when a new input is sent', () => {
    const input = makeTextarea('');
    const controller = new ComposerInputHistory(input);
    controller.remember('a');
    controller.handleArrowKeyDown(key('up')); // index=0
    controller.remember('fresh task');
    expect(controller.handleArrowKeyDown(key('up'))).toBe(true);
    expect(input.value).toBe('fresh task'); // ↑ 从最新一条开始
  });

  it('never touches the disk in browser mode (silent degradation)', async () => {
    const input = makeTextarea('');
    const controller = new ComposerInputHistory(input);
    await controller.load(); // 无 Tauri：不抛错、历史保持为空
    controller.remember('memory only');
    expect(controller.handleArrowKeyDown(key('up'))).toBe(true);
    expect(input.value).toBe('memory only');
  });
});
