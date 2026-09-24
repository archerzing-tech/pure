// src/__tests__/slashCommands.test.ts
// Pure parsing + model matching for the built-in composer slash commands.

import { describe, expect, it } from 'bun:test';
import {
  SLASH_COMMANDS,
  parseSlashCommand,
  pickModelEntry,
  type ModelEntry,
} from '../shared/slashCommands';

const entry = (provider: string, model: string, providerLabel = provider): ModelEntry =>
  ({ provider, model, providerLabel });

describe('parseSlashCommand', () => {
  it('parses each built-in command with and without an argument', () => {
    expect(parseSlashCommand('/model')).toEqual({ command: '/model', arg: '' });
    expect(parseSlashCommand('/model glm-4.6')).toEqual({ command: '/model', arg: 'glm-4.6' });
    expect(parseSlashCommand('/compact')).toEqual({ command: '/compact', arg: '' });
    expect(parseSlashCommand('/help')).toEqual({ command: '/help', arg: '' });
  });

  it('trims surrounding whitespace and normalizes the command word case', () => {
    expect(parseSlashCommand('  /MODEL  GLM-4.6  ')).toEqual({ command: '/model', arg: 'GLM-4.6' });
    expect(parseSlashCommand('\t/compact')).toEqual({ command: '/compact', arg: '' });
  });

  it('keeps interior whitespace of the argument intact', () => {
    expect(parseSlashCommand('/model  glm 4.6 ')).toEqual({ command: '/model', arg: 'glm 4.6' });
  });

  it('rejects words that only start like a command (word boundary)', () => {
    expect(parseSlashCommand('/modelfoo')).toBeNull();
    expect(parseSlashCommand('/compactify now')).toBeNull();
  });

  it('rejects unknown and non-command text', () => {
    expect(parseSlashCommand('/clear')).toBeNull();
    expect(parseSlashCommand('/exit')).toBeNull();
    expect(parseSlashCommand('帮我 /model 一下')).toBeNull();
    expect(parseSlashCommand('')).toBeNull();
    expect(parseSlashCommand('/')).toBeNull();
  });

  it('never offers /clear (GUI session switch belongs to the sidebar)', () => {
    expect(SLASH_COMMANDS).not.toContain('/clear');
  });
});

describe('pickModelEntry', () => {
  const entries = [
    entry('glm', 'glm-4.5'),
    entry('glm', 'glm-4.6'),
    entry('deepseek-openai', 'deepseek-chat', 'DeepSeek'),
    entry('custom-1', 'my-model', 'My Router'),
  ];

  it('matches an exact model id case-insensitively', () => {
    const pick = pickModelEntry('GLM-4.6', entries);
    expect(pick.kind).toBe('exact');
    if (pick.kind === 'exact') expect(pick.entry.provider).toBe('glm');
  });

  it('prefers the current provider when several carry the same id', () => {
    const shared = [entry('glm', 'same-id'), entry('deepseek-openai', 'same-id', 'DeepSeek')];
    const pick = pickModelEntry('same-id', shared, 'deepseek-openai');
    expect(pick.kind).toBe('exact');
    if (pick.kind === 'exact') expect(pick.entry.provider).toBe('deepseek-openai');
  });

  it('resolves a unique substring of the model id', () => {
    const pick = pickModelEntry('seek-chat', entries);
    expect(pick.kind).toBe('unique');
    if (pick.kind === 'unique') expect(pick.entry.model).toBe('deepseek-chat');
  });

  it('reports ambiguity when a substring hits several models', () => {
    const pick = pickModelEntry('glm-4', entries);
    expect(pick.kind).toBe('ambiguous');
    if (pick.kind === 'ambiguous') expect(pick.matches).toHaveLength(2);
  });

  it('falls back to a unique provider label or id match', () => {
    const byLabel = pickModelEntry('deepseek', entries);
    expect(byLabel.kind).toBe('unique');
    if (byLabel.kind === 'unique') expect(byLabel.entry.model).toBe('deepseek-chat');
    const byCustomLabel = pickModelEntry('my router', entries);
    expect(byCustomLabel.kind).toBe('unique');
  });

  it('model matches win over provider matches', () => {
    // 'deepseek' hits exactly one model id even though several provider
    // labels contain it — the model-id pass short-circuits first.
    const pick = pickModelEntry('deepseek', entries);
    expect(pick.kind).toBe('unique');
    if (pick.kind === 'unique') expect(pick.entry.model).toBe('deepseek-chat');
  });

  it('stays ambiguous when only provider labels match several entries', () => {
    const sharedLabel = [entry('a', 'alpha', 'DeepSeek'), entry('b', 'beta', 'DeepSeek')];
    expect(pickModelEntry('deepseek', sharedLabel).kind).toBe('ambiguous');
    expect(pickModelEntry('nope', entries).kind).toBe('none');
    expect(pickModelEntry('   ', entries).kind).toBe('none');
  });
});
