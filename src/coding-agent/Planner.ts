// src/coding-agent/Planner.ts
// v0.1 — Analyzes tasks: determines complexity, optionally generates a plan.
// v0.2 — Logical-trap detection: scans the prompt for self-contradictory /
//        impossible / mutually-exclusive / trick-framed premises so the agent
//        can verify them before execution and escape the trap by switching
//        approach after a failed round instead of repeating the same one.

import type { AnalysisResult, IntentAssessment, RequestIntent, SemanticRouteDecision, TaskComplexity, TaskMode, Plan, PlanStep, PlanVerificationSpec, TrapWarning } from './types';
import type { LLMAdapter, Message, MessageImage } from '../shared/types';
import { repairJsonSource } from '../shared/parseRepair';
import { KNOWN_SUBAGENT_ROLES } from '../shared/adaptiveControl';
import { activeCharacterProfile, registerScaledDecision, type RegisterScaledCaps, type WorkOrderRegister } from '../character';
// Shared confidence vocabulary + gate. One-way dependency (inputDecision knows
// nothing about Planner) so the router and the insertion classifier can be
// judged by the same threshold without a cycle.
import { clampConfidence, inputDefaultConfidence } from './inputDecision';

/**
 * 性格内核（刀 1 收拢，刀 5 改懒读）：步子大小 / 验证密度 / mode 阈值都从
 * 当前活跃内核的决策面读。**每次真读，不在模块加载时取一次**——宿主是在启动、
 * 读完配置之后才注入活跃内核（见 src/character/active.ts），模块加载早于那一刻，
 * 早读会把「切内核」变成静默失效。默认内核的值 = 现行为原样。
 */
const characterDecision = () => activeCharacterProfile().decision;

// ── E2.3 计划层并行标注 ──
// 策略层的 parallelRoles 说的是"这个任务推荐了哪些可并行的角色"；计划步骤是
// 规则生成的通用模板，两者靠步骤文本里的角色域关键词对接。纯规则标注、不
// 加 LLM 调用：标注错了顶多是少并行/多并行一次只读派发，代价可控。
const PARALLEL_STEP_DOMAINS: Record<string, RegExp> = {
  researcher: /调研|研究|搜集|收集|查资?料|搜索|查一下|查查|背景|现状|research|investigat|gather|survey/i,
  deep_thinker: /评估|权衡|比较|方案对比|多方案|可行性|trade-?offs?|evaluat|compar[ei]/i,
  project_auditor: /审计|依赖检查|安全检查|安全审查|漏洞|audit|vulnerab|dependency check/i,
  code_reviewer: /评审|审查|review/i,
  ui_designer: /界面设计|视觉|交互设计|设计稿|ui\s*design|mockup|wireframe/i,
};

/** 把策略层的 parallelRoles 接到计划步骤上：推荐的并行安全角色里只要有一个
 *  的域关键词命中某步，该步就标 parallel。不足两步可并行时不标——单个标记
 *  没有组批对象，只会让卡片和提示词多噪声。返回新 Plan，不改入参。 */
export function markParallelPlanSteps(plan: Plan, parallelRoles: readonly string[]): Plan {
  const domains = parallelRoles
    .map(role => PARALLEL_STEP_DOMAINS[role])
    .filter((re): re is RegExp => Boolean(re));
  if (domains.length === 0) return plan;
  const qualifies = (step: PlanStep): boolean => {
    const text = `${step.action} ${step.description}`;
    return domains.some(re => re.test(text));
  };
  const marked = plan.steps.filter(qualifies);
  if (marked.length < 2) return plan;
  return {
    ...plan,
    steps: plan.steps.map(step => (qualifies(step) ? { ...step, parallel: true } : step)),
  };
}

export interface PlannerConfig {
  /** Threshold for explicit, concrete file-operation evidence. */
  complexFileThreshold?: number;
}

const SEMANTIC_ROUTE_PROMPT = `You are the routing layer for a coding assistant. Understand the user's complete message semantically; do not classify from isolated words or a fixed keyword list. When earlier turns are included they are CONTEXT, not requests: what you classify is always the LAST user message, read as the continuation of that conversation. A short follow-up ("还是不行", "再加一个导出按钮", "用它做", "就先这样") takes its meaning from the preceding turn — judge what it asks for IN that conversation (a repeat of a failed fix, another change to the same deliverable, a switch to a resource the assistant already has), never as a standalone sentence with no subject. Decide what outcome the user is asking for: answer/explanation, research, advice, debugging, a small change, a broad refactor/migration, or creation of a runnable artifact. Distinguish feedback about an existing result from a request to create a new result. A clear creative request is not a reasonableness review merely because it is large, has several variants, or contains style constraints.

Return ONLY one JSON object with this shape:
{"intent":"question|research|add|modify|debug|refactor|migrate|delete|build","complexity":"simple|complex","mode":"yolo|plan|build","requiresPlan":false,"needsDeliveryGate":false,"subagents":["researcher","deep_thinker"],"confidence":0.9,"assessment":{"riskLevel":"low|medium|high","reversibility":"reversible|partially-reversible|hard-to-reverse|irreversible","impact":"...","recommendation":"...","requiresProbe":false,"requiresConfirmation":false}}

"confidence" — how sure you are of the intent above, 0..1, and answer it honestly rather than politely: a message that genuinely reads two ways (a complaint that could be feedback or a request to change the code, a question that could also be an instruction) rates around 0.5, an unambiguous one 0.9+. Omit the field when the call is obvious — the caller treats a missing number as "not doubtful", so a number given out of habit is worse than no number.

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

Use plan/build only when the user's actual outcome benefits from ordered execution or a runnable multi-file deliverable. Do not use them for ordinary advice, critique, explanation, or research. Set needsDeliveryGate only when the user wants files/project output that needs workspace-level delivery verification. Set requiresConfirmation only for an explicit destructive/irreversible action or a concrete safety boundary. Asking HOW is not asking you to DO it: "如何重置 X" / "怎么删掉 Y" / "how do I rotate the key" asks for a procedure, so classify it intent "question" with low risk and requiresConfirmation false even though the sentence names a destructive operation; reserve intent "delete" and requiresConfirmation for a request to perform that action now on a named target. Write "impact" as the concrete reasoning behind the safety decision rather than a category label — what this request would touch and why it cannot be undone (or why a probe comes first). The GUI shows impact verbatim as your assessment, so a label like "this is a delete request" tells the user nothing about why you stopped. Keep impact and recommendation concise and in the user's language. If uncertain between advice and implementation, choose the conversational path and let the assistant explain options rather than modifying files. When the user message is about an image and the goal is to READ, EXTRACT, TRANSCRIBE, or DESCRIBE the text/content shown in that image (e.g. "把图片里的文字读出来", "extract the text from this screenshot", "读出图里的字"), classify it as intent "question", mode "yolo", needsDeliveryGate false — it is a read-only request, NOT a build/delivery task. Never invent a plan or workspace change for reading an image. A request for a SINGLE visual or naming asset — an icon, logo, avatar, cover, illustration, banner, poster, sticker, wallpaper, UI mockup, or a name/title/slogan ("给我生成一个桌面端应用的图标", "设计一个网站的logo", "给这个项目起个名字") — is a direct creative output even though it mentions an app/website/project: classify it intent "add", mode "yolo", needsDeliveryGate false, requiresPlan false, and produce the asset itself (e.g. write an SVG/HTML file or render it inline) to show the user. The mentioned app/site is only what the asset is FOR — it is not the deliverable, and no multi-step engineering plan or test scaffold belongs to it. Reserve plan/build for deliverables that are themselves runnable or multi-file.`;

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

// ── Work-frame veto (2026-10-14) ──────────────────────────────────────────
// `isPlainConversational` below asks the KEYWORD FLOOR whether it already
// reproduced the router's verdict. The floor cannot answer that: `assessIntent`
// defaults every request it does not recognise as destructive/migrate/refactor
// to `intent: 'question'`, risk low — a DEFAULT, not a verdict. Measured on the
// product's own request set (scripts/tmp-route-census.ts, 15 real phrasings),
// the floor read 14 of them as question/simple/yolo, including:
//
//   登录页在我点登录后没有反应，帮我查一下为什么，然后修掉   → chat
//   给这个登录页加上「记住我」和退出登录，并且补上测试         → chat
//   我想给这个项目加一个离线缓存层，先给我一个方案            → chat
//   这个页面不太行，你看看                                    → chat
//   还是不行                                                  → chat
//
// so the hidden router was never called and the turn was carried as chit-chat:
// no assessment, no read-only probe, no plan review, no delivery gate — the
// harness abstaining exactly where the request asks for work. The two vetoes
// below are the corrective: `namesAnEdit` (verb × target) catches the explicit
// edit, and `namesWorkFrame` catches the rest of the work shapes. Both are
// NEGATIVE signals on a floor that can only say "question" — they never claim
// what the turn is, only that the fast path may not settle it.
//
// Bias: recall over precision, deliberately. A false veto costs one router
// round trip (a few seconds, and only on that turn); a false skip costs the
// whole turn's structure (probe / plan / delivery gate / assessment), which is
// the failure this exists to prevent. The line is drawn so that genuine
// conversational turns — questions, small talk, creative asks, design-direction
// questions — carry none of these signals and keep the fast path.

