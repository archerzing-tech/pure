// src/shared/powershellOutput.ts
// PowerShell's redirected-stderr noise. When stderr is a pipe, powershell.exe
// serializes its progress/verbose records as CLIXML — an `<Objs>` document,
// sometimes preceded by a `#< CLIXML` header line — and the module warm-up
// record ("Preparing modules for first use.") is written that way on the first
// command of a fresh process, again when a module is auto-loaded mid-command.
// Left in place it leaks into user-visible error messages and the model's tool
// observations, so it is removed wherever captured PowerShell output is read.
//
// Shared because two surfaces capture PowerShell output for the same reasons:
// the Node tool adapter (execute_command) and the user-hook runner
// (hooks.json). The GUI bundle must not reach into adapter/node for it, hence
// the module lives here.

const WARMUP_MARKER = /<AV>Preparing modules for first use\.<\/AV>/i;
const ERROR_RECORD = /<S\s+S="Error">/i;
/** One warm-up CLIXML document: optional `#< CLIXML` header, the `<Objs>` body
 *  carrying the warm-up record, up to its closing tag. The header is OPTIONAL —
 *  on Windows runners the captured stream often starts straight at `<Objs>`,
 *  which is why matching on the header alone missed the blob entirely. */
const WARMUP_DOCUMENT = /(?:#<\s*CLIXML\s*)?<Objs\b[\s\S]*?<AV>Preparing modules for first use\.<\/AV>[\s\S]*?<\/Objs>\s*/gi;

/**
 * Remove the module warm-up CLIXML document(s) from captured PowerShell output.
 *
 * Returns the input unchanged when no warm-up record is present, and when the
 * stream carries a real `<S S="Error">` record — a CLIXML document can hold
 * both, and cutting it would lose the error the caller must see.
 *
 * Only the warm-up document SEGMENTS are cut out: text the command itself
 * wrote, before or after them, is kept. Blanket-emptying the stream would
 * swallow a hook's own message whenever PowerShell interleaved it with the
 * warm-up record, and a hook's stderr is exactly where an on_pre_tool veto
 * gets its reason from.
 */
export function stripPowerShellStartupProgress(output: string): string {
  const text = output.trim();
  if (!WARMUP_MARKER.test(text)) return output;
  if (ERROR_RECORD.test(text)) return output;

  const cleaned = text.replace(WARMUP_DOCUMENT, '');
  if (cleaned === text) return output; // marker outside a cuttable document
  // Blank lines the removed documents left behind are dropped: the result
  // reads as the command's own output alone.
  return cleaned.replace(/\n{3,}/g, '\n\n').trim();
}
