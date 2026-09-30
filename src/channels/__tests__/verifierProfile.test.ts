// 验收（设计文档 §5.2）：通道会话用的验证器必须是 GUI 那档「规则 + LLM 复核」，
// 而不是 CLI 的纯规则档 —— 通道旁边没有人看输出，判定失败必须能在引擎内重写。
import { describe, it, expect } from 'bun:test';
import { createDefaultVerifier, LLMVerifyCheckName } from '../../coding-agent/Verifier';
import { createChannelVerifier } from '../verifierProfile';
import type { LLMAdapter, Message } from '../../shared/types';

const TASK: Message[] = [
  { role: 'system', content: 'You are pure.' },
  { role: 'user', content: '请列出三个要点' },
];

function verdictLLM(content: string): { llm: LLMAdapter; calls: () => number } {
  let calls = 0;
  return {
    llm: {
      complete: async () => { calls += 1; return { content, toolCalls: [] }; },
      stream: async function* () {},
    },
    calls: () => calls,
  };
}

describe('channel verifier profile', () => {
  it('runs the LLM re-check and can fail an answer the rule verifier would pass', async () => {
    const { llm, calls } = verdictLLM('{"passed": false, "feedback": "缺少第三个要点"}');
    const channel = createChannelVerifier(llm);
    const result = await channel.evaluate({ output: '要点一，要点二', context: TASK });

    expect(calls()).toBe(1);
    expect(result.passed).toBe(false);
    expect(result.evidence.some((e) => e.checkName === LLMVerifyCheckName)).toBe(true);

    // 同一份输出，纯规则档直接放行 —— 对照证明通道档更严。
    const rule = createDefaultVerifier();
    const ruleResult = await rule.evaluate({ output: '要点一，要点二', context: TASK });
    expect(ruleResult.passed).toBe(true);
    expect(ruleResult.evidence.some((e) => e.checkName === LLMVerifyCheckName)).toBe(false);
  });

  it('passes when the LLM verdict passes', async () => {
    const { llm, calls } = verdictLLM('{"passed": true, "feedback": "ok"}');
    const result = await createChannelVerifier(llm).evaluate({ output: '要点一，要点二，要点三', context: TASK });
    expect(calls()).toBe(1);
    expect(result.passed).toBe(true);
  });

  it('still runs the rule check first so empty output fails without a verdict round', async () => {
    const { llm, calls } = verdictLLM('{"passed": true}');
    const result = await createChannelVerifier(llm).evaluate({ output: '   ', context: TASK });
    expect(result.passed).toBe(false);
    expect(result.evidence.some((e) => e.checkName === 'non-empty-output')).toBe(true);
    expect(calls()).toBe(0);
  });
});
