// src/harness/__tests__/LessonReflector.test.ts
// E1.1 — unit tests for the lesson reflector core: evidence extraction from a
// turn transcript, the trigger gate, strict evidence validation (the
// anti-hallucination discipline), the daily-cap counter, and the LLM
// round-trip wrapper. Harness-level wiring lives in Harness.test.ts.

import { describe, it, expect } from 'bun:test';
import type { LLMAdapter, MemoryEntry, Message } from '../../shared/types';
import {
  REFLECT_DEDUPE_PREFIX,
  buildTurnEvidence,
  countReflectionsToday,
  parseReflectedLesson,
  reflectTurn,
  shouldReflect,
  type ReflectionConfig,
  type TurnEvidence,
} from '../LessonReflector';

const REFLECTION_ON: Required<ReflectionConfig> = { enabled: true, dailyCap: 20, minToolCalls: 3 };

function toolCallMessage(name: string, args: string, id = `${name}-1`): Message {
  return {
    role: 'assistant',
    content: '',
    toolCalls: [{ id, index: 0, function: { name, arguments: args } }],
  };
}

describe('buildTurnEvidence', () => {
  it('returns empty for a turn without tool calls', () => {
    const messages: Message[] = [
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: 'hi' },
    ];
    expect(buildTurnEvidence(messages)).toEqual([]);
  });

  it('extracts one catalog entry per tool call, in order', () => {
    const messages: Message[] = [
      { role: 'user', content: 'do it' },
      toolCallMessage('read_file', '{"path":"a.ts"}', 'c1'),
      toolCallMessage('execute_command', '{"command":"bun test"}', 'c2'),
    ];
    const evidence = buildTurnEvidence(messages);
    expect(evidence).toHaveLength(2);
    expect(evidence[0].toolName).toBe('read_file');
    expect(evidence[1].toolName).toBe('execute_command');
    expect(evidence[0].id).not.toBe(evidence[1].id);
  });

  it('hashes content, not order: identical calls collapse to identical ids', () => {
    const a = buildTurnEvidence([toolCallMessage('read_file', '{"path":"a.ts"}', 'x')]);
    const b = buildTurnEvidence([toolCallMessage('read_file', '{"path":"a.ts"}', 'y')]);
    expect(a[0].id).toBe(b[0].id);
  });

  it('truncates the args preview', () => {
    const longArgs = JSON.stringify({ command: 'x'.repeat(400) });
    const evidence = buildTurnEvidence([toolCallMessage('execute_command', longArgs)]);
    expect(evidence[0].argsPreview.length).toBeLessThanOrEqual(160);
    expect(evidence[0].argsPreview.startsWith('{"command":"xxx')).toBe(true);
  });
});

describe('shouldReflect', () => {
  it('never reflects when disabled', () => {
    expect(shouldReflect(10, 5, { ...REFLECTION_ON, enabled: false })).toBe(false);
  });

  it('never reflects a plain-chat turn without tool calls', () => {
    expect(shouldReflect(0, 0, REFLECTION_ON)).toBe(false);
    expect(shouldReflect(0, 3, REFLECTION_ON)).toBe(false);
  });

  it('reflects any turn with failures, and multi-step turns above the threshold', () => {
    expect(shouldReflect(1, 2, REFLECTION_ON)).toBe(true);
    expect(shouldReflect(2, 0, REFLECTION_ON)).toBe(false);
    expect(shouldReflect(3, 0, REFLECTION_ON)).toBe(true);
  });
});

