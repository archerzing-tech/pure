// src/engine/__tests__/FailurePolicy.test.ts
// v0.11 — repeated-error detection: the SAME call (tool + error message)
// failing over and over must escalate faster than the generic count ladder,
// with explicit "do not repeat this exact call" guidance.

import { describe, it, expect } from 'bun:test';
import { DefaultFailurePolicy } from '../FailurePolicy';
import type { FailureRecord, FailureAction } from '../../shared/types';

const toolError = (toolName: string, message: string, turnNumber = 1): FailureRecord => ({
  type: 'tool_error',
  message,
  turnNumber,
  toolName,
});

const llmError = (message: string, turnNumber = 1): FailureRecord => ({
  type: 'llm_error',
  message,
  turnNumber,
});

describe('DefaultFailurePolicy repeated-error detection (v0.11)', () => {
  it('treats 1 failure as a plain retry', () => {
    const policy = new DefaultFailurePolicy();
    const action = policy.decide([toolError('web_fetch', 'Unsupported content type: application/json')]);
    expect(action.kind).toBe('retry');
  });

  it('escalates to reflect with a Do-NOT-repeat hint when the SAME call fails twice', () => {
    const policy = new DefaultFailurePolicy();
    const action: FailureAction = policy.decide([
      toolError('web_fetch', 'Unsupported content type: application/json'),
      toolError('web_fetch', 'Unsupported content type: application/json'),
    ]);
    expect(action.kind).toBe('reflect');
    if (action.kind === 'reflect') {
      expect(action.hint).toContain('identical error');
      expect(action.hint).toContain('Do NOT make this exact call again');
      expect(action.hint).toContain('web_fetch');
    }
  });

  it('stops on the 3rd identical repeat instead of waiting for 6 failures', () => {
    const policy = new DefaultFailurePolicy();
    const action = policy.decide([
      toolError('web_fetch', 'Unsupported content type: application/json'),
      toolError('web_fetch', 'Unsupported content type: application/json'),
      toolError('web_fetch', 'Unsupported content type: application/json'),
    ]);
    expect(action.kind).toBe('stop');
    if (action.kind === 'stop') {
      expect(action.reason).toContain('consecutive failures');
      expect(action.reason).toContain('stop making it');
    }
  });

  it('does NOT treat different errors from the same tool as repeats', () => {
    const policy = new DefaultFailurePolicy();
    // Same tool, different messages → distinct failures, generic count ladder.
    const action = policy.decide([
      toolError('web_fetch', 'Unsupported content type: application/json'),
      toolError('web_fetch', 'HTTP 429'),
      toolError('web_fetch', 'HTTP 503'),
    ]);
    // 3 distinct failures → reflect (count <= 4) but NOT the identical-repeat stop.
    expect(action.kind).toBe('reflect');
    if (action.kind === 'reflect') {
      expect(action.hint).not.toContain('Do NOT make this exact call again');
    }
  });

  it('does NOT treat the same error from different tools as a repeat', () => {
    const policy = new DefaultFailurePolicy();
    const action = policy.decide([
      toolError('web_fetch', 'timeout after 30s'),
      toolError('execute_command', 'timeout after 30s'),
    ]);
    // Different tools → no identical repeat → count=2 → retry.
    expect(action.kind).toBe('retry');
  });

  it('applies repeat detection to llm_error failures too', () => {
    const policy = new DefaultFailurePolicy();
    const action = policy.decide([
      llmError('model overloaded'),
      llmError('model overloaded'),
      llmError('model overloaded'),
    ]);
    expect(action.kind).toBe('stop');
  });

  describe('DefaultFailurePolicy logical-trap escape (v0.2)', () => {
    it('keeps the first failure a plain retry WITHOUT the trap hint', () => {
      const policy = new DefaultFailurePolicy();
      const action = policy.decide([toolError('read_file', 'file not found')]);
      expect(action.kind).toBe('retry');
      if (action.kind === 'retry') {
        expect(action.hint).not.toContain('logical trap');
      }
    });

    it('adds the trap-escape hint on the 2nd failure (after the first failed round)', () => {
      const policy = new DefaultFailurePolicy();
      const action = policy.decide([
        toolError('web_fetch', 'unsupported content type'),
        toolError('web_fetch', 'HTTP 503'),
      ]);
      expect(action.kind).toBe('retry');
      if (action.kind === 'retry') {
        expect(action.hint).toContain('logical trap');
        expect(action.hint).toContain('ORIGINAL user request');
      }
    });

    it('includes the trap-escape hint on reflect (3-4 failures)', () => {
      const policy = new DefaultFailurePolicy();
      const action = policy.decide([
        toolError('read_file', 'a'),
        toolError('web_fetch', 'b'),
        toolError('execute_command', 'c'),
      ]);
      expect(action.kind).toBe('reflect');
      if (action.kind === 'reflect') {
        expect(action.hint).toContain('logical trap');
        expect(action.hint).toContain('fundamentally different approach');
      }
    });

    it('includes the trap-escape hint on identical-repeat reflect', () => {
      const policy = new DefaultFailurePolicy();
      const action = policy.decide([
        toolError('web_fetch', 'same dead end'),
        toolError('web_fetch', 'same dead end'),
      ]);
      expect(action.kind).toBe('reflect');
      if (action.kind === 'reflect') {
        expect(action.hint).toContain('Do NOT make this exact call again');
        expect(action.hint).toContain('logical trap');
      }
    });
  });
});
