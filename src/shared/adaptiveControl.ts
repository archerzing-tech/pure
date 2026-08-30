import type { VerificationSummary } from './types';

export type AdaptiveExploration = 'targeted' | 'broad';
export type AdaptiveVerification = 'focused' | 'standard' | 'thorough';
export type AdaptiveDelegation = 'none' | 'targeted' | 'parallel';
export type AdaptiveRecovery = 'continue-with-evidence' | 'switch-approach' | 'use-verified-procedure';
export type AdaptiveAutonomy = 'unattended-local' | 'assisted' | 'blocked';

export interface AdaptiveEnvironment {
  now?: number;
  timezone?: string;
  projectPath?: string;
  hasWorkspace: boolean;
  toolCount: number;
  verifierAvailable: boolean;
  memoryAvailable: boolean;
}

export interface AdaptiveControlInput {
  prompt: string;
  environment: AdaptiveEnvironment;
  learnedProcedures?: string[];
  recentFailures?: string[];
  verification?: VerificationSummary;
  /** When the shared semantic router has already understood the request, feed
   * its tags/complexity here so delegation (看人下菜) is driven by semantic
   * understanding rather than re-scanning keywords. Keyword inference in
   * parseIntent remains only as a fallback when this is absent. */
  semantic?: {
    tags?: string[];
    complexity?: AdaptiveStrategy['complexity'];
    /** 语义路由按任务属性挑选的子 agent（真实名录精确名）。undefined=路由没给
     * → 关键词兜底；显式 [] = 路由判断无需委派，不回退关键词。 */
    roles?: string[];
  };
}

export interface AdaptiveStrategy {
  id: string;
  timePhase: 'morning' | 'day' | 'evening' | 'night';
  exploration: AdaptiveExploration;
  verification: AdaptiveVerification;
  delegation: AdaptiveDelegation;
  recovery: AdaptiveRecovery;
  autonomy: AdaptiveAutonomy;
  confidence: number;
  signals: string[];
  rationale: string;
  directive: string;
  /** Estimated task complexity, used to decide whether / how to delegate. */
  complexity: 'trivial' | 'simple' | 'moderate' | 'complex';
  /** Detected intent tags (planning / research / design / audit / quick / …). */
  intentTags: string[];
  /** Subagents the model should prefer for THIS request (看人下菜). */
  recommendedRoles: string[];
  /** Of those, the ones that are independent + read-only and may run in parallel. */
  parallelRoles: string[];
}

// ── Content-aware delegation signals (看人下菜) ──
// The old strategy picked delegation almost purely from toolCount; it ignored
// WHAT the user actually asked. These helpers read the request so the agent
// delegates (or stays local) the way a thoughtful engineer would.

export interface RequestIntent {
  quick: boolean;
  planning: boolean;
  refactor: boolean;
  multiFile: boolean;
  research: boolean;
  design: boolean;
  audit: boolean;
  review: boolean;
  /** Build / scaffold / replicate a deliverable (a project, site, app, game,
   * scaffolding — multi-role, multi-file by nature). Drives delegation up. */
  build: boolean;
  parallelRequested: boolean;
  serialRequested: boolean;
}

function parseIntent(prompt: string): RequestIntent {
  const p = prompt.toLowerCase();
  const has = (...kw: string[]) => kw.some((k) => p.includes(k));
  return {
    quick: has('简单', '快速', '小改', '顺手', '修一下', 'quick', 'just ', 'tiny', 'small fix', '小任务'),
    planning: has('规划', '计划', '方案', '拆解', 'plan', 'roadmap', '规划一下'),
    refactor: has('重构', '重排', '重组', 'refactor', 'restructure'),
    multiFile: has('多文件', '多个文件', '整个项目', '跨文件', 'multi-file', 'whole project', 'repository'),
    research: has('调研', '研究', '查一', '调查', '了解', '资料', 'research', 'investigate', 'look up'),
    design: has('设计', '界面', '前端', '视觉', '交互', 'ui', 'ux', 'design', 'layout'),
    audit: has('审计', '安全', '漏洞', '扫描', 'audit', 'security', 'vulnerab'),
    review: has('审查', '评审', '复查', 'review', 'check the code'),
    build: has('复刻', '复现', '复制', '搭建', '新建', '脚手架', '构建', '生成', '做一', '开发一', 'scaffold', 'create project', 'build a', 'make a', 'clone', 'replicate', '复刻这个'),
    parallelRequested: has('并行', '分头', '同时', '一起做', 'parallel', 'concurrently'),
    serialRequested: has('逐步', '串行', '顺序', '先', 'step by step', 'sequentially'),
  };
}

