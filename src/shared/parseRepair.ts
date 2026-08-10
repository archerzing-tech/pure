// src/shared/parseRepair.ts
// Smart fault tolerance for model-generated / user-supplied structured content.
//
// LLM output and hand-edited documents frequently carry small syntax errors:
// trailing commas, single quotes, unquoted keys, markdown code fences, prose
// wrappers, full-width punctuation, JS-style constants, stray backticks. Each
// repair function below applies a small, *parse-gated* set of fixes: a rewrite
// is only ever returned as `repaired: true` when it actually parses (JSON), or
// when it is a structurally safe rewrite the caller retries once (mermaid/svg,
// where the caller re-renders and keeps the original error on failure).
//
// When nothing helps, the original source is returned untouched
// (`repaired: false`) and the caller falls back to its existing error path —
// error state + retry + hand-off to the user. A successful repair therefore
// never produces garbage: it only ever unlocks content that already existed.

export interface ParseRepairResult {
  /** True when the source was rewritten into something that parses / is retried. */
  repaired: boolean;
  /** The repaired text (identical to `source` when `repaired` is false). */
  source: string;
}

// ═══════════════════════════════════════════════════════════════════════
// JSON
// ═══════════════════════════════════════════════════════════════════════


/**
 * Extract the first balanced `{…}` / `[…]` payload from surrounding prose
 * ("Here is the data: {…} hope that helps"). Uses a quote-aware depth scan so
 * braces inside strings never confuse the balance.
 */
function extractJsonPayload(text: string): string {
  const t = text.trim();
  const start = t.search(/[{[]/);
  if (start < 0) return t;
  const open = t[start];
  const close = open === '{' ? '}' : ']';
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < t.length; i++) {
    const ch = t[i];
    if (inString) {
      if (escaped) { escaped = false; continue; }
      if (ch === '\\') { escaped = true; continue; }
      if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') { inString = true; continue; }
    if (ch === open) depth++;
    else if (ch === close) {
      depth--;
      if (depth === 0) return t.slice(start, i + 1);
    }
  }
  return t.slice(start);
}

/** `,}` / `,]` → `}` / `]` (trailing commas after the last element). */
function fixTrailingCommas(s: string): string {
  return s.replace(/,(\s*[}\]])/g, '$1');
}

/** `{key:` / `,key:` → `{"key":` / `,"key":` (already-quoted keys are skipped by the regex). */
function fixUnquotedKeys(s: string): string {
  return s.replace(/([{,]\s*)([A-Za-z_$][A-Za-z0-9_$]*)\s*:/g, '$1"$2":');
}

/** `'…'` → `"…"` — only when the content contains no double quote (would corrupt). */
function fixSingleQuotedStrings(s: string): string {
  return s.replace(/'((?:[^'\\]|\\.)*)'/g, (m, inner: string) =>
    inner.includes('"') ? m : `"${inner}"`);
}

/** Full-width punctuation LLMs love to emit: ，：（）“”‘’ → ASCII. */
function fixFullWidthPunctuation(s: string): string {
  return s
    .replace(/，/g, ',')
    .replace(/：/g, ':')
    .replace(/[“”]/g, '"')
    .replace(/[‘’]/g, "'")
    .replace(/（/g, '(')
    .replace(/）/g, ')');
}

/** JS-isms: True/False/None/undefined → JSON literals; NaN/±Infinity → null. */
function fixJavaScriptConstants(s: string): string {
  return s
    .replace(/\b(True|False|None|undefined)\b/g, (m) => {
      if (m === 'True') return 'true';
      if (m === 'False') return 'false';
      return 'null';
    })
    .replace(/-?\b(Infinity|NaN)\b/g, 'null');
}

/** `} {` / `] [` / mixed → `},{` / `],[` … (adjacent top-level elements). */
function fixMissingCommas(s: string): string {
  return s
    .replace(/}\s*{/g, '},{')
    .replace(/\]\s*\[/g, '],[')
    .replace(/}\s*\[/g, '},[')
    .replace(/\]\s*{/g, '],{');
}

/** Remove `// line` and `/* block *&#47;` comments — string-aware so URLs survive. */
function stripJsonComments(s: string): string {
  let out = '';
  let inString = false;
  let escaped = false;
  let i = 0;
  while (i < s.length) {
    const ch = s[i];
    const next = s[i + 1];
    if (inString) {
      out += ch;
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      i++;
      continue;
    }
    if (ch === '"') { inString = true; out += ch; i++; continue; }
    if (ch === '/' && next === '/') {
      while (i < s.length && s[i] !== '\n') i++;
      continue;
    }
    if (ch === '/' && next === '*') {
      i += 2;
      while (i < s.length - 1 && !(s[i] === '*' && s[i + 1] === '/')) i++;
      i += 2;
      continue;
    }
    out += ch;
    i++;
  }
  return out;
}

