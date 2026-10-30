// src/ui/thinkingCard.ts
// Live "thinking" trace for the chat transcript. It is expanded by default so
// the reasoning stream is visible live, and the native details control lets the
// user collapse and reopen it. Completed thinking remains in the transcript so
// it can be reviewed after the assistant answer or a tool call appears.
//
// Shared structure with toolRow.ts: `.bubble-row` wrapper + `<details>`, so
// live streaming (chat.ts) and any future replay render identically.

import { t } from '../shared/i18n';

/** Collapse verbatim-repeated reasoning blocks into one occurrence.
 * Reasoning models occasionally loop internally and emit the same sentence or
 * paragraph over and over ("I'll call sys_info() now:" × 4). Detect the shortest
 * period that reproduces the whole block sequence and keep only one period, so
 * the user sees a clean thought trace instead of a stuck loop. Only collapses
 * EXACT repetitions — varied reasoning is left untouched. */
export function collapseRepeatedReasoning(text: string): string {
  if (!text) return text;
  const blocks = text
    .split(/\n\s*\n/)
    .map(b => b.trim())
    .filter(b => b.length > 0);
  if (blocks.length < 3) return text;
  for (let period = 1; period <= Math.floor(blocks.length / 2); period++) {
    let periodic = true;
    for (let i = period; i < blocks.length; i++) {
      if (blocks[i] !== blocks[i % period]) {
        periodic = false;
        break;
      }
    }
    if (periodic) {
      return blocks.slice(0, period).join('\n\n');
    }
  }
  return text;
}

export function appendStoredThinking(text: string, parent: HTMLElement): void {
  const handle = createThinkingCard();
  handle.card.classList.remove('thinking');
  handle.card.classList.add('complete');
  handle.card.querySelector('.thinking-dots')?.remove();
  handle.textEl.textContent = collapseRepeatedReasoning(text);
  parent.appendChild(handle.el);
}

export interface ThinkingCardHandle {
  el: HTMLElement;              // .bubble-row.thinking-row
  card: HTMLDetailsElement;     // .thinking-card
  body: HTMLElement;            // .thinking-body (non-scrolling; owns the padding)
  scrollEl: HTMLElement;        // .thinking-scroll (max-height scroll window)
  textEl: HTMLElement;          // .thinking-text (reasoning content)
}

// Honest live label for pre-flight phases (workspace probe, clarifying
// interview, task analysis, first-token wait). chat.ts sets the label the
// moment a REAL phase starts, so the card states what is actually happening
// instead of pretending. The first streamed reasoning token then replaces the
// waiting text with real content. There is deliberately no fake "what I'm
// doing" rotation: cycling claims of work that isn't happening reads as
// theater, and the animated dots already keep the card alive while waiting.
export function setThinkingLabel(handle: ThinkingCardHandle, text: string): void {
  const label = handle.card.querySelector<HTMLElement>('.thinking-label');
  if (!label) return;
  label.textContent = text;
}

// ── Live elapsed-time feedback ──
// A silent wait reads as a hung session ("正在思考下一步" could sit static for
// minutes with only animated dots). The timer chip ticks every second next to
// the label so the user can SEE time advancing, and after hintAfterMs with no
// reasoning text yet, one honest hint explains what long silences usually are.
// No fake progress theater beyond that — matching the no-rotation policy
// documented above.

const THINKING_TIMER_DEFAULTS = { intervalMs: 1000, hintAfterMs: 15000 };

