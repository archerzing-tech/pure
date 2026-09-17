// src/shared/powershellOutput.ts
// PowerShell's redirected-stderr noise. When stderr is a pipe, powershell.exe
// serializes its progress/verbose records as CLIXML and prefixes them with
// `#< CLIXML` — the "Preparing modules for first use." blob, written when the
// host starts and again when a module is auto-loaded on first use, possibly
// interleaved with the command's own output. Left in place it leaks into
// user-visible error messages and the model's tool observations, so it is
// removed wherever captured PowerShell output is read.
//
// Shared because two surfaces capture PowerShell output for the same reasons:
// the Node tool adapter (execute_command) and the user-hook runner
// (hooks.json). The GUI bundle must not reach into adapter/node for it, hence
// the module lives here.

const CLIXML_HEADER = '#< CLIXML';
const WARMUP_MARKER = /<AV>Preparing modules for first use\.<\/AV>/i;
const ERROR_RECORD = /<S\s+S="Error">/i;
const BLOB_END = '</Objs>';

/**
 * Remove the module warm-up CLIXML blob(s) from captured PowerShell output.
 *
 * Returns the input unchanged when there is no CLIXML blob, when a blob
 * carries a real `<S S="Error">` record (genuine error output the caller must
 * see), or when the CLIXML holds anything other than the warm-up progress.
 *
 * Only the blob SEGMENTS are cut out — text the command itself wrote, before
 * or after them, is kept. Blanket-emptying the stream would swallow a hook's
 * own message whenever PowerShell interleaved it with the warm-up record, and
 * a hook's stderr is exactly where an on_pre_tool veto gets its reason.
 */
export function stripPowerShellStartupProgress(output: string): string {
  const text = output.trim();
  if (!text.includes(CLIXML_HEADER)) return output;
  if (ERROR_RECORD.test(text)) return output;
  if (!WARMUP_MARKER.test(text)) return output;

  const kept: string[] = [];
  let cursor = 0;
  while (cursor < text.length) {
    const start = text.indexOf(CLIXML_HEADER, cursor);
    if (start < 0) break;
    const end = text.indexOf(BLOB_END, start);
    if (end < 0) break; // truncated blob — nothing safe to cut from here on
    kept.push(text.slice(cursor, start));
    cursor = end + BLOB_END.length;
  }
  kept.push(text.slice(cursor));
  // Blank lines the blobs left behind are dropped: the result reads as the
  // command's output alone.
  return kept.map((part) => part.trim()).filter(Boolean).join('\n');
}
