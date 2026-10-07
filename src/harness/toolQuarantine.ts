// src/harness/toolQuarantine.ts
// 北极星 §13.4 验收口径 4 后半句：「**连续失败自动停用出卡**」。
//
// 试跑门（toolSolidification 的 ③）只证明「写出来那一刻能跑通」。它证明不了
// 之后：脚本依赖的环境会变、参数形状会变、上游接口会改。固化出来的工具是一台
// 没有看门狗的机器——它在真机上连续失败时，唯一后果是模型一次次重试、一次次
// 拿到同样的报错，把整个回合的预算耗在这上面。本模块是那台看门狗的判定部分。
//
// 三条纪律：
//  1. **只数「工具自己跑不起来」，不数「命令返回非零」**。这条是这道门成立的全部
//     前提，也是它最容易错的地方：生成工具大量就是 grep / diff / test 的包装，
//     而 `grep` 没匹配到就是 exit 1、`diff` 有差异就是 exit 1、`bun test` 有失败
//     用例也打印一屏到 stderr——**这些全都是成功运行**。按「非零即失败」计数，
//     连按三次 Stop 就会把一个健康工具毙掉，而这道门比没有门更糟：用户会开始
//     不信它，然后把真正坏掉的工具也放过去。
//  2. **有样本下限，且计数会过期**。1 次不构成结论；三个月前攒下的失败也不该在
//     重启后第一次调用时立刻引爆（那不是「连续」，是历史）。
//  3. **可逆且留证**。停用态是工具目录里的一个标记文件，不是删工具——用户看完
//     卡可以改脚本再解除，改不动就删目录，一切回到停用前。
//
// 纯函数，无 IO（标记文件的读写在宿主侧），所以整条判据都能在毫秒级测完。

import type { ToolResult } from '../shared/types';

/** 连续失败多少次才停用。 */
export const QUARANTINE_CONSECUTIVE_FAILURES = 3;

/** 停用前至少要有这么多次调用。 */
export const QUARANTINE_MIN_CALLS = 3;

/** 计数有效期：上一次失败早于这个时长就当没失败过（毫秒，默认 7 天）。
 *  没有它，「上个月连挂 3 次、这个月修好了又调用 1 次」会在这一次立刻引爆——
 *  而那是 4 次里 3 次的历史，不是一次「连续」。 */
export const QUARANTINE_COUNT_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/** 停用标记文件名（放在 `~/.pure/tools/<name>/` 里，与 TOOL.json 同级）。
 *  删掉工具目录即连带删掉标记 —— 「删文件即消失」这条设计口径仍然成立。 */
export const QUARANTINE_MARKER_FILE = 'QUARANTINED.json';

/** Shell「这个命令压根没跑起来」的退出码（POSIX sh 约定）。 */
const EXIT_NOT_EXECUTABLE = 126;
const EXIT_COMMAND_NOT_FOUND = 127;

/**
 * 一次外部工具调用的结局分类。**只有 `broken` 进计数器。**
 *
 * - `ok`：退出码 0。
 * - `ran`：跑过了，而且说了话（stdout 或 stderr 非空）。grep 没匹配、diff 有
 *   差异、测试挂了——全都是这一类，它们是**成功的运行**，只是结果是否定。
 * - `inert`：根本没轮到工具表态。用户按了 Stop / 暂停 / 超时。
 * - `broken`：退出码是「命令跑不起来」那一档（126/127），**且一个字都没输出**。
 *   脚本被删了、路径写错了、exec 模板指向一个不存在的文件——工具自己没法用了。
 */
export type ExternalToolOutcome = 'ok' | 'ran' | 'inert' | 'broken';

export interface ExternalToolResultView {
  success: boolean;
  error?: string;
  /** execute_command 回执里的 `{ stdout, stderr, exitCode }`。 */
  result?: unknown;
  /** 宿主已经判定的中断（子代理的暂停/停掉走这条）。 */
  outcome?: string;
}