function fileMentions(prompt: string): number {
  const fileHits = prompt.match(/\b[\w\-./]+\.(tsx?|jsx?|py|go|rs|java|vue|css|html?|md|json|yml|yaml)\b/g) ?? [];
  const wordHits = (prompt.match(/文件|file/g) ?? []).length;
  return fileHits.length + wordHits;
}

/** 把语义路由给出的意图标签映射成看人下菜用的意图标记；仅在没有语义信号时，
 * 才回退到 parseIntent 的关键词推断。这样任务分派由“理解”驱动，而非关键词归类。 */
function intentFromTags(tags: string[]): RequestIntent {
  const t = new Set(tags.map((x) => x.toLowerCase()));
  const has = (...keys: string[]) => keys.some((k) => t.has(k));
  return {
    quick: has('quick', 'question'),
    planning: has('planning', 'plan'),
    refactor: has('refactor'),
    multiFile: has('multi-file', 'multifile', 'whole-project', 'whole', 'repository'),
    research: has('research'),
    design: has('design', 'ui', 'ux'),
    audit: has('audit', 'security'),
    review: has('review'),
    build: has('build', 'scaffold', 'create', 'replicate', 'clone', 'generate'),
    parallelRequested: has('parallel', 'concurrent'),
    serialRequested: has('serial', 'step-by-step', 'sequential'),
  };
}

/** The task actually targets software — only then do the code-modification
 * roles (task_planner → code_editor → code_reviewer) make sense. A "规划/计划"
 * request may be a travel itinerary or event schedule; it must never be routed
 * to code roles just because it used the word "计划". */
function involvesCode(intent: RequestIntent, prompt: string): boolean {
  if (intent.refactor || intent.multiFile || intent.build) return true;
  if (fileMentions(prompt) > 0) return true;
  return /代码|源码|编程|开发|重构|修复|接口|前端|后端|页面|网页|网站|组件|模块|数据库|函数|脚本|补丁|部署|bug|报错|日志|api|功能|游戏|应用/i.test(prompt);
}

function estimateComplexity(prompt: string, intent: RequestIntent): AdaptiveStrategy['complexity'] {
  let score = 0;
  if (intent.quick) score -= 2;
  // 「规划」是否算复杂度看它是否真的涉及代码：非代码计划（行程/活动安排）
  // 不该被当作代码复杂度去推动委托。
  if (intent.refactor || intent.multiFile || (intent.planning && involvesCode(intent, prompt))) score += 2;
  // Build / scaffold / replicate is a multi-role, multi-file deliverable by
  // nature — bias it toward complex so delegation actually kicks in.
  if (intent.build) score += 2;
  if (intent.research) score += 1;
  if (intent.design) score += 1;
  if (intent.audit) score += 1;
  const len = prompt.length;
  if (len > 400) score += 1;
  if (len > 900) score += 1;
  const fm = fileMentions(prompt);
  if (fm >= 2) score += 2;
  if (fm >= 4) score += 1;
  if (score <= 0) return 'trivial';
  if (score <= 1) return 'simple';
  if (score <= 3) return 'moderate';
  return 'complex';
}

// Roles that are independent + read-only and therefore safe to run in parallel.
const PARALLEL_SAFE_ROLES = new Set([
  'researcher', 'deep_thinker', 'project_auditor', 'code_reviewer', 'ui_designer',
]);

/** 语义路由可从中挑选的完整真实子 agent 名录。必须与 SubagentOrchestrator.ts 的
 * BUILT_IN_SUBAGENTS + CODING_AGENT_ROLES 保持一致（当前 8 个，已定不新增）。 */
