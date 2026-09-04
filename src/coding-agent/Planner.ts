// src/coding-agent/Planner.ts
// v0.1 — Analyzes tasks: determines complexity, optionally generates a plan.
// v0.2 — Logical-trap detection: scans the prompt for self-contradictory /
//        impossible / mutually-exclusive / trick-framed premises so the agent
//        can verify them before execution and escape the trap by switching
//        approach after a failed round instead of repeating the same one.

import type { AnalysisResult, IntentAssessment, RequestIntent, SemanticRouteDecision, TaskComplexity, TaskMode, Plan, PlanStep, TrapWarning } from './types';
import type { LLMAdapter, Message, MessageImage } from '../shared/types';
import { repairJsonSource } from '../shared/parseRepair';
import { KNOWN_SUBAGENT_ROLES } from '../shared/adaptiveControl';

/** Upper bound on LLM-plan steps kept in the review card / system prompt. */
const MAX_PLAN_STEPS = 10;
const MAX_PLAN_SUBSTEPS = 8;

export interface PlannerConfig {
  /** Threshold for explicit, concrete file-operation evidence. */
  complexFileThreshold?: number;
}

const SEMANTIC_ROUTE_PROMPT = `You are the routing layer for a coding assistant. Understand the user's complete message semantically; do not classify from isolated words or a fixed keyword list. Decide what outcome the user is asking for: answer/explanation, research, advice, debugging, a small change, a broad refactor/migration, or creation of a runnable artifact. Distinguish feedback about an existing result from a request to create a new result. A clear creative request is not a reasonableness review merely because it is large, has several variants, or contains style constraints.

Return ONLY one JSON object with this shape:
{"intent":"question|research|add|modify|debug|refactor|migrate|delete|build","complexity":"simple|complex","mode":"yolo|plan|build","requiresPlan":false,"needsDeliveryGate":false,"subagents":["researcher","deep_thinker"],"assessment":{"riskLevel":"low|medium|high","reversibility":"reversible|partially-reversible|hard-to-reverse|irreversible","impact":"...","recommendation":"...","requiresProbe":false,"requiresConfirmation":false}}

"subagents" — pick the SMALLEST useful subset of the real subagent roster below (exact names) that this request genuinely needs to delegate real work to. Use [] (empty) for anything you can answer or do directly yourself; never name a helper you would not actually invoke. Cap at 3-4 roles:
- researcher — 查资料/网络/文档调研，只读可并行（查景点、天气、汇率、预算参考等）
- deep_thinker — 复杂推理、架构权衡、多方案评估，把长推理隔离出主会话
- task_planner — 拆解复杂代码任务（仅真正改代码时）
- code_editor — 按计划修改代码（仅真正改代码时）
- code_reviewer — 代码审查把关（仅改代码且需要独立评审时）
- project_auditor — 项目安全/依赖审计
- ui_designer — 界面/视觉/交互设计
- bash_executor — 跑命令、构建/验证（有真实命令要执行时）
A travel plan / itinerary / event arrangement is NOT a coding task: never pick task_planner / code_editor / code_reviewer just because the word "计划/规划" appears. Prefer researcher and/or deep_thinker (or [] if you already know enough).

Use plan/build only when the user's actual outcome benefits from ordered execution or a runnable multi-file deliverable. Do not use them for ordinary advice, critique, explanation, or research. Set needsDeliveryGate only when the user wants files/project output that needs workspace-level delivery verification. Set requiresConfirmation only for an explicit destructive/irreversible action or a concrete safety boundary. Keep impact and recommendation concise and in the user's language. If uncertain between advice and implementation, choose the conversational path and let the assistant explain options rather than modifying files. When the user message is about an image and the goal is to READ, EXTRACT, TRANSCRIBE, or DESCRIBE the text/content shown in that image (e.g. "把图片里的文字读出来", "extract the text from this screenshot", "读出图里的字"), classify it as intent "question", mode "yolo", needsDeliveryGate false — it is a read-only request, NOT a build/delivery task. Never invent a plan or workspace change for reading an image.`;

/** 只有非常短、明显是客套/承接语（不含任何实质任务内容）时才跳过语义路由。
 * 其余一律交给语义路由去理解“完整语句 + 对话上下文”，而不是用一张“动作词关键词
 * 表”去猜用户想做什么。这样“项目跑不起来”这类没有动作词的短消息也会走语义理解，
 * 不再被关键词启发式误判。 */
const PLEASANTRY_BYPASS = /^(?:好的|好|谢谢|感谢|多谢|谢谢您|感谢您|ok|okay|yes|yeah|对的|对|对呀|继续|接着|收到|明白|明白了|嗯|棒|赞|辛苦了|thanks|thank you|sure|continue|got it|noted|righteous|hello|hi|hey|hiya|yo|你好|您好|嗨|哈喽|哈啰|哈罗|早上好|上午好|中午好|下午好|晚上好|晚安|在吗|在么|在不在|好的[。.，,！!?？]?|谢谢[。.，,！!?？]?)$/i;

export function shouldBypassSemanticRoute(prompt: string, images?: MessageImage[] | null): boolean {
  if (images?.length) return false;
  const text = prompt.trim();
  if (text.length > 16) return false;
  return PLEASANTRY_BYPASS.test(text);
}

// ── Deterministic conversational-route skip ───────────────────────────────
// The GUI/CLI call the LLM once to route a request BEFORE the real turn
// starts. On providers that trickle tokens slowly that hidden call alone
// costs 6-12s (measured on GLM) even though the model's first byte arrives
// in ~1s — the whole call is dead latency in front of the first visible
// answer. Most such calls only confirm the obvious (this is a plain
// question), so the synchronous fallback below reproduces the router's
// verdict for exactly that case and the hidden round trip is skipped
// entirely. It fires ONLY when the deterministic fallback already concludes
// "low-stakes conversational question" — every flag that could route to a
// plan / delivery gate / probe / confirmation must already be off, otherwise
// the LLM router still runs.

/** Question markers (CN + EN): the prompt must read as a request for an
 * answer, not an instruction to act. */
const QUESTION_SHAPED = /[?？]|几号|几月|几点|星期|周几|多久|多(?:大|少|远|久|高|长)|为什么|怎么|如何|怎样|能否|能不能|是否|该不该|应不应该|可不可以|会不会|要不要|吗|呢|什么|哪个|哪些|谁|哪里|哪儿|什么时候|what|when|where|which|who|why|how|can|could|should|would/i;

