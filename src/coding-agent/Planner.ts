// src/coding-agent/Planner.ts
// 预判层退役后（2026-11-06）这个文件只做三件事——插话判定的三段 prompt/解析
// （classifyInsertion / resolveStopBranchTarget / recheckCoveredInsertion，共用
// streamUntilParsed）、破坏词安全网（assessIntent，只服务内部判定不塑形主请求）、
// 计划卡的占位骨架与计划 JSON 解析（generatePlan / parsePlanJson）。
// 曾经住在这里的语义路由（SEMANTIC_ROUTE_PROMPT / inferSemanticRoute /
// parseSemanticRoute / routeHistoryMessages）随预判层整体退役（2026-11-06）：
// 更早的 keyword floor（复杂度/陷阱/虚构/项目形态/寒暄直通判定）在框架改革
// 一期已删除——理解用户始终是模型的事，宿主不再用词表猜，也不再雇预判。

import type { AnalysisResult, IntentAssessment, RequestIntent, TaskMode, Plan, PlanStep, PlanVerificationSpec } from './types';
import type { LLMAdapter, Message, MessageImage } from '../shared/types';
import { repairJsonSource } from '../shared/parseRepair';
import { activeCharacterProfile, registerScaledDecision, type RegisterScaledCaps, type WorkOrderRegister } from '../character';
// Shared confidence vocabulary + gate. One-way dependency (inputDecision knows
// nothing about Planner) so the insertion classifiers can be judged by the same
// threshold without a cycle.
import { clampConfidence, inputDefaultConfidence } from './inputDecision';

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
  parseEarly?: (text: string) => T | null,
): Promise<T | null> {
  const controller = new AbortController();
  // caller abort（用户停轮）：无 early 在途时判定也一并放手，别让 race 干等超时线。
  let deliveredEarly = false;
  // settle 挂在对象属性上：裸 let 在同步执行的 IIFE 闭包里被 TS 收窄成 null→
  // never（赋值发生在闭包创建之后），属性收窄不跨闭包，optional call 合法。
  const sink: { resolve?: (v: T | null) => void } = {};
  const settle = (v: T | null): void => { sink.resolve?.(v); };
  const forwardAbort = (): void => {
    controller.abort();
    if (!deliveredEarly) settle(null);
  };
  signal?.addEventListener('abort', forwardAbort, { once: true });
  // 判定一落地（完整版 / early 版 / 流尽无判定）都从这里出来，外层不必等流收尾。
  const settled = new Promise<T | null>((resolve) => { sink.resolve = resolve; });
  let timer: ReturnType<typeof setTimeout> | undefined;
  const stopTimer = (): void => { if (timer !== undefined) { clearTimeout(timer); timer = undefined; } };

  const drain = (async (): Promise<void> => {
    let text = '';
    let early: T | null = null;
    try {
      for await (const chunk of llm.stream(request, [], controller.signal)) {
        if (chunk.type === 'content' && chunk.content) {
          text += chunk.content;
        } else if (chunk.type === 'done' && chunk.content && chunk.content.length > text.length) {
          // Adapters that only deliver the full text on the terminal chunk.
          text = chunk.content;
        }
        if (!text) continue;
        const full = parse(text);
        if (full) {
          // early 在手时完整版补进同一对象（散文/subagents/confidence 齐装），
          // full 字段优先覆盖 early 的同名字段。
          if (early !== null) Object.assign(early as object, full as object);
          stopTimer();
          controller.abort();
          settle?.(early ?? full);
          return;
        }
        if (early === null && parseEarly) {
          const candidate = parseEarly(text);
          if (candidate) {
            early = candidate;
            deliveredEarly = true;
            stopTimer();          // 超时线只守「判定未出」的阶段；散文尾巴不占它
            settle?.(candidate);  // 外层即刻走人，drain 自己把尾巴收完
          }
        }
      }
      if (early === null && text) {
        const tail = parse(text);
        if (tail) { stopTimer(); settle?.(tail); return; }
      }
      if (early === null && settle) settle(null);  // 流尽而无判定：外层不必干等超时线（现状同此）
    } catch {
      /* abort 后的流错误静默：判定若已在手，settle 早已发生 */
    }
  })();

  try {
    return await Promise.race([
      settled,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(new Error('classification timed out'));
        }, timeoutMs);
      }),
    ]);
  } catch {
    /* aborted (timeout / caller) — a parse that already landed still counts */
    return null;
  } finally {
    stopTimer();
    signal?.removeEventListener('abort', forwardAbort);
    // Stop upstream generation once the decision is in hand (or on any exit)
    // so the provider does not keep billing a response we will discard.
    // early 已交付时例外：流尾散文还在后台 drain，掐流会把它掐死。
    if (!deliveredEarly) controller.abort();
    void drain.catch(() => {});  // 后台 drain 永不炸出 unhandled rejection
  }
}