/**
 * Upper bound on the number of BFS candidates `repairJsonSource` processes
 * before giving up. Real payloads resolve in well under 20 nodes (every fixer
 * is a global, parse-gated transform, so the distinct reachable states stay
 * small), making this pure defense against adversarial or glitched input
 * inflating the fix queue. Exhausting the budget returns the original source
 * unrepaired — the caller's normal error path handles it instead of a hang.
 */
export const MAX_REPAIR_CANDIDATES = 200;

/**
 * Repair a JSON string. Valid input passes through untouched
 * (`repaired: false`). Broken input gets every fix combination explored in a
 * breadth-first queue; the FIRST result that parses is returned. Exploration
 * is bounded by `maxCandidates` (default `MAX_REPAIR_CANDIDATES = 200`
 * processed nodes) so a pathological input can never blow up the queue.
 * Returns `repaired: false` with the original source when nothing parses
 * within the budget.
 *
 * With `structuralOnly: true` (user-data imports), content-mutating fixers
 * are skipped so string VALUES are never altered — only syntax is repaired.
 */
export function repairJsonSource(
  source: string,
  opts?: { structuralOnly?: boolean; maxCandidates?: number },
): ParseRepairResult {
  let s = source.replace(/^\uFEFF/, '').trim();
  if (!s) return { repaired: false, source };

  // Already valid → nothing to repair.
  try { JSON.parse(s); return { repaired: false, source }; } catch { /* keep going */ }

  const candidates = [s];
  const fence = unwrapFence(s, ['json']);
  if (fence) candidates.push(fence.trim());
  const extracted = extractJsonPayload(s);
  if (extracted !== s) candidates.push(extracted);

  // Content-mutating fixers (full-width punctuation, JS constants) are fine
  // for display content but must be excluded for user data imports, where
  // string VALUES are the payload and must not be silently altered.
  const contentFixers: Array<(t: string) => string> = opts?.structuralOnly
    ? []
    : [fixFullWidthPunctuation, fixJavaScriptConstants];
  const fixers: Array<(t: string) => string> = [
    ...contentFixers,
    fixTrailingCommas,
    fixSingleQuotedStrings,
    fixUnquotedKeys,
    fixMissingCommas,
    stripJsonComments,
  ];

  const seen = new Set(candidates);
  const queue = [...candidates];
  const maxCandidates = opts?.maxCandidates ?? MAX_REPAIR_CANDIDATES;
  let processed = 0;
  while (queue.length > 0 && processed < maxCandidates) {
    const base = queue.shift()!;
    processed++;
    // A derived candidate may ALREADY parse as-is (e.g. the fence-unwrapped or
    // prose-extracted payload) — test it before applying further fixes.
    try {
      JSON.parse(base);
      return { repaired: true, source: base };
    } catch { /* apply the fix pipeline below */ }
    for (const fix of fixers) {
      const next = fix(base).trim();
      if (next === base || seen.has(next)) continue;
      seen.add(next);
      queue.push(next);
    }
  }
  // Budget exhausted without a parse — total strings ever created stay
  // bounded (≤ 7·max + 3: 7 fixers × processed nodes, plus the seed), and the
  // caller's error path takes over instead of a hang.
  return { repaired: false, source };
}

// ═══════════════════════════════════════════════════════════════════════
// Mermaid
// ═══════════════════════════════════════════════════════════════════════

const MERMAID_TYPE_RE = /^(?:graph|flowchart|sequenceDiagram|classDiagram|stateDiagram|erDiagram|gantt|pie|journey|mindmap|timeline|quadrantChart|requirementDiagram|gitGraph|block-beta|packet-beta|xychart-beta|sankey-beta|architecture-beta|C4Context)\b/;

/** Unwrap a markdown code fence with an optional language tag (json/mermaid/svg/…). */
function unwrapFence(s: string, langs: string[]): string | null {
  const lang = langs.join('|');
  // NB: a real newline after the lang tag is REQUIRED — a greedy \s* here
  // would swallow the first content line's indentation.
  const m = s.match(
    new RegExp('^\\s*```(?:' + lang + ')?[ \\t]*\\r?\\n([\\s\\S]*?)\\r?\\n[ \\t]*```[ \\t]*$', 'i'),
  );
  return m ? m[1] : null;
}