// The slow-response hint must distinguish a recovery from an ordinary
// first-token wait without guessing that the user's network is broken. A
// retry can come from an empty response, provider-side rejection, rate limit,
// tool failure, or verification failure; the precise failure remains in the
// event stream, while this UI copy stays honest and cause-neutral.
function defaultHintFor(handle: ThinkingCardHandle): string {
  // 探测结论优先：具体真相 > cause-neutral 安抚。诊断只在探测失败时存在。
  const diagnosis = netDiagnosisFor(handle);
  if (diagnosis) return diagnosis;
  const label = handle.card.querySelector<HTMLElement>('.thinking-label')?.textContent ?? '';
  if (label.includes('重试') || label.includes('未成功') || label.includes('失败') || label.includes('未通过')) {
    return '上一阶段未成功，正在自动调整处理方式；这不表示你的网络已断开。若持续失败，请查看具体错误信息或停止本轮。';
  }
  const intent = pendingIntentFor(handle);
  if (intent) {
    return `还在等模型这轮返回——它刚说的「${intent}」要等这轮开口才真正动手。暂未发现请求失败，可随时停止本轮。`;
  }
  // 呈现纪律(2026-10-30):用户点名删除「正在等待模型返回首个内容」这类
  // 传输过程话术——等待是常态而非故障,一句轻话术说清状态与停止权即可。
  return '还在等模型开口——通常是深度思考或服务排队，暂未发现连接问题；可随时停止。';
}

// ── Escalated wait expectation ──
// 第一级 hint（15s）解释「为什么还没动静」；长内容轮的静默远不止 15s，
// 用户会从「有点慢」滑向「是不是卡死了」。45s 起 hint 原地换成时间预期管理
// （长内容动笔前的思考常要一两分钟 + 实时秒数）——不是轮播表演：同一张卡
// 同一条 hint，内容随真实等待时长变得更有信息量。秒数每个 tick 刷新，不是
// 一次性快照（评审 P1：冻结的「已经等了 45 秒」旁边是持续走秒的 chip，自相
// 矛盾）；label 翻成重试态后下一 tick 自动回落到重试专属文案。
const ESCALATE_DEFAULT_MS = 45_000;

function escalateHintFor(handle: ThinkingCardHandle, elapsedSec: number): string | null {
  // 有诊断结论时不升级时间预期——「已经等了 N 秒：模型思考常要一两分钟」
  // 在网络故障面前是误导，保持诊断文案直到轮次结束。
  const diagnosis = netDiagnosisFor(handle);
  if (diagnosis) return diagnosis;
  const label = handle.card.querySelector<HTMLElement>('.thinking-label')?.textContent ?? '';
  if (label.includes('重试') || label.includes('未成功') || label.includes('失败') || label.includes('未通过')) return null;
  // 否定性弱断言（与两条旧 hint 同纪律）：UI 验证不了「请求仍然活跃」，
  // 只能如实说「暂未发现失败」——传输层静默挂死时卡片不能替请求撒谎。
  return `已经等了 ${elapsedSec} 秒：写代码、长文档这类产出，模型动笔前的思考常要一两分钟，暂未发现连接问题，不是无响应的卡死；等不及可以停止。`;
}

export function resetThinkingLabelForOutput(handle: ThinkingCardHandle): void {
  const label = handle.card.querySelector<HTMLElement>('.thinking-label')?.textContent ?? '';
  if (handle.card.classList.contains('waiting') || /重试|失败|未成功|未通过|调整输出/.test(label)) {
    handle.card.classList.remove('waiting');
    setThinkingLabel(handle, t('thinking.thinking'));
  }
}

// ── Pending-intent echo ──
// 多轮工作（如「基于文档生成 PPT」）中，模型常在正文里预告下一步（「现在写
// 生成脚本——这是纯代码产出，直接落盘」），然后进入下一轮 THINK：长内容
// （脚本/文档）作为 tool call 参数要等模型整轮生成才出现，这段静默动辄
// 30-60s。等待 hint 若仍是泛化的「深度思考或服务端排队」，用户刚看过预告
// 却只看到「等待模型」，无从分辨 pure 是在干活还是卡死。预告是模型自己的
// 话——回指它不是编造进度，是把「在等什么」如实说出口。
const pendingIntents = new WeakMap<ThinkingCardHandle, string>();

/** Record what the model just announced it would do next (last sentence of
 *  its own answer). The silence hint echoes it so a long wait reads as
 *  "waiting for the announced step" instead of a generic stall. */
