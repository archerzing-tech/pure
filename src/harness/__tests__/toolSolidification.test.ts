// P2-2 — 固化流纯核覆盖：候选检测、起草解析、编译校验、样例参数、试跑、写盘。
import { describe, expect, it } from 'bun:test';
import {
  draftPassesCompiler,
  findSolidifyCandidates,
  parseToolDraft,
  runSolidifyFlow,
  sampleArgsFromSchema,
  SOLIDIFY_MIN_REUSES,
  type SolidifyCandidate,
} from '../toolSolidification';
import type { MemoryEntry, LLMAdapter, LLMResponse } from '../../shared/types';

function procedure(id: string, hitCount: number, content = 'Run the linter then fix errors'): MemoryEntry {
  return { id, type: 'procedure', content, timestamp: Date.now(), sessionId: 's', projectPath: '/ws', hitCount };
}

describe('findSolidifyCandidates', () => {
  it('picks procedures with hitCount ≥ threshold, sorted by reuse count', () => {
    const out = findSolidifyCandidates([
      procedure('p_low', 1),
      procedure('p_ok', 3),
      procedure('p_hot', 7),
      { id: 'not_proc', type: 'successful_pattern', content: 'x', timestamp: 1, sessionId: 's', projectPath: '/ws', hitCount: 10 },
      { ...procedure('p_dormant', 99), lifecycle: 'dormant' as const },
    ]);
    expect(out.map((c) => c.procedureId)).toEqual(['p_hot', 'p_ok']);
    expect(out[0].hitCount).toBe(7);
  });
});

describe('parseToolDraft', () => {
  it('parses a valid TOOL.json reply', () => {
    const draft = parseToolDraft('{"name":"lint_fix","description":"Run linter and fix","exec":"eslint --fix {path}","input_schema":{"type":"object","properties":{"path":{"type":"string"}},"required":["path"]}}');
    expect(draft?.name).toBe('lint_fix');
    expect(draft?.exec).toContain('{path}');
  });

  it('returns undefined for NONE, bad JSON, or missing fields', () => {
    expect(parseToolDraft('NONE')).toBeUndefined();
    expect(parseToolDraft('not json')).toBeUndefined();
    expect(parseToolDraft('{"name":"x"}')).toBeUndefined();
    expect(parseToolDraft('```json\n{"name":"x","description":"too short I mean valid desc","exec":"ls","input_schema":{}}\n```')).toBeDefined();
  });
});

describe('draftPassesCompiler', () => {
  it('accepts a valid draft and rejects a bad name', () => {
    expect(draftPassesCompiler({
      name: 'good_tool', description: 'A valid description here', exec: 'echo hi',
      input_schema: { type: 'object', properties: {}, required: [] },
    })).toBe(true);
    expect(draftPassesCompiler({
      name: 'BadName', description: 'A valid description here', exec: 'echo hi',
      input_schema: { type: 'object' },
    })).toBe(false);
  });
});

describe('sampleArgsFromSchema', () => {
  it('generates reasonable defaults per type', () => {
    expect(sampleArgsFromSchema({
      type: 'object',
      properties: { path: { type: 'string' }, count: { type: 'integer' }, flag: { type: 'boolean' } },
      required: ['path', 'count', 'flag'],
    })).toEqual({ path: 'test', count: 1, flag: true });
  });

  it('uses defaults and enum first values when present', () => {
    expect(sampleArgsFromSchema({
      type: 'object',
      properties: { mode: { type: 'string', enum: ['fast', 'slow'] }, limit: { type: 'number', default: 5 } },
      required: ['mode', 'limit'],
    })).toEqual({ mode: 'fast', limit: 5 });
  });
});

// ── 完整固化流（fake LLM + fake IO）──

function fakeLlm(reply: () => string): LLMAdapter {
  return {
    stream: async function* () { yield { type: 'done', content: '', toolCalls: [] }; },
    complete: async (): Promise<LLMResponse> => ({ content: reply(), toolCalls: [] }),
  };
}

function fakeIo(over: Partial<Parameters<typeof runSolidifyFlow>[0]['io']> = {}): Parameters<typeof runSolidifyFlow>[0]['io'] & { written: Array<{ name: string; manifest: string }> } {
  const io = {
    written: [] as Array<{ name: string; manifest: string }>,
    runCommand: async () => ({ ok: true, output: '' }),
    writeToolDir: async (name: string, manifest: string) => { io.written.push({ name, manifest }); },
    toolExists: async () => false,
    ...over,
  };
  return io;
}

const CANDIDATE: SolidifyCandidate = { procedureId: 'p1', content: 'Run eslint --fix on the file', hitCount: 3 };
const GOOD_REPLY = '{"name":"lint_fix","description":"Run ESLint auto-fix on a file path","exec":"npx eslint --fix {path}","input_schema":{"type":"object","properties":{"path":{"type":"string"}},"required":["path"]}}';

describe('runSolidifyFlow', () => {
  it('writes a valid tool when everything passes', async () => {
    const io = fakeIo();
    const result = await runSolidifyFlow({
      procedure: CANDIDATE,
      llm: fakeLlm(() => GOOD_REPLY),
      io,
      confirm: async () => true,
    });
    expect(result).toEqual({ kind: 'written', name: 'lint_fix' });
    expect(io.written).toHaveLength(1);
    expect(io.written[0].name).toBe('lint_fix');
    expect(io.written[0].manifest).toContain('"version": 1');
  });

  it('returns none when the model declines', async () => {
    const io = fakeIo();
    const result = await runSolidifyFlow({ procedure: CANDIDATE, llm: fakeLlm(() => 'NONE'), io, confirm: async () => true });
    expect(result).toEqual({ kind: 'none' });
    expect(io.written).toHaveLength(0);
  });

  it('retries once on test failure, then succeeds with a different draft', async () => {
    let call = 0;
    const replies = ['{"name":"bad_tool","description":"Always fails in test","exec":"exit 1","input_schema":{"type":"object"}}', GOOD_REPLY];
    const io = fakeIo({ runCommand: async (cmd: string) => cmd.includes('exit 1') ? { ok: false, output: 'exited with code 1' } : { ok: true, output: '' } });
    const result = await runSolidifyFlow({
      procedure: CANDIDATE,
      llm: fakeLlm(() => replies[call++] ?? GOOD_REPLY),
      io,
      confirm: async () => true,
    });
    expect(result).toEqual({ kind: 'written', name: 'lint_fix' });
  });

  it('returns test_failed when all attempts fail the test run', async () => {
    const io = fakeIo({ runCommand: async () => ({ ok: false, output: 'command not found: xyz' }) });
    const result = await runSolidifyFlow({
      procedure: CANDIDATE,
      llm: fakeLlm(() => '{"name":"fail_tool","description":"A tool that always fails","exec":"xyz --bad","input_schema":{"type":"object"}}'),
      io,
      confirm: async () => true,
    });
    expect(result.kind).toBe('test_failed');
  });

  it('returns exists when the tool directory is already there', async () => {
    const io = fakeIo({ toolExists: async () => true });
    const result = await runSolidifyFlow({ procedure: CANDIDATE, llm: fakeLlm(() => GOOD_REPLY), io, confirm: async () => true });
    expect(result).toEqual({ kind: 'exists' });
  });

  it('returns cancelled when the user declines the confirm', async () => {
    const io = fakeIo();
    const result = await runSolidifyFlow({ procedure: CANDIDATE, llm: fakeLlm(() => GOOD_REPLY), io, confirm: async () => false });
    expect(result).toEqual({ kind: 'cancelled' });
    expect(io.written).toHaveLength(0);
  });
});
