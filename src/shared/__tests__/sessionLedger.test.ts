import { describe, expect, it } from 'bun:test';
import {
  actionFingerprint,
  createSessionLedger,
  formatSessionLedgerFacts,
  lookupAsked,
  lookupDone,
  markPlanReplaced,
  normalizeArgs,
  normalizeSessionLedger,
  questionFingerprint,
  recordAnswer,
  recordAsked,
  recordDone,
  recordPlan,
  type SessionLedger,
} from '../sessionLedger';

describe('sessionLedger 指纹', () => {
  it('问句指纹对空白与尾标点不敏感，对语义差异敏感', () => {
    expect(questionFingerprint('这个项目用什么构建？')).toBe(questionFingerprint('这个项目用什么构建'));
    expect(questionFingerprint('这个项目 用什么构建!')).toBe(questionFingerprint('这个项目用什么构建？'));
    expect(questionFingerprint('这个项目用什么构建？')).not.toBe(questionFingerprint('这个项目用什么测试框架？'));
  });

  it('动作指纹对参数键序不敏感，对参数值敏感', () => {
    expect(normalizeArgs('{"a":1,"b":2}')).toBe(normalizeArgs('{"b":2,"a":1}'));
    expect(actionFingerprint('write_file', '{"path":"/a","content":"x"}'))
      .toBe(actionFingerprint('write_file', '{"content":"x","path":"/a"}'));
    expect(actionFingerprint('write_file', '{"path":"/a","content":"x"}'))
      .not.toBe(actionFingerprint('write_file', '{"path":"/a","content":"y"}'));
    // 非法 JSON（模型偶发）不抛，回退 trim 原文，指纹仍稳定。
    expect(actionFingerprint('write_file', ' not json ')).toBe(actionFingerprint('write_file', 'not json'));
  });
});

describe('sessionLedger 三本账', () => {
  it('asked 往返：提问入账未 settled，回答回填后 lookup 命中', () => {
    let ledger = createSessionLedger();
    ledger = recordAsked(ledger, { ts: 1, question: '端口用 3000 还是 8080？', source: 'clarification' });
    expect(ledger.asked).toHaveLength(1);
    expect(ledger.asked[0].settled).toBe(false);
    // 未回收的问题不进查询命中（没有答案可复用）。
    expect(lookupAsked(ledger, '端口用 3000 还是 8080')).toBeUndefined();

    ledger = recordAnswer(ledger, ledger.asked[0].fingerprint, '8080', 2);
    const hit = lookupAsked(ledger, '端口用3000还是8080');
    expect(hit?.answer).toBe('8080');
    expect(hit?.settled).toBe(true);
  });

  it('同一指纹重复提问覆盖成一条，答案不会落进僵尸条目', () => {
    let ledger = createSessionLedger();
    ledger = recordAsked(ledger, { ts: 1, question: '用哪个数据库？', source: 'clarification' });
    ledger = recordAsked(ledger, { ts: 3, question: '用哪个数据库？ ', source: 'clarification' });
    expect(ledger.asked).toHaveLength(1);
    ledger = recordAnswer(ledger, ledger.asked[0].fingerprint, 'postgres', 4);
    expect(lookupAsked(ledger, '用哪个数据库')?.answer).toBe('postgres');
  });

  it('done 记账后同参命中，改参不命中；重复记账覆盖', () => {
    let ledger = createSessionLedger();
    ledger = recordDone(ledger, { ts: 1, intent: 'execute_command', args: '{"command":"bun test"}', ok: true, summary: '3631 pass' });
    expect(lookupDone(ledger, 'execute_command', '{"command":"bun test"}')?.summary).toBe('3631 pass');
    expect(lookupDone(ledger, 'execute_command', '{"command":"bun lint"}')).toBeUndefined();
    ledger = recordDone(ledger, { ts: 2, intent: 'execute_command', args: '{"command":"bun test"}', ok: true, summary: '3636 pass' });
    expect(ledger.done).toHaveLength(1);
    expect(lookupDone(ledger, 'execute_command', '{"command":"bun test"}')?.summary).toBe('3636 pass');
  });

  it('plans 状态链：细化 markPlanReplaced 留痕，不同版本互不误伤', () => {
    let ledger = createSessionLedger();
    ledger = recordPlan(ledger, { ts: 1, planText: '先建骨架再填页面', planSeq: 1, reason: '做个落地页' });
    ledger = recordPlan(ledger, { ts: 2, planText: '先建骨架再填页面，加暗色模式', planSeq: 1, reason: '做个落地页' });
    ledger = recordPlan(ledger, { ts: 3, planText: '改成后台管理系统', planSeq: 2, reason: '改需求了：之前的计划作废，因为用户换成后台' });
    ledger = markPlanReplaced(ledger, 1);
    expect(ledger.plans[0].replaced).toBe(true);
    expect(ledger.plans[1].replaced).toBe(true);
    expect(ledger.plans[2].replaced).toBe(false);
  });

  it('记账不改写入参（快照管线拿旧引用做对照的前提）', () => {
    const before: SessionLedger = createSessionLedger();
    const after = recordDone(before, { ts: 1, intent: 'x', args: '{}', ok: true, summary: 'y' });
    expect(before.done).toHaveLength(0);
    expect(after.done).toHaveLength(1);
  });
});