describe('parseReflectedLesson', () => {
  const evidence: TurnEvidence[] = buildTurnEvidence([
    toolCallMessage('read_file', '{"path":"a.ts"}', 'c1'),
    toolCallMessage('execute_command', '{"command":"bun test"}', 'c2'),
  ]);

  it('accepts a well-formed reply citing real evidence ids as high confidence', () => {
    const reply = JSON.stringify({
      symptom: 'test command failed',
      rootCause: 'wrong working directory',
      prevention: 'cd into the workspace first',
      recovery: 'reran from workspace root',
      evidence: [evidence[0].id, evidence[1].id],
    });
    const lesson = parseReflectedLesson(reply, evidence);
    expect(lesson?.confidence).toBe('high');
    expect(lesson?.evidence).toEqual([evidence[0].id, evidence[1].id]);
    expect(lesson?.prevention).toBe('cd into the workspace first');
  });

  it('strips hallucinated ids and forces low confidence when nothing real remains', () => {
    const reply = JSON.stringify({
      symptom: 's',
      rootCause: 'the moon was in retrograde',
      prevention: 'p',
      recovery: 'r',
      evidence: [evidence[0].id, 'deadbeef0000', 'invented123456'],
    });
    const mixed = parseReflectedLesson(reply, evidence);
    expect(mixed?.confidence).toBe('high');
    expect(mixed?.evidence).toEqual([evidence[0].id]);

    const allFake = parseReflectedLesson(reply.replace(evidence[0].id, 'faked12345678'), evidence);
    expect(allFake?.evidence).toEqual([]);
    expect(allFake?.confidence).toBe('low');
  });

  it('parses fenced JSON and tolerates preambles', () => {
    const reply = `Sure! Here is my analysis:\n\`\`\`json\n${JSON.stringify({
      symptom: 's',
      rootCause: 'citing ' + evidence[0].id,
      evidence: [evidence[0].id],
    })}\n\`\`\``;
    const lesson = parseReflectedLesson(reply, evidence);
    expect(lesson?.confidence).toBe('high');
    expect(lesson?.rootCause).toContain(evidence[0].id);
  });

  it('returns undefined for garbage or missing required fields, with defaults for the rest', () => {
    expect(parseReflectedLesson('no json at all', evidence)).toBeUndefined();
    expect(parseReflectedLesson('{"symptom":"only one field"}', evidence)).toBeUndefined();
    const minimal = parseReflectedLesson(JSON.stringify({ symptom: 's', rootCause: 'r' }), evidence);
    expect(minimal?.prevention).toContain('Keep the same inspection');
    expect(minimal?.recovery).toBe('not needed');
    expect(minimal?.confidence).toBe('low');
  });

  it('caps the procedure at 600 characters', () => {
    const lesson = parseReflectedLesson(JSON.stringify({
      symptom: 's',
      rootCause: 'r',
      procedure: 'p'.repeat(2000),
    }), evidence);
    expect(lesson?.procedure).toHaveLength(600);
  });
});

describe('parseReflectedLesson corrections (E3.1)', () => {
  const evidence: TurnEvidence[] = buildTurnEvidence([
    toolCallMessage('edit_file', '{"path":"a.ts"}', 'c1'),
  ]);

  const base = {
    symptom: 'user corrected the output',
    rootCause: `see ${evidence[0].id}`,
    evidence: [evidence[0].id],
  };

  it('parses a well-formed correction', () => {
    const lesson = parseReflectedLesson(JSON.stringify({
      ...base,
      correction: { kind: 'project_convention', statement: '  No comments in this repo — names must speak for themselves.  ' },
    }), evidence);
    expect(lesson?.correction).toEqual({
      kind: 'project_convention',
      statement: 'No comments in this repo — names must speak for themselves.',
    });
  });

  it('accepts both whitelist kinds and drops unknown ones', () => {
    const pref = parseReflectedLesson(JSON.stringify({
      ...base,
      correction: { kind: 'user_preference', statement: 'Always answer in Chinese.' },
    }), evidence);
    expect(pref?.correction?.kind).toBe('user_preference');

    const offWhitelist = parseReflectedLesson(JSON.stringify({
      ...base,
      correction: { kind: 'output_style', statement: 'Always answer in Chinese.' },
    }), evidence);
    expect(offWhitelist?.correction).toBeUndefined();
  });

  it('drops corrections whose statement is too short or the field is malformed', () => {
    const tooShort = parseReflectedLesson(JSON.stringify({
      ...base,
      correction: { kind: 'user_preference', statement: 'sure' },
    }), evidence);
    expect(tooShort?.correction).toBeUndefined();

    const notObject = parseReflectedLesson(JSON.stringify({
      ...base,
      correction: 'always use bun',
    }), evidence);
    expect(notObject?.correction).toBeUndefined();

    const absent = parseReflectedLesson(JSON.stringify(base), evidence);
    expect(absent?.correction).toBeUndefined();
  });

  it('trims whitespace, then caps the statement at 200 characters', () => {
    const lesson = parseReflectedLesson(JSON.stringify({
      ...base,
      correction: { kind: 'project_convention', statement: `${'x'.repeat(300)}` },
    }), evidence);
    expect(lesson?.correction?.statement).toHaveLength(200);
  });
});

