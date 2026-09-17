// src/shared/__tests__/mcpPrompt.test.ts
import { describe, expect, it } from 'bun:test';
import {
  describeMcpPrompt,
  missingRequiredArgs,
  parseMcpPromptCommand,
  renderMcpPromptMessages,
} from '../mcpPrompt';

describe('parseMcpPromptCommand', () => {
  it('parses the key and key=value arguments', () => {
    expect(parseMcpPromptCommand('/mcp-prompt filesystem__summarize path=notes.md depth=2')).toEqual({
      key: 'filesystem__summarize',
      args: { path: 'notes.md', depth: '2' },
    });
  });

  it('accepts a bare prompt with no arguments', () => {
    expect(parseMcpPromptCommand('/mcp-prompt srv__weekly')).toEqual({ key: 'srv__weekly', args: {} });
    expect(parseMcpPromptCommand('  /mcp-prompt srv__weekly  ')).toEqual({ key: 'srv__weekly', args: {} });
  });

  it('keeps quoted values, including spaces', () => {
    expect(parseMcpPromptCommand('/mcp-prompt srv__read path="a b.txt" mode=full')).toEqual({
      key: 'srv__read',
      args: { path: 'a b.txt', mode: 'full' },
    });
  });

  it('treats a bare key= as an explicit empty value', () => {
    expect(parseMcpPromptCommand('/mcp-prompt srv__read path=')?.args).toEqual({ path: '' });
  });

  it('ignores tokens that are not key=value', () => {
    expect(parseMcpPromptCommand('/mcp-prompt srv__read --verbose path=x')?.args).toEqual({ path: 'x' });
  });

  it('returns null for anything that is not the command', () => {
    expect(parseMcpPromptCommand('summarize this file')).toBeNull();
    expect(parseMcpPromptCommand('/mcp-prompt')).toBeNull();
    // No separator after the command word: a longer word is a different command.
    expect(parseMcpPromptCommand('/mcp-promptfoo srv__x')).toBeNull();
    expect(parseMcpPromptCommand('/prompts')).toBeNull();
  });
});

describe('describeMcpPrompt / missingRequiredArgs', () => {
  const prompt = {
    name: 'summarize',
    description: 'Summarize a file',
    arguments: [
      { name: 'path', required: true },
      { name: 'format' },
    ],
  };

  it('marks required arguments with a star', () => {
    expect(describeMcpPrompt(prompt)).toBe('Summarize a file (path*, format)');
  });

  it('falls back to the name when the server sent no description', () => {
    expect(describeMcpPrompt({ name: 'weekly' })).toBe('weekly');
  });

  it('reports the required arguments a call still needs', () => {
    expect(missingRequiredArgs(prompt, {})).toEqual(['path']);
    expect(missingRequiredArgs(prompt, { path: 'x' })).toEqual([]);
    // An explicitly empty value counts as supplied — the user can clear one.
    expect(missingRequiredArgs(prompt, { path: '' })).toEqual([]);
  });
});

describe('renderMcpPromptMessages', () => {
  it('joins text parts into one prompt body', () => {
    const text = renderMcpPromptMessages([
      { role: 'user', content: { type: 'text', text: 'Summarize this:' } },
      { role: 'user', content: [{ type: 'text', text: 'file contents' }] },
    ]);
    expect(text).toBe('Summarize this:\n\nfile contents');
  });

  it('accepts plain string content', () => {
    expect(renderMcpPromptMessages([{ role: 'user', content: 'hello' }])).toBe('hello');
  });

  it('labels assistant blocks so a mixed template stays interpretable', () => {
    const text = renderMcpPromptMessages([
      { role: 'user', content: { type: 'text', text: 'ask' } },
      { role: 'assistant', content: { type: 'text', text: 'answer' } },
    ]);
    expect(text).toBe('ask\n\n[assistant]\nanswer');
  });

  it('inlines text resources and marks binary ones as omitted', () => {
    const text = renderMcpPromptMessages([
      {
        role: 'user',
        content: [
          { type: 'resource', resource: { uri: 'file:///a.md', text: 'inline body' } },
          { type: 'resource', resource: { uri: 'file:///b.png' } },
          { type: 'image', mimeType: 'image/png' },
        ],
      },
    ]);
    expect(text).toContain('<resource uri="file:///a.md">');
    expect(text).toContain('inline body');
    expect(text).toContain('[binary resource omitted: file:///b.png]');
    expect(text).toContain('[image omitted: image/png]');
  });

  it('drops empty content instead of emitting blank blocks', () => {
    expect(renderMcpPromptMessages([{ role: 'user', content: [] }, { role: 'user', content: { type: 'text', text: '  ' } }])).toBe('');
  });
});
