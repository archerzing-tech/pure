// src/shared/__tests__/steerTargeting.test.ts
// 1a 定向投递（对话智能升格第 1 期）的匹配与投递语义。判据刻意保守：
// 只认区分性命中、打平宁可广播——点错人的代价（别的分支被无关话分心）
// 高于广播的代价（多读一行）。

import { describe, expect, it } from 'bun:test';
import { matchInFlightBranch, steerDeliversTo, steerConsumedBy, cancelReceiptTopic, planTakeoffGate, type InFlightBranch } from '../steerTargeting';

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

describe('planTakeoffGate — 排队未起飞的那支在出生点被拦下', () => {
  // 待起飞的候选：一批委派的缩影，任务书就是匹配面。
  const pending: InFlightBranch[] = [
    { callId: 'k1', name: 'researcher', snippet: '调研 agent 开发技术趋势' },
    { callId: 'k2', name: 'researcher', snippet: '调研 LLM 的发展方向' },
    { callId: 'k3', name: 'researcher', snippet: '调研未来三年的爆发点' },
  ];

  it('出生前取消：区分词认出那一支，其余放行；命中即消费', () => {
    const { blocked, consumed } = planTakeoffGate(pending, ['爆发点这个不要调研了'], []);
    expect(blocked.map((b) => b.callId)).toEqual(['k3']);
    expect(blocked[0].kind).toBe('cancelled-before-dispatch');
    // 一次性：原话被兑现后调用方剪掉，不会拦住下一批无关的活。
    expect(consumed).toEqual(['爆发点这个不要调研了']);
  });

  it('点名真停后的同回合重派：落到同一支上，收据改口径', () => {
    // 用户说「停掉竞品那支」→ 编排器真停；父没听话，同回合又派了一次同一支
    // ——待起飞的那一支就是「排队未起飞的同名支」，出生点拦下。
    const redeployed: InFlightBranch[] = [
      { callId: 'r1', name: 'researcher', snippet: '调研竞品定价策略' },
      { callId: 'r2', name: 'code_editor', snippet: '把登录改成手机号验证' },
    ];
    const { blocked, consumed } = planTakeoffGate(redeployed, [], ['停掉竞品那支']);
    expect(blocked.map((b) => b.callId)).toEqual(['r1']);
    expect(blocked[0].kind).toBe('stopped-branch');
    expect(consumed).toEqual(['停掉竞品那支']);
  });

  it('认不出/打平 = 放行：宁可漏拦交给父边界，绝不误杀', () => {
    // 「调研」家家都有——指不出单支。
    expect(planTakeoffGate(pending, ['调研不要了'], []).blocked).toEqual([]);
    // 没有待起飞候选（这轮没有委派）：挂号原样留着，等下一批。
    const empty = planTakeoffGate([], ['爆发点不要了'], []);
    expect(empty.blocked).toEqual([]);
    expect(empty.consumed).toEqual([]);
  });

  it('一次挂号只拦一支：同名兄弟支照跑', () => {
    // 三支都叫 researcher、都以「调研」开头——只有「爆发点」能区分。
    const { blocked } = planTakeoffGate(pending, ['爆发点不要了'], []);
    expect(blocked).toHaveLength(1);
    expect(pending.filter((p) => !blocked.some((b) => b.callId === p.callId)).map((p) => p.callId)).toEqual(['k1', 'k2']);
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

describe('cancelReceiptTopic — 出生前取消的收执点名', () => {
  it('引号里的话题最先认（用户自己就这么说）', () => {
    expect(cancelReceiptTopic('“未来三年的爆发点” 这个不要调研了')).toBe('未来三年的爆发点');
    expect(cancelReceiptTopic('“agent 开发技术趋势”这项砍掉')).toBe('agent 开发技术趋势');
    expect(cancelReceiptTopic('「竞品定价」就不要了')).toBe('竞品定价');
  });

  it('没引号剥祈使框架取主干：话题在前', () => {
    expect(cancelReceiptTopic('未来三年的爆发点这个不要调研了')).toBe('未来三年的爆发点');
    expect(cancelReceiptTopic('未来三年的爆发点就不要查了')).toBe('未来三年的爆发点');
  });

  it('没引号剥祈使框架取主干：祈使在前', () => {
    expect(cancelReceiptTopic('不要调研未来三年的爆发点了')).toBe('未来三年的爆发点');
  });

  it('拉丁话题整取', () => {
    expect(cancelReceiptTopic('jev 这个就不调研了')).toBe('jev');
  });

  it('提不出就 null：指代词、太短、混着加活，绝不装懂点名', () => {
    expect(cancelReceiptTopic('这个不要调研了')).toBeNull();
    expect(cancelReceiptTopic('不要只查均价了，把区间也查了')).toBeNull();
    expect(cancelReceiptTopic('都别做了')).toBeNull();
    expect(cancelReceiptTopic('')).toBeNull();
  });
});
