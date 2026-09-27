// src/ui/__tests__/composerStopButton.test.ts
// 输入框旁 ⏹ 暂停按钮的语义锚定（2026-09-27 用户反馈：「点击暂停按钮不起作用，
// 需要点击 ESC 键才管用」+「暂停相关提示不必居中，靠一侧简约即可」）。
//
// 病根：按钮的流式分支只走 chat.pause()——第一击开始优雅收尾（几秒到几十秒），
// 收尾期里再点 = pause() 早退、无声 no-op，没有升级通道；而 Esc 经输入框→
// document 双层触发，第二层 escapeWhileStreaming() 看到已 pausing 就立即硬停。
// 于是「按钮失灵、Esc 才管用」。修法：按钮与 Esc 收敛到同一个双档语义。
// main.ts 是副作用大模块不好直接实例化，这里按 modelEditorLayout.test.ts 的
// 先例用源码锚定锁住结构事实；双档行为本身已由 conversationSamples.test.ts
// 的「1c Esc 统一」用例在控制器层锁住。

import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';

const main = readFileSync(new URL('../main.ts', import.meta.url), 'utf8').replaceAll('\r\n', '\n');
const styles = readFileSync(new URL('../styles.css', import.meta.url), 'utf8').replaceAll('\r\n', '\n');
const i18n = readFileSync(new URL('../../shared/i18n.ts', import.meta.url), 'utf8').replaceAll('\r\n', '\n');

describe('⏹ 按钮与 Esc 同一套双档语义（2026-09-27 用户反馈）', () => {
  it('流式分支走 escapeWhileStreaming（双档），不再单走 pause()（无声 no-op 的病根）', () => {
    // 两个发送门（主输入框 + 首屏 landing）的流式分支都必须是同一扇双档门。
    expect(main).toContain('chat.escapeWhileStreaming()');
    const stopBranches = main.match(/if \(chat\.isStreaming\(\)\) \{\n\s*queuedWhileStreaming = null;[^}]*?\}/g) ?? [];
    expect(stopBranches.length).toBeGreaterThanOrEqual(2);
    for (const branch of stopBranches) {
      expect(branch).toContain('chat.escapeWhileStreaming()');
      expect(branch).not.toContain('chat.pause()');
    }
  });

  it('收尾提示条把「再点一下立即停」说出口——第一击不再读起来像失灵', () => {
    // 中英两份文案都要给出升级通道：点 ⏹ 或按 Esc 立即停。
    expect(i18n).toContain("再点 ⏹ 或按 Esc，立即停");
    expect(i18n).toContain('click ⏹ again or press Esc to stop right now');
  });
});

describe('暂停/继续条靠一侧（2026-09-27 用户定调：不必刻意居中）', () => {
  it('.paused-resume-bar 左对齐小条，不是对话正中的舞台', () => {
    const bar = styles.match(/\.paused-resume-bar \{[^}]*\}/)?.[0] ?? '';
    expect(bar).toContain('justify-content: flex-start');
    expect(bar).not.toContain('justify-content: center');
  });
});
