// src/ui/inputRepair.ts
// Roadmap 阶段 11.1 (P0) — submit-time input repair for the GUI composer. Two
// pure, synchronous, zero-model-call steps, both run before the preflight gate:
//
//   normalizeDraft()      lossless cleanup of the draft that IS sent
//   expandRiskSynonyms()  typo-tolerant *shadow* text used ONLY for the risk
//                         assessment — never sent, never shown as the user's words
//
// Iron laws (改进路线图「阶段 11」): semantic text is never silently rewritten,
// and anything that could change meaning must be visible + undoable. So this
// module has no authority over what the user said — it only (a) makes matching
// stable against IME artifacts, and (b) lets the danger floor see through a
// homophone slip. The gate explains the expansion instead; see
// checkPreflight's `repairs` and main.ts confirmHighRiskDraft.
//
// Why no model call here: preflight.ts:5-10 records the lesson — an LLM
// analysis step on the send path was removed because 该环节从未稳定成功. Typing
// latency budgets do not accept a round trip that can also fail.

// ── Lossless normalization ──

/** Invisible characters that break keyword matching and path compare: BOM /
 *  zero-width space / bidi marks / word joiner / soft hyphen. U+200C and
 *  U+200D are deliberately NOT here — they carry real meaning (emoji
 *  sequences, Indic scripts) and dropping them would corrupt the message. */
const INVISIBLE_RE = /[\u200B\u200E\u200F\u2060\uFEFF\u00AD]/g;

/** Exotic Unicode spaces → a plain space. U+3000 (ideographic space) comes
 *  from pasted Chinese prose; U+00A0 from pasted web text. Both read as a
 *  space to the user, neither matches a `\s`-free literal. */
const UNICODE_SPACE_RE = /[\u00A0\u1680\u2000-\u200A\u202F\u205F\u3000]/g;

/** Fullwidth ASCII block (U+FF01–U+FF5E). Every codepoint in it is exactly
 *  0xFEE0 above its halfwidth twin, so the mapping needs no table. */
const FULLWIDTH_ASCII_RE = /[\uFF01-\uFF5E]/g;

/** Fullwidth characters that are CJK punctuation, not a mangled ASCII
 *  character: ，。！？：；（） as typed on purpose. Matching stability is the goal
 *  here, not re-typesetting Chinese prose — leave them alone. (。 is U+3002,
 *  outside the block, so it is untouched either way.) */
const CJK_PUNCT_KEEP = new Set(['\uFF01', '\uFF08', '\uFF09', '\uFF0C', '\uFF1A', '\uFF1B', '\uFF1F']);

/**
 * Lossless cleanup of a draft. Safe to run on every send: it only removes
 * characters the user cannot see and folds fullwidth ASCII to halfwidth, which
 * is what makes `/mcp-prompt` names, file paths and the danger floor's
 * keywords match at all after an IME-heavy sentence.
 *
 * Idempotent by construction (no invisible chars left, spaces are already
 * plain, fullwidth ASCII is already halfwidth).
 *
 * Deliberately NOT done: collapsing runs of interior spaces. Users paste code
 * into the composer and indentation is semantic — "stable matching" is not
 * worth turning a working snippet into a broken one.
 */
export function normalizeDraft(text: string): string {
  if (!text) return text;
  return text
    .replace(INVISIBLE_RE, '')
    .replace(UNICODE_SPACE_RE, ' ')
    .replace(FULLWIDTH_ASCII_RE, (ch) => (
      CJK_PUNCT_KEEP.has(ch) ? ch : String.fromCharCode(ch.charCodeAt(0) - 0xfee0)
    ))
    .trim();
}

// ── Typo-tolerant risk expansion ──

export interface RiskAlias {
  /** A word `assessIntent`'s danger floor already recognises. */
  readonly canonical: string;
  /** Misspellings of it — pinyin homophone slips, letter swaps, smart dashes. */
  readonly variants: readonly string[];
}

/** One replacement that actually fired, used to explain the gate. */
export interface RiskRepair {
  from: string;
  to: string;
}

export interface RiskExpansion {
  /** Shadow text: fed to assessIntent, never sent to the model. */
  text: string;
  /** Replacements that fired, in the order the draft uses them (deduped by
   *  `from`) — the gate's note reads top-to-bottom with what the user sees. */
  applied: RiskRepair[];
}