/**
 * 把宿主回执分类。`aborted` 优先于一切——用户按了 Stop 的时候，工具是被打断
 * 的，不是坏的，把它算成失败等于惩罚用户的手。
 */
export function classifyExternalToolOutcome(
  result: ExternalToolResultView,
  options: { aborted?: boolean; timedOut?: boolean } = {},
): ExternalToolOutcome {
  if (options.aborted || options.timedOut || result.outcome === 'paused' || result.outcome === 'stopped') {
    return 'inert';
  }
  if (result.success) return 'ok';
  const payload = (result.result ?? {}) as { stdout?: unknown; stderr?: unknown; exitCode?: unknown };
  const stdout = typeof payload.stdout === 'string' ? payload.stdout.trim() : '';
  const stderr = typeof payload.stderr === 'string' ? payload.stderr.trim() : '';
  const exitCode = typeof payload.exitCode === 'number' ? payload.exitCode : undefined;
  // 说了话 = 运行本身是成功的，只是结论是否定。这是 grep/diff/test 的常态。
  if (stdout !== '' || stderr !== '') return 'ran';
  // 静默的非零退出：可能是 grep 没匹配（正常），也可能是工具没被调用。
  // 只有 shell 层的「跑不起来」两档退出码才��工具自己的问题。
  if (exitCode === EXIT_NOT_EXECUTABLE || exitCode === EXIT_COMMAND_NOT_FOUND) return 'broken';
  return 'ran';
}

/** 从宿主回执直接判断「超时」，避免上层用字符串匹配去猜。 */
export function looksTimedOut(result: Pick<ToolResult, 'error'>): boolean {
  return typeof result.error === 'string' && /timed out/i.test(result.error);
}


export interface ToolQuarantineState {
  /** 连续「工具跑不起来」次数（一次 `ok` / `ran` / `inert` 即归零）。 */
  consecutiveFailures: number;
  /** 累计调用次数。 */
  totalCalls: number;
  /** 最近一次「工具跑不起来」的时间戳（ms）；从未发生为 0。 */
  lastFailureAt: number;
  /** 是否已被停用。停用后仍继续记账，用户可以在仪表盘看到它有多不work。 */
  quarantined: boolean;
  /** 停用理由（停用时写入，用于出卡）。 */
  reason?: string;
  /** 停用发生的时间戳。 */
  quarantinedAt?: number;
}

export function emptyQuarantineState(): ToolQuarantineState {
  return { consecutiveFailures: 0, totalCalls: 0, lastFailureAt: 0, quarantined: false };
}

/**
 * 记一次调用的结局。**只有 `broken` 累加连续失败**——`ran`（命令成功运行但结论
 * 是否定）与 `inert`（用户打断 / 超时）都必须清零，因为它们同样证明「工具跑得
 * 起来」。把 grep 没匹配算成失败，这道门就变成了对 shell 工具的误杀机器。
 *
 * 过期判断放在**这里**而不是裁决里：裁决时 `lastFailureAt` 刚被本次 tally 刷成
 * `now`，`now - lastFailureAt` 恒为 0，裁决侧的 TTL 永远是死分支。要让「上个月
 * 连挂三次」在今天第一次调用时不算数，必须在看旧值的那一刻就判。
 */
export function tallyToolOutcome(
  state: ToolQuarantineState,
  outcome: { outcome: ExternalToolOutcome; now: number; ttlMs?: number },
): ToolQuarantineState {
  const next: ToolQuarantineState = { ...state, totalCalls: state.totalCalls + 1 };
  if (outcome.outcome !== 'broken') {
    next.consecutiveFailures = 0;
    return next;
  }
  const ttl = outcome.ttlMs ?? QUARANTINE_COUNT_TTL_MS;
  const stale = state.lastFailureAt > 0 && outcome.now - state.lastFailureAt > ttl;
  next.consecutiveFailures = stale ? 1 : state.consecutiveFailures + 1;
  next.lastFailureAt = outcome.now;
  return next;
}

