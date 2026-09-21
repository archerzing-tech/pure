// src/engine/__tests__/relayPipeline.test.ts
// 接力流水线（北极星第 5 步）的纯函数层：声明解析 / 校验 / 拓扑分层 /
// 参数替换 / 收据文本。执行编排与观察消隐的时机在 ToolExecutionCoordinator。

import { describe, expect, it } from 'bun:test';
import {
  applyRelaySubstitution,
  parseRelayDecl,
  planRelayLevels,
  relayNode,
  relayOutputText,
  relayReceipt,
} from '../relayPipeline';
import type { ExecutedToolResult } from '../ToolExecutionCoordinator';
import type { ToolCall } from '../../shared/types';

function call(args: Record<string, unknown>, id = ''): ToolCall {
  return {
    id: id || `call_${JSON.stringify(args).length}_${Math.random().toString(36).slice(2, 8)}`,
    index: 0,
    function: { name: 'agent_x', arguments: JSON.stringify(args) },
  };
}

function resultOf(callId: string, value: unknown, success = true): ExecutedToolResult {
  return {
    toolName: 'agent_x',
    result: { id: callId, toolName: 'agent_x', result: value, success, duration: 1 },
    duration: 1,
    toolCallId: callId,
  };
}

describe('parseRelayDecl', () => {
  it('parses as + from and trims whitespace', () => {
    expect(parseRelayDecl(JSON.stringify({ prompt: 'x', relay: { as: ' research ', from: { plan: ' plan ' } } }))).toEqual({
      as: 'research',
      from: { plan: 'plan' },
    });
  });

  it('returns undefined for absent or malformed declarations', () => {
    expect(parseRelayDecl('{}')).toBeUndefined();
    expect(parseRelayDecl(JSON.stringify({ relay: 'research' }))).toBeUndefined();
    expect(parseRelayDecl(JSON.stringify({ relay: { as: '' } }))).toBeUndefined();
    expect(parseRelayDecl(JSON.stringify({ relay: { from: { a: 42 } } }))).toBeUndefined();
    expect(parseRelayDecl('not json at all {{{')).toBeUndefined();
  });

  it('tolerates unknown relay keys and empty from maps', () => {
    expect(parseRelayDecl(JSON.stringify({ relay: { as: 'a', form: { typo: 'x' }, from: {} } }))).toEqual({ as: 'a' });
  });
});

describe('planRelayLevels', () => {
  it('cuts a linear chain into one node per level', () => {
    const a = relayNode(call({ relay: { as: 'a' } }, 'c1'));
    const b = relayNode(call({ relay: { as: 'b', from: { a: 'plan' } } }, 'c2'));
    const c = relayNode(call({ relay: { from: { b: 'input' } } }, 'c3'));
    const plan = planRelayLevels([c, a, b]);
    expect(plan.errors).toHaveLength(0);
    expect(plan.levels.map((level) => level.map((n) => n.call.id))).toEqual([['c1'], ['c2'], ['c3']]);
  });

  it('keeps independent calls together in the first level (diamond)', () => {
    const a = relayNode(call({ relay: { as: 'a' } }, 'c1'));
    const b = relayNode(call({ relay: { from: { a: 'x' }, as: 'b' } }, 'c2'));
    const c = relayNode(call({ relay: { from: { a: 'y' }, as: 'c' } }, 'c3'));
    const d = relayNode(call({ relay: { from: { b: 'p', c: 'q' } } }, 'c4'));
    const plain = relayNode(call({ prompt: 'no relay' }, 'c0'));
    const plan = planRelayLevels([a, b, c, d, plain]);
    expect(plan.errors).toHaveLength(0);
    const ids = plan.levels.map((level) => level.map((n) => n.call.id).sort());
    expect(ids).toEqual([['c0', 'c1'], ['c2', 'c3'], ['c4']]);
  });

  it('errors the later duplicate stage name and keeps the earlier owner', () => {
    const a = relayNode(call({ relay: { as: 'dup' } }, 'c1'));
    const dup = relayNode(call({ relay: { as: 'dup' } }, 'c2'));
    const consumer = relayNode(call({ relay: { from: { dup: 'x' } } }, 'c3'));
    const plan = planRelayLevels([a, dup, consumer]);
    expect(plan.errors).toHaveLength(1);
    expect(plan.errors[0].callId).toBe('c2');
    // The consumer still runs — the name resolves to the earlier owner.
    expect(plan.levels.flat().map((n) => n.call.id)).toContain('c3');
  });

  it('errors unknown upstream stages and never schedules the call', () => {
    const node = relayNode(call({ relay: { from: { ghost: 'x' } } }, 'c1'));
    const plan = planRelayLevels([node]);
    expect(plan.errors).toHaveLength(1);
    expect(plan.errors[0].message).toContain('ghost');
    expect(plan.levels).toHaveLength(0);
  });

  it('cascades transitively: a broken upstream skips its whole downstream', () => {
    const a = relayNode(call({ relay: { from: { ghost: 'x' } } }, 'c1')); // broken
    const b = relayNode(call({ relay: { as: 'b', from: { a: 'x' } } }, 'c2'));
    const c = relayNode(call({ relay: { from: { b: 'x' } } }, 'c3'));
    const plan = planRelayLevels([a, b, c]);
    expect(plan.errors.map((e) => e.callId).sort()).toEqual(['c1', 'c2', 'c3']);
    expect(plan.levels).toHaveLength(0);
    expect(plan.errors[2].message).toContain('上游阶段 "b"');
  });

  it('reports dependency cycles, including self-reference', () => {
    const a = relayNode(call({ relay: { as: 'a', from: { b: 'x' } } }, 'c1'));
    const b = relayNode(call({ relay: { as: 'b', from: { a: 'x' } } }, 'c2'));
    const self = relayNode(call({ relay: { as: 's', from: { s: 'x' } } }, 'c3'));
    const plan = planRelayLevels([a, b, self]);
    expect(plan.errors.map((e) => e.callId).sort()).toEqual(['c1', 'c2', 'c3']);
    expect(plan.levels).toHaveLength(0);
    expect(plan.errors[0].message).toContain('成环');
  });
});