/** 三值判定（2026-10-28 并线/另线改版，docs/interjection-inline-sideline.md
 *  §一 细化 2）：宿主不再替模型细分九类 relation——原话全文会到主线模型面前，
 *  转向/追加/纠正/强调/停的多意图由它自行消化。判定只回答「这句插话走哪条线」：
 *  - inline   并线：与当前任务相关（转向/追加/纠正/强调/点名某支/停），原话
 *             直投注入流；
 *  - sideline 另线旁答：与任务无关且简报内可即时答（几点了/寒暄/称呼），零
 *             工具快答，答案回注主流；
 *  - new_task 排队新轮：与任务无关但需要能力或多轮（查天气/再写个脚本），
 *             当前回合收尾后开新轮消化。
 *
 *  旧九类 relation（supplement/change/emphasize/unrelated/correction/question/
 *  mixed/meta/misunderstanding）与更旧的七类 kind 就此退役。宿主保留的唯一
 *  机械动作是 stop 掐流（引擎手脚：abortController，不是语义决策）；停支
 *  （stop_branch）/续支（resumes_branch）的裁决器三分与 call_id 机制保留。
 *  置信偏置（细化 5）：低置信一律 inline——宁可打扰不丢话；判定失败/缺席
 *  不再猜，原话直投（passthroughVerdict）——话绝不丢（不变量 §六.1）。 */
export type InsertionVerdict = 'inline' | 'sideline' | 'new_task';

export const INSERTION_VERDICTS: readonly InsertionVerdict[] = ['inline', 'sideline', 'new_task'];

/** 点名支 id 的统一抽取：蛇形 {call_id} 为主、驼峰 {callId} 兜底，id 非空
 *  字符串才收——残缺对象宁可当没点名，绝不拿半截 id 去停/去续/去答「不重复」。 */
function callIdOf(raw: unknown): string | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const id = (raw as { call_id?: unknown; callId?: unknown }).call_id ?? (raw as { callId?: unknown }).callId;
  return typeof id === 'string' && id.trim() ? id.trim() : undefined;
}


/** 判定上下文三要素（蓝图 §5.0，2026-10-27 用户强调「软暂停后开始思考关系」）：
 *  同一句「预算改成 50 万」在「还没用到预算」和「已基于旧预算产出」两种情况
 *  下无法区分——判定输入必须三要素齐备。宿主（chat.ts buildInsertionContext）
 *  产出本 payload；本侧只定义接口与渲染，judge 提示词按三要素消费。rule/net
 *  通道不依赖此 payload。 */
export interface LiveContextPayload {
  /** ① 用户上一句原话：当前任务的目标原点。原样保留，不得摘要掉关键条件。 */
  lastUserMessage: string;
  /** ② 当前输出脉络：正在生成/执行的内容到哪了——最近几个 THINK 段的实质
   *  进展 + 当前批次在做什么。忠实脉络，不是 token 级全文。 */
  outputGist: string;
  /** ③ 任务状态投影：taskState snapshot 的轻量投影（running/pending 节点、
   *  依附约束、最近副作用）——「依据什么条件在做」。 */
  taskStateProjection: string;
}

/** 三要素渲染成 judge user 消息里 <current_task> 块的内层小节。宿主也可以
 *  自行拼装等价文本；这个渲染器只是把三要素的呈现形状固定下来，让提示词里
 *  的小节名（<last_user_message>/<output_gist>/<task_state>）有唯一出处。 */
export function renderLiveContext(payload: LiveContextPayload): string {
  return [
    '<last_user_message>',
    payload.lastUserMessage.trim(),
    '</last_user_message>',
    '',
    '<output_gist>',
    payload.outputGist.trim(),
    '</output_gist>',
    '',
    '<task_state>',
    payload.taskStateProjection.trim(),
    '</task_state>',
  ].join('\n');
}