export type QuarantineVerdict =
  | { kind: 'keep' }
  | { kind: 'quarantine'; reason: string; evidence: string };

/**
 * 裁决：该不该把这个工具停用。
 *
 * 已经停用过的一律不再重复裁决（幂等）——每次调用都重跑一遍裁决会反复写盘、
 * 反复出卡，卡片轰炸比工具坏了更糟。
 *
 * 计数过期**不在这里判**：执行器先 tally 再裁决，而 tally 已把 `lastFailureAt`
 * 刷成 `now`，此刻算 TTL 恒为 0，裁决侧的过期判断是条死分支。过期属于计数器自身
 * 的性质，见 `tallyToolOutcome`。
 */
export function quarantineVerdict(
  name: string,
  state: ToolQuarantineState,
  options: { consecutiveFailures?: number; minCalls?: number } = {},
): QuarantineVerdict {
  const need = options.consecutiveFailures ?? QUARANTINE_CONSECUTIVE_FAILURES;
  const minCalls = options.minCalls ?? QUARANTINE_MIN_CALLS;
  if (state.quarantined) return { kind: 'keep' };
  if (state.totalCalls < minCalls) return { kind: 'keep' };
  if (state.consecutiveFailures < need) return { kind: 'keep' };
  const evidence = `连续 ${state.consecutiveFailures} 次调用「跑不起来」（共调用 ${state.totalCalls} 次）`;
  return {
    kind: 'quarantine',
    evidence,
    reason: `工具 "${name}" 已自动停用：${evidence}，达到 ${need} 次的停用线。它的命令压根没能执行（脚本被删、路径写错或不可执行），继续留着只会让每次委派重蹈覆辙。`,
  };
}

/** 出卡载荷：为什么停、怎么恢复。
 *
 * 恢复路径必须写进卡里——一个只说「已停用」不说「怎么回去」的用户，下次只想
 * 重新启用时只能删目录重来。
 *
 * **刻意没有「一键删除」**：那需要一条递归删除 `~/.pure/tools/<name>/` 的宿主
 * 命令，是这道门之外新增的破坏性面（路径校验、删错不可逆）。真正要删的用户照
 * 提示里的路径手删即可——「删文件即消失」本来就是设计口径，不是必须点一下的按钮。
 */
export interface ToolQuarantineCard {
  toolName: string;
  reason: string;
  evidence: string;
  consecutiveFailures: number;
  totalCalls: number;
  quarantinedAt: number;
  /** 工具所在目录（恢复/删除都指向它）。 */
  toolDir: string;
}

export function buildQuarantineCard(
  name: string,
  state: ToolQuarantineState,
  verdict: Extract<QuarantineVerdict, { kind: 'quarantine' }>,
): ToolQuarantineCard {
  return {
    toolName: name,
    reason: verdict.reason,
    evidence: verdict.evidence,
    consecutiveFailures: state.consecutiveFailures,
    totalCalls: state.totalCalls,
    quarantinedAt: state.quarantinedAt ?? state.lastFailureAt,
    toolDir: `~/.pure/tools/${name}/`,
  };
}

/** 标记文件形状（磁盘契约）。只认这两个字段，其余忽略——标记文件坏了不该
 *  让一个工具永久停死（那比不禁用更糟），所以解析失败按「未停用」处理。 */
/** 标记文件的形状（磁盘契约，Rust 侧同名结构）。六个字段都要读：三个计数是
 *  「跨回合连续」的载体，只读 quarantined/reason 会让计数每次装载归零。 */
export interface QuarantineMarker {
  quarantined: boolean;
  reason?: string;
  quarantinedAt?: number;
  consecutiveFailures?: number;
  totalCalls?: number;
  lastFailureAt?: number;
}