/**
 * Misspelling → the danger-floor word the user meant.
 *
 * INVARIANT (unit-locked in __tests__/inputRepair.test.ts): every `canonical`
 * must itself trip `assessIntent` at the tier this table exists for. An alias
 * whose canonical is invisible to the floor is a dead entry — it expands to
 * something the gate still cannot see, which is worse than not shipping it.
 *
 * Selection rule, in UX terms: a variant that is itself a usable word is
 * EXCLUDED even when the pinyin matches perfectly — '情理' (在情理之中) and
 * '闪出' (闪出一个弹窗) would gate ordinary prose and accuse the user of a typo
 * they never made, which costs more trust than the miss it prevents. A single
 * wrong character is the common slip and stays covered (山除/扇除/删出…).
 *
 * Also rejected by that test: a variant that merely CONTAINS its canonical
 * ('remove alll' ⊃ 'remove all') — expandRiskSynonyms skips those by design, and
 * the floor already matches them as a substring, so the entry is dead weight.
 *
 * Scope follows the floor exactly. Until 2026-09-20 the floor's destructive
 * regex listed only 删除/移除/清理/销毁/不可逆, so 清空/重置/覆盖 and the spoken
 * forms 删了/删掉 were absent here too — expanding a typo into a word the floor
 * cannot see changes nothing observable, and widening the floor is a different
 * decision (it also moves the CLI's per-turn auto-approval). That widening has
 * now happened in Planner.assessIntent, so the table covers them.
 */
export const RISK_ALIASES: readonly RiskAlias[] = [
  // Destructive / irreversible — the tier that actually gates a send.
  { canonical: '删除', variants: ['闪除', '山除', '扇除', '栅除', '珊除', '删出', '刪除'] },
  { canonical: '移除', variants: ['意除', '疑除', '依除', '易除', '衣除'] },
  { canonical: '清理', variants: ['青理', '轻理', '请理', '清里', '亲理'] },
  { canonical: '清空', variants: ['轻空', '青空', '庆空', '清恐', '亲空'] },
  { canonical: '清掉', variants: ['轻掉', '青掉', '请掉'] },
  { canonical: '抹掉', variants: ['末掉', '莫掉'] },
  { canonical: '重置', variants: ['冲置', '充置', '虫置', '崇置'] },
  { canonical: '覆盖', variants: ['复盖', '覆该', '付盖', '附盖', '富盖'] },
  { canonical: '删掉', variants: ['山掉', '扇掉', '删吊', '闪掉'] },
  { canonical: '删了', variants: ['山了'] },
  { canonical: '销毁', variants: ['消毁', '小毁', '肖毁', '霄毁', '削毁'] },
  { canonical: '不可逆', variants: ['不可拟', '不可尼', '不可你', '不可匿', '不可泥', '不可腻'] },
  // English forms: letter swaps, missing separators, macOS smart dashes.
  { canonical: 'rm -rf', variants: ['rm -fr', 'rm-rf', 'rm –rf', 'rm —rf', 'rm - r f', 'rm-r f'] },
  { canonical: 'reset --hard', variants: ['reset -hard', 'reset –hard', 'reset —hard', 'reset--hard', 'rest --hard'] },
  { canonical: 'force push', variants: ['froce push', 'forse push', 'force psuh', 'forcepush', 'force-push', 'frce push'] },
  { canonical: 'delete all', variants: ['delelte all', 'delte all', 'delet all', 'deleet all', 'deleteall', 'delete al'] },
  { canonical: 'remove all', variants: ['remvoe all', 'remove al', 'remov all', 'removeall'] },
  { canonical: 'destroy', variants: ['destory', 'destry', 'desroy', 'dstroy', 'destrory'] },
  { canonical: 'drop table', variants: ['dorp table', 'droptable', 'droptabel', 'drop tabel', 'drap table'] },
  { canonical: 'drop database', variants: ['dorp database', 'drop databse', 'drop databese', 'drop databsae', 'dropdatabase'] },
];

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Replace known misspellings with the words the danger floor understands.
 *
 * The result is a SHADOW string: it exists so `assessIntent`'s literal regex
 * can classify intent the way the user meant it. It is never the text that
 * reaches the model, and never what the transcript shows — the user's own
 * words stay untouched (see the iron laws). Matching is case-insensitive so
 * 'Destory' expands too; replacements are written in the canonical spelling.
 */
export function expandRiskSynonyms(text: string): RiskExpansion {
  if (!text) return { text, applied: [] };
  let out = text;
  const applied: RiskRepair[] = [];
  for (const { canonical, variants } of RISK_ALIASES) {
    // A correctly spelled occurrence already trips the floor on its own, and a
    // missing-character variant is a prefix of its canonical ('delete al' ⊂
    // 'delete all') — expanding on top of one would garble the shadow text.
    if (out.toLowerCase().includes(canonical.toLowerCase())) continue;
    // One alternation per group, longest variant first, so the longest match
    // wins at each position ('rm - r f' over 'rm-r f').
    const ordered = [...variants].sort((a, b) => b.length - a.length).map(escapeRegExp);
    const seen = new Map<string, string>();
    // A single pass, and `replace` never rescans what it inserted — expanding
    // variant by variant would rewrite a freshly produced canonical ('delete
    // all' → 'delete alll') and report a replacement the user never typed.
    out = out.replace(new RegExp(ordered.join('|'), 'gi'), (match) => {
      const key = match.toLowerCase();
      if (!seen.has(key)) seen.set(key, match);
      return canonical;
    });
    // Reported in the order the slips appear in the draft — the gate's note
    // should read top-to-bottom with what the user sees in the composer.
    for (const actual of seen.values()) applied.push({ from: actual, to: canonical });
  }
  return { text: out, applied };
}