export const KNOWN_SUBAGENT_ROLES = new Set([
  'task_planner', 'code_editor', 'deep_thinker', 'ui_designer',
  'bash_executor', 'researcher', 'code_reviewer', 'project_auditor',
]);
/** 代码修改/执行类角色：非代码任务（旅游、问答、调研）永远不该拿到——语义路径
 * 上镜像关键词路径的 involvesCode 门，保证即便路由误判也防住误配。 */
const CODE_OR_EXEC_ROLES = new Set(['task_planner', 'code_editor', 'code_reviewer', 'bash_executor']);
/** 语义推荐的角色数量上限。 */
const MAX_SUBAGENT_ROLES = 4;

function recommendRoles(intent: RequestIntent, complexity: AdaptiveStrategy['complexity'], prompt: string): string[] {
  const roles: string[] = [];
  const codeTask = involvesCode(intent, prompt);
  // 代码管线（规划→实现→评审）只派给真正改动代码的任务；planning 本身可能是
  // 旅游/日程这类非代码计划，绝不给它们派 code_editor/code_reviewer。
  if (codeTask && (intent.planning || intent.refactor || intent.multiFile || intent.build)) {
    roles.push('task_planner', 'code_editor', 'code_reviewer');
  }
  if (intent.research) roles.push('researcher', 'deep_thinker');
  if (intent.design) roles.push('ui_designer');
  if (intent.audit) roles.push('project_auditor', 'code_reviewer');
  if (intent.review) roles.push('code_reviewer');
  // 兜底同样只在代码任务上补 code 角色，避免把非代码复杂任务误派。
  if (roles.length === 0 && codeTask) {
    if (complexity === 'complex') roles.push('task_planner', 'researcher');
    else if (complexity === 'moderate') roles.push('code_reviewer');
  }
  return Array.from(new Set(roles));
}

function timePhase(now: number, timezone?: string): AdaptiveStrategy['timePhase'] {
  let hour = new Date(now).getHours();
  if (timezone) {
    try {
      const part = new Intl.DateTimeFormat('en-US', {
        hour: '2-digit',
        hour12: false,
        timeZone: timezone,
      }).formatToParts(new Date(now)).find(item => item.type === 'hour');
      if (part) hour = Number(part.value) % 24;
    } catch {
      // An unavailable timezone must not prevent strategy selection.
    }
  }
  if (hour < 6) return 'night';
  if (hour < 12) return 'morning';
  if (hour < 18) return 'day';
  if (hour < 23) return 'evening';
  return 'night';
}

function stableToken(value: string): string {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index++) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

function describeEnvironment(environment: AdaptiveEnvironment, phase: AdaptiveStrategy['timePhase']): string[] {
  const signals = [`time:${phase}`, `tools:${Math.max(0, environment.toolCount)}`];
  if (environment.projectPath) signals.push('project:available');
  if (environment.hasWorkspace) signals.push('workspace:available');
  else signals.push('workspace:unavailable');
  if (environment.verifierAvailable) signals.push('verification:available');
  else signals.push('verification:limited');
  if (environment.memoryAvailable) signals.push('memory:available');
  return signals;
}

