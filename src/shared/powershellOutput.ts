// src/shared/powershellOutput.ts
// PowerShell's redirected-stderr noise. When stderr is a pipe, powershell.exe
// serializes its progress/verbose records as CLIXML — an `<Objs>` document,
// sometimes preceded by a `#< CLIXML` header line — and the module warm-up
// record ("Preparing modules for first use.") is written that way on the first
// command of a fresh process, again when a module is auto-loaded mid-command.
// Left in place it leaks into user-visible error messages and the model's tool
// observations, so it is removed wherever captured PowerShell output is read.
// The wrapper is written in two pieces — the header goes out as soon as the
// stream is redirected, the document when the record is serialized — so either
// piece can be captured alone and each is handled on its own.
// Shared because two surfaces capture PowerShell output for the same reasons:
// the Node tool adapter (execute_command) and the user-hook runner
// (hooks.json). The GUI bundle must not reach into adapter/node for it, hence
// the module lives here.

/** Anything PowerShell's CLIXML wrapper leaves behind: the `#< CLIXML` header
 *  line, a serialized `<Objs>` document, or both. Used only to decide whether a
 *  stream is worth looking at — every cut below proves itself separately. */
const CLIXML_HINT = /#<\s*CLIXML|<Objs\b/i;
/** One warm-up CLIXML document: optional `#< CLIXML` header, the `<Objs>` body
 *  carrying the warm-up record, up to its closing tag. The header is OPTIONAL —
 *  on Windows runners the captured stream often starts straight at `<Objs>`,
 *  which is why matching on the header alone missed the blob entirely. */
const WARMUP_DOCUMENT = /(?:#<\s*CLIXML\s*)?<Objs\b[\s\S]*?<AV>Preparing modules for first use\.<\/AV>[\s\S]*?<\/Objs>\s*/gi;
/** A warm-up document the stream cut short: its opening tag never gets a
 *  closing one, so everything from the tag to the end of the stream is the
 *  unfinished document (the same release run delivered documents both ways —
 *  PowerShell was serializing the record while the process was exiting). The
 *  tempered body rejects a `</Objs>` in between, so an unrelated CLIXML shape
 *  that merely sits earlier in the stream is never swallowed. */
const TRUNCATED_WARMUP_DOCUMENT =
  /(?:#<\s*CLIXML\s*)?<Objs\b(?:(?!<\/Objs>)[\s\S])*?<AV>Preparing modules for first use\.<\/AV>(?:(?!<\/Objs>)[\s\S])*$/i;

/** A `#< CLIXML` header line the serialized document never followed. Observing
 *  one is a hard fact, not a guess: the header is written as soon as the stream
 *  is redirected, while the document is serialized later (or, when the process
 *  is on its way out, never). The 2.2.6-alpha release run captured exactly this
 *  — the hook's stderr arrived as the bare header — and it still reached the
 *  caller as a veto reason. A header whose next line opens a document is left
 *  for the document rules to own, so a CLIXML shape we do not understand is
 *  never cut in half. The end anchor is `$(?![\s\S])` rather than a bare `$`:
 *  in multiline mode a bare `$` also matches at every line end, which would
 *  strip the header off a document that does follow it. */
const STRANDED_CLIXML_HEADER =
  /^[ \t]*#<[ \t]*CLIXML[ \t]*\r?\n(?![ \t]*<Objs)|^[ \t]*#<[ \t]*CLIXML[ \t]*$(?![\s\S])/gim;

/** CLIXML escapes what XML cannot carry: `_xHHHH_` for control characters
 *  (notably `_x000D__x000A_` for CRLF) plus the five XML entities. Same decode
 *  as Rust's decode_clixml_escapes — the two must stay in lockstep. */
function decodeClixmlEscapes(text: string): string {
  const unescaped = text.replace(/_x([0-9A-Fa-f]{4})_/g, (_m, hex: string) => {
    const code = Number.parseInt(hex, 16);
    if (!Number.isFinite(code)) return '';
    try {
      return String.fromCodePoint(code);
    } catch {
      return ''; // lone surrogate — Rust's char::from_u32 maps it to nothing too
    }
  });
  return unescaped
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

/** Pull the text back out of a CLIXML envelope's `<S S="…">…</S>` stream
 *  records, keeping whatever the command wrote before the envelope. Returns
 *  null when the stream is not an envelope carrying stream records — the
 *  caller then falls through to the conservative wrapper-only cuts below (an
 *  envelope with no stream records may be an unknown shape we must not drop;
 *  a truncated error record has no `</S>` to close it, so nothing is
 *  extracted and the raw bytes stay visible). Mirror of Rust unwrap_clixml:
 *  a real error record serialized as XML (every PS 5.1 stderr write under
 *  redirection, Windows 判例 2026-11-14 任务 2) reached the model as one
 *  opaque `<Objs>` blob — the text inside is the actual failure. */
function unwrapClixmlStreamRecords(text: string): string | null {
  const m = /#<\s*CLIXML|<Objs\b/i.exec(text);
  if (!m) return null;
  const head = text.slice(0, m.index).trimEnd();
  const records: string[] = [];
  let rest = text.slice(m.index);
  for (;;) {
    const start = rest.indexOf('<S S="');
    if (start === -1) break;
    const after = rest.slice(start);
    const gt = after.indexOf('>');
    const end = after.indexOf('</S>');
    if (gt === -1 || end === -1 || end <= gt) break; // truncated/malformed record
    const decoded = decodeClixmlEscapes(after.slice(gt + 1, end).trim());
    if (decoded.trim()) records.push(decoded);
    rest = after.slice(end + '</S>'.length);
  }
  if (records.length === 0) return null;
  return head ? `${head}\n${records.join('\n')}` : records.join('\n');
}

/**
 * Remove PowerShell's CLIXML wrapper from captured output: the module warm-up
 *  document(s), truncated ones included, any `#< CLIXML` header left behind
 *  without one, and the XML envelope around a real `<S S="Error">` record —
 *  the record's TEXT is unwrapped and kept, so the failure the caller must
 *  see survives without the `<Objs>` markup around it.
 *
 * Returns the input unchanged when the stream carries no CLIXML at all and
 * when nothing is attributable to the wrapper.
 *
 * Only wrapper SEGMENTS are cut out: text the command itself wrote, before or
 * after them, is kept. Blanket-emptying the stream would swallow a hook's own
 * message whenever PowerShell interleaved it with the warm-up record, and a
 * hook's stderr is exactly where an on_pre_tool veto gets its reason from.
 */
export function stripPowerShellStartupProgress(output: string): string {
  const text = output.trim();
  if (!CLIXML_HINT.test(text)) return output; // no PowerShell wrapper at all
  const unwrapped = unwrapClixmlStreamRecords(text);
  if (unwrapped !== null) return unwrapped;

  const cleaned = text
    .replace(WARMUP_DOCUMENT, '')
    .replace(TRUNCATED_WARMUP_DOCUMENT, '')
    .replace(STRANDED_CLIXML_HEADER, '');
  if (cleaned === text) return output; // nothing attributable was cut
  // Blank lines the removed wrapper left behind are dropped: the result reads
  // as the command's own output alone.
  return cleaned.replace(/\n{3,}/g, '\n\n').trim();
}
