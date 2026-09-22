// src/shared/inputHistory.ts
// 输入历史（2026-09-22）：像 shell 一样，按 ↑/↓ 把之前发过的指令翻回来。
// pure 有两个输入面（GUI composer 与 CLI REPL），"什么算一条历史、什么不该
// 存"的裁决只有一份，放这里；两侧各自的取数/落盘通道不同（GUI 走 Tauri
// read_file/write_file 到 ~/.pure/input-history.json，CLI 用 node:fs 读写同
// 一个文件并喂给 readline 的会话内历史），但存下来的格式与去重口径一致。

/** 和 bash 一样封顶：够翻很久，又不至于让文件无界生长。 */
export const MAX_INPUT_HISTORY = 200;

/**
 * 记一条新输入，返回新列表（不就地改参，调用方决定存哪里）。
 * 去重口径与 bash 一致：空串不记；与最近一条相同不记（连发同一条不刷屏）；
 * 其余一律 newest-first 插到最前，超限从尾部裁。
 */
export function rememberInput(history: readonly string[], text: string, max: number = MAX_INPUT_HISTORY): string[] {
  const trimmed = text.trim();
  if (!trimmed) return [...history];
  if (history[0] === trimmed) return [...history];
  return [trimmed, ...history].slice(0, max);
}

/**
 * 从磁盘内容恢复历史：文件可能被手改、截断或根本不是 JSON —— 只认
 * "字符串数组"，其余一律当空历史，绝不让坏文件挡住输入框。
 */
export function parseInputHistory(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter((item): item is string => typeof item === 'string' && item.trim().length > 0).slice(0, MAX_INPUT_HISTORY);
}

/**
 * 上/下键的状态机（shell 口径，纯函数便于单测）：
 * - ↑：存下当前草稿（第一次按才存），往前翻一条；
 * - ↓：往后翻；翻过最新一条回到草稿。
 * index = -1 表示"还在当前输入上"。到头了自然停住，不循环——shell 不循环，
 * 循环会让人找不到自己的草稿去哪了。history 是 newest-first（存的时候
 * unshift 到最前），所以 ↑ 是下标 +1、↓ 是下标 -1。
 */
export function recallInput(
  history: readonly string[],
  index: number,
  draft: string,
  direction: 'up' | 'down',
): { index: number; value: string; draft: string } | undefined {
  if (history.length === 0) return undefined;
  if (direction === 'up') {
    // index === -1（还在草稿上）→ 从最新一条开始翻；已翻到最旧就停在原地。
    const next = index === -1 ? 0 : Math.min(index + 1, history.length - 1);
    return { index: next, value: history[next], draft };
  }
  if (index === -1) return undefined; // 已在最新处，↓ 交还给光标移动
  const next = index - 1;
  if (next < 0) return { index: -1, value: draft, draft }; // 翻过最新一条，回草稿
  return { index: next, value: history[next], draft };
}

/** 发送后重置翻阅状态：草稿已经发出去了，↑ 从最新一条开始。 */
export function resetRecall(): { index: number; draft: string } {
  return { index: -1, draft: '' };
}