function buildDirective(strategy: Omit<AdaptiveStrategy, 'directive'>): string {
  const verification = strategy.verification === 'thorough'
    ? 'Run layered verification and preserve concrete evidence before declaring completion.'
    : strategy.verification === 'standard'
      ? 'Run focused checks after each meaningful change and a matching final check.'
      : 'Run the narrowest meaningful check and state clearly when stronger verification is unavailable.';
  const exploration = strategy.exploration === 'broad'
    ? 'Explore the relevant workspace and dependencies broadly enough to test competing hypotheses before editing.'
    : 'Start with a targeted read of the smallest relevant surface, expanding only when evidence requires it.';
  const delegation = strategy.delegation === 'parallel'
    ? 'This task needs parallel decomposition. Delegate to the matching subagent tools and run independent read-only roles in parallel, then integrate their results. Narrate the orchestration to the user like a colleague setting up a shared effort: one natural sentence about your overall approach first (e.g. "这趟安排有点复杂，我先分头安排：一边让研究员查沿途景点和交通，一边让深度思考的同事把预算和路线取舍算清楚"), then hand each piece to its subagent and weave the results into ONE reply in the user\'s language. Never recite a role list or an arrow-chain of subagents.'
    : strategy.delegation === 'targeted'
      ? 'Delegate the well-scoped pieces of this task to the matching subagent roles when it reduces context or execution risk, and parallelize independent read-only roles where possible — do not do a multi-role job alone by default. Tell the user about each hand-off in one natural sentence at the moment you make it (e.g. "我先让 researcher 把沿途的旅游点和大致预算摸一遍，deep_thinker 再把路线取舍算一算"), and keep the single-voice final answer in the user\'s language.'
      : 'This is a trivial/simple task — keep the loop local and avoid the overhead of delegation; delegate only if new evidence shows it is needed.';
  const roles = strategy.recommendedRoles.length > 0
    ? `\n- 推荐的本任务子 agent：${strategy.recommendedRoles.join(', ')}。${strategy.parallelRoles.length > 0 ? ` 其中可并行：${strategy.parallelRoles.join(', ')}。` : ''}（建议人选；具体怎么跟用户说由你自然表达，不要列成机械清单。）`
    : '';
  const complexityLine = `\n- Task complexity: ${strategy.complexity}.${strategy.intentTags.length > 0 ? ` Intent: ${strategy.intentTags.join(', ')}.` : ''}`;
  const recovery = strategy.recovery === 'switch-approach'
    ? 'Treat prior failures as evidence: change the hypothesis, tool, or scope instead of repeating the failed path.'
    : strategy.recovery === 'use-verified-procedure'
      ? 'Use a retrieved procedure only when the current workspace evidence still matches it; otherwise revise the strategy.'
      : 'Continue only when the next action adds new evidence; otherwise pause, simplify, or switch approach.';
  const autonomy = strategy.autonomy === 'unattended-local'
    ? 'Proceed autonomously for local reversible work within the configured budget; stop at programmatic safety gates.'
    : strategy.autonomy === 'assisted'
      ? 'Proceed on safe local work, but surface missing capability or decisions before crossing a boundary.'
      : 'Do not claim autonomous progress when the workspace or required capability is unavailable.';
  return `<adaptive_strategy>\nRuntime-selected strategy (not a fixed task plan):\n- Signals: ${strategy.signals.join(', ')}\n- Exploration: ${strategy.exploration}\n- Verification: ${strategy.verification}\n- Delegation: ${strategy.delegation}\n- Recovery: ${strategy.recovery}\n- Autonomy: ${strategy.autonomy}\n- Confidence: ${strategy.confidence.toFixed(2)}\n- Rationale: ${strategy.rationale}\n${exploration}\n${verification}\n${delegation}${complexityLine}${roles}\n${recovery}\n${autonomy}\nRevise this strategy when workspace evidence, tool results, or verification contradict it. Never weaken permission, path, budget, or external-side-effect safeguards.\n</adaptive_strategy>`;
}

