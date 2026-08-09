// src/shared/__tests__/promptLayers.test.ts
// Covers the layered prompt architecture (L0 system core / L1 behavior
// contracts / L2 per-request user-turn composer).

import { describe, it, expect } from 'bun:test';
import {
  SYSTEM_CORE_PROMPT,
  WORKFLOW_PROMPT,
  COMPLETION_PROMPT,
  TYPO_TOLERANCE_PROMPT,
  LOGICAL_TRAPS_PROMPT,
  FILE_TOOLS_CORE,
  composeUserTurn,
  stripUserTurnContext,
} from '../promptLayers';

describe('SYSTEM_CORE_PROMPT (L0)', () => {
  it('carries the immutable identity + operating contract', () => {
    expect(SYSTEM_CORE_PROMPT).toContain('<agent_identity>');
    expect(SYSTEM_CORE_PROMPT).toContain('pure');
    expect(SYSTEM_CORE_PROMPT).toContain('<operating_principles>');
    expect(SYSTEM_CORE_PROMPT).toContain('<permission_modes>');
    expect(SYSTEM_CORE_PROMPT).toContain('<runtime>');
    expect(SYSTEM_CORE_PROMPT).toContain('<response_format>');
  });

  it('keeps the system core free of request-specific content', () => {
    expect(SYSTEM_CORE_PROMPT).not.toContain('web_search');
    expect(SYSTEM_CORE_PROMPT).not.toContain('read_file');
    expect(SYSTEM_CORE_PROMPT).not.toContain('## 阶段');
  });
});

describe('L1 behavior contracts', () => {
  it('re-exports the always-on workflow + completion contracts', () => {
    expect(WORKFLOW_PROMPT).toContain('Proactive problem-solving workflow');
    expect(COMPLETION_PROMPT).toContain('Completion report');
  });

  it('shares typo tolerance and logical-traps defense', () => {
    expect(TYPO_TOLERANCE_PROMPT).toContain('Smart typo tolerance');
    expect(LOGICAL_TRAPS_PROMPT).toContain('Logical traps & approach switching');
  });
});

describe('composeUserTurn (L2)', () => {
  it('returns the text unchanged with no fragments', () => {
    expect(composeUserTurn('hello')).toBe('hello');
    expect(composeUserTurn('hello', {})).toBe('hello');
  });

  it('wraps each provided fragment in <task_context> before the request', () => {
    const out = composeUserTurn('build me a game', {
      traps: '<trap>contradiction</trap>',
      buildProtocol: '<build>protocol</build>',
    });
    expect(out.startsWith('<task_context>')).toBe(true);
    expect(out).toContain('<trap>contradiction</trap>');
    expect(out).toContain('<build>protocol</build>');
    expect(out.endsWith('build me a game')).toBe(true);
    expect(out.indexOf('<trap>')).toBeLessThan(out.indexOf('<build>'));
    expect(out.indexOf('<build>')).toBeLessThan(out.indexOf('build me a game'));
    expect(out.indexOf('</task_context>')).toBeLessThan(out.indexOf('build me a game'));
  });

  it('includes the approved-plan fragment when present', () => {
    const out = composeUserTurn('proceed', { plan: '## Execution plan\n1. Do' });
    expect(out).toContain('## Execution plan\n1. Do');
    expect(out.endsWith('proceed')).toBe(true);
  });

  it('ignores empty fragments', () => {
    expect(composeUserTurn('x', { traps: '', buildProtocol: undefined, plan: '' })).toBe('x');
  });
});

describe('stripUserTurnContext (replay round-trip)', () => {
  it('strips the <task_context> block leaving the user text', () => {
    const composed = composeUserTurn('build me a game', { traps: '<trap>x</trap>' });
    expect(stripUserTurnContext(composed)).toBe('build me a game');
  });

  it('returns plain text unchanged', () => {
    expect(stripUserTurnContext('just a normal question')).toBe('just a normal question');
    expect(stripUserTurnContext('')).toBe('');
  });

  it('round-trips a multi-fragment turn exactly', () => {
    const text = '  带空格的请求  ';
    const composed = composeUserTurn(text, {
      traps: 'a',
      buildProtocol: 'b',
      plan: '## Execution plan',
    });
    expect(stripUserTurnContext(composed)).toBe(text);
  });

  it('does not strip when the closing tag is missing (malformed)', () => {
    expect(stripUserTurnContext('<task_context>broken')).toBe('<task_context>broken');
  });
});

describe('FILE_TOOLS_CORE (L1 shared tool list)', () => {
  it('lists the full file + shell/git tool set', () => {
    expect(FILE_TOOLS_CORE).toContain('read_file(path, startLine?, endLine?)');
    expect(FILE_TOOLS_CORE).toContain('replace_files(files[], oldString, newString, allowMultiple?)');
    expect(FILE_TOOLS_CORE).toContain('execute_command(command) — run a shell command');
    expect(FILE_TOOLS_CORE).toContain('git_status — working tree status');
  });
});