export function setThinkingPendingIntent(handle: ThinkingCardHandle, text: string): void {
  const trimmed = text.trim();
  if (trimmed) pendingIntents.set(handle, trimmed);
}

function pendingIntentFor(handle: ThinkingCardHandle): string {
  return pendingIntents.get(handle) ?? '';
}

// ── Network diagnosis injection (2026-10-30) ──
// 「暂未发现请求失败」是 cause-neutral 的纪律，但真断网时这句是误导——
// 用户盯着「模型可能在深度思考」等一个永远不会来的首字。chat.ts 在 hint
// 时刻用与真实请求同构的 test_llm_connection 主动探测一次（同路由决策 +
// 一次性反向兜底），探测**失败**时把结论写到这里原地改写等待卡；探测通过
// 则保持泛化文案——服务可达时「模型在思考」仍是诚实的。
const netDiagnoses = new WeakMap<ThinkingCardHandle, string>();

export function setThinkingNetDiagnosis(handle: ThinkingCardHandle, text: string): void {
  if (!text) return;
  netDiagnoses.set(handle, text);
  // 诊断晚到（探测在 hint 之后才返回）时原地改写已显示的 hint；正在淡出
  // 或真实输出已开始的场合不动。
  const hint = handle.card.querySelector<HTMLElement>('.thinking-hint');
  if (hint && hint.dataset.dismissing !== '1' && !handle.textEl.textContent) {
    hint.textContent = text;
  }
}

function netDiagnosisFor(handle: ThinkingCardHandle): string {
  return netDiagnoses.get(handle) ?? '';
}

const timerIntervals = new WeakMap<ThinkingCardHandle, number>();

// Fade timers for scheduled dismissThinkingHint(delayMs > 0) calls, tracked
// per-handle so stopThinkingTimer can cancel a pending fade when the card is
// finalized or destroyed mid-linger instead of the timer firing later.
const hintFadeTimeouts = new WeakMap<ThinkingCardHandle, number>();

/** Tick an elapsed-seconds chip beside the label until the card finalizes,
 *  detaches (interval self-cancels), or stopThinkingTimer runs. */
export function startThinkingTimer(
  handle: ThinkingCardHandle,
  opts: { intervalMs?: number; hintAfterMs?: number; hintText?: string; escalateAfterMs?: number } = {},
): void {
  stopThinkingTimer(handle);
  const { intervalMs, hintAfterMs, escalateAfterMs = ESCALATE_DEFAULT_MS } = { ...THINKING_TIMER_DEFAULTS, ...opts };
  const hintText = opts.hintText ?? null; // null → state-aware default at fire time
  // 升级线只在默认 hint 语义下运行：调用方显式给了定制文案，说明它知道自己
  // 要什么，45s 的通用时间预期不该悄悄盖掉它（评审 latent 边界）。
  const customHint = hintText !== null;
  const label = handle.card.querySelector<HTMLElement>('.thinking-label');
  if (!label || !handle.card.isConnected) return;
  const chip = document.createElement('span');
  chip.className = 'thinking-timer';
  chip.textContent = '0s';
  label.insertAdjacentElement('afterend', chip);
  const startedAt = Date.now();
  let hinted = false;
  // 升级线不早于首级 hint：escalateAfterMs 被调用方配小时仍保证首级文案
  // 至少能活过一个 interval（评审 latent 边界）。
  const escalateAt = Math.max(escalateAfterMs, hintAfterMs);
  const iv = window.setInterval(() => {
    // Self-cleanup for cards removed without stopThinkingTimer (abort paths).
    if (!handle.card.isConnected) {
      stopThinkingTimer(handle);
      return;
    }
    const ms = Date.now() - startedAt;
    chip.textContent = `${Math.floor(ms / intervalMs)}s`;
    if (!hinted && ms >= hintAfterMs && !handle.textEl.textContent) {
      hinted = true;
      const hint = document.createElement('div');
      hint.className = 'thinking-hint';
      // Resolve the default AT fire time: the label may have flipped to a
      // retry notice between start and hint, so the copy names the actual cause.
      hint.textContent = hintText ?? defaultHintFor(handle);
      handle.body.insertBefore(hint, handle.scrollEl);
    }
    // 长静默升级线：同一 hint 原地维护，秒数每 tick 实时刷新；label 翻成
    // 重试态（retry 通知晚于升级到达）时下一 tick 自动回落到重试专属文案。
    // 真实输出已开始（textEl 非空）或 hint 正在淡出时不动。
    if (hinted && !customHint && !handle.textEl.textContent) {
      const hint = handle.card.querySelector<HTMLElement>('.thinking-hint');
      if (hint && hint.dataset.dismissing !== '1') {
        if (ms >= escalateAt) {
          const upgrade = escalateHintFor(handle, Math.floor(ms / 1000));
          hint.textContent = upgrade ?? (hintText ?? defaultHintFor(handle));
        }
      }
    }
  }, intervalMs);
  timerIntervals.set(handle, iv);
}

