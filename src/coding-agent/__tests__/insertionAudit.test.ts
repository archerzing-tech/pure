// 插话决策事后审计测试（2026-09-28）：关键词退出决策之后，漏报只能靠事后
// 比对发现。这里锁两件事：疑点确实被标出来（漏报不能静默），以及审计**不碰
// 决策**（读一遍疑点，决策对象原样不动）。

import { describe, expect, it } from 'bun:test';
import { auditInsertionDecision, hasInsertionAnomaly } from '../insertionAudit';
import type { InputDecision } from '../inputDecision';

function decision(overrides: Partial<InputDecision>): InputDecision {
  return {
    source: 'mid-run-insert',
    kind: 'task',
    action: 'queue',
    confidence: 0.9,
    timing: { mode: 'after-current' },
    scope: ['plan'],
    shouldAbort: false,
    reason: 'test',
    signals: { via: 'judge' },
    ...overrides,
  };
}

describe('insertionAudit — 契约字段漏报的事后标记', () => {
  it('flags a removal worded message that came back without cancels_part', () => {
    // 这正是"零关键词"改动的代价：宿主不再嗅措辞，漏报在决策那一刻看不见。
    const d = decision({ inputText: '把「市场格局」这份调研取消掉', kind: 'task' });
    expect(auditInsertionDecision(d).anomalies).toEqual(['cancels-missed']);
    expect(hasInsertionAnomaly(d)).toBe(true);
  });

  it('stays quiet when cancels_part was reported', () => {
    const d = decision({
      inputText: '把「市场格局」这份调研取消掉',
      kind: 'steer',
      signals: { via: 'judge', cancelsPart: true },
    });
    expect(auditInsertionDecision(d).anomalies).toEqual([]);
  });

  it('flags a cancelling message that also adds work but lacks adds_along', () => {
    // 漏报 adds_along 的代价是反向的：宿主会真去停那支，把刚要求加的活停掉。
    const d = decision({
      inputText: '不要只查均价了，把区间也查一下',
      kind: 'steer',
      signals: { via: 'judge', cancelsPart: true },
    });
    expect(auditInsertionDecision(d).anomalies).toEqual(['adds-along-missed']);
  });

  it('stays quiet when adds_along is present', () => {
    const d = decision({
      inputText: '不要只查均价了，把区间也查一下',
      kind: 'task',
      signals: { via: 'judge', cancelsPart: true, addsAlong: true },
    });
    expect(auditInsertionDecision(d).anomalies).toEqual([]);
  });

  it('does not audit the mechanical fast paths — the contract fields do not apply there', () => {
    // 「停掉那支」走 BRANCH_STOP_RE，不是收活，契约字段本来就不该带；审计它
    // 只会制造噪音。
    const d = decision({
      inputText: '停掉竞品那支',
      kind: 'steer',
      signals: { via: 'rule', rule: 'BRANCH_STOP_RE', branchStop: true },
    });
    expect(auditInsertionDecision(d).anomalies).toEqual([]);
  });

  it('看得见本项目最经典的取消形状（裸否定 + 动词）', () => {
    // 2026-09-24 事故的原句。CANCELISH_RE 的标记表里没有裸"不"，只搬它的话
    // 这一句漏报也不会被标——而它恰是漏报后反向执行的真实受害者。审计的
    // 假阴性不可接受（见 insertionAudit 头注），所以词族与字面安全网取并集。
    for (const text of ['X 就不调研了', 'Y 那个不用查了', '把 X 这个调研取消掉']) {
      const d = decision({ inputText: text, kind: 'task' });
      expect(auditInsertionDecision(d).anomalies).toEqual(['cancels-missed']);
    }
  });

  it('stays quiet without the user text (nothing to compare)', () => {
    expect(auditInsertionDecision(decision({ kind: 'chatter' })).anomalies).toEqual([]);
    expect(auditInsertionDecision(decision({ inputText: '   ' })).anomalies).toEqual([]);
  });

  it('never mutates the decision it reads', () => {
    const d = decision({ inputText: 'X 就不调研了', kind: 'task' });
    const before = JSON.stringify(d);
    auditInsertionDecision(d);
    expect(JSON.stringify(d)).toBe(before);
  });
});