/** Peel a leading question frame (能不能帮我… / how do i …) so the artifact
 * guard below can still see an embedded build request. */
function stripQuestionPrefix(text: string): string {
  return text.replace(/^(?:请问|能不能|可不可以|可以|能否|是否|我想问|想问|麻烦问|帮我看看|how(?:(?:\s+can|\s+could|\s+do|\s+should|\s+would)?\s+i)?|can\s+you|could\s+you|please)\s*/i, '');
}

/** True when a request is SO plainly a low-stakes conversational question
 * that the LLM router could not change the outcome. Conservative by
 * construction: it requires an interrogative shape, no project/artifact
 * build framing (even hidden behind a question prefix), and the synchronous
 * fallback verdict must already be question / simple / yolo / low-risk with
 * no traps. Anything else keeps the full semantic-route call. */
export function isPlainConversational(prompt: string, images?: MessageImage[] | null): boolean {
  if (images?.length) return false;
  const text = prompt.trim();
  if (!text || text.length > 200) return false;
  if (!QUESTION_SHAPED.test(text)) return false;
  // An imperative build request hiding inside the question frame (e.g.
  // "能不能帮我设计一个自行车网站？") must still reach the LLM router — the
  // artifact/delivery pipeline depends on it. detectArtifactRequest already
  // rejects question-leading forms, so re-test with the frame peeled.
  if (detectProjectRequest(text) || detectArtifactRequest(text)) return false;
  if (detectArtifactRequest(stripQuestionPrefix(text))) return false;
  const analysis = new Planner().analyzeTask(text);
  return analysis.intent.intent === 'question'
    && analysis.intent.riskLevel === 'low'
    && !analysis.intent.requiresProbe
    && !analysis.intent.requiresConfirmation
    && analysis.complexity === 'simple'
    && analysis.mode === 'yolo'
    && analysis.traps.length === 0;
}

/**
 * Stream a classification prompt while accumulating text and stop the moment
 * `parse` yields a result. Classification outputs are tiny JSON objects, but
 * providers keep trickling tokens long after the object is complete
 * (measured 6-12s for a <100-token JSON on GLM) — waiting for the terminal
 * frame turns a 1s first-byte call into many seconds of dead latency in
 * front of the real turn. On a successful parse (or on timeout / caller
 * abort) the upstream stream is cancelled so no further tokens are generated
 * or billed. Any failure returns null, mirroring the previous Promise.race
 * semantics.
 */
async function streamUntilParsed<T>(
  llm: LLMAdapter,
  request: Message[],
  signal: AbortSignal | undefined,
  timeoutMs: number,
  parse: (text: string) => T | null,
): Promise<T | null> {
  const controller = new AbortController();
  const forwardAbort = (): void => controller.abort();
  signal?.addEventListener('abort', forwardAbort, { once: true });
  let timer: ReturnType<typeof setTimeout> | undefined;
  let result: T | null = null;
  try {
    await Promise.race([
      (async () => {
        let text = '';
        for await (const chunk of llm.stream(request, [], controller.signal)) {
          if (chunk.type === 'content' && chunk.content) {
            text += chunk.content;
          } else if (chunk.type === 'done' && chunk.content && chunk.content.length > text.length) {
            // Adapters that only deliver the full text on the terminal chunk.
            text = chunk.content;
          }
          if (text) {
            result = parse(text);
            if (result) break;
          }
        }
        if (!result && text) result = parse(text);
      })(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(new Error('classification timed out'));
        }, timeoutMs);
      }),
    ]);
  } catch {
    /* aborted (timeout / caller) — a parse that already landed still counts */
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    signal?.removeEventListener('abort', forwardAbort);
    // Stop upstream generation once the decision is in hand (or on any exit)
    // so the provider does not keep billing a response we will discard.
    controller.abort();
  }
  return result;
}

export async function inferSemanticRoute(
  llm: LLMAdapter,
  prompt: string,
  signal?: AbortSignal,
  images?: MessageImage[],
  timeoutMs = 12_000,
): Promise<SemanticRouteDecision | null> {
  if (!prompt.trim() || signal?.aborted) return null;
  const request: Message[] = [
    { role: 'system', content: SEMANTIC_ROUTE_PROMPT },
    { role: 'user', content: prompt, images },
  ];
  const decision = await streamUntilParsed(llm, request, signal, timeoutMs, parseSemanticRoute);
  return decision ? applyImageReadOverride(decision, prompt) : null;
}

export function parseSemanticRoute(raw: string): SemanticRouteDecision | null {
  const match = raw.match(/\{[\s\S]*\}/);
  if (!match) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(match[0]);
  } catch {
    try {
      parsed = JSON.parse(repairJsonSource(match[0]).source);
    } catch {
      return null;
    }
  }
  if (!parsed || typeof parsed !== 'object') return null;
  const value = parsed as Record<string, unknown>;
  const intent = value.intent as RequestIntent;
  const complexity = value.complexity as TaskComplexity;
  const mode = value.mode as TaskMode;
  const assessment = value.assessment;
  if (!['question', 'research', 'add', 'modify', 'debug', 'refactor', 'migrate', 'delete', 'build'].includes(intent)
    || !['simple', 'complex'].includes(complexity)
    || !['yolo', 'plan', 'build'].includes(mode)
    || !assessment || typeof assessment !== 'object') return null;
  const a = assessment as Record<string, unknown>;
  const riskLevel = a.riskLevel as IntentAssessment['riskLevel'];
  const reversibility = a.reversibility as IntentAssessment['reversibility'];
  if (!['low', 'medium', 'high'].includes(riskLevel)
    || !['reversible', 'partially-reversible', 'hard-to-reverse', 'irreversible'].includes(reversibility)) return null;
  // subagents 宽松解析：畸形（非数组/元素非字符串）不整体拒绝决策，按缺失处理；
  // 未知角色过滤到已知名录、去重、上限 4。显式空数组保留（= 路由判断无需委派）。
  let subagents: string[] | undefined;
  if (Array.isArray(value.subagents)) {
    subagents = Array.from(new Set(
      value.subagents.filter((s): s is string => typeof s === 'string' && KNOWN_SUBAGENT_ROLES.has(s)),
    )).slice(0, 4);
  }
  return {
    intent,
    complexity,
    mode,
    requiresPlan: value.requiresPlan === true,
    needsDeliveryGate: value.needsDeliveryGate === true,
    subagents,
    assessment: {
      intent,
      riskLevel,
      reversibility,
      impact: typeof a.impact === 'string' ? a.impact : '',
      recommendation: typeof a.recommendation === 'string' ? a.recommendation : '',
      requiresProbe: a.requiresProbe === true,
      requiresConfirmation: a.requiresConfirmation === true,
    },
  };
}

