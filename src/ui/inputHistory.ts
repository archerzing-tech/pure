// src/ui/inputHistory.ts
// 输入历史的 GUI 半边：把 ↑/↓ 接到 composer 上（prompt 主输入框 + landing
// 首屏输入框各接一份，共享同一份磁盘历史）。shell 口径：
//   ↑ 在第一行才翻历史（多行文本里的 ↑ 还是移动光标）；第一次按存下草稿；
//   ↓ 翻回来，翻过最新一条回到草稿；autocomplete 弹层开着时箭头键归它管，
//     这里通过 e.defaultPrevented 让路（它的监听器先注册、先 preventDefault）。
// 持久化：~/.pure/input-history.json（与 CLI 共用一份，格式=字符串数组，
// newest-first）。浏览器模式没有文件系统，历史只在当前页面活着。

import { isTauriRuntime, loadTauriCore } from '../shared/tauri';
import { join, homeDir } from '@tauri-apps/api/path';
import { parseInputHistory, recallInput, rememberInput, resetRecall } from '../shared/inputHistory';

const HISTORY_FILE = 'input-history.json';

export class ComposerInputHistory {
  private history: string[] = [];
  private index = -1;
  private draft = '';

  constructor(private readonly input: HTMLTextAreaElement) {}

  /** 启动时读一次磁盘历史（Tauri 才有文件系统；读不到=还没有历史）。 */
  async load(): Promise<void> {
    if (!isTauriRuntime()) return;
    try {
      const core = await loadTauriCore();
      if (!core) return;
      const pureHome = await join(await homeDir(), '.pure');
      const raw: unknown = JSON.parse(await core.invoke<string>('read_file', { workspace: pureHome, path: HISTORY_FILE }));
      this.history = parseInputHistory(raw);
    } catch {
      this.history = []; // 文件不存在或坏了 = 空历史起步
    }
  }

  /**
   * keydown 里调用：消费了这次 ↑/↓ 返回 true（调用方 stop 流程直接 return）。
   * 只在"光标位于首行按 ↑ / 末行按 ↓"时接管——多行草稿里箭头照样移动光标。
   */
  handleArrowKeyDown(event: KeyboardEvent): boolean {
    if (event.defaultPrevented) return false; // autocomplete 弹层在管
    if (event.isComposing || event.keyCode === 229) return false;
    if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return false;
    const value = this.input.value;
    const caret = this.input.selectionStart ?? value.length;
    if (event.key === 'ArrowUp' && value.slice(0, caret).includes('\n')) return false;
    if (event.key === 'ArrowDown' && value.slice(caret).includes('\n')) return false;
    // 离开草稿的第一下 ↑ 要把当前内容存为草稿——通过 draft 参数带进状态机，
    // 返回值统一落位，避免"存了又被透传的旧值抹掉"。
    const goingUp = event.key === 'ArrowUp';
    const draftToCarry = goingUp && this.index === -1 ? value : this.draft;
    const next = recallInput(this.history, this.index, draftToCarry, goingUp ? 'up' : 'down');
    if (!next) return false;
    event.preventDefault();
    this.index = next.index;
    this.draft = next.draft;
    this.setValue(next.value);
    return true;
  }

  /** 发送成功路径上记一条：内存即刻可翻，磁盘尽力而为（写失败不影响发送）。 */
  remember(text: string): void {
    this.history = rememberInput(this.history, text);
    ({ index: this.index, draft: this.draft } = resetRecall());
    void this.persist();
  }

  private async persist(): Promise<void> {
    if (!isTauriRuntime()) return;
    try {
      const core = await loadTauriCore();
      if (!core) return;
      const pureHome = await join(await homeDir(), '.pure');
      await core.invoke('write_file', { workspace: pureHome, path: HISTORY_FILE, content: JSON.stringify(this.history) });
    } catch {
      // 历史写不进磁盘只是回退成"本页有效"，不值得打断用户。
    }
  }

  private setValue(value: string): void {
    this.input.value = value;
    const end = value.length;
    this.input.setSelectionRange(end, end);
    this.input.dispatchEvent(new Event('input', { bubbles: true })); // 触发自增高与发送按钮态
  }
}