/** Remove the timer chip and cancel its interval (idempotent). Also cancels
 *  any pending hint fade scheduled by dismissThinkingHint — unless the hint is
 *  already mid-dismissal (dismissing === '1'), in which case its own fade
 *  timer owns removal and must be left alone. */
export function stopThinkingTimer(handle: ThinkingCardHandle): void {
  const iv = timerIntervals.get(handle);
  if (iv !== undefined) {
    clearInterval(iv);
    timerIntervals.delete(handle);
  }
  const hint = handle.card.querySelector<HTMLElement>('.thinking-hint');
  if (!hint || hint.dataset.dismissing !== '1') {
    const fade = hintFadeTimeouts.get(handle);
    if (fade !== undefined) {
      clearTimeout(fade);
      hintFadeTimeouts.delete(handle);
    }
  }
  handle.card.querySelector('.thinking-timer')?.remove();
}

/** Linger window between real output becoming visible on screen and the
 * slow-response hint starting its fade-out (the CSS fade adds ~0.35s on top).
 * The hint explains a silent wait; once output is actually rendering, one
 * readable second remains before it goes away. */
export const HINT_LINGER_MS = 1000;

/** Fade the slow-response hint out and remove it. Called once real reasoning
 * or answer text starts flowing. With `delayMs > 0` the hint lingers that long
 * AFTER the first visible output before fading — and the first call anchors
 * that deadline (later deltas are no-ops, they never push it further out).
 * Idempotent; safe when absent. */
export function dismissThinkingHint(handle: ThinkingCardHandle, delayMs = 0): void {
  const hint = handle.body.querySelector<HTMLElement>('.thinking-hint');
  if (!hint || hint.dataset.dismissing === '1') return;
  // Mark scheduled IMMEDIATELY so repeated deltas can't reschedule, and so
  // finalizeThinkingCard leaves an already-fading hint to its own timer.
  hint.dataset.dismissing = '1';
  const startFade = (): void => {
    // Card (and hint) may have left the DOM mid-dwell (abort / session switch).
    if (!hint.isConnected) return;
    hint.classList.add('fading');
    hintFadeTimeouts.set(handle, window.setTimeout(() => hint.remove(), 400));
  };
  if (delayMs > 0) {
    hintFadeTimeouts.set(handle, window.setTimeout(startFade, delayMs));
  } else startFade();
}

