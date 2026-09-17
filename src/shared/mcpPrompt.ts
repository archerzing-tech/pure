// src/shared/mcpPrompt.ts
// `/mcp-prompt` composer command: parsing and rendering for MCP prompt
// templates (roadmap 6.2). Prompts are USER-invoked templates, not model
// tools — the user picks one in the composer and fills its arguments, and the
// server returns the messages to send.
//
// Kept pure and surface-free so the GUI composer, the CLI REPL, and the
// command palettes all share one syntax and one rendering rule.

import type { MCPPromptDescription, MCPPromptMessage } from '../adapter/mcp/MCPTransport';

/** Command word. Written as a constant so the composer, CLI, and docs can't
 *  drift apart on the spelling. */
export const MCP_PROMPT_COMMAND = '/mcp-prompt';

export interface McpPromptInvocation {
  /** `server__promptName` — same `__` separator MCP tools use. */
  key: string;
  args: Record<string, string>;
}

/**
 * Parse `/mcp-prompt <server__name> [key=value …]`.
 *
 * Values may be quoted (`path="a b.txt"`); unquoted values run to the next
 * space. A bare `key=` yields an empty value so a user can clear an argument
 * on purpose. Returns null when the text is not a prompt command — callers
 * must treat that as "send the text as a normal turn".
 */
export function parseMcpPromptCommand(text: string): McpPromptInvocation | null {
  const trimmed = text.trim();
  if (!trimmed.toLowerCase().startsWith(MCP_PROMPT_COMMAND)) return null;
  const rest = trimmed.slice(MCP_PROMPT_COMMAND.length);
  // Require a separator so `/mcp-promptfoo` is not mistaken for the command.
  if (rest.length > 0 && !/\s/.test(rest[0])) return null;
  const tokens = tokenize(rest.trim());
  const key = tokens.shift();
  if (!key) return null;
  const args: Record<string, string> = {};
  for (const token of tokens) {
    const eq = token.indexOf('=');
    if (eq <= 0) continue;
    args[token.slice(0, eq)] = token.slice(eq + 1);
  }
  return { key, args };
}

/** Whitespace split that honors double-quoted runs, dropping the quotes. */
function tokenize(input: string): string[] {
  const tokens: string[] = [];
  let current = '';
  let quoted = false;
  for (const char of input) {
    if (char === '"') {
      quoted = !quoted;
      continue;
    }
    if (!quoted && /\s/.test(char)) {
      if (current) tokens.push(current);
      current = '';
      continue;
    }
    current += char;
  }
  if (current) tokens.push(current);
  return tokens;
}

/** Human-readable one-liner for lists and autocomplete labels. */
export function describeMcpPrompt(prompt: MCPPromptDescription & { key?: string }): string {
  const label = prompt.description?.trim() || prompt.name;
  const args = (prompt.arguments ?? []).map((arg) => (arg.required ? `${arg.name}*` : arg.name));
  return args.length > 0 ? `${label} (${args.join(', ')})` : label;
}

/** Names the user still has to supply — drives the "missing argument" error
 *  instead of silently sending a template with an empty placeholder. */
export function missingRequiredArgs(prompt: MCPPromptDescription, args: Record<string, string>): string[] {
  return (prompt.arguments ?? [])
    .filter((arg) => arg.required && !(arg.name in args))
    .map((arg) => arg.name);
}

/**
 * Flatten a `prompts/get` response into the text the model receives.
 *
 * Binary parts are NOT inlined (a prompt is sent as text); they are replaced by
 * an explicit marker so the model never assumes it saw an image it did not.
 * Assistant-role blocks are labeled — a template that mixes roles stays
 * interpretable instead of reading as one flat user request.
 */
export function renderMcpPromptMessages(messages: MCPPromptMessage[]): string {
  const blocks: string[] = [];
  for (const message of messages ?? []) {
    const body = renderContent(message?.content).trim();
    if (!body) continue;
    blocks.push(message?.role === 'assistant' ? `[assistant]\n${body}` : body);
  }
  return blocks.join('\n\n').trim();
}

function renderContent(content: MCPPromptMessage['content']): string {
  if (content === undefined || content === null) return '';
  if (typeof content === 'string') return content;
  const parts = Array.isArray(content) ? content : [content];
  return parts.map(renderPart).filter(Boolean).join('\n');
}

function renderPart(part: { type?: string; text?: string; mimeType?: string; resource?: { uri?: string; mimeType?: string; text?: string } }): string {
  if (!part) return '';
  if (typeof part.text === 'string' && (part.type === 'text' || part.type === undefined)) return part.text;
  if (part.type === 'resource' && part.resource) {
    const uri = part.resource.uri ?? '';
    if (typeof part.resource.text === 'string' && part.resource.text.trim()) {
      return `<resource uri="${uri.replace(/"/g, '%22')}">\n${part.resource.text}\n</resource>`;
    }
    return `[binary resource omitted: ${uri || 'unknown uri'}]`;
  }
  if (part.type === 'image' || part.type === 'audio') {
    return `[${part.type} omitted: ${part.mimeType ?? 'unknown type'}]`;
  }
  return typeof part.text === 'string' ? part.text : '';
}
