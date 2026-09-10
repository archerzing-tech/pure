// src/shared/tokenEstimate.ts
// Canonical CJK-aware token estimation shared by every token-accounting site:
// engine/BudgetManager, harness/ContextEngine, PromptAssembler (via
// providers.estimatePromptTokens), and the GUI footer gauge. One formula so
// every surface reads and budgets in the same units.
//
// CJK characters are dense: most tokenizers spend ~1 token per CJK char while
// Latin text averages ~4 chars/token. A flat length/4 estimate undercounts CJK
// by ~4×, so long Chinese or symbol-heavy content silently blows past the
// token budget before soft/hard limits fire.

const CJK_CHAR_RE = /[぀-ヿ㐀-䶿一-鿿가-힯豈-﫿]/u;

export function isCjkChar(ch: string): boolean {
  return CJK_CHAR_RE.test(ch);
}

export function countCjkChars(text: string): number {
  let cjk = 0;
  for (const ch of text) {
    if (CJK_CHAR_RE.test(ch)) cjk++;
  }
  return cjk;
}

/** Fast, conservative CJK-aware estimate shared by prompt and history budgets. */
export function estimateTextTokens(text: string): number {
  if (!text) return 0;
  const cjk = countCjkChars(text);
  return Math.ceil(cjk + (text.length - cjk) / 4);
}
