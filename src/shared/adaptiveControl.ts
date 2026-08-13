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
  return `<adaptive_strategy>\nRuntime-selected strategy (not a fixed task plan):\n- Signals: ${strategy.signals.join(', ')}\n- Exploration: ${strategy.exploration}\n- Verification: ${strategy.verification}\n- Delegation: ${strategy.delegation}\n- Recovery: ${strategy.recovery}\n- Autonomy: ${strategy.autonomy}\n- Confidence: ${strategy.confidence.toFixed(2)}\n- Rationale: ${strategy.rationale}\n${exploration}\n${verification}\n${delegation}\n${recovery}\n${autonomy}\nRevise this strategy when workspace evidence, tool results, or verification contradict it. Never weaken permission, path, budget, or external-side-effect safeguards.\n</adaptive_strategy>`;
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
    const broadExploration = hasEvidenceOfFailure || procedures.length === 0 && input.prompt.length > 240;
    const exploration: AdaptiveExploration = broadExploration ? 'broad' : 'targeted';
    const verification: AdaptiveVerification = !environment.verifierAvailable
      ? 'focused'
      : hasEvidenceOfFailure || phase === 'night'
        ? 'thorough'
        : procedures.length > 0
          ? 'standard'
          : 'focused';
    const delegation: AdaptiveDelegation = !hasCapability
      ? 'none'
      : hasEvidenceOfFailure && environment.toolCount >= 4
        ? 'parallel'
        : environment.toolCount >= 2
          ? 'targeted'
          : 'none';
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
      confidence: Math.min(0.95, 0.45 + (environment.verifierAvailable ? 0.12 : 0) + (procedures.length > 0 ? 0.12 : 0) + (failures.length > 0 ? 0.1 : 0)),
      signals,
      rationale,
    };
    return { ...base, directive: buildDirective(base) };
  }
}

export const adaptiveControlPlane = new AdaptiveControlPlane();