/** Change-shaped verbs: naming one is naming work to do, not a question. */
const WORK_VERB_RE = /(?:改(?:成|为|一下|一改|掉|好|得|动|起来)|修改|修正|改动|修复|修好|修掉|修了|修一下|修下|调试|排查|定位|复现|加上|加一个|加个|新增|添加|插入|补上|补齐|补充|删掉|删了|删除|移除|去掉|替换|换成|重构|重写|重命名|拆分|抽出|抽取|迁移|升级|降级|实现|接入|接上|接进去|部署|打包|优化一下|简化|整理|清理|调整|装上|安装|用它做)/;

/** Functional-failure words: the user is reporting something that does not
 *  work — that is a diagnosis request even when phrased as an observation.
 *  Deliberately excludes aesthetic opinions (难看 / 不好看): those are design
 *  feedback, and the product routes design direction as a question on purpose. */
const WORK_SYMPTOM_RE = /(?:没反应|不响应|点不了|点不动|点了没|没效果|没生效|不生效|不起作用|不工作|跑不起来|起不来|打不开|加载不出来|报错|出错|报异常|崩溃|卡住|卡死|失效|失灵|坏了|挂了|不太行|不对劲|不好用|不行了|还是不行|又不行|不通过|没过|构建失败|测试失败|偶发)/;

/** Requests for a plan / an assessment of a concrete target — asking for the
 *  shape of the work is not chit-chat. */
const WORK_PLAN_RE = /(?:给我(?:一个|个|一份)?\s*(?:方案|计划|思路|建议)|先给(?:我)?(?:一个|个)?\s*(?:方案|计划)|规划一下|设计一下|评估一下|分析一下|排查一下|找找原因|定位一下|看看问题|你看看|你看一下|帮我看)/;

/** Does this turn name work (a change, a malfunction, or a plan request)?
 *
 *  Exported so `prefetchTurnRoute` can veto the chit-chat fast path with it.
 *  It answers ONE question — "may the floor's `question` default be trusted?" —
 *  and deliberately does not attempt to classify the turn: the LLM router is
 *  the only layer allowed to say what the request IS. */
export function namesWorkFrame(prompt: string): boolean {
  const text = prompt.trim();
  if (!text) return false;
  return WORK_VERB_RE.test(text) || WORK_SYMPTOM_RE.test(text) || WORK_PLAN_RE.test(text);
}

/** True when a request is SO plainly a low-stakes conversational turn — a
 * question OR a short creative/answer imperative (做一首诗 / 写个故事 / 讲讲
 * X) — that the LLM router could not change the outcome. Conservative by
 * construction: no images, short, no project/artifact build framing (even
 * hidden behind a question prefix), and the synchronous fallback verdict
 * must already be question / simple / yolo / low-risk with no traps.
 * Anything else keeps the full semantic-route call. The interrogative-shape
 * check was dropped: creative imperatives classify identically under the
 * remaining guards, and requiring ？」/吗 made every 生成类 request pay the
 * hidden router round trip (6-12s dead latency) for a verdict the fallback
 * had already reproduced. */
