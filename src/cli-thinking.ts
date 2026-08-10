// src/cli-thinking.ts
// Terminal "thinking" card for the CLI (see src/cli.ts consumeTurn).
//
// Presents the live reasoning stream as a FLAT, BORDERLESS block:
//   💭 thinking
//     … 12 more lines
//     The user is asking for a travel plan
//     from Xi'an to Shanghai…
//
// Constraints from the product requirement:
//  - A quiet flat form (header line + indented plain rows) instead of a boxed
//    frame — box borders made the card look cluttered, and its width/height
//    changes (content growth, terminal resize) were visually jarring as the
//    frame visibly resized. A borderless block reads as a stream, not a frame.
//  - Content too long → the window "scrolls": wrapped lines are capped and the
//    card shows the MOST RECENT lines with a "… N more lines" truncation row
//    at the top (the window follows the newest text).
//  - Card height is capped (header + maxRows content rows).
//  - The thinking TEXT is rendered PLAIN — no bold, no color, no emphasis
//    (a thought trace must never look like highlighted output).
//
// Redraws happen in place with ANSI cursor-up + erase-line sequences. Unlike
// the old single-line `\r\x1b[2K` indicator, the card tracks its own drawn
// height and clears every stale row, so a height change (2 → 6 rows) can never
// leave ghost rows behind.

import { displayWidth } from './termwidth';

export interface ThinkingCardOptions {
  /** Max content rows inside the box (excl. header/footer). Default 7. */
  maxRows?: number;
  /** Max card inner width in display columns. Default 86. */
  maxWidth?: number;
  /** Write sink (process.stdout.write). */
  write: (s: string) => void;
  /** Current terminal width in columns. */
  columns: () => number;
}

/**
 * Wrap a single logical line to `width` display columns (CJK-safe: 全角占 2 列).
 *
 * Word-boundary aware: breaks happen at spaces when possible so words are
 * never cut mid-word ("across" stays intact). Only a word LONGER than the
 * whole line width gets hard-broken into width-sized chunks. Trailing spaces
 * at a visual line end are dropped (they'd be invisible anyway and would
 * misalign the card's right border when a word just misses the width).
 */
export function wrapLine(line: string, width: number): string[] {
  const out: string[] = [];
  let cur = '';
  let curW = 0;

  const flush = (): void => {
    const trimmed = cur.replace(/\s+$/, '');
    if (trimmed.length > 0) out.push(trimmed);
    cur = '';
    curW = 0;
  };

  const tokens = line.match(/\s+|\S+/g) ?? [];
  for (const tok of tokens) {
    const isSpace = /^\s+$/.test(tok);
    const w = displayWidth(tok);
    if (isSpace) {
      if (curW + w > width) flush();
      else { cur += tok; curW += w; }
      continue;
    }
    // A word that doesn't fit on the current line starts a new one (any
    // spaces already accumulated in `cur` would sit at the old line end).
    if (curW > 0 && curW + w > width) flush();
    // Words longer than the whole width: hard-break into chunks.
    if (w > width) {
      if (curW > 0) flush();
      for (const ch of Array.from(tok)) {
        const cw = displayWidth(ch);
        if (curW + cw > width && curW > 0) flush();
        cur += ch;
        curW += cw;
      }
      continue;
    }
    cur += tok;
    curW += w;
  }
  flush();
  if (out.length === 0) out.push('');
  return out;
}

/** Pad a string to `width` DISPLAY columns (CJK-aware — padEnd is UTF-16 based). */
export function padCols(s: string, width: number): string {
  const w = displayWidth(s);
  return w >= width ? s : s + ' '.repeat(width - w);
}

export class ThinkingCard {
  private text = '';
  private start = Date.now();
  private maxRows: number;
  private maxWidth: number;
  private drawn = false;
  private lastDrawnRows = 0;

  constructor(private opts: ThinkingCardOptions) {
    this.maxRows = opts.maxRows ?? 7;
    this.maxWidth = opts.maxWidth ?? 86;
  }

  append(delta: string): void {
    if (!delta) return;
    this.text += delta;
  }

