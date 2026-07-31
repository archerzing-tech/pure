// src/coding-agent/__tests__/LLMVerifier.test.ts
// Covers the LLM-based verification check: verdict parsing, fail-open
// behavior, prompt contents, and task extraction from context.

import { describe, it, expect } from 'bun:test';
import {
  createLLMVerifier,
  createLLMVerifyCheck,
  extractUserTask,
  parseVerdict,
  LLMVerifyCheckName,
} from '../Verifier';
import type { LLMAdapter, Message } from '../../shared/types';

// ── Mock LLM helpers ──

function verdictLLM(content: string): LLMAdapter {
  return {
    complete: async () => ({ content, toolCalls: [] }),
    stream: async function* () {},
  };
}

function capturingLLM(content: string): { llm: LLMAdapter; lastMessages: () => Message[] } {
  let last: Message[] = [];
  return {
    llm: {
      complete: async (messages: Message[]) => {
        last = messages;
        return { content, toolCalls: [] };
      },
      stream: async function* () {},
    },
    lastMessages: () => last,
  };
}

const CTX: Message[] = [
  { role: 'system', content: 'You are pure.' },
  { role: 'user', content: 'Write a function that reverses a string.' },
  { role: 'assistant', content: 'Here is the implementation.' },
  { role: 'user', content: 'Now also handle empty input.' },
];

describe('extractUserTask', () => {
  it('returns the most recent non-empty user message', () => {
    expect(extractUserTask(CTX)).toBe('Now also handle empty input.');
  });

  it('returns empty string when there is no user message', () => {
    expect(extractUserTask([{ role: 'system', content: 'x' }, { role: 'assistant', content: 'y' }])).toBe('');
  });
});

describe('parseVerdict', () => {
  it('parses a plain JSON verdict', () => {
    expect(parseVerdict('{"passed": true, "feedback": "ok"}')).toEqual({ passed: true, feedback: 'ok' });
  });

  it('parses markdown-fenced JSON', () => {
    expect(parseVerdict('```json\n{"passed": false, "feedback": "missing"}```')).toEqual({ passed: false, feedback: 'missing' });
  });

  it('tolerates stray text around the JSON object', () => {
    expect(parseVerdict('Here you go: {"passed": true} thanks!')).toEqual({ passed: true, feedback: undefined });
  });

  it('parses feedback containing literal braces (depth counting)', () => {
    expect(parseVerdict('{"passed": false, "feedback": "missing closing }"}')).toEqual({
      passed: false,
      feedback: 'missing closing }',
    });
  });

  it('returns null for non-verdict responses', () => {
    expect(parseVerdict('I cannot verify this.')).toBeNull();
    expect(parseVerdict('{"verdict": "pass"}')).toBeNull();
  });
});

describe('createLLMVerifier', () => {
  it('passes when the model verdict is passed', async () => {
    const v = createLLMVerifier(verdictLLM('{"passed": true, "feedback": "matches request"}'));
    const result = await v.evaluate({ output: 'function rev(s){...}', context: CTX });
    expect(result.passed).toBe(true);
  });

  it('fails with the model feedback when the verdict is failed', async () => {
    const v = createLLMVerifier(verdictLLM('{"passed": false, "feedback": "empty input not handled"}'));
    const result = await v.evaluate({ output: 'function rev(s){return s.split("").reverse().join("")}', context: CTX });
    expect(result.passed).toBe(false);
    expect(result.feedback).toContain(`[${LLMVerifyCheckName}]`);
    expect(result.feedback).toContain('empty input not handled');
  });

  it('fails open (passes) on an unparseable verdict so the agent is not trapped', async () => {
    // Assert at the check level: Verifier.evaluate drops the feedback field on
    // the pass path, so fail-open diagnostics are only visible via check.run().
    const check = createLLMVerifyCheck(verdictLLM('I think the output is fine, no JSON here.'));
    const result = await check.run({ output: 'some output', context: CTX });
    expect(result.passed).toBe(true);
    expect(result.feedback).toContain('unparseable');
  });

  it('fails open when the verifier LLM throws', async () => {
    const throwing: LLMAdapter = {
      complete: async () => { throw new Error('llm down'); },
      stream: async function* () {},
    };
    const check = createLLMVerifyCheck(throwing);
    const result = await check.run({ output: 'output', context: CTX });
    expect(result.passed).toBe(true);
    expect(result.feedback).toContain('verifier LLM error');
  });

  it('keeps the non-empty fast-fail check before the LLM call', async () => {
    const { llm, lastMessages } = capturingLLM('{"passed": true}');
    const v = createLLMVerifier(llm);
    const result = await v.evaluate({ output: '   ', context: CTX });
    expect(result.passed).toBe(false);
    expect(result.feedback).toContain('non-empty-output');
    // The LLM must not have been consulted for an empty output.
    expect(lastMessages()).toHaveLength(0);
  });

  it('sends the task and the output to the verifier LLM', async () => {
    const { llm, lastMessages } = capturingLLM('{"passed": true}');
    const check = createLLMVerifyCheck(llm);
    await check.run({ output: 'the final answer', context: CTX });
    const prompt = lastMessages()[0].content;
    expect(prompt).toContain('Now also handle empty input.'); // the task
    expect(prompt).toContain('the final answer'); // the output
    expect(prompt).toContain('verification agent');
  });
});
