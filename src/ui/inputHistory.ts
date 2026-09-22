// src/ui/inputHistory.ts
// 输入历史的 GUI 半边：↑/↓ 接到 composer 上（landing 首屏输入框与主输入框
// 各一份翻阅状态），历史本体放在 SessionInputHistoryStore 里按会话分桶——
// A 会话翻不到 B 会话发过的内容（用户实测串台后定的口径）。每个会话一份
// 文件 ~/.pure/input-history/<sessionId>.json；CLI REPL 是自己独立的一个
// 会话面，仍用旧的全局文件 ~/.pure/input-history.json，两边互不可见。
// shell 口径不变：↑ 在第一行才翻历史（多行文本里的 ↑ 还是移动光标）；第一
// 次按存下草稿；↓ 翻回来，翻过最新一条回到草稿；autocomplete 弹层开着时
// 箭头键归它管，这里通过 e.defaultPrevented 让路（它的监听器先注册）。
// 浏览器模式没有文件系统：桶只在内存里，照样按会话隔离。

import { isTauriRuntime, loadTauriCore } from '../shared/tauri';
import { join, homeDir } from '@tauri-apps/api/path';
import { parseInputHistory, recallInput, rememberInput, resetRecall } from '../shared/inputHistory';

const HISTORY_DIR = 'input-history';

/**
 * 按会话分桶的历史仓库（landing 与主输入框共享一个实例）：
 * - 桶以 sessionId 为键，内存缓存 + 每会话一个文件，切会话时预热；
 * - remember 在调用时刻解析会话身份，异步落盘也写进正确的桶；
 * - 同一实例被两个输入框共用，首条消息从哪个框发出都能被 ↑ 翻回来
 *   （此前各实例各记各的账，landing 发出的第一句翻不出来）。
 */
export class SessionInputHistoryStore {
  private buckets = new Map<string, string[]>();
  private loading = new Map<string, Promise<string[]>>();

  constructor(private readonly enabled: () => boolean = isTauriRuntime) {}

  /** 某会话的桶（可能还在异步灌入磁盘内容，调用方用 ready() 判断）。 */
  bucket(sessionId: string): readonly string[] {
    return this.buckets.get(sessionId) ?? [];
  }

  /** 桶是否已在内存。没就绪时 ↑ 先让路，同时触发加载，下一次按就有了。 */
  ready(sessionId: string): boolean {
    return this.buckets.has(sessionId);
  }

  /** 取桶：内存有就返回；没有就先占位再异步灌入磁盘内容（幂等、去重并发）。 */
  async load(sessionId: string): Promise<string[]> {
    const cached = this.buckets.get(sessionId);
    if (cached) return cached;
    const inFlight = this.loading.get(sessionId);
    if (inFlight) return inFlight;
    const run = (async () => {
      const bucket: string[] = [];
      this.buckets.set(sessionId, bucket); // 先占位：并发 remember 不会重复读盘
      if (this.enabled()) {
        try {
          const core = await loadTauriCore();
          if (core) {
            const dir = await join(await homeDir(), '.pure', HISTORY_DIR);
            const raw: unknown = JSON.parse(
              await core.invoke<string>('read_file', { workspace: dir, path: `${sessionId}.json` }),
            );
            bucket.push(...parseInputHistory(raw));
          }
        } catch {
          // 文件不存在或坏了 = 空历史起步；桶已占位，不挡后面的 remember。
        }
      }
      this.loading.delete(sessionId);
      return bucket;
    })();
    this.loading.set(sessionId, run);
    return run;
  }

  /** 发送成功路径上记一条：解析当刻的会话身份，写入正确的桶并尽力落盘。 */
  async remember(sessionId: string, text: string): Promise<void> {
    const bucket = await this.load(sessionId);
    const next = rememberInput(bucket, text);
    if (next === bucket) return; // 空串 / 与最近一条相同：没有变化
    bucket.length = 0;
    bucket.push(...next);
    await this.persist(sessionId, bucket);
  }

  private async persist(sessionId: string, bucket: string[]): Promise<void> {
    if (!this.enabled()) return;
    try {
      const core = await loadTauriCore();
      if (!core) return;
      const dir = await join(await homeDir(), '.pure', HISTORY_DIR);
      await core.invoke('write_file', {
        workspace: dir,
        path: `${sessionId}.json`,
        content: JSON.stringify(bucket),
      });
    } catch {
      // 历史写不进磁盘只是回退成“本次运行内有效”，不值得打断用户。
    }
  }
}

/**
 * 一个输入框的翻阅状态（index/draft 是每框各一份的，历史本体在上面
 * 的共享仓库里）。
 */
export class ComposerInputHistory {
  private index = -1;
  private draft = '';

  constructor(
    private readonly input: HTMLTextAreaElement,
    private readonly store: SessionInputHistoryStore,
    private readonly getSessionId: () => string,
  ) {}

  /** 启动时预热当前会话的桶（Tauri 才有文件系统；读不到=还没有历史）。 */
  async load(): Promise<void> {
    await this.store.load(this.getSessionId());
  }

  /** 会话切换：翻阅状态作废（草稿已随旧会话翻页结束），新桶开始预热。 */
  onSessionChanged(sessionId: string): void {
    ({ index: this.index, draft: this.draft } = resetRecall());
    void this.store.load(sessionId);
  }

  /**
   * keydown 里调用：消费了这次 ↑/↓ 返回 true（调用方 stop 流程直接 return）。
   * 只在“光标位于首行按 ↑ / 末行按 ↓”时接管——多行草稿里箭头照样移动光标。
   */
  handleArrowKeyDown(event: KeyboardEvent): boolean {
    if (event.defaultPrevented) return false; // autocomplete 弹层在管
    if (event.isComposing || event.keyCode === 229) return false;
    if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return false;
    const sessionId = this.getSessionId();
    if (!this.store.ready(sessionId)) {
      void this.store.load(sessionId); // 还在读盘：这次先让路，下一按就绪
      return false;
    }
    const value = this.input.value;
    const caret = this.input.selectionStart ?? value.length;
    if (event.key === 'ArrowUp' && value.slice(0, caret).includes('\n')) return false;
    if (event.key === 'ArrowDown' && value.slice(caret).includes('\n')) return false;
    // 离开草稿的第一下 ↑ 要把当前内容存为草稿——通过 draft 参数带进状态机，
    // 返回值统一落位，避免“存了又被透传的旧值抹掉”。
    const goingUp = event.key === 'ArrowUp';
    const draftToCarry = goingUp && this.index === -1 ? value : this.draft;
    const next = recallInput(this.store.bucket(sessionId), this.index, draftToCarry, goingUp ? 'up' : 'down');
    if (!next) return false;
    event.preventDefault();
    this.index = next.index;
    this.draft = next.draft;
    this.setValue(next.value);
    return true;
  }

  /** 发送成功路径上记一条：内存即刻可翻，磁盘尽力而为（写失败不影响发送）。 */
  remember(text: string): void {
    void this.store.remember(this.getSessionId(), text);
    ({ index: this.index, draft: this.draft } = resetRecall());
  }

  private setValue(value: string): void {
    this.input.value = value;
    const end = value.length;
    this.input.setSelectionRange(end, end);
    this.input.dispatchEvent(new Event('input', { bubbles: true })); // 触发自增高与发送按钮态
  }
}
