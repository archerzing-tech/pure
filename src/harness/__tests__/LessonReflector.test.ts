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
  lessonToMemoryAdds,
  parseReflectedLesson,
  reflectTurn,
  shouldReflect,
  type ReflectedLesson,
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

describe('parseReflectedLesson term_alias corrections (阶段 11.4 纠错记忆闭环)', () => {
  const evidence: TurnEvidence[] = buildTurnEvidence([
    toolCallMessage('read_file', '{"path":"oldname.ts"}', 'c1'),
    toolCallMessage('read_file', '{"path":"newname.ts"}', 'c2'),
  ]);
  const base = {
    symptom: 'user named a file that does not exist',
    rootCause: 'guessed the wrong path',
    evidence: [] as string[],
  };

  it('accepts a grounded term_alias and generates a canonical statement from from/to', () => {
    const lesson = parseReflectedLesson(JSON.stringify({
      ...base,
      correction: { kind: 'term_alias', from: 'oldname.ts', to: 'newname.ts' },
    }), evidence);
    expect(lesson?.correction?.kind).toBe('term_alias');
    expect(lesson?.correction).toMatchObject({ from: 'oldname.ts', to: 'newname.ts' });
    // statement 由 from/to 规范化生成，而不是采信模型措辞。
    expect(lesson?.correction?.statement).toBe('The user writes "oldname.ts" to mean the real path "newname.ts".');
  });

  it('ignores any model-supplied statement for term_alias (stable dedupeKey)', () => {
    const a = parseReflectedLesson(JSON.stringify({
      ...base,
      correction: { kind: 'term_alias', from: 'oldname.ts', to: 'newname.ts', statement: 'first wording' },
    }), evidence);
    const b = parseReflectedLesson(JSON.stringify({
      ...base,
      correction: { kind: 'term_alias', from: 'oldname.ts', to: 'newname.ts', statement: 'totally different wording' },
    }), evidence);
    expect(a?.correction?.statement).toBe(b?.correction?.statement);
  });

  it('drops term_alias with a missing/empty field or from === to', () => {
    const missingTo = parseReflectedLesson(JSON.stringify({
      ...base, correction: { kind: 'term_alias', from: 'oldname.ts' },
    }), evidence);
    expect(missingTo?.correction).toBeUndefined();

    const emptyFrom = parseReflectedLesson(JSON.stringify({
      ...base, correction: { kind: 'term_alias', from: '   ', to: 'newname.ts' },
    }), evidence);
    expect(emptyFrom?.correction).toBeUndefined();

    const same = parseReflectedLesson(JSON.stringify({
      ...base, correction: { kind: 'term_alias', from: 'newname.ts', to: 'newname.ts' },
    }), evidence);
    expect(same?.correction).toBeUndefined();
  });

  it('drops term_alias when from or to cannot be grounded in the turn catalog', () => {
    const ungroundedFrom = parseReflectedLesson(JSON.stringify({
      ...base, correction: { kind: 'term_alias', from: 'ghost.ts', to: 'newname.ts' },
    }), evidence);
    expect(ungroundedFrom?.correction).toBeUndefined();

    const ungroundedTo = parseReflectedLesson(JSON.stringify({
      ...base, correction: { kind: 'term_alias', from: 'oldname.ts', to: 'ghost.ts' },
    }), evidence);
    expect(ungroundedTo?.correction).toBeUndefined();
    // 别名被丢弃，但 lesson 主体照旧解析（correction 只是可选的便车）。
    expect(ungroundedTo?.symptom).toBe(base.symptom);
  });
});