  get charCount(): number {
    return this.text.length;
  }

  get elapsedMs(): number {
    return Date.now() - this.start;
  }

  private innerWidth(): number {
    const cols = this.opts.columns() || 80;
    return Math.max(20, Math.min(this.maxWidth, cols - 6));
  }

  /** Build the full card row set (header + content — flat, no box borders). */
  buildRows(): string[] {
    const W = this.innerWidth();

    // Split into logical lines, wrap each to the card width.
    const wrapped: string[] = [];
    for (const rawLine of this.text.split('\n')) {
      for (const wl of wrapLine(rawLine, W)) wrapped.push(wl);
    }

    // Content rows: cap + tail-following scroll window with a truncation row.
    let truncation: string | null = null;
    let content: string[];
    if (wrapped.length > this.maxRows) {
      const hidden = wrapped.length - (this.maxRows - 1);
      truncation = `… ${hidden} more line${hidden === 1 ? '' : 's'}`;
      content = wrapped.slice(wrapped.length - (this.maxRows - 1));
    } else {
      content = wrapped;
    }
    // Leading blank lines only eat card height — drop them.
    while (content.length > 0 && content[0].trim() === '') content.shift();
    if (content.length === 0) content = ['thinking…'];
    if (content.length > this.maxRows) content.length = this.maxRows;

    const rows: string[] = [];
    // Header: a single flat line. No box frame means a terminal resize or
    // content growth never leaves a misaligned border behind.
    rows.push('💭 thinking');
    if (truncation) rows.push(`  ${truncation}`);
    // Content: indented plain text — no color, no emphasis (a thought trace
    // must never look like highlighted output).
    for (const line of content) rows.push(`  ${line}`);
    return rows;
  }

  /**
   * Draw (first time) or redraw (in place) the card. The card remembers how
   * many rows it last drew and always rewrites from the OLD top row, clearing
   * every stale row — so a height change never leaves ghost rows.
   */
  redraw(): void {
    const rows = this.buildRows();
    const H = rows.length;
    if (this.drawn && this.lastDrawnRows > 0) {
      this.opts.write(`\r\x1b[${this.lastDrawnRows - 1}A`);
    }
    const total = Math.max(H, this.drawn ? this.lastDrawnRows : H);
    for (let i = 0; i < total; i++) {
      this.opts.write('\x1b[2K');
      if (i < H) this.opts.write(rows[i]);
      if (i < total - 1) this.opts.write('\n');
    }
    this.lastDrawnRows = H;
    this.drawn = true;
  }

  /**
   * Erase the card from the screen entirely. After 2K-erasing each row the
   * card rows would otherwise remain as BLANK lines (a terminal only blanks
   * a line, it doesn't remove it) — so we jump back to the card's top row and
   * DELETE the rows with the DL sequence (`ESC[{n}M`), scrolling any content
   * below upward. The cursor ends on the card's top row, ready for the caller
   * to write the collapse summary there with no blank-line residue. Terminals
   * without DL support just ignore the sequence (graceful fallback to blanks).
   */
  clear(): void {
    if (!this.drawn || this.lastDrawnRows <= 0) return;
    const H = this.lastDrawnRows;
    // 1) Blank every card row in place (cursor ends on the last row).
    this.opts.write(`\r\x1b[${H - 1}A`);
    for (let i = 0; i < H; i++) {
      this.opts.write('\x1b[2K');
      if (i < H - 1) this.opts.write('\n');
    }
    // 2) Actually REMOVE the card rows: back to the top row, delete H lines
    //    (DL scrolls content below upward; nothing follows the card in the
    //    CLI flow, so this cleanly deletes the whole card block).
    this.opts.write(`\r\x1b[${H - 1}A`);
    this.opts.write(`\x1b[${H}M`);
    this.drawn = false;
    this.lastDrawnRows = 0;
  }

  /** Erase the card and return a one-line summary to print in its place. */
  collapse(): string {
    const secs = (this.elapsedMs / 1000).toFixed(1);
    const summary = `  💭 thinking · ${secs}s · ${this.charCount} chars`;
    this.clear();
    return summary;
  }
}
