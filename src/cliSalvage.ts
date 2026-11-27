// src/cliSalvage.ts
// turn.journal.jsonl 的打捞 CLI 面：`pure salvage <sessionId> [--out <file>] [--keep-thinking]`。
// 场景：流式回合崩溃（UI 冻结/强杀），快照里没有这一轮的文本——journal 里有
// 每 50ms 批的原文，打捞出最后一个 stream 分组即「未落快照的回复」。
// 与 cliErrorLog 同形：CLI 宿主有 node:fs，直接读 sessions 目录；纯核在
// shared/journalSalvage.ts（可测试）。

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { formatSalvage, salvageLastStream } from './shared/journalSalvage';
import { bold, dim, green, red } from './termcolors';

export const CLI_SESSIONS_DIR = join(homedir(), '.pure', 'sessions');

export function runSalvageCommand(rest: string[], sessionsDir: string = CLI_SESSIONS_DIR): number {
  const sessionId = rest.find((a) => !a.startsWith('--'));
  if (!sessionId) {
    console.error(`${red('用法')}：pure salvage <sessionId> [--out <file>] [--keep-thinking]`);
    return 1;
  }
  const keepThinking = rest.includes('--keep-thinking');
  const outIdx = rest.indexOf('--out');
  const explicitOut = outIdx >= 0 ? rest[outIdx + 1] : undefined;

  const journalPath = join(sessionsDir, sessionId, 'turn.journal.jsonl');
  if (!existsSync(journalPath)) {
    console.error(`${red('未找到 journal')}：${journalPath}`);
    console.error(dim('该会话没有可打捞的流式记录（journal 只在 chat_stream 带 journalSessionId 时写入）。'));
    return 1;
  }

  let raw: string;
  try {
    raw = readFileSync(journalPath, 'utf8');
  } catch (err) {
    console.error(`${red('读取失败')}：${journalPath} — ${String(err)}`);
    return 1;
  }

  const result = salvageLastStream(raw, { keepThinking });
  if (!result || !result.text.trim()) {
    console.error(dim('journal 里没有可打捞的正文（空文件或全是 thinking 且未开 --keep-thinking）。'));
    return 1;
  }

  const report = formatSalvage(result, sessionId);
  const outPath = explicitOut ?? join(sessionsDir, sessionId, `salvaged-${result.lastTs}.md`);
  try {
    // formatSalvage 的返回已含正文（摘要头 + 正文），再拼一次会重复。
    writeFileSync(outPath, report + '\n', 'utf8');
  } catch (err) {
    console.error(`${red('写出失败')}：${outPath} — ${String(err)}`);
    return 1;
  }

  console.log(`${green('打捞完成')}：${bold(outPath)}`);
  console.log(dim(`  正文 ${result.contentChars} 字符 · stream ${result.stream.slice(0, 12)}… · 历史 ${result.olderStreams} 个工具轮已跳过${result.badLines ? ` · ${result.badLines} 行损坏跳过` : ''}`));
  return 0;
}
