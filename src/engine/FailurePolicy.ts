// src/engine/FailurePolicy.ts
// v0.1 — Failure recovery policy: escalating retry → reflect → degrade → stop.
// Used by AgentLoopEngine when consecutive failures accumulate.
// v0.2 — logical-trap escape: after a failed round the hints tell the model to
//        re-read the ORIGINAL request and consider that the premise itself may
//        be a trap (self-contradictory / impossible / trick) — switch to a
//        different interpretation instead of grinding the same dead-end.
// v0.12 — web_search recovery guidance: when the failing tool is web_search,
//        retry/reflect hints append explicit "rephrase, don't repeat" guidance
//        (a dead-end query or a down backend must not be retried verbatim).
//        Mirrors the adapters' error text and the shared PromptAssembler contract
//        so the policy reinforces it even when the raw error message does not.

import type { FailureRecord, FailureAction, FailurePolicy, FailureHistory } from '../shared/types';
import { classifyFailure, FAILURE_CLASS_HINTS } from '../shared/netGuard';

// Trap-escape guidance appended to retry/reflect hints once the first attempt
// has already failed: the failure may not be in the model's execution but in
// the request's premise. Re-reading the original prompt and switching approach
// beats repeating the same failing path.
const TRAP_ESCAPE_HINT =
  ' Also re-read the ORIGINAL user request: the failure may be a logical trap (self-contradictory, impossible, or mutually exclusive constraints, or a trick premise). If the premise itself is flawed, state the trap and solve the most reasonable interpretation instead of repeating the same approach.';

// Web-search recovery guidance appended to retry/reflect hints (and the
// identical-repeat stop reason) when the failing tool is web_search. Repeating
// the same or a near-identical query is the classic web_search failure loop —
// the fix is to rephrase, not retry verbatim. Wording mirrors the adapters'
// empty/failed-search messages and the shared PromptAssembler contract. Starts with
// "Do NOT" (no "if" hedge): the webHint guard already guarantees the failing
// tool is web_search, so the appended sentence can state the rule directly.
const WEB_SEARCH_RECOVERY_HINT =
  ' Do NOT repeat the same or a near-identical query — rephrase it (broader terms, simpler wording, or English), or use web_fetch on a URL you expect to be authoritative.';

const EDIT_MISMATCH_RECOVERY_HINT =
  ' The edit_file target no longer matches the current file. Do NOT repeat the same edit_file call. First call read_file on the target path, compare the current contents with the intended change, then use a shorter exact context or write a complete corrected file only when justified. If the requested change is already present, verify it and move on.';

function isEditMismatch(failure: FailureRecord): boolean {
  return failure.toolName === 'edit_file' && /String not found in file|file may have changed|target no longer matches/i.test(failure.message);
}

/**
 * Default escalating failure policy:
 * - 1-2 consecutive failures → retry with light hint
 * - 3-4 consecutive failures → reflect with deeper hint
 * - 5+ consecutive failures → degrade / stop, requesting user intervention
 *
 * The engine resets failure tracking after any successful phase.
 *
 * v0.11 — repeated-error detection: when the SAME call (same tool + same error
 * message) fails over and over, count-based escalation alone is not enough —
 * the model keeps walking the same dead-end path. The policy recognizes
 * identical repeats and escalates faster with an explicit "do not repeat this
 * call" instruction:
 * - same error repeated 2× → reflect + tell the model to stop making that call
 * - same error repeated 3-4× → degrade: SKIP the failing call, take a workable
 *   alternative, CONTINUE the task (a hard stop here aborted multi-step work
 *   over one non-critical failing call — e.g. a website build dying on a
 *   blocked resource download)
 * - same error repeated 5× → degrade + QUARANTINE (v0.13, framework-reform 4a):
 *   the engine mechanically refuses further identical calls (same tool + same
 *   args) for the rest of the turn — a directive the model kept ignoring
 *   becomes an enforced skip. Refusals stay out of the failure ledger, so the
 *   ladder does not grind on them; a third refusal hands the turn back.
 *   llm_error is the carve-out: an LLM request has no skippable call (the
 *   engine assembles the payload; the model cannot route around it) — 5
 *   identical repeats stop deterministically, as before.
 * - same error repeated 8× with *different* args each time → stop backstop.
 */
