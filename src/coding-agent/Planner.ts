// src/coding-agent/Planner.ts
// v0.1 — Analyzes tasks: determines complexity, optionally generates a plan.
// v0.2 — Logical-trap detection: scans the prompt for self-contradictory /
//        impossible / mutually-exclusive / trick-framed premises so the agent
//        can verify them before execution and escape the trap by switching
//        approach after a failed round instead of repeating the same one.

import type { AnalysisResult, IntentAssessment, RequestIntent, SemanticRouteDecision, TaskComplexity, TaskMode, Plan, PlanStep, TrapWarning } from './types';
import type { LLMAdapter, Message, MessageImage } from '../shared/types';
import { repairJsonSource } from '../shared/parseRepair';

/** Upper bound on LLM-plan steps kept in the review card / system prompt. */
const MAX_PLAN_STEPS = 10;
const MAX_PLAN_SUBSTEPS = 8;

export interface PlannerConfig {
  /** Threshold for explicit, concrete file-operation evidence. */
  complexFileThreshold?: number;
}

const SEMANTIC_ROUTE_PROMPT = `You are the routing layer for a coding assistant. Understand the user's complete message semantically; do not classify from isolated words or a fixed keyword list. Decide what outcome the user is asking for: answer/explanation, research, advice, debugging, a small change, a broad refactor/migration, or creation of a runnable artifact. Distinguish feedback about an existing result from a request to create a new result. A clear creative request is not a reasonableness review merely because it is large, has several variants, or contains style constraints.

Return ONLY one JSON object with this shape:
{"intent":"question|research|add|modify|debug|refactor|migrate|delete|build","complexity":"simple|complex","mode":"yolo|plan|build","requiresPlan":false,"needsDeliveryGate":false,"assessment":{"riskLevel":"low|medium|high","reversibility":"reversible|partially-reversible|hard-to-reverse|irreversible","impact":"...","recommendation":"...","requiresProbe":false,"requiresConfirmation":false}}

Use plan/build only when the user's actual outcome benefits from ordered execution or a runnable multi-file deliverable. Do not use them for ordinary advice, critique, explanation, or research. Set needsDeliveryGate only when the user wants files/project output that needs workspace-level delivery verification. Set requiresConfirmation only for an explicit destructive/irreversible action or a concrete safety boundary. Keep impact and recommendation concise and in the user's language. If uncertain between advice and implementation, choose the conversational path and let the assistant explain options rather than modifying files.`;

/** Action words that make even a very short message a concrete work request
 * ("写个游戏", "改一下", "查查报错") — those still need the semantic router.
 * Short acknowledgements/pleasantries carry none of them and can use the
 * synchronous heuristic floor directly, avoiding a full LLM round-trip (and
 * up to 12s of added latency) for messages that cannot meaningfully need
 * routing. */
const ROUTE_REQUIRING_ACTION = /(?:写|做|改|建|修|查|删|创建|制作|开发|实现|生成|设计|部署|研究|分析|解释|介绍|评估|汇总|检查|调试|编译|运行|测试|安装|下载|上传|重构|迁移|优化|升级|替换|增加|添加|移除|删除|搞|整|弄|build|create|write|make|fix|add|delete|remove|refactor|migrate|debug|analyze|explain|design|generate|install|test|run)/i;

export function shouldBypassSemanticRoute(prompt: string, images?: MessageImage[] | null): boolean {
  if (images?.length) return false;
  const text = prompt.trim();
  if (text.length > 12) return false;
  if (/[?？]/.test(text)) return false;
  return !ROUTE_REQUIRING_ACTION.test(text);
}