/** Result of judging whether a mid-run insert is related to the current task. */
export interface InsertionClassification {
  /** True → fold into the current task & re-plan; False → queue as a separate task. */
  related: boolean;
  reason: string;
}

const INSERTION_CLASSIFY_PROMPT = `You decide whether a NEW user message, sent while an agent is ALREADY working on a task, is RELATED to that task or NOT.

The current task the agent is working on:
<current_task>
{{CONTEXT}}
</current_task>

The new message the user just inserted mid-run:
<new_message>
{{PROMPT}}
</new_message>

Judgment:
- RELATED: the new message changes, refines, constrains, fixes, or directly extends the current task — e.g. a tweak to the deliverable being built ("把首页改成深色"), a correction, an added requirement, a comment about the exact file/feature in progress.
- UNRELATED: the new message is a separate, independent request that does not touch the current task — e.g. a brand-new question, a lookup, a different file/feature not being worked on, a whole different task.

Return ONLY one JSON object:
{"related":true|false,"reason":"<one short line>"}`;

/**
 * Lightweight single-call judgment of whether a message the user inserts while
 * the agent is mid-run is related to the current task. Mirrors
 * inferSemanticRoute's (signal + timeout + JSON-parse) shape. On any failure,
 * timeout, or parse miss it defaults to RELATED so the new input is never
 * silently dropped — folding it in lets the model reconcile it during re-plan.
 */
export async function classifyInsertion(
  llm: LLMAdapter,
  context: string,
  prompt: string,
  signal?: AbortSignal,
  images?: MessageImage[],
  timeoutMs = 8_000,
): Promise<InsertionClassification> {
  const fallback: InsertionClassification = { related: true, reason: 'classification unavailable; treated as related' };
  if (!prompt.trim() || signal?.aborted) return fallback;
  const system = INSERTION_CLASSIFY_PROMPT
    .replace('{{CONTEXT}}', context.slice(0, 3_200))
    .replace('{{PROMPT}}', prompt.slice(0, 2_000));
  const request: Message[] = [
    { role: 'system', content: system },
    { role: 'user', content: prompt, images },
  ];
  const parsed = await streamUntilParsed<{ related?: unknown; reason?: unknown }>(
    llm,
    request,
    signal,
    timeoutMs,
    (raw) => {
      const match = raw.match(/\{[\s\S]*\}/);
      if (!match) return null;
      try {
        const value = JSON.parse(match[0]) as { related?: unknown; reason?: unknown };
        return value && typeof value.related === 'boolean' ? value : null;
      } catch {
        return null;
      }
    },
  );
  if (parsed && typeof parsed.related === 'boolean') {
    return { related: parsed.related, reason: typeof parsed.reason === 'string' ? parsed.reason : '' };
  }
  return fallback;
}

const IMAGE_READ_PATTERN = /(图|截图|照片|图像)[^。；\n]{0,25}?(文字|内容|读|提取|识别|转写)|读图|extract.{0,20}text.{0,20}(image|图)|read.{0,20}text.{0,20}(image|图)/i;
function applyImageReadOverride(
  decision: SemanticRouteDecision,
  prompt: string,
): SemanticRouteDecision {
  if (!IMAGE_READ_PATTERN.test(prompt)) return decision;
  // 读图 / 提取图片文字是只读请求，不应被当成构建任务或进入交付验证门禁。
  return { ...decision, intent: 'question', complexity: 'simple', mode: 'yolo', requiresPlan: false, needsDeliveryGate: false };
}

export class Planner {
  private config: Required<PlannerConfig>;

  constructor(config?: PlannerConfig) {
    this.config = {
      complexFileThreshold: config?.complexFileThreshold ?? 3,
    };
  }

  /** Analyze a task prompt to determine complexity and optionally generate a plan. */
  analyzeTask(prompt: string): AnalysisResult {
    const heuristicComplexity = this.detectComplexity(prompt);
    const traps = this.detectTraps(prompt);
    const intent = assessIntent(prompt);
    const needsSafetyPlan = intent.requiresConfirmation;
    const complexity: TaskComplexity = intent.riskLevel === 'medium' ? 'complex' : heuristicComplexity;

    if (complexity === 'complex' || needsSafetyPlan) {
      const mode: TaskMode = needsSafetyPlan || intent.riskLevel === 'medium' ? 'plan' : this.detectMode(prompt, complexity);
      return {
        complexity,
        // Build intent ("写一个小游戏", "搭建全栈项目") switches the agent into
        // build mode; a destructive request always uses plan mode so it cannot
        // inherit the direct-build path by accident.
        mode,
        plan: this.generatePlan(prompt, mode),
        reasoning: needsSafetyPlan ? intent.recommendation : this.getComplexReasoning(prompt),
        traps,
        intent,
      };
    }

    return {
      complexity: 'simple',
      mode: 'yolo',
      reasoning: 'Task appears straightforward — direct execution is appropriate.',
      traps,
      intent,
    };
  }

  /** The model chooses build vs plan. The synchronous fallback never infers a
   * user's desired outcome from artifact nouns or isolated verbs. */
  private detectMode(prompt: string, complexity: TaskComplexity): TaskMode {
    return detectProjectRequest(prompt) ? 'build' : complexity === 'complex' ? 'plan' : 'yolo';
  }

