// src/termwidth.ts
// Terminal display-width helpers + model-text sanitizer.
//
// Why width matters: a terminal line's physical length is measured in DISPLAY
// COLUMNS, not JS string length. East Asian Wide / Fullwidth characters
// (CJK, fullwidth punctuation, emoji, …) occupy 2 columns each, so a preview
// truncated by `str.length` can be visually twice as wide as intended. When a
// line exceeds the terminal width it WRAPS, and a `\r\x1b[2K` in-place redraw
// only clears the current row — the wrapped remnant rows stay on screen and
// pile up as garbled fragments (the CLI thinking-preview bug: 66 UTF-16 chars
// of mixed Chinese/English measured up to 102 columns on an 80-col terminal).
//
// The ranges below are the standard East Asian Wide/FULLWIDTH (W/F) set from
// wcwidth (Unicode EastAsianWidth.txt), which is what terminals use to decide
// whether a character advances the cursor by 1 or 2 columns.

/** Display width in terminal columns (East Asian Wide/Fullwidth = 2). */
export function displayWidth(s: string): number {
  let w = 0;
  for (const ch of s) {
    const o = ch.codePointAt(0)!;
    if (
      // East Asian Wide / Fullwidth (wcwidth W+F table)
      (o >= 0x1100 && (o <= 0x115f || o === 0x2329 || o === 0x232a ||
        (0x2e80 <= o && o <= 0xa4cf && o !== 0x303f) || (0xac00 <= o && o <= 0xd7a3) ||
        (0xf900 <= o && o <= 0xfaff) || (0xfe10 <= o && o <= 0xfe19) ||
        (0xfe30 <= o && o <= 0xfe6f) || (0xff00 <= o && o <= 0xff60) ||
        (0xffe0 <= o && o <= 0xffe6))) ||
      // Emoji presentation ranges (misc symbols + emoticons + transport &
      // map + supplemental symbols + symbols&pictographs ext-A) and
      // astral-plane wide characters (CJK ext B+)
      (o >= 0x1f300 && o <= 0x1f64f) || (o >= 0x1f680 && o <= 0x1f6ff) ||
      (o >= 0x1f900 && o <= 0x1f9ff) || (o >= 0x1fa70 && o <= 0x1faff) ||
      (o >= 0x20000 && o <= 0x2fffd) || (o >= 0x30000 && o <= 0x3fffd)
    ) {
      w += 2;
    } else {
      w += 1;
    }
  }
  return w;
}

/**
 * Longest SUFFIX of `s` whose display width fits within `maxCols` (walked from
 * the end so CJK/emoji surrogate pairs are never split). Used to build the
 * `…`-prefixed tail preview in the CLI thinking line: the ellipsis takes 1
 * column, so callers pass `maxCols - 1` for the tail itself.
 */
export function fitTail(s: string, maxCols: number): string {
  // Walk by CODE POINTS (Array.from), never string indices — indexing a
  // surrogate pair returns a lone surrogate, which would split an emoji in
  // half and emit U+FFFD replacement garbage.
  const chars = Array.from(s);
  let w = 0;
  let i = chars.length;
  while (i > 0) {
    const cw = displayWidth(chars[i - 1]);
    if (w + cw > maxCols) break;
    w += cw;
    i--;
  }
  return chars.slice(i).join('');
}

/**
 * Strip anything that would corrupt a terminal if written raw: ANSI escape
 * sequences (CSI colors/cursor, OSC titles/hyperlinks, charset selects) and
 * C0 control characters other than newline/tab (CR is stripped too — a raw
 * carriage return mid-answer overwrites the current line). Model reasoning
 * and answer streams occasionally leak such bytes; the thinking preview
 * collapses whitespace anyway, so this only removes invisible or harmful
 * content. Used by the CLI thinking line AND the streamed answer output.
 */
export function sanitizeForTerminal(s: string): string {
  return s
    // CSI: ESC [ params... final (colors, cursor motion, erase, …)
    .replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '')
    // OSC: ESC ] ... BEL or ESC ] ... ESC \ (window title, hyperlinks) —
    // stop the body at the first BEL OR ESC so a trailing \x1b\\ ST inside
    // a hyperlink payload can't swallow the visible link text after it.
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')
    // Charset select: ESC ( / ESC ) + one char
    .replace(/\x1b[()][0-9A-Za-z]/g, '')
    // C0 controls except \n \t (bell, backspace, NUL, CR, …) + DEL
    .replace(/[\u0000-\u0008\u000b-\u000d\u000e-\u001f\u007f]/g, '');
}
