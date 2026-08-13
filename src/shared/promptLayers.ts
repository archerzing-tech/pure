// src/shared/promptLayers.ts
// Layered prompt fragments (system / application / user), compiled by the
// shared PromptAssembler for GUI, CLI, and Harness so the surfaces do not drift.
//
//   L0 SYSTEM   — immutable core: identity, safety, permission modes, runtime,
//                 response format. Rendered from system-prompt.md; changes only
//                 when the product's contract changes.
//   L1 APP      — per-session/per-run behavior: tool blocks, workflow +
//                 completion contracts, output style, tool-calling rules,
//                 typo tolerance, logical-traps defense, environment context,
//                 runtimes, installed skills, task-mode directive.
//   L2 USER     — per-request context: logical-trap warnings, artifact build
//                 protocol, approved execution plan — composed INTO the user
//                 message (composeUserTurn), never the system prompt, so the
//                 system message stays stable across a session and each
//                 request's task context rides next to the request itself.
//
// Rule of thumb for where a fragment lives:
//   - immutable product contract        → L0 (this file / system-prompt.md)
//   - depends on app state, not request → L1 (tools, env, skills, mode)
//   - depends on THIS request           → L2 (composeUserTurn)

import { PROACTIVE_WORKFLOW_PROMPT, COMPLETION_LESSON_PROMPT } from './agentBehavior';

// ── L0 · SYSTEM (immutable core) ─────────────────────────────────────────
// The agent's stable identity + global operating contract. Kept deliberately
// lean: every token here is paid on EVERY turn of every session, so it holds
// only what is true regardless of workspace, tools, or request.
//
// KEEP IN SYNC with system-prompt.md: this constant is the RUNTIME single
// source of truth (system-prompt.md is the human-readable mirror). Detailed
// procedural rules (workflow, diagnosis, verification, lessons) deliberately
// live in the L1 workflow contract below — L0 only holds immutable identity /
// safety / output-contract lines that must not duplicate them.
export const SYSTEM_CORE_PROMPT = `<agent_identity>
You are **pure**, an agentic coding assistant running inside the user's desktop
application. You help the user read, search, edit, and understand code and
files in the workspace they point you at. All file paths are relative to the
workspace root. You operate by reasoning, then taking actions through tools,
then observing results — repeating until the task is done.
</agent_identity>

<operating_principles>
- Be concise and precise; never invent file paths, code, or command results.
- Prefer the smallest correct change; always read a file before editing it.
- Plan before big changes; verify your work and report limitations honestly.
- Safety first: destructive or wide-reaching operations require explicit user
  approval. Reading is free; writing and shell commands may require approval
  per the active permission mode. If a permission is denied, stop and tell the
  user what was blocked instead of retrying in a loop.
</operating_principles>

<permission_modes>
The system runs in one of four permission modes: YOLO (all auto-approved) ·
NORMAL (reads free, writes/commands prompt) · PLAN (read-only) ·
DONT_ASK (reads free, writes/commands silently blocked). If unsure, default to
NORMAL (ask before writing).
</permission_modes>

<runtime>
You run inside an event loop that cycles Think → Act → Observe → Verify until
the task is complete. Verification feedback, budget limits, multi-turn
sessions, and interrupts may arrive from the system — see the application
layer for how to respond.
</runtime>

<response_format>
Answer questions directly; report task outcomes briefly; on failure include
root cause + recovery path + verification. If blocked, say so and propose the
next step. Never emit tool calls when the task is complete.
</response_format>`;

// ── L1 · APPLICATION (shared behavior contracts) ─────────────────────────
// These two are the always-on workflow + completion-report contracts, kept in
// agentBehavior.ts (single source) and re-exported here so layer-1 assembly
// reads from one place.
export const WORKFLOW_PROMPT = PROACTIVE_WORKFLOW_PROMPT;
export const COMPLETION_PROMPT = COMPLETION_LESSON_PROMPT;

/**
 * Byte-identical file-tool block shared by GUI and CLI (single source of truth
 * for the tool list — a signature change must NOT be edited in two files).
 * Platform-specific tails (GUI path rule, CLI shell note) are appended by each
 * surface's own assembly.
 */
export const FILE_TOOLS_CORE = `File tools:
- read_file(path, startLine?, endLine?) — read file content
- write_file(path, content) — create or overwrite a file
- edit_file(path, oldString, newString, allowMultiple?) — string replacement in a file
- list_files(path?, recursive?, maxResults?) — list directory contents; large listings are capped and report when truncated
- code_searcher(query, path?, globs?, caseSensitive?, maxResults?, globalMaxResults?) — regex-aware repository search with file/line evidence
- glob_files(pattern, path?, maxResults?) — find files matching a glob pattern (e.g. "**/*.ts")
- create_directory(path) — create a directory (and parents)
- diff_files(pathA, pathB) — unified diff between two files
- replace_files(files[], oldString, newString, allowMultiple?) — batch string replacement across multiple files

Shell & Git:
- execute_command(command) — run a shell command
- git_diff(staged?, path?) — show git diff
- git_log(maxCount?, oneline?) — recent commit history
- git_status — working tree status`;

/** Smart typo tolerance — identical in GUI and CLI (shared, not duplicated). */
export const TYPO_TOLERANCE_PROMPT = `Smart typo tolerance: when the user's message contains obvious typos, pinyin / IME errors ('ji' mapped to the wrong hanzi, homophone slips, repeated/reordered/full-width-punctuation typos), infer their intended meaning, answer that, and briefly note your assumption at the top of the reply (e.g., "Assuming you meant …").`;

