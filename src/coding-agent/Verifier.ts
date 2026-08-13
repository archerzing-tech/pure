// src/coding-agent/Verifier.ts
// v0.2 — Verifies agent output by running configurable checks.
// v0.2 adds the LLM-based check: the model itself compares the final output
// against the original task and returns a strict JSON verdict.

import type { LLMAdapter, Message, VerificationEvidence, VerificationStatus } from '../shared/types';
import { repairJsonSource } from '../shared/parseRepair';

export interface VerifierCheckResult {
  passed: boolean;
  feedback?: string;
  evidence?: VerificationEvidence | VerificationEvidence[];
}

export interface VerifierCheck {
  name: string;
  run(params: { output: string; context: Message[] }): Promise<VerifierCheckResult>;
}

function defaultEvidence(name: string, result: VerifierCheckResult): VerificationEvidence {
  const status: VerificationStatus = result.passed ? 'passed' : 'failed';
  return {
    id: `verifier_${name}_${Date.now()}`,
    checkName: name,
    status,
    summary: result.feedback ?? (result.passed
      ? `${name} passed (engine output check; not project verification)`
      : `${name} failed`),
    source: 'engine',
    timestamp: Date.now(),
  };
}

function evidenceFor(name: string, result: VerifierCheckResult): VerificationEvidence[] {
  if (!result.evidence) return [defaultEvidence(name, result)];
  return Array.isArray(result.evidence) ? result.evidence : [result.evidence];
}

export class Verifier {
  private checks: VerifierCheck[] = [];

  constructor(checks?: VerifierCheck[]) {
    if (checks) this.checks = checks;
  }

  addCheck(check: VerifierCheck): void {
    this.checks.push(check);
  }

  async evaluate(params: { output: string; context: Message[] }): Promise<{ passed: boolean; feedback?: string; evidence: VerificationEvidence[] }> {
    const evidence: VerificationEvidence[] = [];
    for (const check of this.checks) {
      const result = await check.run(params);
      evidence.push(...evidenceFor(check.name, result));
      if (!result.passed) {
        return { passed: false, feedback: `[${check.name}] ${result.feedback ?? 'Check failed'}`, evidence };
      }
    }
    return { passed: true, evidence };
  }
}

// ── Built-in checks ──

/** Check that assistant output is not empty after tool rounds. */
export const NonEmptyOutputCheck: VerifierCheck = {
  name: 'non-empty-output',
  run: async ({ output }) => ({
    passed: output.trim().length > 0,
    // The hint doubles as the retry instruction the FailurePolicy feeds back
    // to the model: empty output on a reasoning model almost always means the
    // output-token budget was consumed by thinking, so the model must write
    // the answer directly instead of reasoning again.
    feedback: output.trim().length === 0
      ? 'Assistant produced empty output (the output token budget was likely consumed by reasoning). Keep reasoning to a minimum and write the final answer/content directly.'
      : undefined,
  }),
};

/** Check that no obvious error messages are present in the output. */
export const NoErrorMessageCheck: VerifierCheck = {
  name: 'no-error-message',
  run: async ({ output }) => {
    const errorPatterns = [/error:/i, /failed:/i, /unable to/i, /could not/i];
    for (const pattern of errorPatterns) {
      if (pattern.test(output)) {
        return { passed: false, feedback: `Output contains potential error: "${output.slice(0, 100)}"` };
      }
    }
    return { passed: true };
  },
};

/** Default verifier with standard checks. */
export function createDefaultVerifier(): Verifier {
  const v = new Verifier();
  v.addCheck(NonEmptyOutputCheck);
  return v;
}

// ── LLM-based verification (v0.2) ──

export interface LLMVerifierOptions {
  /** Cap the output sent to the verifier LLM (chars). Default 6000. */
  maxOutputChars?: number;
  /** Cap the task excerpt sent to the verifier LLM (chars). Default 800. */
  maxTaskChars?: number;
}

const DEFAULT_MAX_OUTPUT = 6000;
const DEFAULT_MAX_TASK = 800;

export const LLMVerifyCheckName = 'llm-verify';