function repeatKey(f: FailureRecord): string {
  // toolName separates "web_fetch failed on URL A" from "read_file failed";
  // the message identifies the same dead-end (e.g. repeated "unsupported
  // content type" from the same tool).
  return `${f.toolName ?? ''}::${f.message}`;
}

export class DefaultFailurePolicy implements FailurePolicy {
  /** E1.2 — optional cross-session failure experience (a synchronous snapshot,
   *  preloaded once per session). Absent ⇒ the stock session-local ladder. */
  constructor(private readonly history?: FailureHistory) {}

  decide(failures: FailureRecord[]): FailureAction {
    if (failures.length === 0) {
      return { kind: 'retry', hint: 'Continue.' };
    }

    const last = failures[failures.length - 1];
    // ── 分型阶梯（framework-reform 4a）──
    // 通用 count 阶梯只数「与最近失败同类型、且来自纯失败轮」的记录：
    // ① 混账过去把 2 条工具错误 + 2 条验证失败凑成「4 连败」的假象——
    //    tool/llm/verify 各走各的阶梯，互不凑数；
    // ② 部分成功轮的失败（roundHadSuccess）不喂通用阶梯——轮里有真实
    //    成功就证明基础设施活着，与 Harness transient 豁免同尺（同调用
    //    后来成功 = 瞬时故障）。重复/类环检测器不洗：同一调用跨轮硬试
    //    仍是死路，环检测照旧全量计数。
    const sameTypeCount = failures.filter(f => f.type === last.type && !f.roundHadSuccess).length;

    // ── Repeated-identical-error detection (v0.11) ──
    const repeats = failures.filter(f => repeatKey(f) === repeatKey(last)).length;
    const toolLabel = last.toolName ? ` (tool: ${last.toolName})` : '';
    // Web-search recovery guidance only applies when the failing call is a
    // web_search — for other tools it would be noise.
    const webHint = ['web_search', 'researcher_web', 'researcher_docs'].includes(last.toolName ?? '')
      ? WEB_SEARCH_RECOVERY_HINT
      : '';
    const editHint = isEditMismatch(last) ? EDIT_MISMATCH_RECOVERY_HINT : '';
    // Failure class of the most recent failure (shared by the E1.2 gate below
    // and the class-level loop detection further down).
    const lastClass = classifyFailure(last.message);

    // ── Cross-session acceleration (E1.2) ──
    // Past sessions already recorded this tool failing with this error class:
    // move the ladder's entry point forward — the FIRST failure reflects with
    // the recorded lesson instead of blindly retrying, the second degrades
    // straight to skip-it. Gated to a non-generic class: a generic message
    // carries no transferable signal, so an unrelated one-off last session
    // must not escalate today's first failure. New traps keep the stock
    // session-local ladder below.
    const historyEntry = this.history && repeats <= 2 && lastClass !== 'generic'
      ? this.history.lookup(last.toolName, lastClass)
      : undefined;
    if (historyEntry && historyEntry.count > 0) {
      const seen = `Past session(s) already recorded ${historyEntry.count} failure(s) of ${last.toolName ?? 'this tool'} in the "${lastClass}" class, most recently: "${last.message}"${historyEntry.lesson ? ` — lesson recorded then: "${historyEntry.lesson}"` : ''}.`;
      if (repeats === 1) {
        return {
          kind: 'reflect',
          hint: `${seen} Do not walk the same path again — skip the naive retry and change approach now (different tool, route, or premise). This history is prior experience, not a verdict: if the condition that broke it has verifiably changed, retrying is legitimate.${webHint}${TRAP_ESCAPE_HINT}`,
        };
      }
      return {
        kind: 'degrade',
        reason: `${seen} This is a repeat — SKIP the failing call now. Do not retry it with the same or trivially-different arguments: take a workable alternative that still serves the user's goal and CONTINUE the task. The history is a strong prior, not a verdict — retrying is legitimate only once the changed condition has been verified.${webHint}`,
      };
    }

    // ── Context-window overflow: structural, not transient ──
    // A provider 400 saying the conversation no longer fits the input window
    // cannot be retried into success — every injected retry/reflect directive
    // (a user-role message that DOES go on the wire) makes the next request
    // strictly larger. One repeat is enough to stop: grinding the usual
    // 8-failure ladder burned tokens and wedged the session against "继续"
    // (every new turn re-entered trim with the same overweight transcript).
    // 口径（2026-11-01 审查判例）：只数 llm_error 的 context 类。工具级
    // context 错误（子代理/委派打爆它自己的窗口）不是对话超窗——整个任务
    // 可绕，走 classRepeats 阶梯 degrade（拆小/跳过），不该被「1 条任意旧
    // 失败 + 1 条工具 context」的凑数 stop 掉整回合。
    const contextLlmCount = failures.filter(f => f.type === 'llm_error' && classifyFailure(f.message) === 'context').length;
    if (lastClass === 'context' && contextLlmCount >= 2) {
      return {
        kind: 'stop',
        reason: `Context window exhausted: the conversation no longer fits the model's input window (${contextLlmCount} consecutive provider rejections). Last: "${last.message}". Retrying cannot shrink it — the user should start a fresh session or reduce the input; compaction must shed tool-call payloads too.`,
      };
    }

    // 网关拦截类（2026-11-02 内网判例：公司 NetentSec SWG 策略阻断）：403
    // 带网关自产页 = 请求被中间网络设备的策略拦下——不是凭证问题，更不是
    // 模型服务故障，重试与换措辞改变不了网关策略。两次即定性止损，不再磨
    // 阶梯白烧轮次；终点呈现由 sanitizeInterruptedReason 对该形态出专属
    // 拟人归因（讲真话终点：被谁拦的、能做什么、不是程序坏了）。
    const gatewayLlmCount = failures.filter(f => f.type === 'llm_error' && classifyFailure(f.message) === 'gateway').length;
    if (lastClass === 'gateway' && gatewayLlmCount >= 2) {
      return {
        kind: 'stop',
        reason: `The request is being blocked by a network gateway (most likely your corporate proxy / secure web gateway enforcing upload-size or content policies) — the model provider was never reached, so this is not a provider outage. Last: "${last.message}". Retrying cannot change the gateway's policy. Stop here and tell the user plainly: split the task smaller, attach fewer/smaller files, switch to a network without this restriction, or ask the admin to allow the model service domain.`,
      };
    }

    // Same call failed 5+ times with the same error: it kept failing even
    // after the skip-it directive below — words alone stopped working, so the
    // engine takes over mechanically (framework-reform 4a, 强制 skip): the
    // identical call (same tool + same args) is quarantined and refused for
    // the rest of the turn while the ladder itself stays open — the model
    // keeps the turn and must route around the dead call. ≥8 with the same
    // message but *escaping* args (refusals don't count here) is the stop
    // backstop for a pathological loop.
    if (repeats >= 8) {
      return {
        kind: 'stop',
        reason: `${repeats} consecutive failures of the identical call${toolLabel}: "${last.message}". Even after the engine started refusing the quarantined call, the same dead-end kept being hit with slightly different arguments. Stopping here rather than grinding on. Please review and provide guidance.`,
      };
    }
    if (repeats >= 5) {
      // LLM 请求没有「可跳过的调用」——payload 由引擎拼装，模型没有换法
      // 的自由度（2026-10-30 流超时判例同源）：5 连败即确定性止损，注入
      // 换法指令改变不了什么，只会白烧 3 轮。工具调用才有绕路空间，走
      // 隔离强制 skip，把回合留给模型路由。
      if (last.type === 'llm_error') {
        return {
          kind: 'stop',
          reason: `${repeats} consecutive failures of the identical call${toolLabel}: "${last.message}". This exact call kept failing even after a skip-it directive was issued — stopping here rather than retrying again. Please review and provide guidance.`,
        };
      }
      // verify_failure 没有可隔离的调用：账本记录不带 toolName/callArgs
      // （验证器评的是产出，不是某次调用），引擎的隔离登记只认工具错误。
      // 给它不带 QUARANTINE 措辞的诚实 degrade——照抄隔离文案就是向模型
      // 撒谎（引擎从不执行那次「拒绝」）。
      if (last.type === 'verify_failure') {
        return {
          kind: 'degrade',
          reason: `${repeats} consecutive failures of the same verification: "${last.message}". The output keeps failing the same check — do not simply re-run the same fix. Change the approach that produces the output (different method, source, or a narrower goal) and CONTINUE the task.`,
        };
      }
      return {
        kind: 'degrade',
        reason: `${repeats} consecutive failures of the identical call${toolLabel}: "${last.message}". This exact call (same tool, same arguments) is now QUARANTINED — the engine will refuse to execute it again this turn. Do not re-issue it; take a workable alternative that still serves the user's goal (a different source or tool, inline or substitute the content, or omit this step) and CONTINUE the task. Three refused attempts hand the turn back to the user.${webHint}`,
        quarantineLastCall: true,
      };
    }

    // Same call failed 3-4 times with the same error: the model is looping on
    // one dead-end call, but the TASK may be perfectly salvageable. This used
    // to be a hard stop — which aborted multi-step work (e.g. a website build
    // where one resource download kept failing) and threw away its own
    // advice, because the model never got the chance to act on it. Degrade
    // instead: the engine injects the directive and the loop continues, so
    // the model can skip the call and finish the remaining steps.
    if (repeats >= 3) {
      return {
        kind: 'degrade',
        reason: `${repeats} consecutive failures of the identical call${toolLabel}: "${last.message}". This exact call keeps failing with the same error — SKIP it now. Do not retry it with the same or trivially-different arguments. Take a workable alternative that still serves the user's goal (a different source or tool, inline or substitute the content, or omit this step) and CONTINUE the task. One more identical failure and the engine quarantines this call — it will then be refused mechanically, not by advice.${webHint}`,
      };
    }

    // Same call failed twice with the same error: escalate to reflect with an
    // explicit instruction not to repeat the exact call.
    if (repeats === 2) {
      return {
        kind: 'reflect',
        hint: `The same call${toolLabel} has now failed twice with the identical error: "${last.message}". Do NOT make this exact call again — it will fail the same way. Change approach now (different tool, different URL, or ask the user).${webHint}${TRAP_ESCAPE_HINT}`,
      };
    }

    // ── Class-level loop detection (v0.13) ──
    // Diverse arguments, same failure CLASS. Three different URLs failing with
    // three different network errors against the same dead host used to evade
    // the identical-repeat detector and grind to the generic 6-failure
    // ceiling. Same tool + same class is a loop even when the messages differ.
    const classHint = FAILURE_CLASS_HINTS[lastClass];
    const classRepeats = lastClass === 'generic'
      ? 0
      : failures.filter(f => f.toolName === last.toolName && classifyFailure(f.message) === lastClass).length;
    if (classRepeats >= 4) {
      return {
        kind: 'degrade',
        reason: `${classRepeats} failures of the same class (${lastClass}) from ${last.toolName ?? 'this tool'}, most recently: "${last.message}". Stop attacking this path from different angles. ${classHint} Then CONTINUE the task with what is achievable.`,
      };
    }
    if (classRepeats === 3) {
      return {
        kind: 'reflect',
        hint: `3 failures of the same class (${lastClass}) from ${last.toolName ?? 'this tool'}, most recently: "${last.message}". ${classHint}`,
      };
    }

    if (sameTypeCount <= 2) {
      // 2nd failure = the first round of testing already failed → prime the
      // model to consider that the REQUEST may be the trap, not its execution.
      const trapNote = sameTypeCount === 2 ? TRAP_ESCAPE_HINT : '';
      return {
        kind: 'retry',
        // 钳到 1：全混合轮（sameTypeCount=0）不该给模型看 "Attempt 0"。
        hint: `Attempt ${Math.max(1, sameTypeCount)}: ${last.message}. ${isEditMismatch(last) ? 'Re-read the current file before making any further edit.' : 'Please retry with a simpler approach.'}${webHint}${editHint}${trapNote}`,
      };
    }

    if (sameTypeCount <= 4) {
      const toolHints = failures
        .filter(f => f.toolName)
        .map(f => f.toolName)
        .join(', ');
      return {
        kind: 'reflect',
        hint: `${sameTypeCount} consecutive failures${toolHints ? ' involving ' + toolHints : ''}. ` +
          `Last error: ${last.message}. Reflect deeply on what went wrong and try a fundamentally different approach.${webHint}${editHint}${TRAP_ESCAPE_HINT}`,
      };
    }

    // sameTypeCount >= 5 → salvage ladder: degrade with escalating directives.
    // The model gets salvage turns at 5 AND 6-7 (the second one forbids every
    // failing path outright) — a hard stop fires only at 8, when even
    // "deliver with what you have" kept failing.
    if (sameTypeCount >= 8) {
      return {
        kind: 'stop',
        reason: `${sameTypeCount} consecutive failures. Last: ${last.message}. Salvage mode could not complete a delivery — stopping here. Please review and provide guidance.`,
      };
    }
    if (sameTypeCount >= 6) {
      return {
        kind: 'degrade',
        reason: `${sameTypeCount} consecutive failures (last: ${last.message}). SALVAGE, final pass: every path that failed this turn is now OFF-LIMITS — do not call any tool that has failed, and do not start new side quests. Wrap up NOW: finish the minimal verifiable deliverable from what already exists, then report what was completed, what stayed blocked, and the recommended next step.`,
      };
    }
    return {
      kind: 'degrade',
      reason: `${sameTypeCount} consecutive failures (last: ${last.message}). Switched to degraded / simplified mode: stop retrying the failing approach, minimize further tool use, and deliver the simplest complete answer — or hand control back to the user with a clear summary of what was attempted and what failed.`,
    };
  }
}