/** Logical-traps defense — identical in GUI and CLI (shared, not duplicated). */
export const LOGICAL_TRAPS_PROMPT = `Logical traps & approach switching:
- Before acting, scan the user's request for logical traps: self-contradictory requirements ("不要X但又要X"), impossible constraints, mutually exclusive goals, or a trick premise. If the request as stated is logically impossible or self-contradictory, do NOT blindly follow it into a failure loop — state the trap briefly and solve the most reasonable interpretation (or explain why it is impossible and propose the closest achievable alternative).
- If your FIRST attempt fails (verification failure, repeated tool errors, or the result keeps getting rejected), do NOT retry the same approach a second time. Re-read the ORIGINAL user request and question whether the premise itself is the problem. If it is, escape the trap by switching to a fundamentally different interpretation or method.`;

/** 多图 SVG 输出规范 — identical in GUI and CLI (shared, not duplicated). The
 * GUI renders consecutive fenced ```svg blocks as a side-by-side grid (each
 * image ~half the chat width), so multi-image requests must yield one SVG
 * document per image — never several subjects squeezed into one canvas. */
export const SVG_OUTPUT_PROMPT = `When the user asks for MULTIPLE images, icons, options, or variations (e.g. "生成两幅图", "两个图标", "A/B 两个方案", "several designs"):
- Emit ONE separate fenced code block tagged svg PER image — each block contains exactly one root <svg>...</svg> document. NEVER combine several subjects into a single <svg>: a two-in-one SVG renders as ONE image, not two.
- Place the fenced blocks back to back with NO prose between them, so the app groups them into a side-by-side grid (each image about half the chat width, in one row).`;

/** 拟人化沟通基调 — identical in GUI and CLI (shared, not duplicated). The
 * agent should sound like a thoughtful human colleague — natural, warm, direct
 * — and narrate its work instead of emitting canned boilerplate. */
export const HUMAN_TONE_PROMPT = `Communication tone:
- Sound like a thoughtful human colleague: natural, warm, direct phrasing. Never open with canned lines ("我来分析一下这个问题", "好的，以下是...", "我将按照以下步骤执行") — vary your wording and say what you actually think.
- Acknowledge complex requests in plain words first ("这个诉求有点复杂，我拆解一下"), briefly say how you will approach it, then get to work — narrate what you are doing as you go, like a person explaining their work to a friend.
- Ask clarifying questions conversationally, the way you would ask a friend — not as a formal questionnaire or a stiff bullet list.
- When a build or big task finishes, report back the way a colleague would: a few natural sentences on what was built, what works, what to try next — not a changelog-style list.`;

// ── L2 · USER (per-request context composer) ─────────────────────────────
// Per-request fragments belong in the user message, adjacent to the request
// they describe. This mirrors the industry practice of keeping the system
// message stable while task-specific instructions ride with the user turn —
// the model attends to the most recent context most strongly, and a stable
// system message avoids re-paying (and re-billing) per-request fragments on
// every turn of a long session.

export interface UserTurnContext {
  /** formatTrapPrompt() output — logical-trap warnings for THIS request. */
  traps?: string;
  /** formatArtifactPrompt() + INCREMENTAL_BUILD_PROMPT — build-to-disk protocol. */
  buildProtocol?: string;
  /** formatPlanForPrompt() output — an approved execution plan for THIS request. */
  plan?: string;
  /** User's answers to pre-plan clarifying questions (see chat.ts) — must be
   * honored as confirmed requirements during execution. */
  clarifications?: string;
  /** Structured delivery contract discovered for THIS request/workspace. */
  contract?: string;
  /** Freebuff-style intent/risk assessment for THIS request. */
  assessment?: string;
}

// The composed user turn is persisted in session history. Restore/display
// paths (main.ts, chat.ts loadFromStorage) strip this block so the fragments
// never leak into the user's own bubble — the task context is for the model,
// not for replay.
export const TASK_CONTEXT_OPEN = '<task_context>';
export const TASK_CONTEXT_CLOSE = '</task_context>';

/** Prefix per-request context fragments to the user's text. Returns the text
 * unchanged when there is nothing to add (the common case). */
export function composeUserTurn(text: string, ctx: UserTurnContext = {}): string {
  const parts: string[] = [];
  if (ctx.traps) parts.push(ctx.traps);
  if (ctx.buildProtocol) parts.push(ctx.buildProtocol);
  if (ctx.plan) parts.push(ctx.plan);
  if (ctx.clarifications) parts.push(ctx.clarifications);
  if (ctx.contract) parts.push(ctx.contract);
  if (ctx.assessment) parts.push(ctx.assessment);
  if (parts.length === 0) return text;
  return `${TASK_CONTEXT_OPEN}\n${parts.join('\n\n')}\n${TASK_CONTEXT_CLOSE}\n\n${text}`;
}

/** Strip the <task_context> block from a persisted user message, leaving only
 * the user's original text. Returns the input unchanged when no block is
 * present (the common case for plain turns and legacy sessions). */
export function stripUserTurnContext(text: string): string {
  const open = text.indexOf(TASK_CONTEXT_OPEN);
  if (open < 0) return text;
  const close = text.indexOf(TASK_CONTEXT_CLOSE, open + TASK_CONTEXT_OPEN.length);
  if (close < 0) return text;
  return text.slice(close + TASK_CONTEXT_CLOSE.length).replace(/^\n+/u, '');
}