/**
 * Extract the current task from the message context — the most recent
 * non-empty user message (the prompt this turn is answering).
 */
export function extractUserTask(context: Message[]): string {
  for (let i = context.length - 1; i >= 0; i--) {
    const m = context[i];
    if (m.role === 'user' && m.content.trim()) return m.content.trim();
  }
  return '';
}

function buildVerifyPrompt(task: string, output: string): string {
  return `You are a verification agent. Determine whether the assistant's final response substantially addresses the user's original request.

User request:
${task || '(no user request found — judge whether the output is coherent and complete on its own)'}

Assistant final output:
${output}

Rules:
- Pass if the output substantially addresses the request, even with minor imperfections or missing niceties.
- An acknowledgment or polite opening (e.g. "Sure, let me…") followed by a substantive answer is a clear PASS — do NOT fail an output just because it begins with acknowledgment.
- For requests that ask to CREATE or SHOW a creative/visual artifact — a demo, animation, prototype, HTML page, diagram, slideshow, game, or script — pass if the artifact is present and substantially complete and coherent. Do NOT act as a strict code reviewer: minor implementation bugs, styling imperfections, edge cases, or missing polish do NOT fail such requests (the user can iterate on details). Only fail these requests when the artifact is entirely missing, empty, or unusable.
- Fail ONLY if the output is missing a core deliverable, contradicts the request, or is largely off-topic with no attempt to address the request.
- If the request is a simple question, pass when the output answers it.

Respond with ONLY a JSON object, no markdown fences, no extra text:
{"passed": true, "feedback": "short reason"}
or
{"passed": false, "feedback": "what is missing and why"}`;
}

/**
 * Validate a parsed verdict object — must carry a boolean `passed`;
 * `feedback` is optional and string-only. Returns null for anything else.
 */
function verdictFromObject(obj: unknown): { passed: boolean; feedback?: string } | null {
  if (!obj || typeof obj !== 'object') return null;
  const o = obj as { passed?: unknown; feedback?: unknown };
  if (typeof o.passed !== 'boolean') return null;
  return {
    passed: o.passed,
    feedback: typeof o.feedback === 'string' ? o.feedback : undefined,
  };
}

/**
 * Parse a strict-format verdict, tolerating markdown fences and stray text.
 * Uses depth counting so braces inside string values (e.g. a feedback
 * mentioning a literal `}`) don't truncate the JSON. Returns null when the
 * response is not a usable verdict (caller fails open).
 */
/** A parsed verifier verdict. `repaired` is true when the verdict JSON had to
 *  be repaired before it parsed — callers must treat the feedback TEXT as
 *  untrusted (a reconstruction of the model's broken output) and keep it out
 *  of the agent context window (see createLLMVerifyCheck). */
export function parseVerdict(raw: string): { passed: boolean; feedback?: string; repaired?: boolean } | null {
  let text = raw.trim();
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) text = fence[1].trim();

  let start = -1;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (c === '\\') escaped = true;
      else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') {
      inString = true;
      continue;
    }
    if (c === '{') {
      if (start < 0) {
        // Start of a candidate object — clamp any stray `}` seen before it
        // so the depth counter can't be driven negative by leading noise.
        start = i;
        depth = 0;
      }
      depth++;
    } else if (c === '}') {
      depth--;
      if (depth === 0 && start >= 0) {
        const slice = text.slice(start, i + 1);
        try {
          const verdict = verdictFromObject(JSON.parse(slice));
          return verdict ? verdict : null;
        } catch {
          // Smart fault tolerance: a verdict with minor syntax errors (trailing
          // comma, single quotes, unquoted keys) is repaired once before the
          // caller fails open. Parse-gated — only accepted if it parses.
          const repaired = repairJsonSource(slice);
          if (!repaired.repaired) return null;
          try {
            const verdict = verdictFromObject(JSON.parse(repaired.source));
            // Repaired text is a RECONSTRUCTION of the model's broken output:
            // only the `passed` boolean survives (validated, content-free);
            // the feedback TEXT is dropped so it can never re-enter the agent
            // context window as if the model had written it.
            return verdict ? { passed: verdict.passed, repaired: true } : null;
          } catch {
            return null;
          }
        }
      }
    }
  }
  return null;
}