describe('relayOutputText / applyRelaySubstitution', () => {
  it('extracts string results, SubagentResult.output, and falls back to JSON', () => {
    expect(relayOutputText(resultOf('c1', 'plain text'))).toBe('plain text');
    expect(relayOutputText(resultOf('c1', { output: 'agent output', agentId: 'ag-x' }))).toBe('agent output');
    expect(relayOutputText(resultOf('c1', { files: ['a', 'b'] }))).toBe('{"files":["a","b"]}');
    expect(relayOutputText(resultOf('c1', undefined))).toBe('');
  });

  it('injects upstream output into the named argument slot, preserving the rest', () => {
    const consumer = call({ instructions: 'do it', relay: { from: { research: 'context' } } }, 'c2');
    const outputs = new Map([['research', resultOf('c1', 'the findings')]]);
    const rewritten = applyRelaySubstitution(consumer, { research: 'context' }, outputs);
    const parsed = JSON.parse(rewritten.function.arguments) as Record<string, unknown>;
    expect(parsed.context).toBe('the findings');
    expect(parsed.instructions).toBe('do it');
    expect(rewritten.id).toBe('c2');
  });

  it('leaves the call untouched when a declared stage has no recorded output', () => {
    const consumer = call({ instructions: 'do it' }, 'c2');
    const rewritten = applyRelaySubstitution(consumer, { ghost: 'context' }, new Map());
    expect(JSON.parse(rewritten.function.arguments)).toEqual({ instructions: 'do it' });
  });
});

describe('relayReceipt', () => {
  it('replaces a string result with the receipt note', () => {
    const tr = resultOf('c1', 'a very long research report');
    const receipt = relayReceipt(tr, ['plan']);
    expect(receipt.result.result).toContain('[relay]');
    expect(receipt.result.result).toContain('"plan"');
    expect(receipt.result.result).not.toContain('a very long research report');
  });

  it('keeps the SubagentResult shape and only swaps the output field', () => {
    const tr = resultOf('c1', { id: 'c1', agentId: 'ag-1', agentName: 'researcher', success: true, output: 'full findings', duration: 5, tokensUsed: 9 });
    const receipt = relayReceipt(tr, ['plan']);
    const value = receipt.result.result as Record<string, unknown>;
    expect(value.agentId).toBe('ag-1');
    expect(value.agentName).toBe('researcher');
    expect(String(value.output)).toContain('[relay]');
    expect(String(value.output)).not.toContain('full findings');
  });
});