/** A trailing line that can never be a complete mermaid statement (cut mid-edge). */
const INCOMPLETE_TAIL_RE = /^(?:[A-Za-z0-9_\[\]"']*-->?|<--?|--|\.->|==>)$/;

/** Lines whose double quotes are label/title delimiters (tracked for balance). */
const MERMAID_QUOTE_PREFIX_RE = /^(?:subgraph|click|link|x-axis|y-axis|Note|note|title|state|section|participant|actor)\b/i;

/**
 * Balance one mermaid line's label delimiters. LLM truncation often cuts a
 * node label mid-string, leaving `[`, `(`, or `"` unclosed \u2014 or a stray
 * trailing closer. Quotes are only tracked in LABEL context (inside an open
 * bracket, or on subgraph/click/Note-style lines) so apostrophes in unquoted
 * labels (`A[don't]`) never trigger a false repair. Braces are deliberately
 * excluded \u2014 `--o{` crows-foot (erDiagram) and `block "x" {` (block-beta) are
 * valid syntax. `%%` comment and blank lines pass through untouched.
 */
function balanceMermaidLine(line: string): string {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith('%%')) return line;
  const quoteContext = MERMAID_QUOTE_PREFIX_RE.test(trimmed);
  const stack: Array<'[' | '(' | '"'> = [];
  // The last significant delimiter action. Only a stray closer that is ALSO
  // the line's trailing char may be stripped \u2014 a mid-line stray must never
  // delete a later legitimate closer (e.g. `A[foo] bar] --> B[x]`).
  let lastAction: 'stray' | 'other' | null = null;
  // After a `:` in free text (sequenceDiagram/classDiagram message lines),
  // parens and quotes are content, not syntax \u2014 stop tracking them.
  // Brackets stay tracked: `A --> B[foo]` node shapes still need balancing.
  let freeText = false;
  let i = 0;
  while (i < line.length) {
    const ch = line[i];
    const top = stack[stack.length - 1];
    if (ch === '\\') { i += 2; continue; }
    if (top === '"') {
      // Inside a quoted label: brackets are literal text; the quote closes.
      if (ch === '"') { stack.pop(); lastAction = 'other'; }
      i++;
      continue;
    }
    if (ch === '[') {
      stack.push(ch);
      lastAction = 'other';
    } else if (ch === ']') {
      if (top === '[') { stack.pop(); lastAction = 'other'; }
      else lastAction = 'stray';
    } else if (ch === '(' || ch === ')') {
      if (!freeText) {
        if (ch === '(') { stack.push(ch); lastAction = 'other'; }
        else if (top === '(') { stack.pop(); lastAction = 'other'; }
        else lastAction = 'stray';
      }
    } else if (ch === '"') {
      if (!freeText && (quoteContext || stack.length > 0)) {
        stack.push('"');
        lastAction = 'other';
      }
    } else if (ch === ':' && stack.length === 0) {
      freeText = true;
    }
    i++;
  }

  if (stack.length === 0 && lastAction !== 'stray') return line;
  if (stack.length > 0) {
    // Close unpaired openers in reverse order (a quote before the bracket it
    // sits inside).
    const closers = stack.map((o) => (o === '"' ? '"' : o === '[' ? ']' : ')')).reverse();
    return line + closers.join('');
  }
  // Only strip a stray closer when IT is the line's trailing char.
  return /[\]\)][\s]*$/.test(line) ? line.replace(/[\]\)][\s]*$/, '') : line;
}



/**
 * Repair Mermaid source. There is no cheap validity gate here (mermaid is a
 * heavy lazy import) — the caller (renderMermaidNodes) only invokes this AFTER
 * a render failure and only accepts the result if a re-render succeeds, so
 * `repaired: true` means "rewritten, worth one retry". Safe structural fixes:
 * fence unwrap, stray backticks, leading prose until the diagram start line,
 * dedent, HTML comments, per-line label delimiter balancing (unpaired quotes /
 * brackets), and a trailing line truncated mid-edge.
 */
