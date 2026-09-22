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

  it('重复 toolCallId 取首次（first-wins），不被后来的结果覆盖', () => {
    // 会话存档里同一结果会重复出现（真实数据里内容逐字节相同）；"首次即结果"
    // 是我们能陈述的规则，而不是 Map 插入顺序的副产物。
    const messages = [
      { role: 'assistant', toolCalls: [{ id: 'call_dup', function: { name: 'researcher', arguments: '{"topic":"x"}' } }] },
      { role: 'tool', toolCallId: 'call_dup', content: JSON.stringify({ success: true, output: '第一次结果' }) },
      { role: 'tool', toolCallId: 'call_dup', content: JSON.stringify({ success: true, output: '第二次结果' }) },
    ];
    const [sample] = harvestRoleSamples([{ id: 's1', messages }]);
    expect(sample.output).toBe('第一次结果');
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

  it('同 args 不同键序视为同一例（规范化去重）', () => {
    const first = { role: 'researcher', args: { topic: 'x', scope: 'y' }, output: 'o1', sessionId: 's1', messageIndex: 0 };
    const second = { role: 'researcher', args: { scope: 'y', topic: 'x' }, output: 'o2', sessionId: 's2', messageIndex: 0 };
    expect(sampleDedupeKey(first)).toBe(sampleDedupeKey(second));
    expect(dedupeSamples([first, second])).toEqual([first]);
  });

  it('嵌套对象也按键序规范化', () => {
    const first = { role: 'r', args: { filter: { b: 1, a: 2 } }, output: 'o', sessionId: 's', messageIndex: 0 };
    const second = { role: 'r', args: { filter: { a: 2, b: 1 } }, output: 'o', sessionId: 's', messageIndex: 1 };
    expect(sampleDedupeKey(first)).toBe(sampleDedupeKey(second));
  });

  it('数组顺序不同不等于同一例（规范化保留数组顺序）', () => {
    const first = { role: 'r', args: { files: ['a', 'b'] }, output: 'o', sessionId: 's', messageIndex: 0 };
    const second = { role: 'r', args: { files: ['b', 'a'] }, output: 'o', sessionId: 's', messageIndex: 1 };
    expect(sampleDedupeKey(first)).not.toBe(sampleDedupeKey(second));
  });

  it('按角色分组，角色名升序', () => {
    const groups = groupSamplesByRole([a, c, d]);
    expect([...groups.keys()]).toEqual(['code_reviewer', 'researcher']);
    expect(groups.get('researcher')).toEqual([a, c]);
  });
});