/**
 * E1.2 — build the synchronous FailureHistory snapshot from error_pattern
 * memories (`memoryStore.list({ type: 'error_pattern' })`), the exact
 * records the Harness writes when the failure policy stops/degrades. The
 * tool name is recovered from the recorded "(tool: x)" suffix; the class is
 * classified over the recorded content. Unclassifiable (generic) records
 * are skipped — they carry no transferable signal, mirroring the gate in
 * decide(). Takes a structural record type so the engine never imports the
 * memory adapter.
 */
export function failureHistoryFromMemories(memories: Array<{ type: string; content: string }>): FailureHistory {
  const counts = new Map<string, number>();
  const lessons = new Map<string, string>();
  for (const memory of memories) {
    if (memory.type !== 'error_pattern') continue;
    const toolMatch = memory.content.match(/\(tool: ([^)]+)\)/);
    const errorClass = classifyFailure(memory.content);
    if (errorClass === 'generic') continue;
    const key = `${toolMatch?.[1] ?? ''}::${errorClass}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
    if (!lessons.has(key)) lessons.set(key, memory.content.slice(0, 200));
  }
  return {
    lookup(toolName, errorClass) {
      const key = `${toolName ?? ''}::${errorClass}`;
      return { count: counts.get(key) ?? 0, lesson: lessons.get(key) ?? '' };
    },
  };
}
