// 插话决策事后审计测试（2026-09-28 建立）。2026-10-28 二分改版后疑点全退：
// 取消话 inline 直投主线模型自行消化，停支/整停各有 stop_branch.call_id /
// action:stop 契约承载，字面嗅探整个退役。这里改锁三件事：任何形状的决策都
// 不再标疑点（恒空）、审计**不碰决策**、summary/trend 的分母口径照旧工作。

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

describe('insertionAudit — 疑点退役后恒空', () => {
  it('cancels-missed 退役：取消味的句子照旧不标（原话直投主线消化）', () => {
    // 旧判据 CANCEL_SMELL/EXCLUSIVITY/looksLikeRemoval 已随二分改版整删：
    // 当年 2026-09-24 事故的原句「X 就不调研了」也不再由审计兜——语义判断
    // 归裁决器，宿主侧零字面匹配。
    for (const text of [
      '把「市场格局」这份调研取消掉',
      'X 就不调研了',
      'Y 那个不用查了',
      '不要只查均价，把区间也取消掉',
    ]) {
      const d = decision({ inputText: text, kind: 'task' });
      expect(auditInsertionDecision(d).anomalies).toEqual([]);
      expect(hasInsertionAnomaly(d)).toBe(false);
    }
  });

  it('adds-along-missed 不再产生（2026-10-28 刀 1）', () => {
    // 判据 SCOPE_ADD_RE 已随刀 1 删除（决策路径死代码）：报了取消又加活的
    // 句子不再标这个疑点——类型值保留供诊断面板全键 Record 兼容。
    const d = decision({
      inputText: 'B站那支别查了，再加一个爱奇艺',
      kind: 'steer',
      signals: { via: 'judge', cancelsPart: true, addsAlong: true },
    });
    expect(auditInsertionDecision(d).anomalies).toEqual([]);
  });

  it('rule/passthrough 快路径不在审计范围——契约字段对它们本来就不适用', () => {
    const d = decision({
      inputText: '停掉竞品那支',
      kind: 'steer',
      signals: { via: 'rule', rule: 'BRANCH_STOP_RE', branchStop: true },
    });
    expect(auditInsertionDecision(d).anomalies).toEqual([]);
  });

  it('stays quiet without the user text (nothing to compare)', () => {
    expect(auditInsertionDecision(decision({ kind: 'chatter' })).anomalies).toEqual([]);
    expect(auditInsertionDecision(decision({ inputText: '   ' })).anomalies).toEqual([]);
  });

  it('遵守率的分母口径照旧：rule/passthrough 与没有原话的不进分母', () => {
    // 疑点恒零之后，面板从这套数字里读的其实是"可审计插话量"与恒零的疑点率
    // ——分母口径保持原样，面板不用跟着改。
    const entries = [
      decision({ inputText: '把知乎那项也取消掉', kind: 'task' }),
      decision({ inputText: '记得跑测试' }),
      decision({ inputText: '停掉竞品那支', signals: { via: 'rule', rule: 'BRANCH_STOP_RE' } }),
      decision({ inputText: '推翻重来', signals: { via: 'passthrough', netReason: 'no-judge' } }),
      decision({ inputText: '' }),
    ];
    expect(auditTrend(entries, 2)).toEqual([{ index: 1, total: 2, anomalies: 0, rate: 0 }]);
    expect(auditSummary(entries)).toEqual({ total: 2, anomalies: 0, rate: 0 });
  });

  it('按时间顺序分批，批次序号从 1 起', () => {
    const entries = [
      decision({ inputText: '把知乎那项也取消掉', kind: 'task' }),
      decision({ inputText: '记得跑测试' }),
      decision({ inputText: '把「市场格局」这份调研取消掉', kind: 'task' }),
    ];
    const trend = auditTrend(entries, 2);
    expect(trend.map((b) => [b.index, b.total, b.anomalies])).toEqual([[1, 2, 0], [2, 1, 0]]);
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
