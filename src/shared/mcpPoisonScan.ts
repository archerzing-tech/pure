// src/shared/mcpPoisonScan.ts
// Tool-poisoning feature scan for MCP tools (6.3). A third-party server
// controls its tools' names and descriptions — the one channel that reaches
// the model verbatim on every turn — so this scans both for the known attack
// signatures: instruction injection hidden in descriptions, invisible
// characters, identifier lookalikes, and names that shadow trusted tools.
//
// POLICY (2026-09-17 user directive): informational only. Findings are shown
// on the server card; nothing here blocks a connection, filters a tool, or
// waits for anyone. Pure functions, no I/O — the callers decide where the
// verdict goes.

export type PoisonSeverity = 'high' | 'medium';

export interface PoisonFinding {
  /** Stable machine kind, e.g. `injection-phrase` — UI keys off this. */
  kind:
    | 'injection-phrase'
    | 'invisible-chars'
    | 'non-ascii-name'
    | 'name-collision'
    | 'description-too-long'
    | 'url-with-exfil-verb';
  severity: PoisonSeverity;
  /** Short human-readable evidence: the matched text or characters. */
  evidence: string;
}

export interface PoisonScanInput {
  /** Full registered name, e.g. `filesystem__read_file`. */
  name: string;
  description: string;
  /** Names this tool must not shadow: built-ins plus other servers' tools.
   *  Optional — collisions are only checked when provided. */
  knownNames?: string[];
}

/** Visible-char check for names: zero-widths, bidi controls, joiners, BOM,
 *  and the invisible tag/vary selectors. Any hit is high severity — a name
 *  that renders differently than it behaves is never accidental. */
const INVISIBLE_RE = /[​-‏‪-‮⁠-⁤⁦-⁩﻿]/;

/** Instruction-injection phrases (EN + ZH), matched case-insensitively. */
const INJECTION_PATTERNS: RegExp[] = [
  /ignore\s+(?:all\s+|any\s+|the\s+|your\s+)?(?:previous|prior|earlier|above|system|old)\s+(?:instructions?|prompts?|rules?)/i,
  /disregard\s+(?:all\s+|any\s+|your\s+|the\s+)?(?:previous|prior|above|system)?\s*(?:instructions?|prompts?|rules?)/i,
  /\bsystem\s+prompt\b/i,
  /do\s+not\s+(?:tell|inform|reveal|show|mention)\s+(?:the\s+|your\s+)?user/i,
  /(?:hide|conceal)\s+(?:this|it|that|these|those)\s+from\s+(?:the\s+)?user/i,
  /you\s+must\s+(?:call|invoke|execute|run)\s+(?:the\s+)?[\w-]+__/i,
  /before\s+(?:that|this|anything)[, ]+(?:you\s+)?must\s+(?:call|invoke|run)/i,
  /忽略(?:之前|先前|以上|上面|以前|系统|全部|所有|任何)?(?:的)?(?:指令|提示|规则)/,
  /(?:不要|别|切勿)(?:告诉|告知|透露|显示给)(?:用户|对方|他|她)/,
  /(?:不要|别|切勿)?让(?:用户|对方|他|她)(?:知道|发现|看见)/,
  /(?:隐瞒|隐藏)(?:这|此|该|以上)[^。]{0,10}(?:不)?(?:要|让|给)?(?:用户|对方)?(?:知道|看见|发现)?/,
  /系统提示词/,
];

/** Verbs that move data somewhere — a URL plus one of these in a description
 *  is the classic exfiltration shape (docs links alone are fine and common). */
const EXFIL_VERB_RE = /\b(send|post|upload|transmit|forward|exfiltrate)\b|(推送|发送|上传|转发)/i;

/** Longest description still considered a normal tool doc. Beyond this the
 *  text is carrying instructions-to-the-model, not documenting behavior. */
const MAX_DESCRIPTION_LENGTH = 2000;

/** Description chars per sentence window used when pairing a URL with a verb;
 *  verbs far from the URL don't count. */
const EXFIL_WINDOW = 120;

/**
 * Bounded Levenshtein distance with early cutoff — only ever asked "is this
 * within maxDist?", never the exact distance.
 */
function withinEditDistance(a: string, b: string, maxDist: number): boolean {
  if (Math.abs(a.length - b.length) > maxDist) return false;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const curr = [i];
    let rowMin = i;
    for (let j = 1; j <= b.length; j++) {
      const d = Math.min(
        prev[j] + 1,
        curr[j - 1] + 1,
        prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
      curr.push(d);
      if (d < rowMin) rowMin = d;
    }
    if (rowMin > maxDist) return false;
    prev = curr;
  }
  return prev[b.length] <= maxDist;
}

