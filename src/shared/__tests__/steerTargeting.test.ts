// src/shared/__tests__/steerTargeting.test.ts
// 1a 定向投递（对话智能升格第 1 期）的匹配与投递语义。判据刻意保守：
// 只认区分性命中、打平宁可广播——点错人的代价（别的分支被无关话分心）
// 高于广播的代价（多读一行）。

import { describe, expect, it } from 'bun:test';
import { matchInFlightBranch, steerDeliversTo, steerConsumedBy, type InFlightBranch } from '../steerTargeting';

const branches: InFlightBranch[] = [
  { callId: 'call_a', name: 'code_editor', role: '负责代码修改', snippet: '把登录模块改成手机号验证' },
  { callId: 'call_b', name: 'researcher', role: '负责调研', snippet: '调研竞品定价策略' },
];

describe('matchInFlightBranch — 用户这句话点名了谁', () => {
  it('按分支名点名：直达那一支', () => {
    expect(matchInFlightBranch('editor 那路慢一点，先看看缓存', branches)?.callId).toBe('call_a');
  });

  it('按任务书里独有的词点名：直达那一支', () => {
    // 「竞品」只出现在 researcher 的匹配面里——区分性命中。
    expect(matchInFlightBranch('竞品那份先别收，等等再用', branches)?.callId).toBe('call_b');
    // 「登录」只出现在 code_editor 的匹配面里。
    expect(matchInFlightBranch('登录这边用户名改成手机号', branches)?.callId).toBe('call_a');
  });

  it('家家都有的词指不出人：宁可广播', () => {
    // 「调研」两家任务书里都有（researcher 有，code_editor 的 snippet 里
    // 也埋了会撞车的词时同样不算数）——直接构造共同词场景。
    const both: InFlightBranch[] = [
      { callId: 'x', name: 'a1', snippet: '调研市场' },
      { callId: 'y', name: 'b1', snippet: '调研用户' },
    ];
    expect(matchInFlightBranch('调研再深入一点', both)).toBeNull();
  });

  it('命中打平：分不清，不赌', () => {
    const pair: InFlightBranch[] = [
      { callId: 'x', name: 'a1', snippet: ' Alpha 任务' },
      { callId: 'y', name: 'b1', snippet: ' Beta 任务' },
    ];
    // 每支各命中一个区分词——打平。
    expect(matchInFlightBranch('alpha beta', pair)).toBeNull();
  });

  it('停用词不参与点名：指代词永远选不出来', () => {
    expect(matchInFlightBranch('这个先停一下', branches)).toBeNull();
    expect(matchInFlightBranch('那个不对，重新来', branches)).toBeNull();
  });

  it('拉丁词大小写不敏感', () => {
    expect(matchInFlightBranch('Editor 你慢一点', branches)?.callId).toBe('call_a');
  });

  it('空话或没有在飞分支：没点名', () => {
    expect(matchInFlightBranch('  ', branches)).toBeNull();
    expect(matchInFlightBranch('竞品先别收', [])).toBeNull();
  });
});

describe('steerDeliversTo / steerConsumedBy — 投递与消费矩阵', () => {
  const parent = undefined;
  const branchA = { branchCallId: 'call_a', branchName: 'code_editor' };
  const branchB = { branchCallId: 'call_b', branchName: 'researcher' };

  it('父级专属条目：只有父引擎读、父引擎收走', () => {
    expect(steerDeliversTo('parent', parent)).toBe(true);
    expect(steerDeliversTo('parent', branchA)).toBe(false);
    expect(steerConsumedBy('parent', parent)).toBe(true);
    expect(steerConsumedBy('parent', branchA)).toBe(false);
  });

  it('广播条目：人人可读，只有父边界收走（分支读了不丢话）', () => {
    expect(steerDeliversTo('all', parent)).toBe(true);
    expect(steerDeliversTo('all', branchA)).toBe(true);
    expect(steerDeliversTo('all', branchB)).toBe(true);
    expect(steerConsumedBy('all', branchA)).toBe(false);
    expect(steerConsumedBy('all', branchB)).toBe(false);
    expect(steerConsumedBy('all', parent)).toBe(true);
  });

  it('点名条目：只投给被点名的那支、也只有它取走', () => {
    const target = { branchCallId: 'call_a', branchName: 'code_editor' };
    expect(steerDeliversTo(target, branchA)).toBe(true);
    expect(steerDeliversTo(target, branchB)).toBe(false);
    expect(steerDeliversTo(target, parent)).toBe(false);
    expect(steerConsumedBy(target, branchA)).toBe(true);
    expect(steerConsumedBy(target, branchB)).toBe(false);
    expect(steerConsumedBy(target, parent)).toBe(false);
  });
});