/**
 * A VerifierCheck that asks the model itself to judge the final output against
 * the task. Fail-open: any verifier LLM error or unparseable verdict passes
 * (with a note) so a broken verdict can never trap the agent in a retry loop.
 */
export function createLLMVerifyCheck(llm: LLMAdapter, options?: LLMVerifierOptions): VerifierCheck {
  const maxOutput = options?.maxOutputChars ?? DEFAULT_MAX_OUTPUT;
  const maxTask = options?.maxTaskChars ?? DEFAULT_MAX_TASK;
  return {
    name: LLMVerifyCheckName,
    run: async ({ output, context }) => {
      const task = extractUserTask(context).slice(0, maxTask);
      const prompt = buildVerifyPrompt(task, output.slice(0, maxOutput));
      let response: string;
      try {
        const res = await llm.complete([{ role: 'user', content: prompt }], []);
        response = res.content ?? '';
      } catch (err) {
        const summary = `verifier LLM error: ${(err as Error).message}`;
        return {
          passed: true,
          feedback: summary,
          evidence: {
            id: `verifier_llm_error_${Date.now()}`,
            checkName: LLMVerifyCheckName,
            status: 'incomplete',
            summary,
            source: 'engine',
            timestamp: Date.now(),
          },
        };
      }
      const verdict = parseVerdict(response);
      if (!verdict) {
        const summary = 'verifier returned an unparseable verdict (failed open)';
        return {
          passed: true,
          feedback: summary,
          evidence: {
            id: `verifier_unparseable_${Date.now()}`,
            checkName: LLMVerifyCheckName,
            status: 'incomplete',
            summary,
            source: 'engine',
            timestamp: Date.now(),
          },
        };
      }
      return {
        passed: verdict.passed,
        evidence: {
          id: `verifier_llm_${Date.now()}`,
          checkName: LLMVerifyCheckName,
          status: verdict.passed ? 'passed' : 'failed',
          summary: verdict.feedback ?? (verdict.passed ? 'LLM verifier passed.' : 'LLM verifier failed.'),
          source: 'engine',
          timestamp: Date.now(),
        },
        // Repaired verdict feedback is dropped in parseVerdict (reconstructed
        // model text must not enter the context). Substitute a system-authored
        // note on failure so the engine's "Verification failed: …" message
        // stays honest; a passed verdict never reads feedback anyway.
        feedback: verdict.feedback
          ?? (verdict.repaired && !verdict.passed ? 'verifier verdict required auto-repair; its feedback is unavailable' : undefined),
      };
    },
  };
}

/**
 * LLM-based verifier: fast rule check (non-empty output) first, then the model
 * judges conformance to the task. Wire it via `config.verifier` to replace the
 * pure rule-based default in real flows.
 *
 * P1-1 note: this SYNC variant is no longer the default in the GUI/CLI — the
 * LLM round-trip it adds after the answer stream blocks the "turn complete"
 * UX, and a failed verdict rewrites the answer the user just read. The
 * GUI now uses `createLLMOnlyVerifier` in fire-and-forget mode instead.
 */
export function createLLMVerifier(llm: LLMAdapter, options?: LLMVerifierOptions): Verifier {
  const v = new Verifier();
  v.addCheck(NonEmptyOutputCheck);
  v.addCheck(createLLMVerifyCheck(llm, options));
  return v;
}

/**
 * LLM-only verifier for ASYNC verification (P1-1): the model judges the final
 * output against the task AFTER the answer has already been delivered. The GUI
 * runs it fire-and-forget — a failed verdict appends a neutral suggestion
 * bubble instead of rewriting the displayed answer, so the LLM round-trip can
 * never delay the turn-complete UI or undo streamed content. Skips the
 * rule-based checks (they stay in the engine's synchronous `verifier`, where a
 * hard failure like empty output must still trigger a rewrite).
 */
export function createLLMOnlyVerifier(llm: LLMAdapter, options?: LLMVerifierOptions): Verifier {
  const v = new Verifier();
  v.addCheck(createLLMVerifyCheck(llm, options));
  return v;
}