export interface InsertionClassification {
  /** 三值判定——权威分类面（见 InsertionVerdict）。 */
  verdict: InsertionVerdict;
  reason: string;
  /** The model's OWN confidence in `verdict` (0..1). It is what lets the caller
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
   *  (timeout / network / unparseable / empty input): the coordinator ignores
   *  the verdict entirely and passes the user's words through verbatim
   *  (passthroughVerdict) instead of trusting it as a reading. */
  fallbackUsed?: boolean;
  /** 现场收执（§〇 呈现层契约）：裁决器现场措辞，像人说的一句话，短、点名
   *  具体的事、零客套；缺席/空串=引擎沉默。只有必须即时确认处（整停/停支/
   *  排队新任务）才写——并线默认不出 receipt，主线模型下一轮的自然承接才是
   *  真正的回应。 */
  receipt?: string;
  /** 整树停命令（宿主唯一保留的机械动作，接棒已删的 STOP_RE 快路径）：用户
   *  明确命令整棵树停下时输出 "action":"stop"——宿主据此掐流，不重排不重想。
   *  其余一律缺席（模型不必输出；解析只认严格 === "stop"，其他值当缺席）。 */
  action?: 'stop';
  /** 点名停支（保留成果）：消息停/收掉某支在飞委派时，裁决器从上下文
   *  <live_branches> 花名册指认那支的确切 id，宿主只核实执行——「停哪支」
   *  是理解，理解归模型。指认不出留空，插话照走 inline 由主线消化。 */
  stopBranch?: { callId: string };
  /** 点名续支（保留成果）：用户点名把某一支接着跑完时，从花名册指认该支的
   *  确切 id，宿主核实后按原始参数同参重派（稳定 sessionId 命中断点续跑）。 */
  resumesBranch?: { callId: string };
  /** 插话点名某支（§一 细化 2：inline 可附带 call_id）：范围确认（「调研必须
   *  包括优酷」）/转向/问及某支时，裁决器拿花名册抄回那支的确切 id，宿主只
   *  核实 id 真实性（机械事实零语义）；点不出留空，照旧路由。 */
  branchCallId?: string;
}

