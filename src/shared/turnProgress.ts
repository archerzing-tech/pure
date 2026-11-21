// src/shared/turnProgress.ts
// 回合级「无进展」判据（2026-11-21）。
//
// 背景：用户报 pure 在编码任务里「反复打转」。查三家当前实现后确认，循环本身
// 都没有迭代计数器（Codex 154 个 crate 里没有 max_turns，opencode 是 while(true)
// 靠 finish_reason 停），所以打转只能靠回合内的进展信号兜。这里落两个判据：
//   1. 同一 (tool, args) **成功**执行到第 3 次——结果不会变，再发一次是白烧；
//   2. 连续 6 个回合没有任何成功写入——只读超过这个长度，通常已经不是探索。
//
// 阈值为什么是这两个数（docs/evals/turn-progress-baseline-2026-11-21.md 实测，
// 17 个确定性 fixture / 22 次运行）：
//   · 成功重复：中位 1、最大 2，没有任何一次达到 3。所以 3 是「确实异常」的
//     线，而不是「常见」的线——opencode 的 doom_loop 门槛也是 3，同一个口径。
//   · 无写入连：中位 3、最大 6。取 4 会在 47% 的**通过**运行里误报，取 3 会到
//     82%——那等于把探索当打转。取 6 只在上界之外触发，宁可晚一点。
//   两个数都可以用环境变量覆盖（PURE_TURN_PROGRESS_REPEAT / _NOWRITE），大仓库
//   臂（当前 fixture 只有 3-20 个文件，测不出长尾）该用更低的线重跑再定。
//
// 判据只陈述事实，不替模型结束回合：失败已有 FailurePolicy 的 3/5/8 级阶梯，
// 这里只管「成功但没进展」和「只读太久」。每回合各提醒一次，不再重复。

/** 同一 (tool, args) 成功执行到这个次数就提醒。 */
export const TURN_REPEAT_THRESHOLD = 3;
/** 连续这么多个回合没有成功写入就提醒。 */
export const TURN_NO_WRITE_THRESHOLD = 6;

/** 写入类工具（write_file / edit_file / apply_patch / code_editor 的写模式）。 */
const WRITE_TOOL = /(?:^|_)(?:write|edit|patch)(?:_|$)/i;

export interface TurnProgressWatch {
  /**
   * 记一笔工具结果。返回非空 = 本回合该提醒一次，调用方作为 internal user
   * 消息插进转录（位置必须在工具结果配平之后，否则 400）。
   * `round` 是引擎的回合号（StateChange → THINK 的计数），用于无写入连。
   */
  observe(toolName: string, rawArgs: string | undefined, success: boolean, round: number): string;
}

/** 回退开关：`PURE_TURN_PROGRESS=0` 关掉两个判据（与验收即停同款，便于同码 A/B）。 */
export function turnProgressEnabled(): boolean {
  return typeof process === 'undefined' || process.env?.PURE_TURN_PROGRESS !== '0';
}

function envThreshold(name: string, fallback: number): number {
  if (typeof process === 'undefined') return fallback;
  const raw = process.env?.[name];
  const parsed = raw ? Number.parseInt(raw, 10) : Number.NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

/** 参数归一：键序不同不该被当成两次不同调用（同 FailurePolicy 的去重口径）。 */
function callKey(toolName: string, rawArgs: string | undefined): string {
  if (!rawArgs) return `${toolName}::`;
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawArgs);
  } catch {
    return `${toolName}::${rawArgs.slice(0, 400)}`;
  }
  const stable = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(stable);
    if (value && typeof value === 'object') {
      const out: Record<string, unknown> = {};
      for (const key of Object.keys(value as Record<string, unknown>).sort()) {
        out[key] = stable((value as Record<string, unknown>)[key]);
      }
      return out;
    }
    return value;
  };
  return `${toolName}::${JSON.stringify(stable(parsed))}`;
}

export function createTurnProgressWatch(): TurnProgressWatch {
  const repeatThreshold = envThreshold('PURE_TURN_PROGRESS_REPEAT', TURN_REPEAT_THRESHOLD);
  const noWriteThreshold = envThreshold('PURE_TURN_PROGRESS_NOWRITE', TURN_NO_WRITE_THRESHOLD);
  const callCounts = new Map<string, number>();
  let lastRound = 0;
  let roundHadWrite = false;
  let noWriteStreak = 0;
  let repeatAnnounced = false;
  let noWriteAnnounced = false;

  return {
    observe(toolName: string, rawArgs: string | undefined, success: boolean, round: number): string {
      // 首见的回合不结算：没见过的回合不能假设它没写入（续跑/恢复场景的
      // 回合号会从中间开始）。
      if (lastRound === 0) lastRound = round;
      // 回合推进：每进入一个新回合，结算上一个回合有没有写入。回合号可能跳
      // （并行/恢复路径），所以要逐个补结算。
      while (round > lastRound) {
        if (lastRound > 0 && !roundHadWrite) noWriteStreak += 1;
        roundHadWrite = false;
        lastRound += 1;
      }
      if (!success) return '';

      const base = toolName.includes('__') ? toolName.slice(toolName.lastIndexOf('__') + 2) : toolName;
      // 写入成功就把连击清零：连击是「连续」没写入，不是「累计」没写入。
      if (WRITE_TOOL.test(base)) {
        roundHadWrite = true;
        noWriteStreak = 0;
      }

      if (!repeatAnnounced) {
        const key = callKey(base, rawArgs);
        const count = (callCounts.get(key) ?? 0) + 1;
        callCounts.set(key, count);
        if (count >= repeatThreshold) {
          repeatAnnounced = true;
          return renderRepeatNote(base, count);
        }
      }

      if (!noWriteAnnounced && noWriteStreak >= noWriteThreshold) {
        noWriteAnnounced = true;
        return renderNoWriteNote(noWriteStreak);
      }
      return '';
    },
  };
}

function renderRepeatNote(toolName: string, count: number): string {
  return `<turn_progress signal="repeated_call">
You have now executed this exact call successfully ${count} times in this turn (${toolName}, same arguments each time). The result will be the same again — repeating it cannot move the task forward. If something is blocking you, say what it is in your reply; otherwise take the next different step now.
</turn_progress>`;
}

function renderNoWriteNote(rounds: number): string {
  return `<turn_progress signal="no_write">
${rounds} rounds have passed in this turn without writing a single file. Reading is how you find out what to change, not a substitute for changing it. If you already know the edit, make it now; if a specific fact is still missing, read only what answers that question and then act.
</turn_progress>`;
}