  /**
   * Scan the prompt for potential logical traps: self-contradictory negation
   * ("不要X但又要X"), contradictory extremes ("越快越好但越慢越好"), mutually
   * exclusive simultaneity, impossible absolute obligations, and explicit
   * paradox/trick framing. Heuristic — a hit means "verify the premise", not
   * "the request is definitely impossible"; the description is injected into
   * the system prompt so the LLM checks it rather than blindly following a
   * contradictory instruction into a failure loop.
   */
  detectTraps(prompt: string): TrapWarning[] {
    const traps: TrapWarning[] = [];
    const add = (type: TrapWarning['type'], description: string) => traps.push({ type, description });

    // Explicit paradox / trick framing — the user themselves signals a trap.
    if (/悖论|逻辑陷阱|陷阱题|脑筋急转弯|自相矛盾|trick question|paradox|self-contradict/i.test(prompt)) {
      add('trap-keyword', 'The request is explicitly framed as a paradox/trick question — verify the premise before answering.');
    }

    // 不要X但又要X — the same object is both prohibited and demanded.
    // The comma before 但 is allowed because the clause may be comma-separated
    // ("不要X，但又要X") — but only ONE separator may appear, so a longer
    // unrelated phrase can't slip through the back-reference.
    const sameNeg = prompt.match(/(?:不要|不能|禁止|不允许)([^。；;]{2,20}?)(?:，|,)?(?:又要|还要|却要|但又要|同时要|仍要)\1/);
    if (sameNeg) {
      add('self-contradiction', `The request both prohibits and demands "${sameNeg[1].trim()}" — a direct self-contradiction.`);
    }

    // 既要X又不要X — simultaneously wants and forbids the same thing.
    // The leading 要 is optional so the back-reference aligns with the
    // second occurrence ("既要修改文件又不要修改文件").
    const jiTrap = prompt.match(/既(?:要|必须)?([^。；,]{2,16}?)(?:又|还)(?:要|必须)不\1/);
    if (jiTrap) {
      add('self-contradiction', `The request simultaneously wants and forbids "${jiTrap[1].trim()}".`);
    }

    // 越快越好但越慢越好 — contradictory directional extremes on one quantity.
    // The pair must be a TRUE opposite (快↔慢, 多↔少, …) — "越快越好，但占用越少越好"
    // (fast AND low-resource) is coherent and must NOT be flagged, so the match
    // is verified against the opposite map instead of cross-matching.
    const CMP_PAIRS: Record<string, string> = { 快: '慢', 早: '晚', 多: '少', 大: '小', 高: '低', 长: '短', 强: '弱' };
    const cmpTrap = prompt.match(/越(快|早|多|大|高|长|强)[^。；，,]{0,20}(?:，|,)?(?:又|但|却|同时|还要)[^。；，,]{0,14}越(慢|晚|少|小|低|短|弱)/);
    if (cmpTrap && CMP_PAIRS[cmpTrap[1]] === cmpTrap[2]) {
      add('self-contradiction', `The request imposes contradictory extremes: "the ${cmpTrap[1]}er the better" and "the ${cmpTrap[2]}er the better" at once.`);
    }

    // 同时...又不能... — two mutually exclusive things demanded together.
    if (/(?:同时|既要)[^。；，,]{1,20}(?:，|,)?(?:又不能|还要不|却要|又不要)/.test(prompt)) {
      add('mutually-exclusive', 'The request demands two mutually exclusive things at the same time.');
    }

    // 从不X，但必须X — an absolute obligation paired with its own negation on
    // the SAME object (back-reference), e.g. "从不失败，但必须失败". Requires the
    // object to repeat so benign "永远不要提交敏感信息，但要提交代码" (two different
    // objects) is NOT flagged.
    const absTrap = prompt.match(/(?:永远|从不|绝不|任何情况下都)(?:不要|不能|禁止|不允许|必须|要)?([^。；,]{2,20}?)(?:，|,)?(?:但|却|同时)(?:又要|还要|仍然要|必须|要)\1/);
    if (absTrap) {
      add('impossible-constraint', `The request makes an absolute statement about "${absTrap[1].trim()}" and simultaneously demands its opposite — impossible as stated.`);
    }

    // English: "do not X but also X" (back-reference on the same action).
    if (/(?:do not|don't|cannot|must not)\s+([a-z][a-z ']{2,30}?)\s+(?:but|yet|while)\s+(?:also\s+)?(?:do not|must|need to)?\s*\1/i.test(prompt)) {
      add('self-contradiction', 'The request both prohibits and demands the same action — a direct contradiction.');
    }

    // English: contradictory directional extremes.
    if (/\b(faster|more|bigger|higher|longer|earlier)\b[^.]{0,40}\b(slower|less|smaller|lower|shorter|later)\b/i.test(prompt)) {
      add('self-contradiction', 'The request imposes contradictory directional constraints on the same quantity.');
    }