describe('lessonToMemoryAdds term_alias mapping (阶段 11.4)', () => {
  const ctx = {
    sessionId: 'sess-alias',
    projectPath: '/ws/project-a',
    dedupeKey: 'reflect:sess-alias:open the file',
    verificationSummary: 'not needed',
    verificationPassed: false,
  };

  function aliasLesson(scope?: 'project' | 'machine'): ReflectedLesson {
    return {
      symptom: 'user named a missing file',
      rootCause: 'guessed the path',
      prevention: 'resolve the real path first',
      recovery: 'used the real path',
      evidence: ['abc123'],
      confidence: 'low',
      correction: { kind: 'term_alias', statement: 'ignored', from: 'oldname.ts', to: 'newname.ts' },
      ...(scope ? { scope } : {}),
    };
  }

  it('maps term_alias onto an existing project_convention draft (no new MemoryType)', () => {
    const adds = lessonToMemoryAdds(aliasLesson(), ctx);
    const draft = adds.find((a) => a.dedupeKey?.startsWith('correction:term_alias:'));
    expect(draft).toBeDefined();
    expect(draft!.type).toBe('project_convention');
    expect(draft!.confidence).toBe('low');
    expect(draft!.projectPath).toBe('/ws/project-a');
    // content 是可读的「本工作区词条」，包含 from/to 两个 token。
    expect(draft!.content).toContain('oldname.ts');
    expect(draft!.content).toContain('newname.ts');
    expect(draft!.content).toContain('本工作区词条');
  });

  it('keeps the alias in the project domain even when the lesson is scope:machine', () => {
    const adds = lessonToMemoryAdds(aliasLesson('machine'), ctx);
    const draft = adds.find((a) => a.dedupeKey?.startsWith('correction:term_alias:'));
    expect(draft!.projectPath).toBe('/ws/project-a');
    // 主 lesson 才随 machine 走全局。
    const main = adds.find((a) => a.type === 'successful_pattern');
    expect(main!.projectPath).toBe('__machine__');
  });

  it('produces the same dedupeKey for the same from/to across sessions (硬验收)', () => {
    const first = lessonToMemoryAdds(aliasLesson(), { ...ctx, sessionId: 'session-A' })
      .find((a) => a.dedupeKey?.startsWith('correction:term_alias:'))!;
    const second = lessonToMemoryAdds(aliasLesson(), { ...ctx, sessionId: 'session-B' })
      .find((a) => a.dedupeKey?.startsWith('correction:term_alias:'))!;
    expect(first.dedupeKey).toBe(second.dedupeKey);
    expect(first.dedupeKey).toMatch(/^correction:term_alias:[0-9a-f]{12}$/);
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

describe('lesson scope (E1 机器级教训通道, 2026-10-13)', () => {
  const evidence: TurnEvidence[] = buildTurnEvidence([
    toolCallMessage('web_fetch', '{"url":"https://x"}', 'c1'),
  ]);
  const ctx = {
    sessionId: 'sess-scope',
    projectPath: '/ws/project-a',
    dedupeKey: 'reflect:sess-scope:task',
    verificationSummary: 'passed',
    verificationPassed: true,
  };

  it('parses scope:"machine" and defaults/invalid values to project', () => {
    const machine = parseReflectedLesson(JSON.stringify({
      symptom: 'full clone of a large repo timed out',
      rootCause: 'github direct access is slow on this network',
      prevention: 'prefer GitHub API file listing + raw batched download',
      recovery: 'switched to API listing and succeeded',
      evidence: [evidence[0].id],
      scope: 'machine',
    }), evidence);
    expect(machine?.scope).toBe('machine');

    const project = parseReflectedLesson(JSON.stringify({
      symptom: 's', rootCause: 'r', prevention: 'p', recovery: 'r',
      evidence: [evidence[0].id],
    }), evidence);
    expect(project?.scope).toBeUndefined(); // 缺省不写 = project

    const typo = parseReflectedLesson(JSON.stringify({
      symptom: 's', rootCause: 'r', prevention: 'p', recovery: 'r',
      evidence: [evidence[0].id],
      scope: 'Machine ', // 拼写偏差 → 回落 project
    }), evidence);
    expect(typo?.scope).toBeUndefined();
  });

  it('persists machine-scoped lesson and procedure into the global scope, correction stays project-scoped', () => {
    const lesson = parseReflectedLesson(JSON.stringify({
      symptom: 'full clone timed out on this network',
      rootCause: 'slow github direct access on this machine',
      prevention: 'prefer API file listing + raw batched download',
      recovery: 'switched and succeeded',
      evidence: [evidence[0].id],
      procedure: 'list files via API -> batch raw downloads -> verify',
      correction: { kind: 'project_convention', statement: 'never full-clone here' },
      scope: 'machine',
    }), evidence)!;

    const adds = lessonToMemoryAdds(lesson, ctx);
    // 主条目与 procedure 跟机器走;correction 留在项目域。
    for (const add of adds) {
      if (add.type === 'project_convention' || add.type === 'user_preference') {
        expect(add.projectPath).toBe('/ws/project-a');
      } else {
        expect(add.projectPath).toBe('__machine__');
      }
    }
    expect(adds.some(a => a.type === 'procedure' && a.projectPath === '__machine__')).toBe(true);
  });

  it('keeps project-scoped lessons in the project path (no behavior change)', () => {
    const lesson = parseReflectedLesson(JSON.stringify({
      symptom: 's', rootCause: 'r', prevention: 'p', recovery: 'r',
      evidence: [evidence[0].id],
    }), evidence)!;
    const adds = lessonToMemoryAdds(lesson, ctx);
    expect(adds.every(a => a.projectPath === '/ws/project-a')).toBe(true);
  });
});
