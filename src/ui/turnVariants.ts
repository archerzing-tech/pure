// src/ui/turnVariants.ts
// Reply variants (regenerate + edit-resend + version switching), pure logic —
// no DOM, no chat imports, directly testable under bun.
//
// One variant group lives on the LAST user turn only: a variant is produced
// while its turn is the last one (regenerate, edit-resend), and switching
// rewrites the tail of the linear `messages` array (context stays the selected
// chain — the model must never see two answers to the same question). A
// variant's user text IS its first message, so an edited variant switches the
// visible question together with the reply. The snapshot's full-rewrite
// persistence carries the ledger for free; the JSONL event log keeps every
// variant's turn_messages as its append-only audit trail (an edit-resend is a
// NEW user_input — the user said something new — while a regenerate is not).

import type { Message } from '../shared/types';

export const TURN_VARIANT_CAP = 5;

export interface TurnVariant {
  /** The turn's full message slice: the user message and everything after it
   * (assistant, tool, internal pause commits). Engine-canonical content. The
   * first message's content doubles as this variant's user text. */
  messages: Message[];
  /** JSON fingerprint used to dedupe a re-adoption of the currently shown
   * slice (regenerate → switch back → regenerate again). */
  fingerprint: string;
}

export interface TurnVariantGroup {
  variants: TurnVariant[];
  active: number;
}

/** Index of the last non-internal user message — the start of the last user
 * turn in the linear messages array. Internal user commits (auto/pause) that
 * follow it belong to this turn's slice. */
export function lastUserTurnStart(messages: Message[]): number | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (message.role === 'user' && !message.internal) return i;
  }
  return null;
}

export function variantFingerprint(messages: Message[]): string {
  return JSON.stringify(messages);
}

/** Identity check: does the ledger group still belong to the turn that is now
 * last in `messages`? Anchored on the ACTIVE variant's first message — an edit
 * intentionally changes the turn's user text, so the group follows the active
 * slot, not a frozen string. */
export function groupAnchoredToTurn(group: TurnVariantGroup, messages: Message[]): boolean {
  const start = lastUserTurnStart(messages);
  if (start === null) return false;
  const activeVariant = group.variants[group.active];
  return activeVariant?.messages[0]?.role === 'user' && activeVariant.messages[0].content === messages[start].content;
}

/** Snapshot restore path: anything malformed degrades to "no variants" the
 * same way normalizeSessionLedger does — a corrupt ledger must never block a
 * session from opening. */
export function normalizeTurnVariants(raw: unknown): TurnVariantGroup | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const candidate = raw as Partial<TurnVariantGroup>;
  if (!Array.isArray(candidate.variants)) return null;
  const variants: TurnVariant[] = [];
  for (const entry of candidate.variants) {
    if (!entry || typeof entry !== 'object') continue;
    const messages = (entry as Partial<TurnVariant>).messages;
    if (!Array.isArray(messages) || messages.length === 0) continue;
    // A variant slice must start at its turn's user message — anything else
    // would splice a broken tail into the linear array on switch.
    if (messages[0]?.role !== 'user') continue;
    variants.push({ messages: messages as Message[], fingerprint: variantFingerprint(messages as Message[]) });
  }
  if (variants.length === 0) return null;
  const active = typeof candidate.active === 'number' && candidate.active >= 0 && candidate.active < variants.length
    ? candidate.active
    : variants.length - 1;
  return { variants, active };
}