/**
 * 解析标记文件内容。`content` 可以是 JSON 文本**或已解析的对象**——Rust 侧发的是
 * 对象（`serde_json::Value`），TS 侧曾按字符串消费，两边对不上时这里会
 * `text.trim is not a function` 把整条加载路径抛掉，表现为「仪表盘永远显示没有
 * 停用、重新启用按钮永不渲染」。两种形态都收，契约就不再是个隐式假设。
 *
 * 未停用的标记**同样保留计数**——计数是在停用之前就开始攒的，把它们归零等于
 * 「连续」只在单次运行内连续，那这道门跨回合永远攒不到线。
 *
 * 坏内容一律读成「全新状态」：标记坏了不该让一个工具永久死锁。
 */
export function parseQuarantineMarker(content: string | QuarantineMarker | null | undefined): ToolQuarantineState {
  if (content === null || content === undefined) return emptyQuarantineState();
  let parsed: QuarantineMarker;
  if (typeof content === 'string') {
    if (!content.trim()) return emptyQuarantineState();
    try {
      parsed = JSON.parse(content) as QuarantineMarker;
    } catch {
      return emptyQuarantineState();
    }
  } else {
    parsed = content;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return emptyQuarantineState();
  const num = (value: unknown): number => (typeof value === 'number' && Number.isFinite(value) ? value : 0);
  const state: ToolQuarantineState = {
    quarantined: parsed.quarantined === true,
    consecutiveFailures: num(parsed.consecutiveFailures),
    totalCalls: num(parsed.totalCalls),
    lastFailureAt: num(parsed.lastFailureAt),
  };
  if (state.quarantined) {
    state.reason = typeof parsed.reason === 'string' ? parsed.reason : undefined;
    state.quarantinedAt = num(parsed.quarantinedAt) || undefined;
  }
  return state;
}

/** 停用状态 → 标记文件文本。计数一并落盘，否则「连续」只在单次运行内连续：
 *  一个每次启动失败两次的工具，跨重启永远攒不到三次。 */
export function renderQuarantineMarker(state: ToolQuarantineState): string {
  const marker: QuarantineMarker = {
    quarantined: state.quarantined,
    ...(state.quarantined ? { reason: state.reason, quarantinedAt: state.quarantinedAt } : {}),
    consecutiveFailures: state.consecutiveFailures,
    totalCalls: state.totalCalls,
    lastFailureAt: state.lastFailureAt,
  };
  return `${JSON.stringify(marker, null, 2)}\n`;
}

/** 停用的工具被调用时的回执（兜底路径）。模型必须立刻知道「这个工具不会再跑了」
 *  以及为什么，否则它会把同一个调用重试到预算耗尽 —— 那正是这道门要掐掉的事。
 *
 * 刻意**不带** `ToolResult.outcome`：那个字段只有 'paused' | 'stopped'，两个值都
 *  表达「用户按了暂停/停止」，而 UI 上色、引擎同参去重豁免、失败策略三处都按它
 *  分流。停用是**工具级永久拒绝**，不是这一轮的中断，塞进去会给三处都掺一个它们
 *  不认识的新语义。主防线也不在这里——停用后工具即从工具列表消失，模型根本调不到；
 *  这条只是「停用发生的那一轮里模型已经把它选出来了」的兜底，不执行任何命令，
 *  所以按失败记账也只花一个空转。 */
export function quarantinedToolResult(
  toolCallId: string,
  toolName: string,
  state: ToolQuarantineState,
  duration = 0,
): ToolResult {
  const why = state.reason ?? `已自动停用（连续 ${state.consecutiveFailures} 次调用失败）`;
  return {
    id: toolCallId,
    toolName,
    success: false,
    duration,
    error: `工具 "${toolName}" 已被自动停用，不会再执行。${why} 修好 ~/.pure/tools/${toolName}/ 下的脚本后可在进化仪表盘重新启用。`,
    result: { outcome: 'quarantined', summary: `工具 ${toolName} 已自动停用：${why}` },
  };
}