export function repairMermaidSource(source: string): ParseRepairResult {
  const orig = source.replace(/\r\n/g, '\n');
  let s = orig;

  const fence = unwrapFence(s, ['mermaid']);
  if (fence) s = fence;
  s = s.replace(/`/g, '');

  let lines = s.split('\n');
  // Drop leading prose until the first line that looks like a diagram start.
  const start = lines.findIndex((l) => MERMAID_TYPE_RE.test(l.trim()));
  if (start > 0) lines = lines.slice(start);

  // Dedent: strip the common leading whitespace of the non-empty lines.
  const nonEmpty = lines.filter((l) => l.trim().length > 0);
  const indent = nonEmpty.length > 0
    ? Math.min(...nonEmpty.map((l) => l.match(/^\s*/)![0].length))
    : 0;
  s = lines.map((l) => l.slice(Math.min(indent, l.length))).join('\n');

  // HTML comments are markup to mermaid, not comments — strip them.
  s = s.replace(/<!--[\s\S]*?-->/g, '');


  // Balance repair: LLM truncation often leaves a label's quote/bracket open.
  // Close unpaired `[` / `(` / `"` openers (label context only) and strip a
  // stray trailing `]` / `)` with no matching opener. Braces are excluded
  // (erDiagram crows-foot, block-beta blocks); single quotes are left alone
  // (apostrophes in unquoted labels).
  const balanced = s.split('\n').map(balanceMermaidLine).join('\n');
  if (balanced !== s) s = balanced;

  // Drop a trailing line truncated mid-edge (`A-->` with no target).
  const trimmed = s.trim();
  const tailLines = trimmed.split('\n');
  const last = tailLines[tailLines.length - 1];
  if (tailLines.length > 1 && INCOMPLETE_TAIL_RE.test(last.trim())) {
    tailLines.pop();
  }
  const clean = tailLines.join('\n').trim();

  if (clean === orig.trim()) return { repaired: false, source };
  return { repaired: true, source: clean };
}

// ═══════════════════════════════════════════════════════════════════════
// SVG
// ═══════════════════════════════════════════════════════════════════════

/**
 * Repair SVG source: unwrap a markdown fence, extract the `<svg>…</svg>` block
 * from surrounding prose, and complete a truncated document (missing `</svg>`
 * or a closing `>` on the final tag). Bare fragments are left for
 * sanitizeSvgSource to wrap — that path already works and is not an error.
 */
export function repairSvgSource(source: string): ParseRepairResult {
  const orig = source.trim();
  let s = orig;

  const fence = unwrapFence(s, ['svg', 'xml']);
  if (fence) s = fence.trim();
  s = s.replace(/`/g, '');

  // Extract the complete <svg>…</svg> block if prose surrounds it.
  const block = s.match(/<svg\b[^>]*>[\s\S]*?<\/svg>/i);
  if (block) {
    s = block[0].trim();
  } else if (/^<svg\b[^>]*>/i.test(s)) {
    // A document that opens with <svg> but never closes it. Only complete a
    // closing tag when the tail is unambiguous: `</svg` (missing the final
    // '>') or nothing at all. A deeper truncation like `</sv` is left
    // untouched rather than producing a double-close `<...></sv</svg>`.
    const tail = s.slice(s.lastIndexOf('>') + 1);
    if (/^<\/svg\s*$/i.test(tail)) s += '>';        // truncated closing tag
    else if (tail.trim() === '') s += '</svg>';          // missing closing tag
  }

  if (s === orig) return { repaired: false, source };
  return { repaired: true, source: s };
}

/**
 * Parse a tool-call's JSON arguments string into an object for ToolAdapter
 * execute() paths. Slightly-broken LLM JSON (trailing commas, single quotes,
 * unquoted keys, full-width punctuation, code fences, prose wrappers) is
 * repaired first, so one formatting slip no longer drops the whole payload.
 *
 * Contract: always returns a plain object. A payload that parses to an array
 * or primitive (or that cannot be repaired) yields {} — callers treat args as
 * Record<string, unknown> and must never receive an array to spread.
 */
export function parseToolArguments(json: string): Record<string, unknown> {
  const trimmed = (json ?? '').trim();
  if (!trimmed) return {};
  try {
    const parsed = JSON.parse(trimmed);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return {};
  } catch {
    // Invalid JSON — fall through to the repair path.
  }
  const repaired = repairJsonSource(trimmed);
  if (repaired.repaired) {
    // repairJsonSource is parse-gated: repaired.source is GUARANTEED to parse
    // (it only reports repaired: true after a successful JSON.parse), so only
    // the plain-object contract check remains — no try/catch needed.
    const parsed = JSON.parse(repaired.source);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  }
  return {};
}