describe('formatSessionLedgerFacts', () => {
  it('空账返回空串，不占提示词', () => {
    expect(formatSessionLedgerFacts(createSessionLedger())).toBe('');
    expect(formatSessionLedgerFacts(null)).toBe('');
  });

  it('未回收的提问不进素材；已回收的问答/已做/计划按事实列出', () => {
    let ledger = createSessionLedger();
    ledger = recordAsked(ledger, { ts: 1, question: '用哪个端口？', source: 'clarification' });
    ledger = recordAnswer(ledger, ledger.asked[0].fingerprint, '8080', 2);
    ledger = recordAsked(ledger, { ts: 3, question: '还没答的问题？', source: 'clarification' });
    ledger = recordDone(ledger, { ts: 4, intent: 'write_file', args: '{"path":"/a"}', ok: false, summary: '写失败：目录不存在' });
    ledger = recordPlan(ledger, { ts: 5, planText: '计划甲', planSeq: 1, reason: '起因乙' });

    const facts = formatSessionLedgerFacts(ledger);
    expect(facts).toContain('<session_ledger_facts>');
    expect(facts).toContain('用哪个端口');
    expect(facts).toContain('8080');
    expect(facts).not.toContain('还没答的问题');
    expect(facts).toContain('write_file');
    expect(facts).toContain('未成功');
    expect(facts).toContain('第 1 版');
    expect(facts).toContain('起因乙');
  });

  it('上限裁剪：只保留最近的若干条，不裸灌', () => {
    let ledger = createSessionLedger();
    for (let i = 0; i < 20; i++) {
      ledger = recordDone(ledger, { ts: i, intent: `tool_${i}`, args: `{"i":${i}}`, ok: true, summary: `第 ${i} 号活` });
    }
    const facts = formatSessionLedgerFacts(ledger);
    expect(facts).toContain('tool_19');
    expect(facts).not.toContain('tool_0\n');
    expect(facts).not.toContain('第 0 号活');
  });

  it('长文本按上限截断', () => {
    let ledger = createSessionLedger();
    ledger = recordDone(ledger, { ts: 1, intent: 'write_file', args: '{"p":1}', ok: true, summary: '长'.repeat(300) });
    const facts = formatSessionLedgerFacts(ledger);
    expect(facts!.length).toBeLessThan(600);
    expect(facts).toContain('…');
  });
});

describe('normalizeSessionLedger 兜底', () => {
  it('旧快照缺字段 / 非对象输入归一为空账，读侧不崩', () => {
    expect(normalizeSessionLedger(undefined)).toEqual(createSessionLedger());
    expect(normalizeSessionLedger('junk')).toEqual(createSessionLedger());
    expect(normalizeSessionLedger({ version: 1, done: [{ ts: 1, fingerprint: 'f', intent: 'x', ok: true, summary: 's' }] })).toEqual({
      version: 1,
      asked: [],
      done: [{ ts: 1, fingerprint: 'f', intent: 'x', ok: true, summary: 's' }],
      plans: [],
    });
  });
});
