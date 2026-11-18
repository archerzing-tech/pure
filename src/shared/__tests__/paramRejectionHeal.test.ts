// src/shared/__tests__/paramRejectionHeal.test.ts
// 参数拒绝自愈的判定与账本面（2026-11-18 DeepSeek V4.1 真机 400 判例）。

import { describe, it, expect, beforeEach } from 'bun:test';
import {
  paramHealScope,
  planParamWithdrawal,
  recordParamWithdrawal,
  resetParamHealForTests,
  withdrawnParams,
  withdrawExtraBody,
} from '../paramRejectionHeal';

// 真机判例原文（2026-11-18，DeepSeek V4.1 chat_template_kwargs）。
const DEEPSEEK_400 = '400 Bad Request: {"error":{"message":"DeepSeek V4.1 reasoning_effort must be low, high, xhigh, max, or an integer within [1, 100] in chat_template_kwargs","type":"BadRequestError","param":"","code":400}}';

beforeEach(() => resetParamHealForTests());

describe('planParamWithdrawal', () => {
  it('认出真机判例：DeepSeek V4.1 拒收 reasoning_effort', () => {
    expect(planParamWithdrawal(DEEPSEEK_400, ['reasoning_effort', 'thinking'])).toBe('reasoning_effort');
  });

  it('认出 OpenAI 风格的未知参数拒绝', () => {
    expect(planParamWithdrawal(
      "400 Unrecognized request argument supplied: reasoning_effort",
      ['reasoning_effort'],
    )).toBe('reasoning_effort');
    expect(planParamWithdrawal(
      "400 - {'error': \"Unknown parameter: 'thinking'\"}",
      ['thinking', 'tool_stream'],
    )).toBe('thinking');
  });

  it('凭证 / 网络类错误不触发撤参', () => {
    expect(planParamWithdrawal('401 Unauthorized: invalid api key', ['reasoning_effort'])).toBeNull();
    expect(planParamWithdrawal('Connection reset by peer (ECONNRESET)', ['reasoning_effort'])).toBeNull();
  });

  it('动词在场但键不在场：不误伤别的键', () => {
    expect(planParamWithdrawal(DEEPSEEK_400, ['thinking', 'tool_stream'])).toBeNull();
  });

  it('键在场但没有拒收动词（普通回显）：不撤', () => {
    expect(planParamWithdrawal(
      'model deepseek-v4.1 accepted request with reasoning_effort noted',
      ['reasoning_effort'],
    )).toBeNull();
  });

  it('空消息或无旋钮：null', () => {
    expect(planParamWithdrawal('', ['reasoning_effort'])).toBeNull();
    expect(planParamWithdrawal(DEEPSEEK_400, [])).toBeNull();
  });
});

describe('进程级撤参账本（sticky）', () => {
  it('记录后 withdrawExtraBody 撤掉该键，其余保留', () => {
    const scope = paramHealScope('https://api.deepseek.com/v1', 'deepseek-v4.1');
    recordParamWithdrawal(scope, 'reasoning_effort');
    expect(withdrawExtraBody({ reasoning_effort: 'medium', tool_stream: true }, scope))
      .toEqual({ tool_stream: true });
    // 没记录的 scope 原样透传（同一引用语义）。
    expect(withdrawExtraBody({ reasoning_effort: 'medium' }, paramHealScope('https://other', 'm')))
      .toEqual({ reasoning_effort: 'medium' });
  });

  it('键全撤光 → undefined（不带空对象上请求）', () => {
    const scope = paramHealScope('https://api.deepseek.com/v1', 'deepseek-v4.1');
    recordParamWithdrawal(scope, 'reasoning_effort');
    expect(withdrawExtraBody({ reasoning_effort: 'medium' }, scope)).toBeUndefined();
    expect(withdrawExtraBody(undefined, scope)).toBeUndefined();
  });

  it('scope 归一化：尾斜杠与大小写同格', () => {
    recordParamWithdrawal(paramHealScope('https://API.example.com/v1/', 'm'), 'thinking');
    expect(withdrawnParams(paramHealScope('https://api.example.com/v1', 'm')).has('thinking')).toBe(true);
  });

  it('reset 清场', () => {
    const scope = paramHealScope('https://x', 'm');
    recordParamWithdrawal(scope, 'thinking');
    resetParamHealForTests();
    expect(withdrawExtraBody({ thinking: 1 }, scope)).toEqual({ thinking: 1 });
  });
});
