// src/cli_toolrow.ts
// v0.1 — Formatting for CLI tool-result rows. Kept out of src/cli.ts so tests
// can import these pure helpers without triggering the CLI's module-level
// `main()` side effect (same pattern as src/cli_permission.ts).

import { sanitizeForTerminal } from './termwidth';

/** Max printed length of a tool failure reason (keeps the transcript clean). */
export const TOOL_ERROR_MAX = 240;

/**
 * Visible width of the ASCII wordmark (4 letters × 10 cols + 3 single-space
 * gaps + 2 tail cols). If the logo box is narrower than this, the wordmark
 * rows cannot be centered without overflowing the right border.
 */
export const LOGO_WORDMARK_W = 10 * 4 + 3 + 2;

/**
 * Decide how the logo's 6 middle rows render for a given box inner width:
 * - `true`  → the full ASCII wordmark row (only when it fits: inner >= W).
 * - `'mark'`→ the compact one-line `PURE` mark (fallback on narrow terminals).
 * - `false` → a blank row.
 *
 * Regression guard: centering a 45-col wordmark inside a 40-col box produced
 * negative padding (clamped to 0) that left the row wider than the border —
 * the fallback keeps every row within the box at any width.
 */
export function logoRowPlan(inner: number): Array<true | 'mark' | false> {
  if (inner >= LOGO_WORDMARK_W) {
    return [true, true, true, true, true, true];
  }
  return [false, false, 'mark', false, false, false];
}

/**
 * Collapse a tool failure reason into a single sanitized, truncated line for
 * the terminal transcript. Tool errors carry what the MODEL sees — command
 * stderr may include ANSI escapes, control bytes and newlines that must not
 * corrupt the terminal or stretch the transcript across dozens of lines.
 * Returns '' for an empty/whitespace-only error.
 */
export function formatToolErrorLine(error: string): string {
  const reason = sanitizeForTerminal(error).replace(/\s+/g, ' ').trim();
  if (!reason) return '';
  return reason.length > TOOL_ERROR_MAX ? `${reason.slice(0, TOOL_ERROR_MAX - 1)}…` : reason;
}