/** Identifier form used for collision checks: lowercase, separators removed,
 *  so `read-file`, `read_file` and `readFile` all normalize alike. */
function normalizeName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9一-鿿]/g, '');
}

/** The tool's own name without its server prefix — `evil__read_file` shadows
 *  the built-in `read_file`, so collisions compare this local part. */
function localName(name: string): string {
  return name.split('__').pop() ?? name;
}

function codepoints(text: string): string {
  return Array.from(text)
    .map((ch) => `U+${ch.codePointAt(0)!.toString(16).toUpperCase().padStart(4, '0')}`)
    .join(' ');
}

/** Scan one tool's name + description for poisoning features. */
export function scanMcpTool({ name, description, knownNames = [] }: PoisonScanInput): PoisonFinding[] {
  const findings: PoisonFinding[] = [];

  for (const pattern of INJECTION_PATTERNS) {
    const hit = description.match(pattern);
    if (hit) {
      findings.push({ kind: 'injection-phrase', severity: 'high', evidence: hit[0].slice(0, 80) });
    }
  }

  const invisibleInName = name.match(new RegExp(INVISIBLE_RE.source, 'g'));
  if (invisibleInName?.length) {
    findings.push({ kind: 'invisible-chars', severity: 'high', evidence: `${invisibleInName.length} 个隐形字符（${codepoints(invisibleInName.join(''))}）` });
  }
  const invisibleInDesc = description.match(new RegExp(INVISIBLE_RE.source, 'g'));
  if (invisibleInDesc?.length) {
    findings.push({ kind: 'invisible-chars', severity: 'medium', evidence: `${invisibleInDesc.length} 个隐形字符（${codepoints(invisibleInDesc.join(''))}）` });
  }

  // MCP tool names are identifier-like; anything outside printable ASCII in
  // the name is either homoglyph spoofing or a server that will confuse the
  // model. Either way the human should see it.
  const nonAscii = Array.from(name).filter((ch) => ch.charCodeAt(0) > 126);
  if (nonAscii.length) {
    findings.push({ kind: 'non-ascii-name', severity: 'high', evidence: `「${nonAscii.join('')}」（${codepoints(nonAscii.join(''))}）` });
  }

  if (description.length > MAX_DESCRIPTION_LENGTH) {
    findings.push({ kind: 'description-too-long', severity: 'medium', evidence: `${description.length} 字符（上限 ${MAX_DESCRIPTION_LENGTH}）` });
  }

  const url = description.match(/https?:\/\/[^\s)]+/);
  if (url) {
    // Pair the URL with an exfil verb only in its neighbourhood — a verb two
    // paragraphs away from the link is a docs page, not an exfil channel.
    const start = Math.max(0, url.index! - EXFIL_WINDOW);
    const window = description.slice(start, url.index! + url[0].length + EXFIL_WINDOW);
    const verb = window.match(EXFIL_VERB_RE);
    if (verb) {
      findings.push({ kind: 'url-with-exfil-verb', severity: 'medium', evidence: `${verb[0]} → ${url[0].slice(0, 60)}` });
    }
  }

  // Shadowing: an identifier that only READS like a trusted one — the
  // cross-server attack registers `evil__read_fi1e` and hopes the model picks
  // it instead of the real `read_file`. Exact same-name tools across servers
  // are legitimate namespacing (two file servers both offering read_file is
  // normal) and are deliberately NOT flagged — only near-identity is. The
  // comparison is local part to local part (and against the full known name
  // for prefix-less built-ins) so a server prefix can't launder the collision.
  const own = normalizeName(localName(name));
  if (own.length >= 5) {
    for (const known of knownNames) {
      if (known === name) continue;
      for (const target of [normalizeName(localName(known)), normalizeName(known)]) {
        if (!target || target === own) continue;
        if (withinEditDistance(own, target, 2)) {
          findings.push({ kind: 'name-collision', severity: 'high', evidence: `近似 ${known}` });
          break;
        }
      }
      if (findings.some((f) => f.kind === 'name-collision')) break;
    }
  }

  return findings;
}

/** Card-level rollup: how many findings, and how bad is the worst. */
export function summarizeMcpPoison(findings: PoisonFinding[]): { count: number; maxSeverity: PoisonSeverity | null } {
  let maxSeverity: PoisonSeverity | null = null;
  for (const f of findings) {
    if (f.severity === 'high') { maxSeverity = 'high'; break; }
    if (!maxSeverity) maxSeverity = f.severity;
  }
  return { count: findings.length, maxSeverity };
}
