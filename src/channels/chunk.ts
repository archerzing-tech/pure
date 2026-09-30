// src/channels/chunk.ts
// 长消息按段落 → 换行 → 句子 → 硬切 的优先级分片，多片附 `(i/n)`。
// 所有通道共用（飞书 / 钉钉 / webchat），保证降级矩阵里的「长回答分片」一行是
// 一份实现而不是每个适配器各写一次。
export function chunkText(text: string, maxLength: number): string[] {
  if (text.length <= maxLength) return [text];
  // 预留后缀 `\n(i/n)` 的位置：末片也必须在 maxLength 之内。
  const budget = Math.max(1, maxLength - 12);
  const pieces: string[] = [];
  let rest = text;
  while (rest.length > budget) {
    let cut = -1;
    for (const sep of ['\n\n', '\n', '。', '. ', '；', '; ', ' ']) {
      const idx = rest.lastIndexOf(sep, budget);
      if (idx > budget * 0.4) { cut = idx + sep.length; break; }
    }
    if (cut <= 0) cut = budget;
    pieces.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut);
  }
  pieces.push(rest.trim());
  const total = pieces.length;
  return pieces.map((piece, i) => (total > 1 ? `${piece}\n(${i + 1}/${total})` : piece));
}
