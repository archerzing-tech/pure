// src/shared/slashCommands.ts
// Built-in composer slash commands (/model /compact /help): parsing and
// model-name matching. Kept pure and surface-free (same discipline as
// mcpPrompt.ts) so the GUI composer — and any future CLI port — share one
// syntax. A parsed command NEVER reaches the engine: the host executes it and
// clears the draft.
//
// Deliberately NO /clear: in the GUI a context reset is a session switch, and
// the sidebar's 新对话 already owns that (user decision, 2026-09-24).

/** Command words, written as a tuple so the composer autocomplete, the send
 *  gate, and docs can't drift apart on the spelling. */
export const SLASH_COMMANDS = ['/model', '/compact', '/help'] as const;

export type SlashCommand = (typeof SLASH_COMMANDS)[number];

/** i18n key of the one-line description, for the autocomplete popup and /help. */
export const SLASH_COMMAND_I18N: Record<SlashCommand, { desc: string }> = {
  '/model': { desc: 'slash.model.desc' },
  '/compact': { desc: 'slash.compact.desc' },
  '/help': { desc: 'slash.help.desc' },
};

export interface ParsedSlashCommand {
  command: SlashCommand;
  /** Everything after the command word, trimmed. '' when absent. */
  arg: string;
}

/**
 * Parse a composer draft as a built-in command.
 *
 * Case-insensitive on the command word, tolerant of leading whitespace, and
 * requires a word boundary after it so `/modelfoo` stays an ordinary message.
 * Returns null for anything that is not a built-in — the caller sends that
 * text to the engine as a normal turn (same contract as parseMcpPromptCommand).
 */
export function parseSlashCommand(text: string): ParsedSlashCommand | null {
  const match = text.trim().match(/^\/(\S+)(?:\s+([\s\S]*))?$/);
  if (!match) return null;
  const word = `/${match[1].toLowerCase()}`;
  if (!(SLASH_COMMANDS as readonly string[]).includes(word)) return null;
  return { command: word as SlashCommand, arg: (match[2] ?? '').trim() };
}

/** A selectable model as the host enumerates it (same source as the composer
 *  model dropdown: keyed providers first, then custom providers). */
export interface ModelEntry {
  provider: string;
  model: string;
  /** Provider display label (localized registry label or custom name). */
  providerLabel: string;
}

export type ModelPick =
  | { kind: 'exact'; entry: ModelEntry }
  | { kind: 'unique'; entry: ModelEntry }
  | { kind: 'ambiguous'; matches: ModelEntry[] }
  | { kind: 'none' };

/**
 * Resolve a `/model <query>` against the available entries.
 *
 * An exact (case-insensitive) model-id match wins — when several providers
 * carry the same id, the current provider's entry is preferred. Otherwise a
 * unique substring of the model id matches; failing that, the provider label
 * or id ("glm" → GLM's models). Several substring hits are ambiguous: the
 * caller shows the candidates rather than guessing.
 */
export function pickModelEntry(query: string, entries: ModelEntry[], currentProvider?: string): ModelPick {
  const q = query.trim().toLowerCase();
  if (!q) return { kind: 'none' };
  const exact = entries.filter((e) => e.model.toLowerCase() === q);
  if (exact.length > 0) {
    const preferred = currentProvider ? exact.find((e) => e.provider === currentProvider) : undefined;
    return { kind: 'exact', entry: preferred ?? exact[0] };
  }
  const byModel = entries.filter((e) => e.model.toLowerCase().includes(q));
  if (byModel.length === 1) return { kind: 'unique', entry: byModel[0] };
  if (byModel.length > 1) return { kind: 'ambiguous', matches: byModel };
  const byProvider = entries.filter(
    (e) => e.providerLabel.toLowerCase().includes(q) || e.provider.toLowerCase().includes(q),
  );
  if (byProvider.length === 1) return { kind: 'unique', entry: byProvider[0] };
  if (byProvider.length > 1) return { kind: 'ambiguous', matches: byProvider };
  return { kind: 'none' };
}
