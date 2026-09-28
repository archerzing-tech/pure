// 插话决策事后审计测试（2026-09-28）：关键词退出决策之后，漏报只能靠事后
// 比对发现。这里锁两件事：疑点确实被标出来（漏报不能静默），以及审计**不碰
// 决策**（读一遍疑点，决策对象原样不动）。

import { describe, expect, it } from 'bun:test';
import { auditInsertionDecision, auditSummary, auditTrend, hasInsertionAnomaly } from '../insertionAudit';
import type { InputDecision } from '../inputDecision';

function decision(overrides: Partial<InputDecision> = {}): InputDecision {
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
      inputText: 'B站那支别查了，再加一个爱奇艺',
      kind: 'steer',
      signals: { via: 'judge', cancelsPart: true },
    });
    expect(auditInsertionDecision(d).anomalies).toEqual(['adds-along-missed']);
  });

  it('stays quiet when adds_along is present', () => {
    const d = decision({
      inputText: 'B站那支别查了，再加一个爱奇艺',
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

  it('排他句不报漏报——「不要只 X」没有移除任何东西', () => {
    // 「不要只查均价」= 不要仅限于查均价，均值仍被需要。审计对它大喊漏报的话，
    // 假阳性多了人就学会无视这个标记了。
    for (const text of ['不要只查均价，把区间也查了', '别只查价格，区间也算一下', '不只是查均价']) {
      const d = decision({ inputText: text, kind: 'steer' });
      expect(auditInsertionDecision(d).anomalies).toEqual([]);
    }
  });

  it('排他句里藏着的真取消照旧报出来', () => {
    // 抹的是排他标记，不是动词：「把区间也取消掉」仍然是取消。
    const d = decision({ inputText: '不要只查均价，把区间也取消掉', kind: 'task' });
    expect(auditInsertionDecision(d).anomalies).toEqual(['cancels-missed']);
  });

  it('stays quiet without the user text (nothing to compare)', () => {
    expect(auditInsertionDecision(decision({ kind: 'chatter' })).anomalies).toEqual([]);
    expect(auditInsertionDecision(decision({ inputText: '   ' })).anomalies).toEqual([]);
  });

  it('遵守率逐批算：命令快路径与没有原话的不进分母', () => {
    // 分母只收"契约字段本来适用"的决策：命令走 rule（字段对停一支本来就不适用），
    // 没有原话则无从比对。把它们算进去，遵守率就变成"插话里有多少是命令"。
    const entries = [
      decision({ inputText: 'X 就不调研了', kind: 'task' }),
      decision({ inputText: '记得跑测试' }),
      decision({ inputText: '停掉竞品那支', signals: { via: 'rule', rule: 'BRANCH_STOP_RE' } }),
      decision({ inputText: '' }),
    ];
    expect(auditTrend(entries, 2)).toEqual([{ index: 1, total: 2, anomalies: 1, rate: 0.5 }]);
    expect(auditSummary(entries)).toEqual({ total: 2, anomalies: 1, rate: 0.5 });
  });

  it('按时间顺序分批，批次序号从 1 起', () => {
    const entries = [
      decision({ inputText: 'X 就不调研了', kind: 'task' }),
      decision({ inputText: '记得跑测试' }),
      decision({ inputText: '把知乎那项也取消掉', kind: 'task' }),
    ];
    const trend = auditTrend(entries, 2);
    expect(trend.map((b) => [b.index, b.total, b.anomalies])).toEqual([[1, 2, 1], [2, 1, 1]]);
  });

  it('空日志给空趋势——面板据此显示"还没有数据"，而不是一条平线', () => {
    expect(auditTrend([])).toEqual([]);
    expect(auditTrend([decision({ inputText: '停掉竞品那支', signals: { via: 'rule' } })])).toEqual([]);
    expect(auditSummary([])).toEqual({ total: 0, anomalies: 0, rate: 0 });
  });

  it('never mutates the decision it reads', () => {
    const d = decision({ inputText: 'X 就不调研了', kind: 'task' });
    const before = JSON.stringify(d);
    auditInsertionDecision(d);
    expect(JSON.stringify(d)).toBe(before);
  });
});
