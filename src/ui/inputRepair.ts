// src/ui/inputRepair.ts
// Lossless normalization for the GUI composer draft (roadmap 阶段 11.1). A
// pure, synchronous, zero-model-call cleanup that runs before every send.
//   normalizeDraft()      lossless cleanup of the draft that IS sent
// The typo-tolerant risk expansion (expandRiskSynonyms + RISK_ALIASES) that
// used to live here was removed on 2026-11-01 together with its only caller
// (preflight.ts, itself offline since 2026-10-14): the submit-time hard gate
// is gone for good (2026-09-17/2026-11-01 定调——确认卡只留操作级毁灭，任务级
// 破坏词探查后直接动手), so a shadow-text table whose sole purpose was feeding
// that gate's floor has no consumer left.
// Iron laws (改进路线图「阶段 11」): semantic text is never silently rewritten.
// This module has no authority over what the user said — it only makes matching
// stable against IME artifacts.

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