export class AdaptiveControlPlane {
  select(input: AdaptiveControlInput): AdaptiveStrategy {
    const environment = input.environment;
    const phase = timePhase(environment.now ?? Date.now(), environment.timezone);
    const procedures = input.learnedProcedures?.filter(Boolean) ?? [];
    const failures = input.recentFailures?.filter(Boolean) ?? [];
    const hasEvidenceOfFailure = failures.length > 0
      || input.verification?.status === 'failed'
      || input.verification?.status === 'incomplete';
    const hasCapability = environment.hasWorkspace && environment.toolCount > 0;
    const intent = input.semantic?.tags && input.semantic.tags.length > 0
      ? intentFromTags(input.semantic.tags)
      : parseIntent(input.prompt);
    const complexity = input.semantic?.complexity ?? estimateComplexity(input.prompt, intent);
    // 理解驱动的角色分配优先：语义路由已按任务属性挑好人选。undefined=路由没给
    // （超时/失败/模型忽略新字段）→ 关键词兜底，保持原有行为；显式 [] = 路由判断
    // 无需委派，不回退关键词。
    const semanticRoles = input.semantic?.roles;
    let recommendedRoles: string[];
    if (semanticRoles !== undefined) {
      let roles = Array.from(new Set(
        semanticRoles.filter((r) => KNOWN_SUBAGENT_ROLES.has(r)),
      )).slice(0, MAX_SUBAGENT_ROLES);
      // 语义路径的防误配镜像门：非代码任务（旅游/问答/调研）永远剔除代码/执行角色，
      // 即使路由误选了也兜住——与关键词路径的 involvesCode 门对称。
      if (!involvesCode(intent, input.prompt)) {
        roles = roles.filter((r) => !CODE_OR_EXEC_ROLES.has(r));
      }
      recommendedRoles = roles;
    } else {
      recommendedRoles = recommendRoles(intent, complexity, input.prompt);
    }
    const parallelRoles = recommendedRoles.filter((r) => PARALLEL_SAFE_ROLES.has(r));
    const broadExploration = hasEvidenceOfFailure || (procedures.length === 0 && input.prompt.length > 240);
    const exploration: AdaptiveExploration = broadExploration ? 'broad' : 'targeted';
    const verification: AdaptiveVerification = !environment.verifierAvailable
      ? 'focused'
      : hasEvidenceOfFailure || phase === 'night'
        ? 'thorough'
        : procedures.length > 0
          ? 'standard'
          : 'focused';
    // Content-aware delegation (看人下菜): decide HOW to delegate from what the
    // user actually asked, not just from how many tools are loaded.
    const delegation: AdaptiveDelegation = !hasCapability
      ? 'none'
      // 语义路由显式给出空角色清单 = 模型判断本任务无需委派：不再因为 build/complex
      // 就把委托级别抬到 parallel，避免“硬往不相关子 agent 上靠”的旧问题复现。
      : semanticRoles !== undefined && semanticRoles.length === 0
        ? 'none'
        : hasEvidenceOfFailure
        ? (environment.toolCount >= 3 ? 'parallel' : 'targeted')
        : intent.quick || complexity === 'trivial'
          ? 'none'
          : complexity === 'simple'
            ? 'targeted'
            : complexity === 'complex'
              ? (intent.parallelRequested || intent.build
                || ((intent.research || intent.audit || intent.design) && environment.toolCount >= 2)
                ? 'parallel'
                : 'targeted')
              : 'targeted';
    const recovery: AdaptiveRecovery = hasEvidenceOfFailure
      ? 'switch-approach'
      : procedures.length > 0
        ? 'use-verified-procedure'
        : 'continue-with-evidence';
    const autonomy: AdaptiveAutonomy = !environment.hasWorkspace || !hasCapability
      ? 'blocked'
      : environment.verifierAvailable && phase !== 'morning'
        ? 'unattended-local'
        : 'assisted';
    const signals = describeEnvironment(environment, phase);
    if (failures.length > 0) signals.push(`recent-failures:${Math.min(failures.length, 9)}`);
    if (procedures.length > 0) signals.push(`learned-procedures:${Math.min(procedures.length, 9)}`);
    const rationale = hasEvidenceOfFailure
      ? 'Recent execution evidence indicates that repeating the previous path is less reliable than widening exploration and increasing verification.'
      : procedures.length > 0
        ? 'A verified procedure is available, so start efficiently while checking that current workspace evidence still matches it.'
        : !hasCapability
          ? 'Required local capability is unavailable, so remain honest about the boundary and avoid pretending that exploration completed.'
          : 'No prior failure evidence was retrieved; begin with the smallest evidence-producing action and adapt from results.';
    const base: Omit<AdaptiveStrategy, 'directive'> = {
      id: `adaptive-${stableToken(`${input.prompt}|${environment.projectPath ?? ''}|${phase}|${signals.join('|')}`)}`,
      timePhase: phase,
      exploration,
      verification,
      delegation,
      recovery,
      autonomy,
      confidence: Math.min(0.95, 0.45 + (environment.verifierAvailable ? 0.12 : 0) + (procedures.length > 0 ? 0.12 : 0) + (failures.length > 0 ? 0.1 : 0) + (complexity === 'complex' ? 0.05 : 0)),
      signals,
      rationale,
      complexity,
      intentTags: Object.entries(intent).filter(([, v]) => v).map(([k]) => k),
      recommendedRoles,
      parallelRoles,
    };
    return { ...base, directive: buildDirective(base) };
  }
}

export const adaptiveControlPlane = new AdaptiveControlPlane();
