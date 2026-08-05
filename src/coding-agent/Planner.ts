// src/coding-agent/Planner.ts
// v0.1 — Analyzes tasks: determines complexity, optionally generates a plan.
// v0.2 — Logical-trap detection: scans the prompt for self-contradictory /
//        impossible / mutually-exclusive / trick-framed premises so the agent
//        can verify them before execution and escape the trap by switching
//        approach after a failed round instead of repeating the same one.

import type { AnalysisResult, TaskComplexity, Plan, PlanStep, TrapWarning } from './types';

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
        plan: this.generatePlan(prompt),
        reasoning: this.getComplexReasoning(prompt),
        traps,
      };
    }

    return {
      complexity: 'simple',
      reasoning: 'Task appears straightforward — direct execution is appropriate.',
      traps,
    };
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

    // User explicitly asks for planning
    if (/plan|先计划|规划|设计|think step by step|think through/i.test(prompt)) {
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

    return 'simple';
  }

  private generatePlan(prompt: string): Plan {
    // Generate a generic plan based on task analysis
    const steps: PlanStep[] = [
      {
        id: '1',
        action: 'Understand',
        description: 'Read relevant files and understand the current codebase structure.',
        expectedOutcome: 'Clear understanding of what needs to change.',
      },
      {
        id: '2',
        action: 'Plan',
        description: 'Design the solution approach and identify files to modify.',
        expectedOutcome: 'Concrete change plan with file-by-file details.',
      },
      {
        id: '3',
        action: 'Implement',
        description: 'Execute changes across identified files.',
        expectedOutcome: 'Working implementation matching the plan.',
      },
      {
        id: '4',
        action: 'Verify',
        description: 'Run tests and verify the implementation works correctly.',
        expectedOutcome: 'All tests pass, changes are validated.',
      },
    ];

    return {
      steps,
      reasoning: this.getComplexReasoning(prompt),
    };
  }

  private getComplexReasoning(prompt: string): string {
    return `This task involves multiple files or significant changes. A structured approach with planning, implementation, and verification steps will ensure correctness.`;
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