describe('countReflectionsToday', () => {
  const projectPath = '/ws';

  function storeWith(entries: Partial<MemoryEntry>[]): { list: (opts?: { projectPath?: string }) => MemoryEntry[] } {
    return {
      list: (opts) => entries
        .map((e, i) => ({ id: `m${i}`, type: 'successful_pattern', content: '', timestamp: 0, sessionId: 's', projectPath, ...e } as MemoryEntry))
        .filter((e) => opts?.projectPath === undefined || e.projectPath === opts.projectPath),
    };
  }

  it('counts only today\'s reflect-prefixed entries in the same project', () => {
    const now = Date.now();
    const yesterday = now - 24 * 60 * 60 * 1000;
    const store = storeWith([
      { dedupeKey: `${REFLECT_DEDUPE_PREFIX}s1:task`, timestamp: now, projectPath },
      { dedupeKey: `${REFLECT_DEDUPE_PREFIX}s1:task2`, timestamp: now - 1000, projectPath },
      { dedupeKey: `${REFLECT_DEDUPE_PREFIX}s1:old`, timestamp: yesterday, projectPath },
      { dedupeKey: 'template-key', timestamp: now, projectPath },
      { dedupeKey: `${REFLECT_DEDUPE_PREFIX}s1:other-project`, timestamp: now, projectPath: '/elsewhere' },
    ]);
    expect(countReflectionsToday(store as never, projectPath, now)).toBe(2);
  });

  it('returns 0 for an empty or failing store', () => {
    expect(countReflectionsToday(storeWith([]) as never, projectPath)).toBe(0);
    expect(countReflectionsToday({ list: () => { throw new Error('disk gone'); } } as never, projectPath)).toBe(0);
  });
});

describe('reflectTurn', () => {
  const evidence = buildTurnEvidence([toolCallMessage('read_file', '{"path":"a.ts"}', 'c1')]);
  const input = {
    userPrompt: 'fix the flaky test',
    evidence,
    failures: [{ toolName: 'execute_command', message: 'exit 1' }],
    verificationSummary: 'no verification evidence',
    verificationPassed: false,
  };

  function llmReturning(content: string): LLMAdapter {
    return {
      stream: async function* () { yield { type: 'done', content: '', toolCalls: [] }; },
      complete: async () => ({ content }),
    };
  }

  it('round-trips a usable reply into a validated lesson', async () => {
    const llm = llmReturning(JSON.stringify({
      symptom: 'flaky test',
      rootCause: `see ${evidence[0].id}`,
      prevention: 'isolate the timer',
      evidence: [evidence[0].id],
    }));
    const lesson = await reflectTurn(llm, input);
    expect(lesson?.confidence).toBe('high');
    expect(lesson?.symptom).toBe('flaky test');
  });

  it('propagates transport failures (caller falls back to the template)', async () => {
    const llm: LLMAdapter = {
      stream: async function* () { yield { type: 'done', content: '', toolCalls: [] }; },
      complete: async () => { throw new Error('provider down'); },
    };
    await expect(reflectTurn(llm, input)).rejects.toThrow('provider down');
  });

  it('resolves undefined for an unusable reply (parse-level fallback)', async () => {
    expect(await reflectTurn(llmReturning('I cannot help with that.'), input)).toBeUndefined();
  });
});
