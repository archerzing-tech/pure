// src/evaluation/__tests__/roleSampleHarvest.test.ts
// 13.3 part 3 / 13.1 — 真实派发样本收割的纯函数测试（无 IO、无网络）。

import { describe, expect, it } from 'bun:test';
import {
  dedupeSamples,
  groupSamplesByRole,
  harvestRoleSamples,
  sampleDedupeKey,
  type HarvestSession,
} from '../roleSampleHarvest';

/** One delegation = an assistant message with a toolCall + a tool message
 *  keyed by the same toolCallId (the shape the session archive stores). */
function delegation(role: string, args: unknown, output: unknown, id = 'call_1', success = true) {
  return [
    { role: 'assistant', toolCalls: [{ id, function: { name: role, arguments: JSON.stringify(args) } }] },
    { role: 'tool', toolCallId: id, toolName: role, content: JSON.stringify({ id, agentName: role, success, output }) },
  ];
}

const session = (id: string, ...messages: HarvestSession['messages']): HarvestSession => ({
  id,
  messages: messages.flat(),
});

describe('harvestRoleSamples', () => {
  it('回收一次成功的角色委派（args 解析 + 产出）', () => {
    const [sample] = harvestRoleSamples([
      session('s1', ...delegation('code_reviewer', { prompt: 'review this', files: 'a.ts' }, '发现 correctness 问题')),
    ]);
    expect(sample.role).toBe('code_reviewer');
    expect(sample.args).toEqual({ prompt: 'review this', files: 'a.ts' });
    expect(sample.output).toBe('发现 correctness 问题');
    expect(sample.sessionId).toBe('s1');
  });

  it('用 toolCallId 精确配对，不靠"下一条 tool 消息"的位置猜测', () => {
    const messages = [
      { role: 'assistant', toolCalls: [{ id: 'call_a', function: { name: 'researcher', arguments: '{"topic":"a"}' } }] },
      // 另一条 tool 消息插在中间（属于别的调用）——不能被误配。
      { role: 'tool', toolCallId: 'call_b', content: JSON.stringify({ output: '别的东西' }) },
      { role: 'tool', toolCallId: 'call_a', content: JSON.stringify({ success: true, output: '主题 A 的结论' }) },
    ];
    const [sample] = harvestRoleSamples([{ id: 's1', messages }]);
    expect(sample.output).toBe('主题 A 的结论');
    expect(sample.args).toEqual({ topic: 'a' });
  });

  it('丢弃失败与中断的委派', () => {
    const samples = harvestRoleSamples([
      session('s1', ...delegation('code_reviewer', { prompt: 'x' }, 'Error: tool code_reviewer aborted', 'call_1', false)),
    ]);
    expect(samples).toEqual([]);
  });

  it('success:false 即使有文本产出也丢弃', () => {
    const samples = harvestRoleSamples([
      session('s1', ...delegation('researcher', { topic: 'x' }, '半截结果', 'call_1', false)),
    ]);
    expect(samples).toEqual([]);
  });

  it('空产出与非法 args 的委派被丢弃', () => {
    const samples = harvestRoleSamples([
      { id: 's1', messages: [
        { role: 'assistant', toolCalls: [{ id: 'c1', function: { name: 'researcher', arguments: 'not json' } }] },
        { role: 'tool', toolCallId: 'c1', content: JSON.stringify({ success: true, output: 'x' }) },
        ...delegation('researcher', { topic: 'ok' }, '   ', 'c2'),
      ] },
    ]);
    expect(samples).toEqual([]);
  });

  it('只收已知角色；非角色工具（read_file）不进样本', () => {
    const samples = harvestRoleSamples([
      session('s1',
        ...delegation('read_file', { path: 'a.ts' }, 'file body', 'c1'),
        ...delegation('researcher', { topic: 'ok' }, '结论', 'c2'),
      ),
    ]);
    expect(samples.map((s) => s.role)).toEqual(['researcher']);
  });

  it('自带 roles 白名单时以白名单为准', () => {
    const samples = harvestRoleSamples(
      [session('s1', ...delegation('researcher', { topic: 'ok' }, '结论'))],
      ['code_reviewer'],
    );
    expect(samples).toEqual([]);
  });
});

describe('dedupeSamples / groupSamplesByRole', () => {
  const a = { role: 'researcher', args: { topic: 'x' }, output: 'o1', sessionId: 's1', messageIndex: 0 };
  const b = { role: 'researcher', args: { topic: 'x' }, output: 'o2', sessionId: 's2', messageIndex: 0 };
  const c = { role: 'researcher', args: { topic: 'y' }, output: 'o3', sessionId: 's1', messageIndex: 4 };
  const d = { role: 'code_reviewer', args: { prompt: 'p' }, output: 'o4', sessionId: 's1', messageIndex: 6 };

  it('同角色同 args 只留首次', () => {
    expect(sampleDedupeKey(a)).toBe(sampleDedupeKey(b));
    expect(dedupeSamples([a, b, c])).toEqual([a, c]);
  });

  it('按角色分组，角色名升序', () => {
    const groups = groupSamplesByRole([a, c, d]);
    expect([...groups.keys()]).toEqual(['code_reviewer', 'researcher']);
    expect(groups.get('researcher')).toEqual([a, c]);
  });
});
