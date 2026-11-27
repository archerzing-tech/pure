// src/shared/journalSalvage.ts
// turn.journal.jsonl 的打捞纯核（P1-c 的消费端，2026-11-27）。
//
// journal 的写入语义（Rust TurnJournal）：一次 chat_stream 一个 requestId，
// 行为 {ts, stream, kind, text}；同回合多个工具轮追加而非截断——所以「崩溃时
// 未落快照的流式文本」= 最后一个 stream 分组的连续文本。打捞规则（plan §P1-c）：
// 按 stream 分组取最后一段；thinking/reasoning 默认排除（那是推理痕迹，不是
// 交付文本），--keep-thinking 时以引用块附加。
//
// 纯函数无 node 依赖：文件读取在 cliSalvage.ts，测试直接喂字符串。

export interface JournalLine {
  ts: number;
  stream: string;
  kind: string;
  text: string;
}

export interface SalvageResult {
  /** 打捞出的 stream id（崩溃回合最后一次 chat_stream）。 */
  stream: string;
  /** 连续正文（content 拼接；--keep-thinking 时 thinking 以引用块附后）。 */
  text: string;
  /** 组内行数（content 行）。 */
  contentChars: number;
  /** 被排除的 thinking/reasoning 字符数。 */
  thinkingChars: number;
  /** 首末行时间戳（组内）。 */
  firstTs: number;
  lastTs: number;
  /** 该会话 journal 里其余 stream 的条数（历史工具轮，不打捞）。 */
  olderStreams: number;
  /** 解析失败的行数（截断/交错——journal 8MB 截断可能切出半行）。 */
  badLines: number;
}

/** 逐行解析，坏行跳过并计数（8MB 截断可能切出半行 JSON——不是错误是常态）。 */
export function parseJournalLines(raw: string): { lines: JournalLine[]; badLines: number } {
  const lines: JournalLine[] = [];
  let badLines = 0;
  for (const lineRaw of raw.split('\n')) {
    if (!lineRaw.trim()) continue;
    try {
      const e = JSON.parse(lineRaw) as Partial<JournalLine>;
      if (typeof e.stream !== 'string' || typeof e.kind !== 'string') { badLines += 1; continue; }
      lines.push({
        ts: typeof e.ts === 'number' ? e.ts : 0,
        stream: e.stream,
        kind: e.kind,
        text: typeof e.text === 'string' ? e.text : '',
      });
    } catch {
      badLines += 1;
    }
  }
  return { lines, badLines };
}

/**
 * 打捞最后一个 stream 分组（= 崩溃回合最后一次 chat_stream 的连续文本）。
 * journal 为空/全坏行返回 null。
 */
export function salvageLastStream(
  raw: string,
  opts: { keepThinking?: boolean } = {},
): SalvageResult | null {
  const { lines, badLines } = parseJournalLines(raw);
  if (lines.length === 0) return null;

  // 按 stream 分组，组序按首次出现（journal 追加有序，最后出现的组=最后一次调用）。
  const order: string[] = [];
  const groups = new Map<string, JournalLine[]>();
  for (const line of lines) {
    if (!groups.has(line.stream)) { groups.set(line.stream, []); order.push(line.stream); }
    groups.get(line.stream)!.push(line);
  }
  const stream = order[order.length - 1];
  const group = groups.get(stream)!;

  const firstTs = group[0]?.ts ?? 0;
  const lastTs = group[group.length - 1]?.ts ?? 0;
  let text = '';
  let contentChars = 0;
  let thinkingChars = 0;
  let thinkingBlock = '';
  for (const line of group) {
    if (line.kind === 'content') {
      text += line.text;
      contentChars += line.text.length;
    } else if (opts.keepThinking) {
      thinkingChars += line.text.length;
      thinkingBlock += line.text;
    } else {
      thinkingChars += line.text.length;
    }
  }
  if (opts.keepThinking && thinkingBlock.trim()) {
    text += `\n\n> [thinking]\n> ${thinkingBlock.replace(/\n/g, '\n> ')}`;
  }

  return {
    stream,
    text,
    contentChars,
    thinkingChars,
    firstTs,
    lastTs,
    olderStreams: order.length - 1,
    badLines,
  };
}

/** 人读摘要 + 正文，直接可贴回会话或存档。 */
export function formatSalvage(result: SalvageResult, sessionId: string): string {
  const head = [
    `# 打捞：未落快照的流式文本`,
    ``,
    `- 会话：${sessionId}`,
    `- stream：${result.stream}`,
    `- 时间：${new Date(result.firstTs).toLocaleString()} → ${new Date(result.lastTs).toLocaleString()}`,
    `- 正文 ${result.contentChars} 字符${result.thinkingChars ? `（另有 ${result.thinkingChars} 字符 thinking${result.thinkingChars && !result.text.includes('> [thinking]') ? '，未包含' : '，已附后'}）` : ''}`,
    `- 历史 ${result.olderStreams} 个更早的工具轮已跳过${result.badLines ? `；${result.badLines} 行损坏跳过` : ''}`,
    ``,
  ].join('\n');
  return `${head}\n${result.text}\n`;
}
