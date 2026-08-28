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
    parallelRequested: has('并行', '分头', '同时', '一起做', 'parallel', 'concurrently'),
    serialRequested: has('逐步', '串行', '顺序', '先', 'step by step', 'sequentially'),
  };
}

function fileMentions(prompt: string): number {
  const fileHits = prompt.match(/\b[\w\-./]+\.(tsx?|jsx?|py|go|rs|java|vue|css|html?|md|json|yml|yaml)\b/g) ?? [];
  const wordHits = (prompt.match(/文件|file/g) ?? []).length;
  return fileHits.length + wordHits;
}

function estimateComplexity(prompt: string, intent: RequestIntent): AdaptiveStrategy['complexity'] {
  let score = 0;
  if (intent.quick) score -= 2;
  if (intent.refactor || intent.multiFile || intent.planning) score += 2;
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

function recommendRoles(intent: RequestIntent, complexity: AdaptiveStrategy['complexity']): string[] {
  const roles: string[] = [];
  if (intent.planning || intent.refactor || intent.multiFile) {
    roles.push('task_planner', 'code_editor', 'code_reviewer');
  }
  if (intent.research) roles.push('researcher', 'deep_thinker');
  if (intent.design) roles.push('ui_designer');
  if (intent.audit) roles.push('project_auditor', 'code_reviewer');
  if (intent.review) roles.push('code_reviewer');
  if (roles.length === 0) {
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
    ? 'Use independent read-only or verification subagents in parallel when that reduces uncertainty.'
    : strategy.delegation === 'targeted'
      ? 'Delegate only an independent, well-scoped investigation when it reduces context or execution risk.'
      : 'Do not delegate by default; keep the loop local unless new evidence makes delegation useful.';
  const roles = strategy.recommendedRoles.length > 0
    ? `\n- Preferred subagents for this request: ${strategy.recommendedRoles.join(', ')}.${strategy.parallelRoles.length > 0 ? ` Run these in parallel when independent: ${strategy.parallelRoles.join(', ')}.` : ''}`
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
    const intent = parseIntent(input.prompt);
    const complexity = estimateComplexity(input.prompt, intent);
    const recommendedRoles = recommendRoles(intent, complexity);
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
      : hasEvidenceOfFailure
        ? (environment.toolCount >= 3 ? 'parallel' : 'targeted')
        : intent.quick || complexity === 'trivial'
          ? 'none'
          : complexity === 'simple'
            ? 'targeted'
            : complexity === 'complex'
              ? (intent.parallelRequested || ((intent.research || intent.audit || intent.design) && environment.toolCount >= 2)
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