    // Dedupe (type + description) so overlapping rules don't spam the prompt.
    const seen = new Set<string>();
    return traps.filter(t => {
      const k = `${t.type}|${t.description}`;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
  }

  private detectComplexity(prompt: string): TaskComplexity {
    const lower = prompt.toLowerCase();
    const trimmed = prompt.trim();

    // Chinese questions — hoisted so both the planning-rule guard below and
    // the Chinese build rules can skip question phrasing ("怎么规划？" is
    // ASKING, not planning; "如何搭建一个全栈项目" asks HOW, not to build).
    // Leading prefixes AND question words anywhere in the prompt count — EXCEPT
    // when the prompt starts with an imperative build verb ("帮我搭建…",
    // "写一个…"): then the build intent dominates, and a trailing question
    // ("…怎么做性能优化？") must not suppress planning.
    const startsWithBuild = /^(?:请)?\s*(?:帮我|麻烦你|给我)?\s*(?:编写|写|做|开发|制作|创建|搭建|实现|构建|设计|生成|部署|重构|重写|迁移|规划)\s*/.test(trimmed);
    // 纯破坏性单步命令（删除/清空整个项目）走“确认闸”处理，不应因为“整个项目”这种
    // 范围词被升级成多步复杂计划——范围词只在“需要逐文件改动一大片”时才有意义。
    const destructive = /(?:删除|移除|销毁|清空|drop\s+(?:table|database)|destroy|delete|rm\s|reset\s+--hard|force\s+push)/i.test(lower);
    // 只读/查询类动作（查看/了解/解释/分析/总结/读…）即便目标范围是“整个项目”也只是
    // 一次查看，不该被范围词升级成多步复杂计划；真正的改动广度由语义路由判断。
    const readOnly = /(?:查看|查一下|查查|看下|看看|了解|理解|解释|说明|介绍|总结|概括|研究|调研|分析|评估|阅读|读一下|describe|explain|summar|analyz|understand|look at|inspect|view|read)/i.test(lower);
    const cnQuestion = !startsWithBuild && (
      /^(?:如何|怎么|怎样|能否|能不能|是否|请问|为什么|怎么办|该怎么办|应该怎么办|该不该|应不应该|(?:请)?帮我?(?:看看|查查|看下|分析|解释|介绍|讲讲|说说|告诉我|描述|总结|评估))/.test(trimmed) ||
      /(?:怎么办|该怎么办|应该怎么办|怎么|如何|怎样|能否|能不能|是否|该不该|应不应该|为什么|吗|呢|什么(?!都|也|能))/.test(trimmed)
    );

    // User explicitly asks for planning. A request to write a project plan or
    // documentation is a deliverable, not an instruction to plan the coding
    // work, so keep that document intent out of the plan gate.
    const documentationRequest = /(?:write|create|draft|生成|编写|写)\s+(?:a\s+)?(?:project\s+)?(?:plan|documentation|document|docs|summary|report|spec|tutorial|计划|文档|总结|报告|方案)/i.test(prompt);
    if (!documentationRequest && /plan|先计划|think step by step|think through/i.test(prompt)) {
      return 'complex';
    }
    if (!cnQuestion && /(?:规划|设计)\s*(?:一个|一套|个|套|一下|一番)?\s*(?:工程|项目|系统|网站|应用|平台|框架|架构|方案|模块|功能|页面|界面)/i.test(prompt)) {
      return 'complex';
    }

    // Multiple file operations or new module creation
    const fileOpPatterns = [
      /create\s+(a\s+)?(new\s+)?(file|module|class|component|service|api)/i,
      /refactor|重构|重写|rewrite/i,
      /migrate|迁移/i,
      /add\s+(a\s+)?(new\s+)?feature/i,
      /implement\s+(a\s+)?(full|complete|end.to.end)/i,
    ];

    const matches = fileOpPatterns.filter(p => p.test(lower));
    if (matches.length >= this.config.complexFileThreshold) {
      return 'complex';
    }

    // 广义改动动词（重构/重写/迁移/跨整个项目…）意味着多步、跨文件的改动范围，属于
    // “工作量/范围”证据而非把用户意图归类为某种固定类型——据此判定为复杂。它和具体的
    // 破坏/只读动作无关，疑问句也不触发。
    if (!cnQuestion && !destructive && !readOnly
      && /(?:重构|重写|rewrite|refactor|迁移|migrate|across the (?:entire )?project|整个项目重|重?构.*项目)/i.test(lower)) {
      return 'complex';
    }

    // Scope indicators
    const scopeIndicators = [
      /multiple\s+files/i,
      /several\s+(files|modules|components)/i,
      /whole\s+(project|app|system)/i,
      /from\s+scratch/i,
    ];

    if (!cnQuestion && !destructive && !readOnly && scopeIndicators.some(p => p.test(lower))) {
      return 'complex';
    }

    // Project creation is inherently multi-step. Keep this before the
    // conservative fallback so semantic-router failures still enter a build
    // plan; detectProjectRequest excludes questions and documentation requests.
    if (detectProjectRequest(prompt)) {
      return 'complex';
    }

    // Ordinary creation, advice, critique, research, and domain language are
    // deliberately not classified here. The shared semantic router handles
    // those from the complete request; this fallback stays direct rather than
    // turning a noun such as “项目/网页/原型” into a plan by itself.
    return 'simple';
  }

  /**
   * 计划结构由语义路由给出的 mode（build / plan / yolo）决定，而不是用关键词把
   * 用户意图重新归类为“创建 / 提问 / 其他”三种固定模板。只有当语义层面判定为
   * build 时才走构建式计划；其余一律用中性、不预设任务类型的通用步骤。
   * 具体的任务拆解属于 LLM 语义分析的职责，这里只在那层不可用时兜个底。
   */
  generatePlan(prompt: string, mode: TaskMode): Plan {
    if (mode === 'build') {
      return {
        steps: [
          {
            id: '1',
            action: '理解与分析需求',
            description: '拆解这个需求的目标、数据来源、使用场景与约束，明确缺失的关键信息。',
            expectedOutcome: '对要交付的东西有清楚、无歧义的理解。',
          },
          {
            id: '2',
            action: '确定技术栈与测试策略',
            description: '根据交付物选择运行方式和测试框架，先定义测试入口、测试目录与首个主流程 smoke test。Web/DOM 项目优先选择适配的 DOM 测试环境。',
            expectedOutcome: '技术栈、测试 runner、test script 和首个测试场景已明确。',
          },
          {
            id: '3',
            action: '搭建包含测试入口的项目骨架',
            description: '建立目录、依赖和可运行脚本，同时写入测试配置与最小测试文件，不把测试基础设施留到收尾阶段。',
            expectedOutcome: '项目和测试命令都能启动，最小测试可以被发现。',
          },
          {
            id: '4',
            action: '分模块实现并同步编写测试',
            description: '按功能拆分实现，每个关键路径配套 focused/unit/integration 测试，保持实现和测试一起演进。',
            expectedOutcome: '核心功能落地，关键行为有自动化保护。',
          },
          {
            id: '5',
            action: '运行测试、检查与构建并修复失败',
            description: '实际执行 test、typecheck/lint（如有）和 build；任何失败都根据证据修复后重新运行，不能用手工检查替代自动化测试。',
            expectedOutcome: '测试与项目验证命令真实通过，或明确记录无法解决的阻断。',
          },
          {
            id: '6',
            action: '收尾与交付',
            description: '补齐运行说明和测试说明，报告真实执行过的命令、结果与仍存在的限制。',
            expectedOutcome: '交付物完整，用户知道如何运行和验证项目。',
          },
        ],
        reasoning: '这是一次构建型任务：先理解清楚要做什么，再搭骨架、逐模块实现，最后联调验证，保证结果可用。',
      };
    }

    // 非构建类：中性通用步骤，不把请求归类为“确认范围 / 完成改动 / 验证结果”这类
    // 预设编辑模板，也不按关键词判断是提问还是改动——交给实际执行时结合上下文决定。
    return {
      steps: [
        {
          id: '1',
          action: '先理解这次请求真正想要的结果',
          description: '结合上下文确认目标、约束与已知条件，不急于套用固定模板。',
          expectedOutcome: '目标与边界清楚。',
        },
        {
          id: '2',
          action: '用最小动作验证关键假设',
          description: '先读相关代码或跑最小探针，确认理解无误再扩展改动。',
          expectedOutcome: '关键未知点被证据消除。',
        },
        {
          id: '3',
          action: '按小步推进并持续验证',
          description: '每步都可运行、可验证，必要时回头调整方向，最后说明仍存在的限制。',
          expectedOutcome: '结果可靠、可被验证。',
        },
      ],
      reasoning: this.getComplexReasoning(prompt),
    };
  }

  private getComplexReasoning(prompt: string): string {
    // Shown above the plan review card — plain user-facing language.
    return '这个任务涉及多文件或较大改动，按步骤推进并逐步验证，能保证结果正确可靠。';
  }
}

/**
 * Detect whether the user is asking for fictional / alternate-history /
 * "ignore the rules" content — the case where the plausibility &
 * real-world consistency review must be skipped. Deterministic heuristic
 * (the model must NOT be the judge of this), deliberately conservative:
 * it fires only on explicit opt-outs of real-world constraints or explicit
 * fiction-creation markers, never on a bare genre noun in a factual question
 * ("介绍科幻小说的历史" stays reviewed).
 */
export function detectFictionIntent(prompt: string): boolean {
  const lower = prompt.toLowerCase();

  // 1. Explicit opt-out of real-world constraints — strongest signal.
  //    "不用管事实", "不考虑现实/物理/规律", "ignore physics", "make it up".
  if (
    /(?:(?:不用|无需|不需要|不必)(?:管|考虑|符合|在意|在乎|讲究)?|别(?:管|考虑|符合|在意|在乎|讲究))\s*(?:事实|现实|真实|逻辑|物理|化学|数学|时间线|历史|规律|合理性|严谨)/i.test(prompt)
    || /(?:忽略|无视|不考虑|不管|不讲究|不追求|不严谨)\s*(?:事实|现实|真实|逻辑|物理|化学|数学|时间线|历史|规律|合理性)/i.test(prompt)
    || /(?:ignore|disregard|don'?t\s+care\s+about|no\s+need\s+to\s+(?:be|follow|respect))\s*(?:the\s+)?(?:facts?|reality|realism|physics|chemistry|math(?:ematics)?|timeline|history|logic|rules?|science|accuracy|plausibility)/i.test(lower)
    || /(?:make\s+it\s+up|make\s+something\s+up|don'?t\s+worry\s+about\s+(?:accuracy|facts|realism|physics|reality|rules|logic))/i.test(lower)
  ) return true;

  // 2. Creation-oriented fiction markers — unambiguously fictional.
  if (
    /(?:虚构|架空|编造|乱编|随便编|编一个|编个|天马行空|脑洞|平行世界|平行宇宙|异世界|架空的|架空世界|架空历史)/i.test(prompt)
    || /\b(?:fiction|fictional|alternate[ -]history|alternate[ -]universe|make[- ]?believe|worldbuilding)\b/i.test(lower)
    || /\b(?:write|make\s+up|invent)\s+(?:a\s+|some\s+)?(?:fiction|fictional|fantasy|fantastical|mythical)\b/i.test(lower)
  ) return true;

  // 3. Genre creation: a creation verb + an unambiguous fiction genre noun
  //    ("写一个科幻小说", "write a fantasy story") — but NOT "介绍科幻".
  const creationVerb = /(?:写|编|创作|编写|生成|制作|构思|设计|给我写|帮我写|来一个|give\s+me|write|create|invent|generate|draft)/i;
  const fictionGenre = /(?:科幻|奇幻|玄幻|魔幻|魔法|神话|童话|穿越|架空)\s*(?:小说|故事|剧|剧本|剧情|设定|世界|世界观)|(?:sci[- ]?fi|science[- ]?fiction|fantasy|fairy[- ]?tale|myth(?:ology)?)\s*(?:story|stories|novel|tale|fiction|world)/i;
  if (creationVerb.test(prompt) && fictionGenre.test(prompt)) return true;

  return false;
}

/**
 * 语义路由不可用时的“安全兜底策略”：用关键词识别明确的高风险 / 不可逆操作
 * （删除、销毁、重构、迁移、force push…），把这些归为需要探针 / 确认的安全护栏。
 * 它只是兜底——一旦语义路由可用，完整的意图 / 风险判断以语义路由为准（见
 * requestWorkflow.ts 的 mergeSemanticAssessment），关键词不再覆盖语义结论。
 * 普通任务的意图分类仍交由语义路由结合“完整语句 + 上下文”决定。
 */
export function assessIntent(prompt: string): IntentAssessment {
  const text = prompt.trim();
  const lower = text.toLowerCase();
  const chinese = /[\u4e00-\u9fff]/.test(text);
  const destructive = /(?:删除|移除|清理|销毁|不可逆|drop\s+(?:table|database)|destroy|rm\s+-rf|reset\s+--hard|force\s+push|delete\s+(?:all|the|entire)|remove\s+(?:all|the|entire))/i.test(lower);
  const migration = /(?:迁移|升级依赖|替换底层|切换框架|schema|database migration|migrat|upgrade dependencies|breaking change)/i.test(lower);
  const refactor = /(?:重构|重写|大规模修改|全量修改|refactor|rewrite|rewrite the whole|across the project)/i.test(lower);
  const riskLevel: IntentAssessment['riskLevel'] = destructive ? 'high' : migration || refactor ? 'medium' : 'low';
  const intent: RequestIntent = destructive ? 'delete' : migration ? 'migrate' : refactor ? 'refactor' : 'question';
  const reversibility: IntentAssessment['reversibility'] = destructive
    ? 'irreversible'
    : migration
      ? 'hard-to-reverse'
      : refactor
        ? 'partially-reversible'
        : 'reversible';
  const requiresProbe = riskLevel !== 'low';
  const requiresConfirmation = riskLevel === 'high';
  const impact = chinese
    ? (destructive
      ? '可能删除或覆盖现有数据、文件或历史状态，影响范围需要先确认。'
      : riskLevel === 'medium'
        ? '改动可能波及现有模块、依赖关系或行为，先读取真实结构再决定改动。'
        : '不根据关键词假定任务类型；由语义路由结合完整请求决定处理方式。')
    : (destructive
      ? 'This may delete or overwrite existing data, files, or history; confirm the blast radius first.'
      : riskLevel === 'medium'
        ? 'This may affect existing modules, dependencies, or behavior; inspect the real structure before changing it.'
        : 'No task type is inferred from keywords; semantic routing will use the complete request.');
  const recommendation = chinese
    ? (destructive
      ? '先做只读检查并列出受影响对象，给出可恢复或更窄的替代方案，确认后再动手。'
      : riskLevel === 'medium'
        ? '先做最小只读探针，再按小步修改并立即验证。'
        : '先由语义理解确定用户要得到的结果；如果只是建议或解释，直接回答，不要擅自修改文件。')
    : (destructive
      ? 'Inspect read-only first, list affected targets, propose a recoverable or narrower alternative, then ask for approval.'
      : riskLevel === 'medium'
        ? 'Run a minimal read-only probe, then make a small change and verify it.'
        : 'Use semantic understanding of the complete request; if it asks for advice or explanation, answer directly instead of editing files.');
  return {
    intent,
    riskLevel,
    reversibility,
    impact,
    recommendation,
    requiresProbe,
    requiresConfirmation,
    // Deterministic fiction detection: when set, the plausibility review is
    // skipped programmatically (see requestWorkflow.ts).
    skipPlausibilityReview: detectFictionIntent(text),
  };
}

export function formatIntentPrompt(assessment: IntentAssessment): string {
  return `<intent_assessment>\nIntent: ${assessment.intent}\nRisk: ${assessment.riskLevel}\nReversibility: ${assessment.reversibility}\nImpact: ${assessment.impact}\nRecommended approach: ${assessment.recommendation}\nBefore acting, follow this assessment. If a read-only probe can reduce uncertainty, do that first. Do not broaden the change beyond the confirmed impact. If the operation is high risk, wait for explicit user approval before any write or destructive command.\n</intent_assessment>`;
}

export function formatTrapPrompt(traps: TrapWarning[]): string {
  if (traps.length === 0) return '';
  const bullets = traps.map(t => `- [${t.type}] ${t.description}`).join('\n');
  return `\n\n<logical_trap_warning>\nThe user's request may contain a logical trap:\n${bullets}\nBefore acting, verify the premise. If a constraint is self-contradictory or impossible as stated, say so briefly and solve the most reasonable interpretation — do NOT blindly follow contradictory instructions into a failure loop. If your first attempt fails, re-read the ORIGINAL request and switch to a fundamentally different approach.\n</logical_trap_warning>`;
}

/**
 * Detect whether the user is asking the agent to create a project rather than
 * answer a question about one. Project requests always require a visible plan
 * and incremental execution, even when the prompt is short ("帮我创建一个项目").
 */
export function detectProjectRequest(prompt: string): boolean {
  const p = prompt.trim();
  if (!p) return false;
  const question = /^(?:如何|怎么|怎样|能否|能不能|是否|请问|为什么|what|how|can|could|should)\b/i.test(p)
    || /(?:怎么|如何|怎样|吗|呢|什么|为什么|能否|能不能|应该怎么办|what|how)\s*(?:创建|搭建|开发|做|build|create|scaffold|develop)/i.test(p)
    || /(?:怎么|如何|怎样|吗|呢|为什么|能否|能不能|应该怎么办)[^。！？?!]{0,24}(?:$|[。！？?!])/i.test(p);
  if (question) return false;
  // The deliverable noun may follow a project NAME, not just a quantifier —
  // e.g. "创建一个5G保障大屏监控项目" puts "5G保障大屏监控" between the verb
  // and "项目". A short name-like run is allowed in between, but doc-style
  // words in that run (介绍/说明/文档…) are rejected so "写一段介绍项目的文字"
  // stays a writing task instead of a build. The lookahead after the noun
  // still excludes "项目的技术方案/说明文档" style doc requests.
  const creation = /(?:请|帮我|麻烦你|给我)?\s*(?:创建|建立|搭建|构建|开发|制作|做|实现|编写|写|生成|create|build|scaffold|develop|make|implement)\s*(?:(?:一个|一套|个|整套|整个|完整的|全栈的|大型的|多文件的|多模块的|a|an|the)\s*)?(?![^，。；、,.!?？：:]{0,32}(?:介绍|说明|文档|方案|总结|报告|教程|README|计划|清单|笔记|心得|简介|描述|演示|思路))[^，。；、,.!?？：:]{0,32}?(?:项目|工程|平台|系统|应用|程序|网站|大屏|dashboard|project|application|app|website|site|system|platform)(?!\s*(?:的)?\s*(?:(?:技术|开发|产品|实施)\s*)?(?:总结|方案|文档|介绍|报告|说明|计划|清单|列表|简介|笔记|教程|plan|documentation|document|docs|summary|report|spec|tutorial))/i;
  return creation.test(p.slice(0, 140));
}

/**
 * Detect whether a request asks for a COMPLETE runnable artifact — a game,

 * web page/site, app, tool, script, or small project — as opposed to a simple
 * question or a short code snippet. When true, the agent should write the
 * artifact to disk (an HTML file / a small project directory) by default
 * instead of printing the full code inline. This is the "写一个小游戏/做一
 * 个网页" case: the user wants something runnable, not a paste.
 *
 * Heuristic, deliberately conservative: it matches an imperative build verb
 * (写/编写/做/开发/创建/实现/做一个/编写一个/写个…) directly followed (within
 * a few words) by a concrete artifact noun (游戏/小游戏/网页/网站/页面/工具/脚
 * 本/程序/工程/项目/应用/app/组件/动画/html 页面…). Pure questions ("这个
 * 游戏怎么玩") don't start with a build verb, so they won't match. A bare
 * "写一段代码" with no artifact noun also won't match — that stays inline.
 */
export function detectArtifactRequest(prompt: string): boolean {
  const p = prompt.trim();
  if (!p) return false;

  // Build verbs — the request must IMPERATIVELY create something. Keeping the
  // list explicit avoids matching questions or analysis-only requests.
  const buildVerb = /^(?:(?:请\s*)?(?:帮我|麻烦你|给我)|我想(?:要)?|希望(?:你)?|please\s+|can\s+you\s+)?(?:编写|编一个|写|写一个|写个|做|做一个|做个|开发|制作|创建|搭建|实现|搞一个|搞个|整一个|整个|设计|生成|做一个|给我写|重构|重写|迁移|build|create|make|write|develop|design|generate)/i;
  if (detectProjectRequest(p)) return true;
  // Artifact nouns that imply a runnable/complete deliverable.
  const artifact =
    /(?:小?游戏|网页|网站|页面|主页|首页|工具|脚本|程序|小程序|应用|app|工程|项目|组件|动画|演示|原型|demo|prototype|html\s*页面|web\s*app|web\s*page|mini[- ]?game|game|tool|script|app|project|prototype)/i;

  // Only look at the first ~40 chars — the artifact clause is almost always at
  // the front of the request ("帮我写一个连连看小游戏，要求…").
  const head = p.slice(0, 40);
  return buildVerb.test(head) && artifact.test(head);
}

/**
 * System-prompt fragment injected when detectArtifactRequest() fires: tells
 * the model to persist the artifact to disk instead of dumping code inline.
 * Pairs with the same rule assembled by PromptAssembler — the injection makes
 * the instruction explicit for this particular request.
 */
export function formatArtifactPrompt(): string {
  return `\n\n<artifact_output_rule>\nThis request asks you to BUILD a complete runnable artifact (a game, web page, app, tool, script, or small project). Write it to a file on disk — do NOT dump the full source code in your reply.\n- Single-file artifact (HTML page, single JS/CSS file, small script): write it as a new file in the workspace, e.g. index.html, game.html, app.py, or a sensible name derived from the request.\n- Multi-file project: create a directory and write the files into it (entry point + assets), e.g. ./mini-game/index.html. Before implementing feature code, choose the project-appropriate test runner and create a runnable test script plus at least one focused smoke/unit/integration test for the main path. For Web/DOM projects, use an appropriate DOM test environment such as happy-dom when needed; for other stacks use the stack's standard test runner. Do not replace automated tests with manual inspection unless the user explicitly opts out.\nAfter writing, run the actual test command (and typecheck/lint/build when the project provides them), fix failures, then briefly tell the user the file path(s), how to run/open the artifact, and the commands and results used to verify it. If no workspace is configured, say so and ask for one instead of printing the code.\n</artifact_output_rule>`;
}

/** Result of parsing an LLM plan payload, with a repair flag for callers that
 *  must keep reconstructed text out of the LLM context window. */
export interface PlanParseResult {
  plan: Plan | null;
  /** True when the plan JSON had to be repaired before it parsed. */
  repaired: boolean;
}

/**
 * Parse + validate a task-specific plan the LLM returned as JSON (the output
 * of the plan-generation pre-flight call). Accepts a plain JSON array, a JSON
 * object with a `steps` array, or the same wrapped in ```json fences. Each
 * step must carry `action` (string) and `description` (string); `expectedOutcome`
 * is optional and defaults to the description. Slightly-broken JSON (trailing
 * commas, single quotes, unquoted keys, full-width punctuation) is repaired
 * automatically before validation. Returns null on any malformed input so the
 * caller can fall back to the heuristic generic plan.
 */
export function parsePlanJson(text: string): Plan | null {
  return parsePlanJsonCore(text).plan;
}

/**
 * Like parsePlanJson, but also reports whether the plan JSON was repaired.
 * Repaired step text is a reconstruction of the model's broken output — it may
 * be shown to the user for approval, but must NOT be re-injected into the LLM
 * context window as "the approved plan" (see chat.ts's plan gate).
 */
export function parsePlanJsonWithMeta(text: string): PlanParseResult {
  return parsePlanJsonCore(text);
}

function normalizePlanSubsteps(raw: unknown): NonNullable<PlanStep['substeps']> {
  if (!Array.isArray(raw)) return [];
  const substeps = raw.flatMap((item, index) => {
    if (!item || typeof item !== 'object') return [];
    const value = item as { action?: unknown; description?: unknown; expectedOutcome?: unknown };
    const action = typeof value.action === 'string' ? value.action.trim() : '';
    const description = typeof value.description === 'string' ? value.description.trim() : '';
    if (!action && !description) return [];
    return [{
      id: String(index + 1),
      action: action || description,
      description: description || action,
      expectedOutcome: typeof value.expectedOutcome === 'string' ? value.expectedOutcome.trim() : description || action,
    }];
  }).slice(0, MAX_PLAN_SUBSTEPS);
  return substeps;
}

function parsePlanJsonCore(text: string): PlanParseResult {
  if (!text) return { plan: null, repaired: false };
  let cleaned = text.trim();
  // Strip ```json ... ``` fences (some models wrap structured output).
  const fence = cleaned.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/);
  if (fence) cleaned = fence[1].trim();

  let parsed: unknown;
  let repaired = false;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    // Smart fault tolerance: LLM plan JSON with minor syntax errors (trailing
    // commas, single quotes, unquoted keys, full-width punctuation, prose
    // wrappers) is repaired and re-parsed before falling back to the generic
    // heuristic plan. Parse-gated — only accepted if it parses cleanly.
    const repairedResult = repairJsonSource(cleaned);
    if (!repairedResult.repaired) return { plan: null, repaired: false };
    repaired = true;
    try {
      parsed = JSON.parse(repairedResult.source);
    } catch {
      return { plan: null, repaired: false };
    }
  }

  const rawSteps: unknown = Array.isArray(parsed) ? parsed : (parsed as { steps?: unknown })?.steps;
  if (!Array.isArray(rawSteps) || rawSteps.length === 0) return { plan: null, repaired };

  const steps: PlanStep[] = [];
  for (const raw of rawSteps) {
    const step = raw as { action?: unknown; description?: unknown; expectedOutcome?: unknown; todosRequired?: unknown; substeps?: unknown };
    const action = typeof step.action === 'string' ? step.action.trim() : '';
    const description = typeof step.description === 'string' ? step.description.trim() : '';
    if (!action && !description) continue;
    const normalizedSubsteps = normalizePlanSubsteps(step.substeps);
    const todosRequired = typeof step.todosRequired === 'boolean'
      ? step.todosRequired
      : normalizedSubsteps.length > 0;
    steps.push({
      id: String(steps.length + 1),
      action: action || description,
      description: description || action,
      expectedOutcome: typeof step.expectedOutcome === 'string' ? step.expectedOutcome.trim() : description || action,
      todosRequired,
      substeps: todosRequired ? normalizedSubsteps : undefined,
    });
  }
  if (steps.length === 0) return { plan: null, repaired };
  // Hard cap so a non-compliant model can't balloon the review card / system
  // prompt with dozens of micro-steps (the prompt asks for 4-8).
  const capped = steps.slice(0, MAX_PLAN_STEPS);
  // Re-index ids after the cap (parsePlanJson assigned sequential ids above).
  const indexed = capped.map((s, i) => ({ ...s, id: String(i + 1) }));

  return {
    plan: {
      steps: indexed,
      reasoning: `The task has been broken into ${indexed.length} concrete steps, each with a defined outcome.`,
    },
    repaired,
  };
}
