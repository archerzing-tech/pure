// src/coding-agent/Planner.ts
// v0.1 — Analyzes tasks: determines complexity, optionally generates a plan.
// v0.2 — Logical-trap detection: scans the prompt for self-contradictory /
//        impossible / mutually-exclusive / trick-framed premises so the agent
//        can verify them before execution and escape the trap by switching
//        approach after a failed round instead of repeating the same one.

import type { AnalysisResult, TaskComplexity, TaskMode, Plan, PlanStep, TrapWarning } from './types';
import { repairJsonSource } from '../shared/parseRepair';

/** Upper bound on LLM-plan steps kept in the review card / system prompt. */
const MAX_PLAN_STEPS = 10;

export interface PlannerConfig {
  /** Threshold for 'complex': > this many file ops triggers planning. */
  complexFileThreshold?: number;
  /** Always plan when the user asks for it. */
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
    const complexity = this.detectComplexity(prompt);
    const traps = this.detectTraps(prompt);

    if (complexity === 'complex') {
      return {
        complexity,
        // Build intent ("写一个小游戏", "搭建全栈项目") switches the agent into
        // build mode; anything else complex gets plan mode. Both run the same
        // plan-review → live-todo-checkoff flow, only the label differs.
        mode: this.detectMode(prompt, complexity),
        plan: this.generatePlan(prompt),
        reasoning: this.getComplexReasoning(prompt),
        traps,
      };
    }

    return {
      complexity: 'simple',
      mode: 'yolo',
      reasoning: 'Task appears straightforward — direct execution is appropriate.',
      traps,
    };
  }

  /** Map a task to its operating mode: simple → yolo; complex + build/artifact
   * intent → build; complex otherwise → plan. */
  private detectMode(prompt: string, complexity: TaskComplexity): TaskMode {
    if (complexity !== 'complex') return 'yolo';
    return detectProjectRequest(prompt) || detectArtifactRequest(prompt) ? 'build' : 'plan';
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
      /^(?:如何|怎么|怎样|能否|能不能|是否|请问|为什么|该不该|应不应该|(?:请)?帮我?(?:看看|查查|看下|分析|解释|介绍|讲讲|说说|告诉我|描述|总结|评估))/.test(trimmed) ||
      /(?:怎么|如何|怎样|能否|能不能|是否|该不该|应不应该|为什么|吗|呢|什么(?!都|也|能))/.test(trimmed)
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

  private generatePlan(prompt: string): Plan {
    // Generic fallback plan shown when the LLM plan generation is skipped or
    // fails. Steps are written in plain user-facing language (not internal
    // labels like Understand/Plan/Implement/Verify) so the review card and
    // progress card read naturally. This is the heuristic fallback — for real
    // turns the LLM-generated plan (which follows the user's language) wins.
    const steps: PlanStep[] = [
      {
        id: '1',
        action: '了解需求',
        description: '先弄清任务要达成什么目标，以及有哪些约束条件。',
        expectedOutcome: '清楚知道要做什么、做到什么程度。',
      },
      {
        id: '2',
        action: '制定方案',
        description: '规划实现思路，确定要新建或修改哪些文件。',
        expectedOutcome: '有一份清晰的实施步骤清单。',
      },
      {
        id: '3',
        action: '分步实现',
        description: '按方案一步一步完成改动，每步都检查是否正常。',
        expectedOutcome: '核心功能按计划完成。',
      },
      {
        id: '4',
        action: '验证结果',
        description: '运行检查和测试，确认结果可用，并总结改了什么。',
        expectedOutcome: '交付验证过的可用成果。',
      },
    ];

    return {
      steps,
      reasoning: this.getComplexReasoning(prompt),
    };
  }

  private getComplexReasoning(prompt: string): string {
    // Shown above the plan review card — plain user-facing language.
    return '这个任务涉及多文件或较大改动，按步骤推进并逐步验证，能保证结果正确可靠。';
  }
}

/**
 * Render detected logical traps into a system-prompt fragment the LLM must
 * honor: verify the premise before executing, and if the request is
 * self-contradictory / impossible as stated, escape the trap by stating it
 * and solving the most reasonable interpretation instead of blindly following
 * contradictory instructions. Returns '' when there are no traps.
 */
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
  const creation = /(?:请|帮我|麻烦你|给我)?\s*(?:创建|建立|搭建|构建|开发|制作|做|实现|编写|写|生成|create|build|scaffold|develop|make|implement)\s*(?:(?:一个|一套|个|整套|整个|完整的|全栈的|大型的|多文件的|多模块的|a|an|the)\s*)?(?:项目|工程|project|application|app|website|site)(?!\s*(?:的)?\s*(?:(?:技术|开发|产品|实施)\s*)?(?:总结|方案|文档|介绍|报告|说明|计划|清单|列表|简介|笔记|教程|plan|documentation|document|docs|summary|report|spec|tutorial))/i;
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
  const buildVerb = /(?:请|帮我|麻烦你|给我)?(?:编写|编一个|写|写一个|写个|做|做一个|做个|开发|制作|创建|搭建|实现|搞一个|搞个|整一个|整个|设计|生成|做一个|给我写)/;
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
 * Pairs with the same rule baked into BASE_SYSTEM_PROMPT — the injection makes
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
    const step = raw as { action?: unknown; description?: unknown; expectedOutcome?: unknown };
    const action = typeof step.action === 'string' ? step.action.trim() : '';
    const description = typeof step.description === 'string' ? step.description.trim() : '';
    if (!action && !description) continue;
    steps.push({
      id: String(steps.length + 1),
      action: action || description,
      description: description || action,
      expectedOutcome: typeof step.expectedOutcome === 'string' ? step.expectedOutcome.trim() : description || action,
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