const INSERTION_CLASSIFY_PROMPT = `You are the agent, mid-task. The user just said something while you were working. Decide ONE thing: which line does the remark travel on — the line you and the user are already weaving, or a side line of its own? Judge the way a sharp human colleague would: NOT by matching keywords, but by weighing two things together: WHEN it arrived (which phase you are in, from the context) and WHAT it changes about the result you still owe them. A sharp human never drops the remark. Neither may you.

The next user message carries your live situation — read all of it before judging:
<current_task> — your situation woven from three threads. 用户上一句原话: the user's LAST message, the origin the whole task answers to — its exact conditions (place, budget, scope, wording) are the ground truth. 当前输出脉络: where the work-in-progress stands and what the current batch is producing. 任务状态投影: what the work rests on — steps running or pending, the constraints they answer to, recent side effects. The host may render the three threads as separate tagged sections (<last_user_message> / <output_gist> / <task_state>) inside the block; whatever the layout, all three are there. Which line a remark belongs to DEPENDS on these: the same words land differently before vs after the work has already used them.
<live_branches> / <finished_branches> — when present, the delegated branches (running / finished) with id, name, role and task snippet.
<new_message> — what the user just said.

Return ONLY one JSON object:
{"verdict":"inline|sideline|new_task","action":"stop","stop_branch":{"call_id":"<exact id from the roster, or omit>"},"resumes_branch":{"call_id":"<exact id from the roster, or omit>"},"call_id":"<exact id of the branch the remark names, or omit>","reason":"<one short line>","confidence":<0..1>,"receipt":"<a line a human would actually say, or omit>"}

Include a field only when it applies; omit everything else.

The three verdicts (pick exactly one):

- "inline" — the remark belongs to the work you are already making. This is the WIDE bucket, and the whole remark reaches you verbatim on the main line — YOU digest it in your next turn: a turn or overturn ("换成X来做", "推翻重来"), an addition inside or beside the deliverable ("背景上加几朵会动的云", "新增加两位"), a premise that turned out different ("其实我在西安，不是广东", "预算只有三千"), the user fixing their own earlier wording ("哦我前面说错了，不是周三是周四"), a re-weighting ("重点研究X"), a process directive ("先给我看计划再执行", "输出别用表格"), steering a running branch ("优酷那路重点查剧场版"), a question about the work itself ("跑完了吗" — answer it as you work), and the whole-run stop ("先缓一缓" — with "action":"stop", below). Judge a multi-part message as ONE whole ("顺便查下股价，另外预算改成两万"): the most far-reaching part picks the verdict, and you handle the rest naturally when the words reach you — never split it. When the message contradicts itself ("用X。算了还是Y"), the user's LAST explicit statement is the message. And when you are genuinely unsure which line fits, that IS "inline": a doubtful remark must stay on the main line — 宁可打扰，不丢话 (the main line reading costs a moment of attention; the wrong side line loses the words).
- "sideline" — UNRELATED to the task AND answerable on the spot from what you already know: the time ("现在几点了"), small talk, thanks, reactions ("哈哈", "好的", "辛苦了", "+1"), being addressed ("在吗"). The host answers out-of-band with a cheap lookup and both lines keep running. HIGH BAR: only when you are sure it touches nothing in <current_task> AND nothing needs a tool, a lookup, or more than a sentence back — otherwise it is "inline".
- "new_task" — UNRELATED to the task AND it needs real capability or several turns: something must come BACK as work of its own ("顺便查一下北京的天气", "再写一个爬虫脚本", "把这份报告也翻译成英文"). It queues and runs after the current round; nothing is dropped.

"confidence" is how sure you are of the verdict — 0.9+ for an unambiguous remark, ~0.5 when it genuinely reads two ways. Report genuine doubt also when the message touches something irreversible (sending, publishing, deleting, paying, deploying) while staying unclear. A low number never reroutes the remark — it stays "inline"; only a confident verdict may send it to a side line. Never inflate the number: a low one is cheap, a wrong high one is not.

"action": "stop" — set it ONLY when the user's own words command the WHOLE tree to stop: 停/停下/取消/中止/别做了/全部停下/先别做了/stop/cancel, or a soft whole-run stop ("先缓一缓", "够了，先这样", "不用继续了") — the running work ends and NOTHING takes its place. A stop is the user's explicit command, not a reading exercise: output "action":"stop", pick "inline", and say in "reason" what was stopped — the host cuts the stream for you; that is the one mechanical action left to it. Everything else — naming ONE branch to stop or resume, steering, adding — omits "action".

"stop_branch": when the message stops or cancels what ONE delegated branch is doing, copy that branch's id EXACTLY from <live_branches>: {"call_id":"..."}. Never invent or shorten an id; only a live branch can be stopped; when the roster is absent or nothing clearly matches, OMIT the field — the remark still lands "inline" and the removal is digested on the main line.

"resumes_branch": when the user names ONE branch to pick back up and finish ("把竞品那支接着跑完", "让报价那路继续"), copy its id EXACTLY from the roster — the host re-delegates it from where it stopped. OMIT when no roster entry matches; a bare "继续" that names no branch is not this.

"call_id": the remark NAMES a branch for any other reason — scope confirmation ("调研必须包括优酷", "别忘了知乎"), steering, asking about it. Copy the id EXACTLY from the roster (live or finished). The host verifies the id and tells the user 「那路正在跑着，不重复」 when the named thing is already covered. OMIT when no roster entry matches — never guess: a wrong id answers about the WRONG branch.

"receipt": only where the user needs an immediate confirmation — a whole-run stop, a stopped branch, a queued new task. One or two short sentences the user sees the moment their remark lands: plain prose, the user's language, no internal jargon (never 支/委派/分类/排队/转向). Name the actual thing from their words and what will happen next ("好——竞品那路这就停，其余照跑。"); describe what WILL happen, never claim it already has. For a plain "inline" remark OMIT it — your next natural sentence on the main line is the real answer.`;


/**
 * Lightweight single-call routing of a message the user inserts while the
 * agent is mid-run (三值 verdict 契约，§一 细化 2). Mirrors inferSemanticRoute's
 * (signal + timeout + JSON-parse) shape. On any failure, timeout, or parse
 * miss it returns a verdict flagged fallbackUsed — the coordinator never
 * trusts that as a reading: it passes the user's words through verbatim
 * (passthroughVerdict), the one delivery that can never lose the words
 * (2026-09-22 判例：父任务阻塞收委派时没有"下个动作"可兑现，"顺路带上"是
 * 空头承诺).
 */