export function createThinkingCard(): ThinkingCardHandle {
  const el = document.createElement('div');
  el.className = 'bubble-row thinking-row';

  const card = document.createElement('details');
  card.className = 'thinking-card thinking';
  // Open by default → the reasoning stream is visible live (默认展开思考过程);
  // click the header to collapse it while keeping the transcript row.
  card.open = true;
  el.classList.add('expanded');

  const summary = document.createElement('summary');
  summary.className = 'thinking-toggle';

  const dots = document.createElement('span');
  dots.className = 'thinking-dots';
  dots.setAttribute('aria-hidden', 'true');
  for (let i = 0; i < 3; i++) dots.appendChild(document.createElement('i'));

  // Cyan-blue gem — the same #icon-gem graphic as the app icon, so the
  // thinking indicator matches the reference icon (引用图标一致).
  const icon = document.createElement('span');
  icon.className = 'thinking-icon';
  icon.setAttribute('aria-hidden', 'true');
  icon.innerHTML = '<svg viewBox="0 0 1024 1024" width="14" height="14"><use href="#icon-gem"/></svg>';

  const label = document.createElement('span');
  label.className = 'thinking-label';
  label.textContent = t('thinking.thinking');

  // Down-arrow affordance — hints the chip is expandable; flips up when open.
  const chevron = document.createElement('span');
  chevron.className = 'thinking-chevron';
  chevron.setAttribute('aria-hidden', 'true');
  chevron.innerHTML = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg>';

  summary.append(icon, dots, label, chevron);

  const body = document.createElement('div');
  body.className = 'thinking-body';

  // Scroll window for the reasoning text. The body's bottom padding must stay
  // OUTSIDE it (same rationale as .tool-row-scroll in toolRow.ts): padding at
  // the end of a scroll container is below the fold, which used to clip long
  // reasoning flush against the card's bottom edge.
  const scrollEl = document.createElement('div');
  scrollEl.className = 'thinking-scroll';

  const textEl = document.createElement('div');
  textEl.className = 'thinking-text';

  scrollEl.appendChild(textEl);
  body.appendChild(scrollEl);
  card.append(summary, body);
  el.appendChild(card);

  // `<details>` toggles fire in all browsers including WKWebView. Keep the row
  // class synchronized so the same card can move between full-width and compact
  // presentation without replacing the user's open/closed state.
  card.addEventListener('toggle', () => {
    el.classList.toggle('expanded', card.open);
  });

  return { el, card, body, scrollEl, textEl };
}

/** Append a reasoning delta to the card body. */
export function appendThinkingText(handle: ThinkingCardHandle, text: string): void {
  if (!text) return;
  // Append a fresh text node instead of re-assigning textContent so long
  // reasoning streams don't re-serialize the whole buffer on every delta.
  handle.textEl.appendChild(document.createTextNode(text));
  // While expanded, keep the reasoning body pinned to the newest text so the
  // thinking "continuously scrolls" as requested.
  if (handle.card.open) {
    handle.scrollEl.scrollTop = handle.scrollEl.scrollHeight;
  }
}

/** Mark the thinking phase as complete while preserving its transcript row.
 *  The live timer chip is replaced by a frozen total ("思考完成 · 42s") so the
 *  transcript keeps the duration as reviewable information. */
export function finalizeThinkingCard(handle: ThinkingCardHandle): void {
  // Collapse any verbatim loop the model emitted before the card is reviewed
  // (the live stream may briefly show the repeats; the final card is clean).
  handle.textEl.textContent = collapseRepeatedReasoning(handle.textEl.textContent);
  // A lingering slow-response hint is obsolete the moment the phase ends —
  // remove it outright UNLESS a delayed dismissal is already scheduled (output
  // resumed and the hint is mid-linger): that timer owns the fade now.
  const hint = handle.body.querySelector<HTMLElement>('.thinking-hint');
  if (hint && hint.dataset.dismissing !== '1') hint.remove();
  const chip = handle.card.querySelector<HTMLElement>('.thinking-timer');
  const elapsedLabel = chip?.textContent ?? '';
  stopThinkingTimer(handle);
  handle.card.classList.remove('thinking');
  handle.card.classList.add('complete');
  const label = handle.card.querySelector<HTMLElement>('.thinking-label');
  if (label) {
    const secs = parseInt(elapsedLabel, 10);
    label.textContent = Number.isFinite(secs) && secs >= 1 ? `${t('thinking.done')} · ${elapsedLabel}` : t('thinking.done');
  }
  handle.card.querySelector('.thinking-dots')?.remove();
}
