// src/shared/rewriteGate.ts
// 整份重写硬闸的判据（2026-11-23 用户点名「改一段文字就要整个重新写入」）。
//
// 已有的「未读先写」门只挡没读过的文件，模型传 overwrite:true 就能绕过，然后照样
// 把全文重发一遍。这里补的是另一侧：文件已经读过、内容也和磁盘上高度相似，说明这次
// 其实是「只改了一小段」——那就不该用 write_file，必须用 edit_file 只送改动片段。
//
// 判据纯机械，不做语义判断：只比公共前后缀。改动集中在中间时前缀+后缀几乎覆盖全文，
// 比值很小就拦；真正整体重写时前后缀都很短，比值接近 1，照常放行，不误伤正当重写。
// 不放在 adapter 里是因为 GUI/CLI/子代理共用同一个判据，这里保持无 node 依赖。

/** 太短的文件整写本来就没多少 token，不值得拦（与 writeFeedback 的重写阈值同口径）。 */
export const REWRITE_GATE_MIN_CHARS = 1_200;
/** 改动不超过全文这个比例就算「只改了一小段」。 */
export const REWRITE_GATE_MAX_CHANGED_RATIO = 0.25;

export interface RewriteGateVerdict {
  blocked: boolean;
  changedChars: number;
  changedRatio: number;
}

/**
 * 判定一次整文件写入是否只是局部改动。
 *
 * oldContent 取不到（新文件 / 快照超预算降级）时一律放行——没有磁盘事实就不该拦。
 * 返回的比例同时写进拒绝语，让模型知道「到底差了多少」，便于它改用 edit_file。
 */
export function classifyRewrite(oldContent: string | undefined, newContent: string): RewriteGateVerdict {
  const size = Math.max(oldContent?.length ?? 0, newContent.length);
  const plain = { blocked: false, changedChars: size, changedRatio: 1 };
  if (!oldContent || size < REWRITE_GATE_MIN_CHARS) return plain;

  // 撤销快照走 Rust read_file，它 trim() 掉末尾换行；模型写入的新内容通常带尾换行。
  // 不归一的话首尾会同时失配，把「只改一行」误判成整体重写（真机 gate_exact.ts 判例）。
  const old = oldContent.replace(/\s+$/, '');
  const next = newContent.replace(/\s+$/, '');
  const normalizedSize = Math.max(old.length, next.length);
  if (normalizedSize === 0) return plain;

  const shorter = Math.min(old.length, next.length);
  let prefix = 0;
  while (prefix < shorter && old[prefix] === next[prefix]) prefix += 1;
  let suffix = 0;
  while (suffix < shorter - prefix && old[old.length - 1 - suffix] === next[next.length - 1 - suffix]) suffix += 1;

  const changedChars = Math.max(0, normalizedSize - prefix - suffix);
  const changedRatio = changedChars / normalizedSize;
  return {
    blocked: changedRatio <= REWRITE_GATE_MAX_CHANGED_RATIO,
    changedChars,
    changedRatio,
  };
}

/** 拒绝语单一来源：两处适配器与测试共用，避免口径漂移。 */
export function rewriteRefusal(path: string, verdict: RewriteGateVerdict): string {
  return `write_file refused: ${path} already exists and this write is ${Math.round((1 - verdict.changedRatio) * 100)}% identical to the current file — only ${verdict.changedChars} characters would change. That is a targeted edit, not a full rewrite. Use edit_file (oldString → newString) to send only the changed region, or append:true when adding to the end.`;
}