export async function classifyInsertion(
  llm: LLMAdapter,
  context: string,
  prompt: string,
  signal?: AbortSignal,
  images?: MessageImage[],
  // 插话首响的延迟上界（2026-10-28 体验刀 U1）：掐流重入期间用户盯着字停
  // 半空，判定拖 8s 是死机感，2.5s ≈ 人被打断后的自然停顿上界。插话场景
  // 延迟比判定精度贵——超时跌落 passthrough 原话直投，损失≈0（话本来就
  // 该到主线模型面前）。其余判定调用（覆盖复核/点名停支）不在此路径，超时另议。
  timeoutMs = 2_500,
): Promise<InsertionClassification> {
  // Fallback 是原话直投（inline），不是排队：低置信一律 inline（§一 细化 5）
  // ——宁可打扰不丢话。协调器对 fallbackUsed 的判定不信不猜，统一改走
  // passthroughVerdict 投递。这份兜底只是解析失败时的形态占位。
  const fallback: InsertionClassification = {
    verdict: 'inline',
    reason: 'classification unavailable; the words pass through verbatim so they can never be lost',
    // See inputDefaultConfidence() (inputDecision.ts). This is the parse/timeout
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
  const parsed = await streamUntilParsed<Record<string, unknown>>(
    llm,
    request,
    signal,
    timeoutMs,
    (raw) => {
      const match = raw.match(/\{[\s\S]*\}/);
      if (!match) return null;
      try {
        const value = JSON.parse(match[0]) as { verdict?: unknown };
        // 只有 verdict 合法落在三值名录里才算解析成功——旧九类 relation JSON
        // 与更旧的 seven-kind JSON 一律当没解析出来，走 fallback 原话直投，
        // 绝不拿旧词表冒充判定。
        return value && typeof value.verdict === 'string' && INSERTION_VERDICTS.includes(value.verdict as InsertionVerdict)
          ? value
          : null;
      } catch {
        return null;
      }
    },
  );
  if (parsed && typeof parsed.verdict === 'string' && INSERTION_VERDICTS.includes(parsed.verdict as InsertionVerdict)) {
    const rawConfidence = typeof parsed.confidence === 'number' || typeof parsed.confidence === 'string'
      ? Number(parsed.confidence)
      : NaN;
    // 点名三形（stop_branch / resumes_branch / call_id）：蛇形为主、驼峰兜底，
    // id 非空才收——残缺对象宁可当没点名（宿主退回保守路由/照旧消化），
    // 绝不拿半截 id 去停、去续、去答「不重复」。
    const stopId = callIdOf(parsed.stop_branch ?? parsed.stopBranch);
    const resumesId = callIdOf(parsed.resumes_branch ?? parsed.resumesBranch);
    const rawNamed = parsed.call_id ?? parsed.callId;
    const namedId = typeof rawNamed === 'string' && rawNamed.trim() ? rawNamed.trim() : undefined;
    return {
      verdict: parsed.verdict as InsertionVerdict,
      reason: typeof parsed.reason === 'string' ? parsed.reason : '',
      confidence: clampConfidence(parsed.confidence),
      confidenceDefaulted: !Number.isFinite(rawConfidence),
      // 现场收执：空串/空白视为缺席（缺席 = 引擎沉默，呈现层契约 §〇）。
      ...(typeof parsed.receipt === 'string' && parsed.receipt.trim()
        ? { receipt: parsed.receipt.trim().slice(0, 240) }
        : {}),
      // 整树停命令：严格 === "stop" 才收；其他值一律当缺席（宿主按缺省
      // inline 处置，不掐流）。
      ...(parsed.action === 'stop' ? { action: 'stop' as const } : {}),
      ...(stopId ? { stopBranch: { callId: stopId } } : {}),
      // 点名续支：同 stop_branch 的核实纪律——宿主只认这个 id。
      ...(resumesId ? { resumesBranch: { callId: resumesId } } : {}),
      ...(namedId ? { branchCallId: namedId } : {}),
    };
  }
  return fallback;
}

/** 聚焦点名（模型判断、宿主执行，2026-10-10）：裁决器判了「要停一支」但没
 *  点名/点名存疑时的窄问题补问——只要一个确切 id，指认是理解，归模型。（
 *  2026-10-28 框架改革刀 1：字面快路径 BRANCH_STOP_RE 已删，插话通路收敛为
 *  唯一形态——判定归裁决器分类直出 stop_branch.call_id，宿主只核实执行；
 *  依赖规则快路径喂 kind 的旧调用方式随之退役，本窄问暂无生产调用方，保留
 *  供复核/工具化复用。）任何失败返回 null，调用方退回保守折入。 */
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

ALSO write "receipt" for EVERY verdict that does something to the running work (supplement, emphasize, meta, change, correction, misunderstanding, cancels_part): one or two short sentences the user sees the moment their remark lands — you speaking mid-work, plain prose, the user's language, no internal jargon (never 支/委派/分类/排队/转向). Generic filler like 「收到——活不停，下个动作就带上这句」 is wrong by construction (2026-10-27 用户真机复验): name the actual thing from the user's words and say what happens next (the named work stops leaving the result / the addition rides along with the next step / the rest carries on). Honesty: describe what WILL happen, never claim it already has.

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

export class Planner {
  /** 语义路由不可用时的最后兜底（requestWorkflow.compileRequestWorkflow 的
   *  else 分支）。不再做任何复杂度 / 形态 / 陷阱判定——理解用户是模型的语义
   *  判断，宿主只保留两级破坏词安全网（assessIntent：操作级毁灭→确认卡；
   *  任务级动词→探查推进）。普通任务一律直推；「先读再动」的探查纪律由
   *  workShapedFallback 的 probeRequired 承载，不在这里造计划。 */
  analyzeTask(prompt: string): AnalysisResult {
    return {
      complexity: 'simple',
      mode: 'yolo',
      reasoning: '语义路由不可用：按普通任务直接推进，两级破坏词安全网已过。',
      intent: assessIntent(prompt),
    };
  }

  /**
   * 计划卡占位骨架：真实拆解是主模型的事（计划 JSON / work order），
   * 宿主不再教它「先理解→搭骨架→逐模块→测试→收尾」的固定模板（框架改革
   * 一期：方法论归还模型）。这里只保证计划卡有可渲染的步骤结构。
   */
  generatePlan(_prompt: string, mode: TaskMode): Plan {
    return {
      steps: [
        {
          id: '1',
          action: '明确这次要的结果',
          description: '结合上下文确认目标、约束与已知条件，从最小可验证的一步开始。',
          expectedOutcome: '目标与边界清楚，第一步可执行。',
        },
        {
          id: '2',
          action: '小步推进并持续验证',
          description: '每一步都可运行、可验证，出现偏差就回头调整；收尾如实报告已验证与未验证的部分。',
          expectedOutcome: '结果可靠、可被验证。',
        },
      ],
      reasoning: mode === 'build'
        ? '构建型任务：先搭最小可运行骨架，再逐块实现，随时用真实运行结果校准。'
        : '按小步推进并持续验证。',
    };
  }
}

/**
 * 语义路由不可用时的最后安全网：两级破坏词识别。这不是意图分类——
 * 普通任务一律按「改动任务」直推（framework-reform 一期：宿主不再用词表
 * 猜用户想干什么），只有命中破坏词才抬风险：
 *   操作级毁灭形态（rm -rf / drop database / 删库 / force push / reset --hard）
 *     → 确认卡（2026-09-17 定调「非常危险除外」的唯一例外）；
 *   任务级动词（删除/清理/清空/重置/覆盖…）→ 探查推进：先只读探查列对象，
 *     然后直接动手，不暂停（2026-11-01 用户判例落死：「能清理夏普电视吗」
 *     不再整轮挂起等确认）。
 * 「怎么做」是问方法不是让人动手（askingHow 豁免）；句末「可以吗」仍是
 * 征求执行许可（不豁免）。语义路由可用时本函数不参与判定——结论整体由
 * 路由给出（见 requestWorkflow.buildSemanticAnalysis）。
 */
export function assessIntent(prompt: string): IntentAssessment {
  const text = prompt.trim();
  const lower = text.toLowerCase();
  const chinese = /[\u4e00-\u9fff]/.test(text);
  const askingHow = /(?:如何|怎么|怎样|咋(?:办|样)|为什么|求(?:教|助)|请教|请问|该怎么|要怎么做|能否|能不能|可不可以|how\s+(?:do|can|should|to|would)|why|can\s+i|could\s+i|should\s+i|what'?s\s+the\s+way)/i.test(lower);
  const COMMAND_DESTRUCTIVE_RE = /(?:rm\s+-rf|drop\s+(?:table|database)|删库|清库|删表|清表|reset\s+--hard|force\s+push|delete\s+(?:all|the|entire)|remove\s+(?:all|the|entire)|不可逆)/i;
  const TASK_DESTRUCTIVE_RE = /(?:删除|移除|清理|清空(?!输入框)|清掉|抹掉|销毁|destroy|重置(?!密码|按钮|表单|输入|选项|筛选)|覆盖(?!率|测试|范围|报告|度|统计|场景)|删(?:了|掉))/i;
  const commandHit = COMMAND_DESTRUCTIVE_RE.exec(lower)?.[0];
  const taskHit = TASK_DESTRUCTIVE_RE.exec(lower)?.[0];
  const destructive = Boolean(commandHit || taskHit) && !askingHow;
  const riskLevel: IntentAssessment['riskLevel'] = destructive ? (commandHit ? 'high' : 'medium') : 'low';
  const intent: RequestIntent = destructive ? 'delete' : 'modify';
  const reversibility: IntentAssessment['reversibility'] = destructive
    ? (commandHit ? 'irreversible' : 'hard-to-reverse')
    : 'reversible';
  const requiresProbe = destructive;
  // 确认卡只挂在操作级毁灭上（2026-09-17 定调：默认自动允许，非常危险除外）。
  const requiresConfirmation = destructive && Boolean(commandHit);
  // impact 是被卡片直接展示给用户的那句话（见 ui/assessmentFlow.ts）——它要讲清
  // 「这次请求会动到什么」，而不是给请求贴一个类别。带上命中的那个词，用户才看
  // 得出判断是怎么来的。
  const impact = chinese
    ? (commandHit
      ? `请求里有「${commandHit}」这类毁灭性操作（数据/库/系统级，基本无法恢复）：先把会动到的对象列清楚，等你确认后再动手。`
      : destructive
        ? `请求里有「${taskHit}」这类删除动作：先只读探查、把会动到的对象列出来，然后直接动手，优先用可恢复的方式，不必停下来等确认。`
        : '按普通改动任务直接推进，具体处理方式由模型结合完整请求与上下文决定。')
    : (commandHit
      ? `The request contains "${commandHit}", a system-scale destructive operation that cannot practically be undone — list what it would touch first and wait for approval.`
      : destructive
        ? `The request contains "${taskHit}", which deletes existing data or files: probe read-only, list what it would touch, then proceed directly with a recoverable approach — no confirmation pause.`
        : 'Carried as an ordinary change task; the model decides how to handle it from the complete request.');
  const recommendation = chinese
    ? (commandHit
      ? '先做只读检查并列出受影响对象，给出可恢复或更窄的替代方案，确认后再动手。'
      : destructive
        ? '先只读检查并列出受影响对象，然后继续执行，不要停下来等确认；优先窄范围、可回退的做法。'
        : '直接按对结果最有利的方式推进；如果其实只是建议或解释，直接回答，不要擅自修改文件。')
    : (commandHit
      ? 'Inspect read-only first, list affected targets, propose a recoverable or narrower alternative, then ask for approval.'
      : destructive
        ? 'Inspect read-only, list affected targets, then continue without waiting for approval; prefer narrow, reversible steps.'
        : 'Proceed the way that best serves the requested outcome; if it turns out to be advice or explanation, answer directly instead of editing files.');
  return {
    intent,
    riskLevel,
    reversibility,
    impact,
    recommendation,
    requiresProbe,
    requiresConfirmation,
  };
}

/**
 * Build 请求注入的落盘协议片段（触发判定已归语义路由 needsDeliveryGate /
 * intent=build——宿主不再用形态正则猜）。与 PromptAssembler 装配的同款规则
 * 成对：这里让该指令对这一具体请求显式出现。
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