export async function inferSemanticRoute(
  llm: LLMAdapter,
  prompt: string,
  signal?: AbortSignal,
  images?: MessageImage[],
  timeoutMs = 12_000,
): Promise<SemanticRouteDecision | null> {
  if (!prompt.trim() || signal?.aborted) return null;
  const controller = new AbortController();
  const forwardAbort = (): void => controller.abort();
  signal?.addEventListener('abort', forwardAbort, { once: true });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const request: Message[] = [
      { role: 'system', content: SEMANTIC_ROUTE_PROMPT },
      { role: 'user', content: prompt, images },
    ];
    const response = await Promise.race([
      llm.complete(request, [], controller.signal),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(new Error('semantic route timeout'));
        }, timeoutMs);
      }),
    ]);
    return parseSemanticRoute(String(response.content ?? ''));
  } catch {
    return null;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    signal?.removeEventListener('abort', forwardAbort);
    controller.abort();
  }
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
  return {
    intent,
    complexity,
    mode,
    requiresPlan: value.requiresPlan === true,
    needsDeliveryGate: value.needsDeliveryGate === true,
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
  private detectMode(_prompt: string, complexity: TaskComplexity): TaskMode {
    return complexity === 'complex' ? 'plan' : 'yolo';
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

    // Scope indicators
    const scopeIndicators = [
      /multiple\s+files/i,
      /several\s+(files|modules|components)/i,
      /whole\s+(project|app|system)/i,
      /from\s+scratch/i,
    ];

    if (scopeIndicators.some(p => p.test(lower))) {
      return 'complex';
    }

    // Ordinary creation, advice, critique, research, and domain language are
    // deliberately not classified here. The shared semantic router handles
    // those from the complete request; this fallback stays direct rather than
    // turning a noun such as “项目/网页/原型” into a plan by itself.
    return 'simple';

    // ── Chinese project-scale requests ──
    // Any imperative request to create a project is a multi-step build, even
    // when the user does not add words such as "完整" or "大型". A project is
    // not equivalent to a one-file artifact: it needs structure, implementation
    // phases, and verification before the agent should touch the workspace.
    if (detectProjectRequest(prompt)) {
      return 'complex';
    }

    // A multi-phase build needs ALL THREE elements in one clause: an
    // imperative build verb + a scale word + a project noun ("制作一个大型工
    // 程", "搭建完整的全栈项目"). Requiring the scale word kills the old
    // false positives where a bare verb + noun matched ("写个项目方案", "做个
    // 系统介绍") — those are small or documentation requests. The project noun
    // must NOT be a document object: when a doc word (方案/总结/文档/介绍/报
    // 告…) follows it, the request is producing paperwork, not a system.
    // Questions stay simple too: both leading question prefixes ("如何/怎
    // 么…", "请帮我看看…") AND question words anywhere in the prompt ("…怎么
    // 设计？") mean the user is ASKING about a large system, not building one.
    if (!cnQuestion) {
      // Document nouns — when one follows the matched project noun (possibly
      // via 的/技术/开发/测试…, "项目的技术方案", "工程的开发文档"), the
      // "build" is really a documentation task and stays simple.
      const cnDoc = '(?:方案|总结|文档|介绍|报告|说明|计划|清单|列表|简介|笔记|心得|草案|书|表|设计稿|规划|大纲|教程)';
      const docExclusion = `(?!\\s*(?:的)?\\s*[^，。！？;；\\n]{0,4}?${cnDoc})`;
      const cnBuild = new RegExp(
        `(?:编写|写|做|开发|制作|创建|搭建|实现|构建|设计|生成|部署|重构|重写|迁移|规划)` +
        `\\s*(?:一个|一套|个|套)?\\s*` +
        `(?:(?:大型|完整|全栈|复杂|多文件|整个|从零|从头|多模块|整套|一站式)(?:的)?\\s*){1,3}` +
        `(?:工程|项目|系统|网站|应用|平台|框架|架构|小程序|脚手架|软件|服务)` +
        docExclusion
      );
      if (cnBuild.test(trimmed)) {
        return 'complex';
      }
      // Scale word + project noun as a fused phrase ("全栈项目", "多模块系
      // 统") — but only when a build verb appears somewhere in the request, so
      // consultations ("全栈项目的技术选型") don't trigger a plan dialog.
      const cnScope = new RegExp(
        `(?:大型|完整|全栈|复杂|多文件|多模块|整套|一站式)\\s*的?\\s*` +
        `(?:工程|项目|系统|网站|应用|平台|框架|架构|小程序|脚手架|软件|服务)` +
        docExclusion
      );
      if (/(?:编写|写|做|开发|制作|创建|搭建|实现|构建|设计|生成|部署|重构|重写|迁移)/.test(trimmed) && cnScope.test(trimmed)) {
        return 'complex';
      }
      // From-scratch idioms embed their own build intent ("从零开始做一个项
      // 目", "从头搭建一个网站") — the noun is still required so "从零开始学
      // 习" stays simple, and the same doc-exclusion applies ("从零搭建一个网
      // 站的教程" is a doc request, not a build).
      if (new RegExp(
        `(?:从零|从头)\\s*(?:开始)?\\s*(?:做一个?|搭建一个?|构建一个?|开发一个?|实现一个?|写一个?|重写一个?|重构一个?)\\s*(?:工程|项目|系统|网站|应用|平台|框架|架构|小程序|脚手架|软件|服务)` +
        docExclusion
      ).test(trimmed)) {
        return 'complex';
      }
    }

    return 'simple';
  }

  private generatePlan(prompt: string, mode: TaskMode): Plan {
    // Minimal fallback only. Task-specific decomposition, step count, and Todo
    // granularity belong to the LLM analysis; this keeps the UI usable when
    // that analysis is unavailable without prescribing a workflow.
    //
    // A genuine from-scratch build (creating a NEW project/artifact — NOT a
    // refactor/rewrite/migration of an existing codebase) follows the natural
    // build arc: understand the need, scaffold, implement module by module,
    // integrate and verify, deliver. A brand-new requirement must never read as
    // an edit of existing code ("确认范围/完成改动/验证结果"). Positive
    // creation signals gate this so a rebuild request ("重构整个项目") or a
    // trailing question ("…怎么做性能优化？") keeps the generic template.
    const isFreshBuild = mode === 'build'
      && /(?:创建|搭建|制作|开发|实现|构建|生成|新建|从零|从头|新建一个|构建一个|开发一个|生成一个|写一个|做一个|create|build|make|develop|implement|construct|generate|set up|scaffold|from scratch)/i.test(prompt);
    if (isFreshBuild) {
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
            action: '搭建项目骨架',
            description: '确定技术栈与目录结构，建立可运行的起点。',
            expectedOutcome: '项目可启动，结构清晰。',
          },
          {
            id: '3',
            action: '分模块实现核心功能',
            description: '按功能拆分逐块实现，每完成一块保持可运行。',
            expectedOutcome: '核心功能逐一落地。',
          },
          {
            id: '4',
            action: '联调集成与验证',
            description: '把模块连起来运行真实场景，检查关键流程是否可用。',
            expectedOutcome: '整体可用，关键路径验证通过。',
          },
          {
            id: '5',
            action: '收尾与交付',
            description: '补齐必要说明，指出仍存在的限制。',
            expectedOutcome: '交付物完整，使用方式清楚。',
          },
        ],
        reasoning: '这是从零构建的任务：先理解清楚要做什么，再搭骨架、逐模块实现，最后联调验证，保证结果可用。',
      };
    }

    return {
      steps: [
        {
          id: '1',
          action: '确认范围',
          description: '查看与请求直接相关的内容，确认目标和约束。',
          expectedOutcome: '改动范围和关键未知点清楚。',
        },
        {
          id: '2',
          action: '完成改动',
          description: '根据已确认的范围选择合适的实现方式。',
          expectedOutcome: '请求中的核心结果已经实现。',
        },
        {
          id: '3',
          action: '验证结果',
          description: '根据实际风险运行相关检查，并说明仍存在的限制。',
          expectedOutcome: '有真实证据支持交付或继续处理。',
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
 * Provide a conservative safety floor before semantic routing is available.
 * This function intentionally does NOT decide whether ordinary language means
 * advice, research, creation, debugging, or editing. Those are model-semantic
 * decisions. Lexical checks remain only for explicit operations whose safety
 * boundary must not depend on a model being available or correct.
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
        ? '可能波及现有模块、依赖关系或行为，先读取真实结构再决定改动。'
        : '尚未根据关键词假定任务类型；由语义路由结合完整请求决定处理方式。')
    : (destructive
      ? 'This may delete or overwrite existing data, files, or history; confirm the blast radius first.'
      : riskLevel === 'medium'
        ? 'This may affect existing modules, dependencies, or behavior; inspect the real structure before changing it.'
        : 'No ordinary task type is inferred from keywords; semantic routing will use the complete request.');
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
    || /(?:怎么|如何|怎样|吗|呢|what|how)\s*(?:创建|搭建|开发|做|build|create|scaffold|develop)/i.test(p);
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
  return `\n\n<artifact_output_rule>\nThis request asks you to BUILD a complete runnable artifact (a game, web page, app, tool, script, or small project). Write it to a file on disk — do NOT dump the full source code in your reply.\n- Single-file artifact (HTML page, single JS/CSS file, small script): write it as a new file in the workspace, e.g. index.html, game.html, app.py, or a sensible name derived from the request.\n- Multi-file project: create a directory and write the files into it (entry point + assets), e.g. ./mini-game/index.html.\nAfter writing, briefly tell the user the file path(s) and how to run/open the artifact (e.g. open the HTML in a browser). If no workspace is configured, say so and ask for one instead of printing the code.\n</artifact_output_rule>`;
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