export function isPlainConversational(prompt: string, images?: MessageImage[] | null): boolean {
  if (images?.length) return false;
  const text = prompt.trim();
  if (!text || text.length > 200) return false;
  // An imperative build request hiding inside a question frame (e.g.
  // "能不能帮我设计一个自行车网站？") must still reach the LLM router — the
  // artifact/delivery pipeline depends on it. detectArtifactRequest already
  // rejects question-leading forms, so re-test with the frame peeled.
  if (detectProjectRequest(text) || detectArtifactRequest(text)) return false;
  const peeled = stripQuestionPrefix(text);
  if (detectProjectRequest(peeled) || detectArtifactRequest(peeled)) return false;
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

/** One prior turn handed to the router. Declared structural rather than reusing
 *  Message so a caller cannot smuggle tool results or images into the context. */
export interface RouteContextTurn {
  role: 'user' | 'assistant';
  content: string;
}

/** How many prior turns the router may see, and how much of each. Small on
 *  purpose: the router needs WHAT the conversation is working on, not the
 *  transcript — and this call rides in front of every non-trivial turn. */
export const ROUTE_HISTORY_TURNS = 6;
export const ROUTE_HISTORY_CHARS = 600;

/**
 * Build the router's context messages from the tail of the conversation.
 *
 * Field shape this exists for: a follow-up ("还是不行" / "再加一个导出按钮" /
 * "用它做") carries almost none of its meaning by itself — routed as a standalone
 * sentence it reads as a fresh, tiny, unclassifiable request, which is how a
 * debugging continuation got carried as chit-chat. The last user message is the
 * request being classified; everything before it is context only.
 *
 * A trailing user turn identical to the current prompt is dropped: the caller's
 * transcript already contains the message being routed, and feeding it twice
 * reads as "the user said this twice".
 */
export function routeHistoryMessages(
  turns: readonly RouteContextTurn[] | undefined,
  current: string,
): Message[] {
  if (!turns?.length) return [];
  const normalize = (text: string): string => text.replace(/\s+/g, ' ').trim();
  const target = normalize(current);
  const usable = turns.filter((turn) => turn.role === 'user' || turn.role === 'assistant');
  while (usable.length > 0) {
    const last = usable[usable.length - 1];
    if (last.role === 'user' && normalize(last.content) === target) usable.pop();
    else break;
  }
  return usable
    .filter((turn) => turn.content.trim().length > 0)
    .slice(-ROUTE_HISTORY_TURNS)
    .map((turn) => ({
      role: turn.role,
      content: turn.content.length > ROUTE_HISTORY_CHARS
        ? `${turn.content.slice(0, ROUTE_HISTORY_CHARS)}…`
        : turn.content,
    }));
}

export async function inferSemanticRoute(
  llm: LLMAdapter,
  prompt: string,
  signal?: AbortSignal,
  images?: MessageImage[],
  timeoutMs = 12_000,
  history?: readonly RouteContextTurn[],
): Promise<SemanticRouteDecision | null> {
  if (!prompt.trim() || signal?.aborted) return null;
  const request: Message[] = [
    { role: 'system', content: SEMANTIC_ROUTE_PROMPT },
    ...routeHistoryMessages(history, prompt),
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
    // 只在模型真的给了数字时带上：缺字段与 clamp 后的默认值必须能区分开，否则
    // "没报"会被读成"报了 0.7"，日志里就再也看不出一轮路由到底有没有表态。
    ...(Number.isFinite(Number(value.confidence)) ? { confidence: clampConfidence(value.confidence) } : {}),
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

/** Result of judging a mid-run insert against the current task.
 *
 * 插话重构：判定不再问"相关与否"，而是直接问"人看到这句话会怎么处理"——
 * question 侧路回答、steer 顺路带上、premise-change 前提被推翻止损重来、
 * goal-change 方向推翻重来、stop 停手不重排、task 排队、chatter 会心一笑。
 *
 * stop 分两层（2026-09-28 补）：**字面命令**（"停止""停下""取消"…）仍走
 * STOP_RE 快路径——停是不可逆动作，等一次分类往返是抗命，且限流/超时期间
 * 机械路径是唯一可靠的处置通道；**非字面的停**（"先缓一缓""这个就到这儿"
 * "停掉整个任务""不用继续了"）正则覆盖不到，以前会被判成 steer（带上）或
 * task（排队），现在由裁决器判 stop。判据是「没有东西补上来」：goal-change
 * 是换一个方向继续，stop 是不需要这个结果了。 */
export type InsertionKind = 'question' | 'steer' | 'premise-change' | 'goal-change' | 'stop' | 'task' | 'chatter';

export interface InsertionClassification {
  kind: InsertionKind;
  reason: string;
  /** The model's OWN confidence in `kind` (0..1). It is what lets the caller
   *  ask instead of gambling — see applyConfidenceGate in inputDecision.ts.
   *  Absent/ignored by a provider → inputDefaultConfidence() (see there for why
   *  the default sits ABOVE the gate). */
  confidence: number;
  /** True when the model answered WITHOUT a confidence number, so the value
   *  above is inputDefaultConfidence() rather than its own judgement. Without
   *  this flag a default that keeps the app quiet would be indistinguishable
   *  from a model that actually said "I am sure". */
  confidenceDefaulted?: boolean;
  /** True when this verdict is not a judgment at all but the internal fallback
   *  (timeout / network / unparseable / empty input): the coordinator answers
   *  it with the literal safety nets instead of trusting "task" as a reading.
   *  2026-09-28 用户定调：正则不配做决策，只配做裁决器倒下时的安全网。 */
  fallbackUsed?: boolean;
  /** The model's reading of WHEN this input wants to run, verbatim ("now",
   *  "after", "10 分钟后", "下午三点"). Parsing happens in inputDecision.ts so
   *  the clock arithmetic stays testable and provider-independent. */
  when?: string;
  /** True when the message CANCELS or removes a named part of the running
   *  work rather than adding or adjusting one (2026-09-24 取消案例). The host
   *  routes the removal away from the task queue on this flag — queuing a
   *  removal would run the opposite of what was asked. */
  cancelsPart?: boolean;
  /** True when ONE message does both jobs: removes a named part AND asks for new
   *  work ("B站那支别查了，再加一个爱奇艺"——砍掉那一支，同时把这一支加进来).
   *  注意别拿「不要只查均价了」当这类句子："只"限定的是排他性，均价仍被需要，
   *  那既不是移除也没有 adds_along（2026-09-28 复核）。
   *  Only meaningful alongside `cancelsPart`, and the host reads it as the gate
   *  on stopping a branch: pausing that branch would kill the work the message
   *  just asked for, so the removal is folded into the join instead. Replaces
   *  the host's old SCOPE_ADD_RE keyword sniff (2026-09-28). */
  addsAlong?: boolean;
  /** 祈使式「停掉 X 那支」（第 2 期分支中断快路径）：真停一支在飞委派，
   * 不等汇合轮。宿主先点名寻址（matchSteerRecipient），点到了就
   * abortBranch；点不到退回取消折入——宁可折叠不误杀。 */
  branchStop?: boolean;
  /** 模型点名、宿主执行（2026-10-10 重构）：消息停/收掉某支**在飞**委派时，
   * 裁决器从上下文 <live_branches> 花名册里指认那支的确切 id。宿主只按这
   * 个 id 真停，不做任何自己的文本匹配——「停哪支」是理解，理解归模型。
   * 指认不出（模糊/无所指/花名册缺席）留空，宿主退回保守折入。mode 不进
   * 契约：祈使停=abort、收掉一项=pause 由宿主按判例口径从信号推导。 */
  stopBranch?: { callId: string };
  /** 分支级继续（第 2 期第三刀）：「把 X 那支接着跑完」——宿主点名找到那支
   * 已暂停/已停的档案，用**原始参数**同参重派（稳定 sessionId 命中断点 →
   * 引擎 continue）；点不到具体支或拿不到原参退回让父模型重派。
   * 命名与 cancelsPart 同风格（分类器 JSON 字段 resumes_part → 这里），
   * coordinator 再转成信号 resumesBranch。 */
  resumesPart?: boolean;
  /** 思考窗吸收（2026-09-27 用户定调）：这句话往**当前正在产出的那一件东西
   * 里**加内容（画小鸟时“背景加几朵会动的云”、做页面时“标题再大一点”），
   * 不是第二件活。宿主在预检思考还活着时据此把它并进请求一起想，第一版
   * 产出就带上；不排队（排队=拆成两件事，构图就断了）。 */
  supplementsCurrent?: boolean;
  /** 方法切换（2026-10-13 REA 判例）：「你刚才不是已经装了 X 吗」这类资源
   * 提醒 = 换做法，不是纯取消——交付物不变，换的是路。宿主照 pause 口径
   * 止损在飞支并让插话重入，绝不落取消收执（「这项不做了」会把用户真正
   * 要的「换成 X」那半句扔掉）。 */
  methodSwitch?: boolean;
  /** 止损失效重想（2026-10-21 对话主导架构刀 B，用户拍板）：这句插话改变
   * 「当前正在产出的东西」从现在起该是什么样——按旧路继续吐出来的内容
   * 反正要被收回。宿主当场停流（委派在飞则 PAUSE 存档），押话重入：原话
   * 开场、结合现场重新思考，已完成的不丢。是 EXECUTING 阶段
   * supplements_current 的对应物（那个管思考窗，这个管执行流）；
   * cancels_part/resumes_part/stop_branch 在场时不生效（专门臂优先）。 */
  affectsCurrent?: boolean;
  /** 范围确认去重（2026-10-21 对话主导架构刀 F，真机「调研必须包括优酷」
   *  判例二连反转）：这句插话要求某件东西**必须出现在产出范围内**，而花名
   *  册里已有一支在做/做完了它——宿主该答「那路正在跑着，不重复」而不是再
   *  转达一遍。刀 E 试过「裁决器抄对象名+宿主字面匹配」，真机否决：裁决器
   *  漏报新字段、字面匹配对不上语义对应（「优酷」vs 任务书里的「优酷动漫
   *  官方消息」）。刀 F 改与 stop_branch 同构——**模型拿花名册点名已覆盖
   *  那支的确切 callId，宿主只核实 id 真实性**（机械事实零语义）；点不出
   *  就留空，照旧路由（缺的东西照常补上）。 */
  coveredBranch?: { callId: string };
  /** 「这个急」提级（第 5 期调度）：用户明确这件新活加急/该先办（"这个急"、
   *  "优先处理这个"、"加急"）时置真——宿主据此把队列里的这项插到队头并换
   *  提级收执。只对 task（排队）/steer 有意义；提级只改**队列次序**，不涉
   *  任何破坏性动作，所以缺省绝不自己补（严格 === true 才认）。 */
  urgent?: boolean;
  /** 现场收执（2026-10-15 用户定调「不要固定话术，要结合上下文说明会怎么
   * 做」）：裁决那一刻裁决器就在现场（看得见 current_task 的阶段与插话原
   * 话），由它顺手写好给用户看的那一两句——听懂了什么（点名插话里的实际
   * 对象）、手头的活怎么办、接下来会怎么做。宿主只在路线与收执语义一致时
   * 采用（steer / 普通折入）；停支没停成、早派这类只有宿主知道的事实，其
   * 诚实口径优先于它；缺席/空串回落固定话术（规则与安全网路径没有裁决器
   * 在场，永远走固定口径）。 */
  receipt?: string;
}

const INSERTION_CLASSIFY_PROMPT = `You are the agent, mid-task. The user just said something while you were working. Decide what to do with it the way a sharp human colleague would — NOT by matching keywords, but by weighing two things together: WHEN it arrived (which phase you are in, from the context) and WHAT it changes about the result you still owe them. One question decides everything: which handling leaves the final result best off — 统筹兼顾顺势而为 (take it in stride, fold it into what you are already doing) or 及时停下改方向 (stop, and redo from the new ground truth)? A sharp human never drops the remark, and never throws work away without a reason. Neither may you.

The next user message carries your live situation in two tagged sections — read both before judging:
<current_task> — what you are working on right now; read the phase carefully, it decides what "taking it in stride" even means.
<new_message> — what the user just said.

The ways to take a remark (pick exactly one kind):

- "steer" — the remark belongs to the thing you are ALREADY making: a constraint that reshapes it ("诗句里一定要出现'明月'", "这首必须是五言的"), an element or detail added inside the same deliverable ("背景上加几朵会动的云", "标题再大一点"), the one list/answer growing ("新增加两位" while five are being worked out — the same answer now covers seven), or guidance on how it proceeds ("记得跑测试", "文案再口语一点"). The growing-list case counts ONLY when that list lives INSIDE the one deliverable, so the remark changes what the deliverable covers and nothing else — it is NOT this when the added thing is another OBJECT of the kind already being worked on in parallel (three platforms being researched and the user names a fourth): that object is a unit of work of its own, not a detail of the current one, and it is a TASK (see below). Which "taking it in stride" means is decided by the PHASE in the context: while you are still THINKING (the context says the plan is being thought out), it means the thought must be redone with the remark INSIDE it — the host merges it into the request and rethinks from scratch; if the remark belongs to the thing being thought, set "supplements_current": true and trust the host to do that. While EXECUTING, it means the running work carries it at the next step — UNLESS the remark changes what the output must be from here on (「你理解错了」/ a new emphasis or audience): then set "affects_current": true instead, and the host stops the stream and redoes it from the remark. While COLLECTING parallel results, an addition merges into the汇总, and a named removal ("X 就不调研了", "Y 那个别查了" — set "cancels_part": true) simply leaves the result: NEVER queue a removal — queuing would run the exact opposite of what was asked — and never treat one branch changing as the whole direction overturning. A named paused/stopped branch being carried on ("把竞品那支接着跑完", "让报价那路继续") is also steer with "resumes_part": true — the branch has its own checkpoint to continue from; queuing it would start it from scratch.
- "premise-change" — the remark corrects a FACT the work is built on: place, dates, environment, versions, budget, who owns what, what something IS ("其实我在西安，不是广东", "预算只有三千", "你对jev的理解是错误的，jev是2026年9月新发布的模型"). The goal stands, but everything computed from the wrong fact comes out worthless — the work must be redone from the corrected fact. Judge this over steer whenever the correction would change the ANSWER, not just its wording. Especially while THINKING: if the thought-so-far (shown in the context) rests on the wrong fact, redoing the thought is the only honest move.
- "goal-change" — the user overturns the direction itself: replace the goal/approach/output, start the task over differently ("推翻重来", "换方案", "别做这个了，改成…"). The dividing line with steer is scope: one part or one aspect changing is steer; the whole thing heading somewhere else is this. A RESOURCE REMINDER is 换方案 said sideways, and it lands HERE with "method_switch": true: the user points at something you ALREADY have — an installed tool, a skill, a server, a package ("你刚才不是已经安装了REA这个工具了吗，专门用来反编译分析的", "不是有现成的X吗，用X来做") — meaning "stop the approach it replaces and use it instead". The deliverable stands; only the way of producing it changes. This holds even when the reminder touches only one part of the work — the switch outranks the scope test above. It is NEVER a plain removal — "cancels_part" must stay OFF for it: answering a resource reminder with "这项不做了" throws away the very half the user asked for (switch to the named resource), and that reading is the single most confusing reply an insertion can produce.
- "stop" — the running work ends and NOTHING takes its place ("先缓一缓", "这个就到这儿吧", "停掉整个任务", "不用继续了", "够了，先这样"). The whole question is what happens to the work: a stop leaves no answer to build, a goal-change replaces it with a different one, and a steer reshapes it. Phrases that look like stopping but are not: a constraint on how the work proceeds ("别停下来", "先别改这部分") is steer; asking where things stand ("跑完了吗") is question; a removal of ONE named branch or part while the rest continues is steer with "cancels_part" (the work as a whole carries on).
- "task" — a NEW, completable piece of work, even one that extends the current job ("再加一个 X 平台", "顺便也查一下 Y", "把 Z 也照样处理", "再写一首五言绝句" alongside an essay). Queuing runs it right after the current task so it can never be lost; when torn between steer and task over ADDED work, pick task. The test needs NO deliberation — ask what has to come BACK: something that must be fetched, looked up, researched or produced on its own is a task however small, even when it is worded as an addition ("再加一个爱奇艺平台" while three platforms are being researched = one more unit of work of that kind, not a detail of the 对比汇总; "把爱奇艺也查一下", "芒果TV也来一份", "also check Douban" all ask for something brought back). But what has to come back must ALSO be outside the current job: a step the current work itself has to take anyway — verifying it, running its tests, checking the result, keeping a style — adds no scope and is guidance, i.e. steer ("记得跑测试", "文案再口语一点"); it is not a second piece of work just because it names an action. Only a remark that changes the ONE thing you are already producing — its shape, its content, a constraint on it — is steer. ONE exception outranks this test: when the SAME message also REMOVES work that was already asked for (see "cancels_part"), the removal decides the kind — that message is steer, its addition is folded into the join, and nothing is queued ("B站那支别查了，再加一个爱奇艺" drops one branch and grows another in the same breath — the insert is reshaped, not deferred). A removal sent to the queue runs the exact opposite of what was asked. The user's expectation draws the same line otherwise: ONE deliverable that now carries the remark (steer), or a SECOND deliverable after this one (task).
- "question" — the user asks something and expects an answer NOW ("跑完了吗", "现在到哪了"), or asks for a decision only they can make. Answering must not disturb the running work.
- "chatter" — small talk, thanks, reactions, filler ("哈哈", "好的", "辛苦了", "+1"). Nothing to act on.

One message may carry SEVERAL instructions ("预算改两万；人群换成企业决策者；顺便查下股价"). Judge it as ONE whole: pick the kind of whichever part changes the running work the MOST, and name the remaining parts in "reason" so nothing is dropped. When a message contradicts itself or flips back and forth ("用X。算了还是Y。不，别管刚才那句"), do NOT classify a middle state — the user's LAST explicit statement is the message; say in "reason" that the earlier ones were overridden.

Return ONLY one JSON object:
{"kind":"steer|premise-change|goal-change|stop|task|question|chatter","reason":"<one short line>","confidence":<0..1>,"when":"<timing words or null>","cancels_part":true,"adds_along":true,"resumes_part":true,"supplements_current":true,"affects_current":true,"method_switch":true,"urgent":true,"receipt":"<what you tell the user, see below>","covered_branch":{"call_id":"<exact id from the roster, or omit>"},"stop_branch":{"call_id":"<exact id from the live_branches roster, or omit>"}}

"confidence" is how sure you are of the kind and therefore of the action that
follows it — 0.9+ for an unambiguous message, ~0.5 when the message genuinely
reads two ways (a correction of facts that could also be a small tweak, an
overturn that could also be a scope addition). Report genuine doubt (~0.5 or
lower) also when the message is self-contradictory, or when it touches
something irreversible (sending, publishing, deleting, paying, deploying)
while staying unclear — the host will ask the user one short question instead
of gambling with an action that cannot be undone. Never inflate the number: a
low one is cheap (the agent asks the user one short question), a wrong high
one is not (the agent restarts work or loses the message).

"when" is the user's own words for WHEN this should run if they named a time
("10 分钟后", "下午三点", "明天早上") — copy them, do not compute a time. Use
"now" when the message implies it must be handled immediately, "after" when it
explicitly belongs after the current task, and null when no timing was said.

"cancels_part": include it as true whenever the message REMOVES work that was
already asked for — a named branch or part ("X 就不调研了", "Y 那个别查了", "去掉
X 的调研", "我说不需要 X 的") or an imperative removal of one ("把 X 这个调研
取消掉", "知乎那项也收掉吧", "暂停 X", "砍掉 X 那路"). The removal vocabulary is
an OPEN SET, not a keyword list — 去掉/不需要/不要了/暂停/剔除/收掉/砍掉/先不查
all remove work; read the intent, not the vocabulary. NARROWING
counts as removal too — but ONLY when the user actually stops wanting that output
("均价不用查了，改查区间"): a 只 next to the negation ("不要只查均价了") narrows what is
EXCLUSIVE, not what is required — the average is still wanted there, so nothing is
removed and cancels_part stays off. Report it
EVEN WHEN you pick "task" for the same message: the host routes removals away
from the queue on this flag alone, and a removal that reaches the queue runs the
exact opposite of what was asked — a misjudged kind is survivable, a missing
flag is not. And a message that names a REPLACEMENT for the work it stops
(stop this way, use X instead of it) removes nothing from the result — the
result now comes from X — so it is goal-change with "method_switch": true,
never cancels_part. This covers only a replacement that takes the removed
work's place; a message that ALSO cancels some unrelated part is different:
the unrelated removal still reports "cancels_part" as usual ("换成X来做，
另外知乎那支别查了"). Omit it for messages that only add or adjust work.

"adds_along": include it as true ONLY together with "cancels_part" — when the
same message does BOTH jobs: it removes one named part AND asks for new work
("B站那支别查了，再加一个爱奇艺" — that branch leaves, this one joins; "均价不用查了，
把区间加上"). NOT "不要只查均价了，把区间也查一下": 只 narrows the exclusivity only,
the average is still wanted, so nothing is removed and there is no adds_along. The host reads it as a gate on stopping a branch: pausing the
named branch would kill the work this very message asked for, so the removal is
folded into the join and nothing is stopped. Omit it for messages that only
remove, or only add.

"resumes_part": include it as true ONLY when kind is "steer" AND the message
asks to carry on ONE named branch that was previously stopped or paused; omit
it for every other message.

"supplements_current": include it as true ONLY when kind is "steer" AND the
remark belongs INSIDE the one thing currently being produced — an added
element, a reshaping constraint, the growing list — so the host merges it
into the request and redoes the thought; omit it for every other message.

"affects_current": the "stop now, redo the output with this in hand" move —
the EXECUTING-phase sibling of "supplements_current". Include it as true
when the remark changes what the CURRENT output must be from this point on
— its direction, emphasis, audience, format or scope — so that going on
along the old line would produce content you would have to take back
anyway. The one test: would the VERY NEXT thing you are about to produce
already be wrong or stale because of this message? 「你理解错了，我说的是X」
/「重点放到价格上，别铺那么长背景」/「这份是给老板看的，不要技术细节」 — all
true: the host stops the stream mid-sentence, keeps everything already
done, and restarts from the remark with you. While EXECUTING this outranks
the default carry-at-next-step — carrying on is only right when the current
line still stands. NOT this: a remark that only adds a parallel piece of
work (the current line is untouched), a corrected FACT ("premise-change"
owns that), guidance for a LATER step, or anything landing while still
THINKING ("supplements_current" already covers that phase). Omit it when
the current output survives the remark unchanged.

"covered_branch": the "make sure X is covered" remark — the user confirms or
extends the SET of things the work must include (「调研的平台必须包括腾讯」
「别忘了知乎」「记得把芒果TV也查上」). Before answering, CHECK THE ROSTER:
the context may carry <live_branches> (branches still running) and
<finished_branches> (branches already done, their results are in the
汇总). When ONE branch there already covers the thing the user names — by
its task snippet or role, including paraphrase (「优酷」 matches a branch
researching 优酷动漫官方消息) — point at it: {"call_id": "<the id copied
EXACTLY from the roster>"}. The host verifies the id and answers the user
「那路正在跑着，不重复」 (or 「已跑完，在汇总里」) for you — a sharp human
pointing out the thing is already being worked on, not relaying the order a
second time. When NOTHING on the roster covers it, OMIT the field — the
remark routes as usual and the missing thing gets added; say so in
"receipt" (「目前还没在查优酷，这就补上」). Never guess or shorten an id: a
wrong one tells the user the WRONG branch is already on it. NOT this:
steering an already-running branch's direction (「优酷那路重点查剧场版」 —
the branch exists and this changes HOW it works, not what the set
includes), removing ("cancels_part" owns that), or any message that does
not hinge on a thing being present in the result. "stop_branch" and
"covered_branch" never fire together — one message stops a branch or
confirms coverage, not both.

"method_switch": include it as true ONLY with kind "goal-change", when the
message switches HOW the work is done by pointing at a resource you already
have ("你不是已经装了X吗", "用X来做") — the goal stands, the approach is
replaced. For goal changes that change WHAT is being made, omit it.

"urgent": include it as true ONLY when the user's own words say this new work
should jump ahead of other waiting work — "这个急", "这件比较急", "优先处理这个",
"加急", "先办这个". It only reorders work that is already waiting to run after
the current task (the urgent item goes before the other queued ones), it never
means interrupt the current task, and it is meaningless for kinds that are not
"task" or "steer". Do NOT infer urgency from tone — a piece of work being
important is not the user calling it urgent, and "不着急" is the opposite.
Omit the field for every message that does not say it.

"stop_branch": the context may contain a <live_branches> block — the delegated
branches currently running, each with its id, name, role and task snippet.
When the message stops or cancels work that ONE of those branches is doing,
set it to {"call_id": "<the id copied EXACTLY from the roster>"} — the host
stops that branch for you the moment you name it. Copy the id verbatim, never
invent or shorten one; name only ONE branch even when the wording is loose.
Only <live_branches> can be stopped — a branch in <finished_branches> has
nothing left to stop (its result is already in the 汇总). When the roster is
absent, or no live branch clearly matches what the message
removes, OMIT the field entirely — a wrong id stops the wrong branch, an
invented one stops nothing. Omitting it when you are genuinely unsure is the
honest answer: the host folds the removal into the result instead of gambling.

"receipt": the one or two sentences the user sees the moment their remark
lands — YOU speaking to them, mid-work, the way a sharp colleague would. No
canned formula, no template reply: a receipt that would fit any conversation
is wrong for this one. Write it for EVERY kind except "chatter" and
"question" (a reaction needs no reply, and a question gets its own answer
instead) — including "stop", "premise-change" and "goal-change": the user
just changed something, and the first thing they hear back must be about
THEIR words, not a machine announcing an action. Cover three things in your
own words for THIS exact message, in this order: what you understood (name
the actual things the user named — the platforms, the branch to drop, the
corrected fact, the new direction), what happens to the work already
running (it carries on / it stops here with progress kept / it is redone
from the corrected ground), and what you will do next (「结束后我会新派两
路查询补上芒果TV和爱奇艺，再一起汇总输出」 / the constraint lands in the
next step / the collection redone without that part). Open by receiving
their words (「明白，优酷那路不要了」), never by announcing mechanics
(「已收到您的指令」). One or two short sentences, the user's language,
plain prose — no markdown, no internal jargon
(never 支/委派/分类/排队/上下文 — those are machine words). Honesty:
describe what WILL happen;
never claim something has already been dispatched, stopped or removed —
the doing is the host's hand, and the host corrects the receipt when
reality differs.`;

/**
 * Lightweight single-call routing of a message the user inserts while the
 * agent is mid-run. Mirrors inferSemanticRoute's (signal + timeout + JSON-
 * parse) shape. On any failure, timeout, or parse miss it falls back to
 * "task": the message queues and runs deterministically after the current
 * task. The old steer fallback predates a proven hole — a parent blocked on
 * parallel delegations has no THINK boundary to cash a steer at, so
 * "delivered as a remark" could silently drop. Queueing never drops.
 */
export async function classifyInsertion(
  llm: LLMAdapter,
  context: string,
  prompt: string,
  signal?: AbortSignal,
  images?: MessageImage[],
  timeoutMs = 8_000,
): Promise<InsertionClassification> {
  // Fallback is a QUEUED task, not a steer (2026-09-22 redesign): a parent
  // blocked on parallel delegations has no THINK boundary to cash a steer at,
  // so "delivered as a remark" could silently drop. Queueing waits its turn
  // and runs deterministically — the words can never be lost.
  const fallback: InsertionClassification = {
    kind: 'task',
    reason: 'classification unavailable; queued so the words can never be lost',
    // Queueing IS the confident action when no label could be produced — see
    // inputDefaultConfidence() (inputDecision.ts). This is the parse/timeout
    // fallback; the no-classifier-at-all policy is the coordinator's.
    confidence: inputDefaultConfidence(),
    fallbackUsed: true,
  };
  if (!prompt.trim() || signal?.aborted) return fallback;
  // 刀 4.1 缓存固化：system 只留逐字稳定的指令模板（进程生命周期内
  // byte-identical；anthropic 路径在 system 上打 cache_control，首次写后
  // 全命中），易变现场（投影/消息）一律进 user 消息。原状把
  // {{CONTEXT}}/{{PROMPT}} 拼进 system——每次判例 system 都不同，标记
  // 等于每次一次缓存写（1.25×）且永不命中；自动前缀缓存路径也只能命中
  // 变量块之前的指令头，JSON 契约尾巴永远打不中。
  const request: Message[] = [
    { role: 'system', content: INSERTION_CLASSIFY_PROMPT },
    {
      role: 'user',
      content: `<current_task>\n${context.slice(0, 3_200)}\n</current_task>\n\n<new_message>\n${prompt.slice(0, 2_000)}\n</new_message>`,
      images,
    },
  ];
  const KINDS: readonly string[] = ['question', 'steer', 'premise-change', 'goal-change', 'stop', 'task', 'chatter'];
  const parsed = await streamUntilParsed<{ kind?: unknown; reason?: unknown; confidence?: unknown; when?: unknown; cancelsPart?: unknown; cancels_part?: unknown; addsAlong?: unknown; adds_along?: unknown; resumesPart?: unknown; resumes_part?: unknown; methodSwitch?: unknown; method_switch?: unknown; urgent?: unknown }>(
    llm,
    request,
    signal,
    timeoutMs,
    (raw) => {
      const match = raw.match(/\{[\s\S]*\}/);
      if (!match) return null;
      try {
        const value = JSON.parse(match[0]) as { kind?: unknown };
        return value && typeof value.kind === 'string' && KINDS.includes(value.kind) ? value : null;
      } catch {
        return null;
      }
    },
  );
  if (parsed && typeof parsed.kind === 'string' && KINDS.includes(parsed.kind)) {
    const rawConfidence = typeof parsed.confidence === 'number' || typeof parsed.confidence === 'string'
      ? Number(parsed.confidence)
      : NaN;
    const parsedAny = parsed as { supplements_current?: unknown; supplementsCurrent?: unknown; affects_current?: unknown; affectsCurrent?: unknown; covered_branch?: unknown; coveredBranch?: unknown; stop_branch?: unknown; stopBranch?: unknown; method_switch?: unknown; methodSwitch?: unknown; receipt?: unknown };
    // 模型点名（stop_branch / covered_branch）：蛇形为主、驼峰兜底。id 非空
    // 字符串才收——残缺对象宁可当没点名（宿主退回保守折入/照旧路由），绝不
    // 拿半截 id 去停或去答「不重复」。
    const rawStop = parsedAny.stop_branch ?? parsedAny.stopBranch;
    const rawStopId = rawStop && typeof rawStop === 'object'
      ? (rawStop as { call_id?: unknown; callId?: unknown }).call_id ?? (rawStop as { callId?: unknown }).callId
      : undefined;
    // 范围确认去重（刀 F）：裁决器点名已覆盖那支的确切 id，宿主只核实——
    // 刀 E 的「抄对象名+宿主字面匹配」真机否决（漏报新字段/语义对应不上）。
    const rawCovered = parsedAny.covered_branch ?? parsedAny.coveredBranch;
    const coveredId = rawCovered && typeof rawCovered === 'object'
      ? (rawCovered as { call_id?: unknown; callId?: unknown }).call_id ?? (rawCovered as { callId?: unknown }).callId
      : undefined;
    return {
      kind: parsed.kind as InsertionKind,
      reason: typeof parsed.reason === 'string' ? parsed.reason : '',
      confidence: clampConfidence(parsed.confidence),
      confidenceDefaulted: !Number.isFinite(rawConfidence),
      when: typeof parsed.when === 'string' ? parsed.when : undefined,
      // 契约字段是蛇形 cancels_part（见提示词 JSON 样例）；驼峰兜底防模型
      // 自行改写。两处都严格 === true，缺省即 false。
      ...(parsed.cancels_part === true || parsed.cancelsPart === true ? { cancelsPart: true } : {}),
      ...(parsed.adds_along === true || parsed.addsAlong === true ? { addsAlong: true } : {}),
      ...(parsed.resumes_part === true || parsed.resumesPart === true ? { resumesPart: true } : {}),
      ...(parsedAny.supplements_current === true || parsedAny.supplementsCurrent === true ? { supplementsCurrent: true } : {}),
      ...(parsedAny.affects_current === true || parsedAny.affectsCurrent === true ? { affectsCurrent: true } : {}),
      ...(typeof coveredId === 'string' && coveredId.trim() ? { coveredBranch: { callId: coveredId.trim() } } : {}),
      ...(parsedAny.method_switch === true || parsedAny.methodSwitch === true ? { methodSwitch: true } : {}),
      // 第 5 期「这个急」提级：只认严格 === true；缺省/非 true 都不带标记，
      // 宿主只按这一个读取点插队。
      ...(parsed.urgent === true ? { urgent: true } : {}),
      // 现场收执（2026-10-15）：非空字符串才收，去首尾空白、封顶 240 字——
      // 它是直接上屏给用户的，超长就不再是「一两句」了。
      ...(typeof parsedAny.receipt === 'string' && parsedAny.receipt.trim()
        ? { receipt: parsedAny.receipt.trim().slice(0, 240) }
        : {}),
      ...(typeof rawStopId === 'string' && rawStopId.trim() ? { stopBranch: { callId: rawStopId.trim() } } : {}),
    };
  }
  return fallback;
}

/** 规则快路径的聚焦点名（模型判断、宿主执行，2026-10-10）：BRANCH_STOP_RE
 *  只裁「要不要停」（命令零延迟），不裁「停哪支」——指认是理解，归模型。
 *  与 classifyInsertion 分开：这里只要一个确切 id，不要一次完整分类（kind
 *  已由规则落定，再判一遍既浪费还会跟规则打架）。任何失败返回 null，调用
 *  方退回保守折入。 */
const STOP_TARGET_PROMPT = `The user, mid-task, is telling you to stop or cancel ONE piece of delegated work that is currently running as a parallel branch. You are the agent deciding WHICH branch they mean — judgment, not keyword matching: weigh the branch names, roles and task snippets against what the user said, including paraphrase (「评审」 may match a code_reviewer role, 「爆发点」 a task snippet).

The next user message carries your situation in three tagged sections:
<current_task> — what you are working on.
<live_branches> — the delegated branches currently running, each with its id, name, role and task snippet.
<new_message> — what the user just said.

Return ONLY one JSON object: {"call_id":"<the id copied EXACTLY from the roster>"} when exactly one branch clearly matches what the user wants stopped; {"call_id":null} when none does, or when two could. Never invent an id. When in doubt answer null — a wrong pick stops the wrong branch, while null just leaves the removal to be folded into the result.`;

export async function resolveStopBranchTarget(
  llm: LLMAdapter | null,
  context: string,
  prompt: string,
  roster: Array<{ callId: string; name: string; role?: string; snippet?: string }>,
  signal?: AbortSignal,
  timeoutMs = 8_000,
): Promise<{ callId: string } | null> {
  if (!llm || !prompt.trim() || roster.length === 0 || signal?.aborted) return null;
  const rosterText = roster
    .map((b) => `- id=${b.callId} name=${b.name}${b.role ? ` role=${b.role}` : ''}${b.snippet ? ` task=${String(b.snippet).slice(0, 80)}` : ''}`)
    .join('\n');
  // 刀 4.1 缓存固化：与 classifyInsertion 同一纪律——system 逐字稳定，
  // 现场（任务投影/花名册/消息）进 user 消息。
  const request: Message[] = [
    { role: 'system', content: STOP_TARGET_PROMPT },
    {
      role: 'user',
      content: `<current_task>\n${context.slice(0, 3_200)}\n</current_task>\n\n<live_branches>\n${rosterText}\n</live_branches>\n\n<new_message>\n${prompt.slice(0, 2_000)}\n</new_message>`,
    },
  ];
  const parsed = await streamUntilParsed<{ call_id?: unknown; callId?: unknown }>(
    llm,
    request,
    signal,
    timeoutMs,
    (raw) => {
      const match = raw.match(/\{[\s\S]*\}/);
      if (!match) return null;
      try {
        const value = JSON.parse(match[0]) as { call_id?: unknown; callId?: unknown };
        return value && typeof value === 'object' ? value : null;
      } catch {
        return null;
      }
    },
  );
  const callId = parsed?.call_id ?? parsed?.callId;
  return typeof callId === 'string' && callId.trim() ? { callId: callId.trim() } : null;
}

/** 复核判定（去重撞车专用，2026-10-21 真机「停掉优酷这一调研」二次判 task
 *  实证了锚定问题）：不用同一个 system 重问——同一个提示词框架下模型会把
 *  原判再背一遍（<dedupe_conflict> 块在 system 里零契约，被当噪声忽略）。
 *  换一个只装这条窄问题的独立提示词，把「它已在跑」当事实摆在面前、举证
 *  责任倒置：谁会要求加一个正在跑的东西？ */
export interface CoveredRecheckVerdict {
  cancelsPart: boolean;
  stopBranchCallId?: string;
  receipt?: string;
  reason: string;
  confidence: number;
}

const RECHECK_COVERED_PROMPT = `You are the agent, mid-task, re-examining ONE user message under a fact your first read clashed with. The next user message carries your situation in three tagged sections:
<current_task> — what you are working on, including the roster of delegated branches currently running (each with its id and task).
<dedupe_conflict> — the fact your first read missed: the thing the user's message names is ALREADY being worked on by one of those branches.
<new_message> — the message itself.

Ask the only question that matters here: WHO asks to ADD work that is ALREADY RUNNING? Almost nobody. When a message names something already in flight, the overwhelmingly likely intent is to STOP it, PAUSE it, or say it is no longer wanted — however it is worded. 「停掉X这一调研」「去掉X的调研」「我说不需要X的」「暂停X」「X就不调研了」 are all that ONE intent. The burden of proof is INVERTED from a normal classification: treat the message as a removal or pause of the running work UNLESS it clearly asks for something NEW and DIFFERENT on top of what is running (a different platform to add, a different deliverable, an extra scope — such wording names the NEW thing, not the running one).

Decide:
- Removal or pause of the running work — or you cannot honestly read the message as new different work: set "cancels_part": true. If exactly ONE running branch clearly matches what the message removes, ALSO set "stop_branch": {"call_id": "<id copied EXACTLY from the roster>"} — the host pauses that branch the moment you name it; never invent or shorten an id; when two could match, name none and let the removal fold into the result instead of gambling.
- Clearly a request for new, different work that merely collides with a running branch: leave "cancels_part" off — the host will tell the user that work is already running.

When "cancels_part" is true, also write "receipt": one or two short sentences the user sees the moment their remark lands — you speaking mid-work, plain prose, the user's language, no internal jargon (never 支/委派/分类/排队). Say what you understood (name the actual thing) and what happens next (the named work stops leaving the result / the rest carries on). Honesty: describe what WILL happen, never claim it already has.

Return ONLY one JSON object:
{"cancels_part":true,"stop_branch":{"call_id":"<exact id from the roster, or omit>"},"receipt":"<...>","reason":"<one short line>","confidence":<0..1>}`;

export async function recheckCoveredInsertion(
  llm: LLMAdapter,
  context: string,
  conflictNote: string,
  prompt: string,
  signal?: AbortSignal,
  images?: MessageImage[],
  // 12s（2026-10-21 真机三连：8s 恰好掐死冷启动首调——GLM 系强制思考，
  // 全新 system 零缓存，思考起步+provider 冷税叠加出不了 8s；账本实证
  // 主判定→终稿间隙恰 8003ms）。没结论有兜底暂停接着，快败不是灾难。
  timeoutMs = 12_000,
): Promise<CoveredRecheckVerdict | null> {
  if (!prompt.trim() || !conflictNote.trim() || signal?.aborted) return null;
  // 刀 4.1 缓存固化同一纪律：system 逐字稳定，现场（投影/矛盾事实/消息）进
  // user 消息。dedupe_conflict 是顶层块——独立提示词点名词它，模型没有无视
  // 的余地。
  const request: Message[] = [
    { role: 'system', content: RECHECK_COVERED_PROMPT },
    {
      role: 'user',
      content: `<current_task>\n${context.slice(0, 3_200)}\n</current_task>\n\n<dedupe_conflict>\n${conflictNote.slice(0, 800)}\n</dedupe_conflict>\n\n<new_message>\n${prompt.slice(0, 2_000)}\n</new_message>`,
      images,
    },
  ];
  const parsed = await streamUntilParsed<{ cancels_part?: unknown; cancelsPart?: unknown; stop_branch?: unknown; stopBranch?: unknown; receipt?: unknown; reason?: unknown; confidence?: unknown }>(
    llm,
    request,
    signal,
    timeoutMs,
    (raw) => {
      const match = raw.match(/\{[\s\S]*\}/);
      if (!match) return null;
      try {
        const value = JSON.parse(match[0]);
        return value && typeof value === 'object' ? value : null;
      } catch {
        return null;
      }
    },
  );
  if (!parsed) return null;
  // 与主分类同一口径：蛇形为主、驼峰兜底，严格 === true，缺省即 false。
  const cancels = parsed.cancels_part === true || parsed.cancelsPart === true;
  const rawStop = parsed.stop_branch ?? parsed.stopBranch;
  const rawStopId = rawStop && typeof rawStop === 'object'
    ? (rawStop as { call_id?: unknown; callId?: unknown }).call_id ?? (rawStop as { callId?: unknown }).callId
    : undefined;
  return {
    cancelsPart: cancels,
    ...(typeof rawStopId === 'string' && rawStopId.trim() ? { stopBranchCallId: rawStopId.trim() } : {}),
    ...(typeof parsed.receipt === 'string' && parsed.receipt.trim()
      ? { receipt: parsed.receipt.trim().slice(0, 240) }
      : {}),
    reason: typeof parsed.reason === 'string' ? parsed.reason : '',
    confidence: clampConfidence(parsed.confidence),
  };
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
      complexFileThreshold: config?.complexFileThreshold ?? characterDecision().modeThreshold.complexFileThreshold,
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
    return detectProjectRequest(prompt) ? 'build' : complexity === characterDecision().modeThreshold.planAtComplexity ? 'plan' : 'yolo';
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

    // 任务级矛盾（2026-10-14）：「不要改任何文件，但把这个函数里的 bug 修掉」。
    // 这不是名词回指（上面几条要求同一个名词出现两次），而是任务级：两句话各自
    // 都清楚，放一起才不可能——只有读懂「修掉 bug 必然要改文件」才看得出来。
    // 判据刻意收窄在前半句是整类封禁（任何/所有/整个 + 文件/代码/项目），否则
    // 「不要改配置，但把 README 补上」这类正常分工会被误报；命中只代表「先验证
    // 前提」，不代表请求一定不可能。
    const forbidWholeClass = /(?:不要|不能|别|禁止|不允许|不许)\s*(?:改|修改|动|碰|编辑|变更|写)\s*(?:任何|所有|全部|一切|整[个套])?\s*(?:的)?\s*(?:文件|代码|源码|代码库|项目|仓库|工程)/.test(prompt);
    const laterAsksChange = /(?:但|却|同时|又要|还得|另外|顺便)[^。；]{0,24}(?:修|改|加|删|换|补|重构|实现|去掉|移除|替换|加上|统一)/.test(prompt);
    if (forbidWholeClass && laterAsksChange) {
      add('self-contradiction', 'The request forbids touching any file/code and then asks for a change that cannot be made without touching them — both cannot hold as stated; say so and settle what the boundary really is.');
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
    if (!cnQuestion) {
      // 规划/设计 + 交付物名词 → 多步复杂。但「设计一个应用的图标」要的是
      // 那张图，不是那个应用——单资产所属结构不算复杂；「…图标管理系统」
      // 这类资产词后面跟着真实构造词的仍是复杂。
      const designScope = /(?:规划|设计)\s*(?:一个|一套|个|套|一下|一番)?\s*(?:工程|项目|系统|网站|应用|平台|框架|架构|方案|模块|功能|页面|界面)/gi;
      designScope.lastIndex = 0;
      let dm: RegExpExecArray | null;
      while ((dm = designScope.exec(prompt)) !== null) {
        const after = prompt.slice(dm.index + dm[0].length, dm.index + dm[0].length + 16);
        if (!ASSET_DELIVERABLE_AFTER.test(after) || ASSET_AFTER_CONSTRUCTION.test(after)) return 'complex';
      }
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
  // 破坏性说法（高危档）。2026-09-20 扩展：口语化的「删了 / 删掉」、清空、重置、
  // 覆盖此前完全不在底线里——拼对也拦不住，比错字更糟（错字至少还能靠别名表展开
  // 补上）。三个负向断言是刻意的，它们把同一个词在工程语境里的良性用法挡在外面：
  // 清空输入框（UI 行为）、重置密码 / 重置按钮（功能需求）、覆盖率 / 覆盖测试（不是
  // 覆写）。误判的代价不只是一次确认：CLI 会把整轮的自动批准关掉
  // （cliRepl.ts 的 applyCliIntentPermission），所以这条底线宁窄勿宽——宁可漏掉
  // 一个含糊说法，也不把日常请求拉进高危通道。
  // 2026-10-14 再收窄一档：问「怎么做」不是「让你动手做」。以前只挡住紧跟在
  // 「重置」后面的名词（重置密码），「你帮我看下如何重置」「怎么才能清空缓存」这类
  // 求助句里的破坏词仍算高危——代价不是多问一句，而是确认卡把一句提问读成了删除
  // 指令（卡片上还写着「我判断这是一次删除请求」）。判据分强弱两档：方式/可行性
  // 疑问（如何、怎么、为什么…）本身就是求一段说明，直接豁免。这里刻意只豁免
  // 「问方法 / 问原因」：句末的「可以吗 / 好吗」（"删除整个项目的文件，可以吗？"）
  // 是在征求执行的许可，不是问怎么做，仍然留在高危通道上（保住那条既有判例：
  // 破坏性措辞一律交给语义路由/确认通道，本地不自己拍低）。
  const mannerQuestion = /(?:如何|怎么|怎样|咋(?:办|样)|为什么|求(?:教|助)|请教|请问|该怎么|要怎么做|能否|能不能|可不可以|how\s+(?:do|can|should|to|would)|why|can\s+i|could\s+i|should\s+i|what'?s\s+the\s+way)/i.test(lower);
  const askingHow = mannerQuestion;
  const destructiveHit = /(?:删除|移除|清理|清空(?!输入框)|清掉|抹掉|销毁|重置(?!密码|按钮|表单|输入|选项|筛选)|覆盖(?!率|测试|范围|报告|度|统计|场景)|删(?:了|掉)|删库|删表|清库|清表|不可逆|drop\s+(?:table|database)|destroy|rm\s+-rf|reset\s+--hard|force\s+push|delete\s+(?:all|the|entire)|remove\s+(?:all|the|entire))/i.exec(lower)?.[0];
  const destructive = Boolean(destructiveHit) && !askingHow;
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
  // impact 是被卡片直接展示给用户的那句话（见 ui/assessmentFlow.ts）——它要讲清
  // 「这次请求会动到什么」，而不是给请求贴一个类别。带上命中的那个词，用户才看
  // 得出判断是怎么来的。
  const impact = chinese
    ? (destructive
      ? `请求里有「${destructiveHit}」这类动作：它会删掉或覆盖现有的数据、配置或文件，往往不可恢复，所以先把会动到的对象列清楚。`
      : riskLevel === 'medium'
        ? '改动可能波及现有模块、依赖关系或行为，先读取真实结构再决定改动。'
        : '不根据关键词假定任务类型；由语义路由结合完整请求决定处理方式。')
    : (destructive
      ? `The request contains "${destructiveHit}", which deletes or overwrites existing data, config, or files and usually cannot be undone — so list what it would touch first.`
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

// ── Single-asset possessive guard ─────────────────────────────────────────
// "给我生成一个桌面端应用的图标" asks for an ICON, not an app — the noun the
// build regexes match (应用) is only a possessive modifier of the real
// deliverable. Routing that through the project/artifact pipeline turned a
// "draw one thing and show it" request into a multi-step engineering plan
// with test scaffolding. The guard below recognizes 〈deliverable-noun〉 +
// 的(+short filler)+〈asset word〉 and lets such matches go: the deliverable
// is the asset. An asset word immediately heading a real construction
// (图标库 / 图标管理系统 / icon manager) does NOT count — that is a build
// whose topic happens to be assets.
const ASSET_NOUN_SRC = '图标|标志|头像|封面|配图|插画|插图|壁纸|横幅|海报|吉祥物|徽章|表情包|贴纸|启动图|开屏图|设计图|原型图|草图|线框图|示意图|效果图|截图|名字|名称|标题|标语|口号|文案|icons?|logos?|avatars?|covers?|banners?|posters?|badges?|stickers?|illustrations?|wallpapers?|mascots?|splash|screenshots?|taglines?|slogans?|wireframes?|mockups?';
const CONSTRUCTION_SRC = '工具|编辑器|生成器|管理器|管理|库|系统|平台|商店|市场|插件|引擎|manager|tools?|editors?|generators?|library|store|plugins?';
/** An asset word that is NOT heading a construction noun. */
const ASSET_NOT_CONSTRUCTION = `(?:${ASSET_NOUN_SRC})(?![a-z])(?![-\\s的]{0,2}?(?:${CONSTRUCTION_SRC}))`;
/** Directly after a matched deliverable noun: 的(+≤4 filler chars)+asset —
 * the matched noun was a modifier; the asset is the real deliverable. */
const ASSET_DELIVERABLE_AFTER = new RegExp(`^\\s*(?:的)?\\s*[^，。；、,.!?？：:]{0,4}?${ASSET_NOT_CONSTRUCTION}`, 'i');
/** …unless that asset itself heads a construction (图标管理系统) — the build
 * is real after all. */
const ASSET_AFTER_CONSTRUCTION = new RegExp(`^\\s*(?:的)?\\s*[^，。；、,.!?？：:]{0,4}?(?:${ASSET_NOUN_SRC})(?![a-z])[-\\s的]{0,2}?(?:${CONSTRUCTION_SRC})`, 'i');

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
  // stays a writing task instead of a build; a lone asset word in the run
  // ("generate an icon for my desktop app") is rejected the same way — the
  // asset is the deliverable. The lookahead after the noun still excludes
  // "项目的技术方案/说明文档" style doc requests.
  const creation = new RegExp(
    '(?:请|帮我|麻烦你|给我)?\\s*(?:创建|建立|搭建|构建|开发|制作|做|实现|编写|写|生成|create|build|scaffold|develop|make|implement)\\s*'
    + '(?:(?:一个|一套|个|整套|整个|完整的|全栈的|大型的|多文件的|多模块的|a|an|the)\\s*)?'
    + `(?![^，。；、,.!?？：:]{0,32}(?:介绍|说明|文档|方案|总结|报告|教程|README|计划|清单|笔记|心得|简介|描述|演示|思路|${ASSET_NOT_CONSTRUCTION}))`
    + '[^，。；、,.!?？：:]{0,32}?'
    + '(?:项目|工程|平台|系统|应用|程序|网站|大屏|dashboard|project|application|app|website|site|system|platform)'
    + '(?!\\s*(?:的)?\\s*(?:(?:技术|开发|产品|实施)\\s*)?(?:总结|方案|文档|介绍|报告|说明|计划|清单|列表|简介|笔记|教程|plan|documentation|document|docs|summary|report|spec|tutorial))',
    'gi',
  );
  const scope = p.slice(0, 140);
  creation.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = creation.exec(scope)) !== null) {
    const after = scope.slice(m.index + m[0].length, m.index + m[0].length + 16);
    // Possessive asset ("…应用的图标/logo/名字"): the matched noun was only a
    // modifier — unless the asset itself heads a construction ("应用的图标
    // 管理系统" is a real build). Keep scanning: a later clause may still
    // hold a genuine project ("…的图标，另外帮我开发一个管理系统").
    if (!ASSET_DELIVERABLE_AFTER.test(after) || ASSET_AFTER_CONSTRUCTION.test(after)) return true;
  }
  return false;
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
    /(?:小?游戏|网页|网站|页面|主页|首页|工具|脚本|程序|小程序|应用|app|工程|项目|组件|动画|演示|原型|demo|prototype|html\s*页面|web\s*app|web\s*page|mini[- ]?game|game|tool|script|app|project|prototype)/gi;

  // Only look at the first ~40 chars — the artifact clause is almost always at
  // the front of the request ("帮我写一个连连看小游戏，要求…").
  const head = p.slice(0, 40);
  if (!buildVerb.test(head)) return false;
  artifact.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = artifact.exec(head)) !== null) {
    // "设计一个网站的logo / 做一个应用的启动图标" — a single visual asset OF
    // the matched noun is the deliverable, not a runnable artifact (an asset
    // heading a construction — 图标管理系统 — still counts as a build).
    const after = head.slice(m.index + m[0].length, m.index + m[0].length + 16);
    if (!ASSET_DELIVERABLE_AFTER.test(after) || ASSET_AFTER_CONSTRUCTION.test(after)) return true;
  }
  return false;
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
export function parsePlanJson(text: string, register?: WorkOrderRegister): Plan | null {
  return parsePlanJsonCore(text, register).plan;
}

/**
 * Like parsePlanJson, but also reports whether the plan JSON was repaired.
 * Repaired step text is a reconstruction of the model's broken output — it may
 * be shown to the user for approval, but must NOT be re-injected into the LLM
 * context window as "the approved plan" (see chat.ts's plan gate).
 *
 * 刀 6 分量判读：`register` 是本回合的分量档位（宿主判定后穿参进来——参数
 * 而非全局，多会话并发时各自的回合各带各的档位）。production 缺省 = 现行为
 * 逐字节不变；draft/spike 把步骤/子步/验证三个 slice 收进档位表（只轻不重）。
 */
export function parsePlanJsonWithMeta(text: string, register?: WorkOrderRegister): PlanParseResult {
  return parsePlanJsonCore(text, register);
}

function normalizePlanSubsteps(raw: unknown, cap: number): NonNullable<PlanStep['substeps']> {
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
  }).slice(0, cap);
  return substeps;
}

/** 刀 1.1：归一化模型声明的验证清单。只留带非空 command 的项（坏项丢弃
 *  而非整体作废——一条写坏不该陪葬整份清单），reason/final 按声明保留。
 *  白名单把关不在这里：那是宿主门禁的职责（delivery.resolveGateSpecs），
 *  解析层只负责把声明如实带出来。 */
function normalizePlanVerification(raw: unknown, cap: number): PlanVerificationSpec[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((item): PlanVerificationSpec[] => {
    if (!item || typeof item !== 'object') return [];
    const value = item as { command?: unknown; reason?: unknown; final?: unknown };
    const command = typeof value.command === 'string' ? value.command.trim() : '';
    if (!command) return [];
    return [value.final === true
      ? { command, reason: typeof value.reason === 'string' ? value.reason.trim() : '', final: true }
      : { command, reason: typeof value.reason === 'string' ? value.reason.trim() : '' }];
  }).slice(0, cap);
}

function parsePlanJsonCore(text: string, register: WorkOrderRegister = 'production'): PlanParseResult {
  // 刀 6：production 走现值原样（registerScaledDecision 恒等复制），draft/spike
  // 收进档位表——三个 slice 消费同一份 caps，判定器与缩放器之间没有第二处映射。
  const caps: RegisterScaledCaps = registerScaledDecision(activeCharacterProfile(), register);
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
    const normalizedSubsteps = normalizePlanSubsteps(step.substeps, caps.maxPlanSubsteps);
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
  // prompt with dozens of micro-steps (the prompt asks for 4-8). 刀 6：cap 从
  // 档位 caps 读——production 与原值相同，draft/spike 收进各自档位表。
  const capped = steps.slice(0, caps.maxPlanSteps);
  // Re-index ids after the cap (parsePlanJson assigned sequential ids above).
  const indexed = capped.map((s, i) => ({ ...s, id: String(i + 1) }));

  // 刀 1.1：验证清单只在对象形态下存在（纯数组形态无处挂它），如实归一化
  // 后随计划带出；空清单不占字段。
  const rawVerification: unknown = Array.isArray(parsed) ? undefined : (parsed as { verification?: unknown }).verification;
  const verification = normalizePlanVerification(rawVerification, caps.maxVerificationItems);

  return {
    plan: {
      steps: indexed,
      reasoning: `The task has been broken into ${indexed.length} concrete steps, each with a defined outcome.`,
      verification: verification.length > 0 ? verification : undefined,
    },
    repaired,
  };
}
