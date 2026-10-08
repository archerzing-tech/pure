// src/evaluation/__tests__/roleAssertionDraft.test.ts
// 13.3 part 3 / 13.1 — 断言起草的纯函数测试（提示词构造 + 回复校验）。

import { describe, expect, it } from 'bun:test';
import {
  buildAssertionDraftPrompt,
  filterUnsupportedMarkers,
  gateAdmits,
  MAX_ASSERTION_CHARS,
  MAX_ASSERTIONS,
  parseAssertionDraft,
} from '../roleAssertionDraft';

describe('buildAssertionDraftPrompt', () => {
  it('带上角色、契约与参考产出', () => {
    const prompt = buildAssertionDraftPrompt({ role: 'code_reviewer', roleContract: '分类: correctness/security', realOutput: '发现 correctness 越界' });
    expect(prompt).toContain('ROLE: code_reviewer');
    expect(prompt).toContain('correctness/security');
    expect(prompt).toContain('发现 correctness 越界');
  });

  it('全程截断参考产出，防话痨产出撑爆调用', () => {
    const prompt = buildAssertionDraftPrompt({ role: 'r', roleContract: 'c', realOutput: 'x'.repeat(10_000) });
    expect(prompt.length).toBeLessThan(6000);
  });
});

describe('parseAssertionDraft', () => {
  it('解析严格 JSON', () => {
    const draft = parseAssertionDraft('{"must":["correctness"],"mustNot":["no issues"]}');
    expect(draft).toEqual({ must: ['correctness'], mustNot: ['no issues'] });
  });

  it('容忍围栏与前后闲话', () => {
    const draft = parseAssertionDraft('Sure!\n```json\n{"must":["步骤"],"mustNot":[]}\n```\n');
    expect(draft).toEqual({ must: ['步骤'], mustNot: [] });
  });

  it('must 为空 / 坏 JSON → 不可用', () => {
    expect(parseAssertionDraft('{"must":[],"mustNot":["x"]}')).toBeUndefined();
    expect(parseAssertionDraft('not json at all')).toBeUndefined();
    expect(parseAssertionDraft('{"mustNot":["x"]}')).toBeUndefined();
  });

  it('丢弃过短/过长/非字符串标记，去重，并封顶条数', () => {
    const long = 'y'.repeat(MAX_ASSERTION_CHARS + 5);
    const many = Array.from({ length: MAX_ASSERTIONS + 4 }, (_, i) => `标记${i}`);
    const draft = parseAssertionDraft(JSON.stringify({ must: ['ab', 'ab', long, 42, ...many], mustNot: [] }));
    expect(draft).toBeDefined();
    expect(draft!.must).toHaveLength(MAX_ASSERTIONS);
    expect(draft!.must).not.toContain(long);
    expect(draft!.must).not.toContain(42);
    // 'ab' 有效且去重后只剩一条，排在前面；'a'（长度 <2）不在此列。
    expect(draft!.must[0]).toBe('ab');
  });

  it('折叠标记里的连续空白（子串匹配前先归一）', () => {
    const draft = parseAssertionDraft(JSON.stringify({ must: ['two   words'], mustNot: [] }));
    expect(draft!.must).toEqual(['two words']);
  });
});

describe('filterUnsupportedMarkers', () => {
  const output = 'We evaluated LangGraph and AutoGen; conclusions follow.\n依据：官方文档。';

  it('原文有的 must 保留（大小写与空白按判分器口径归一）', () => {
    const draft = { must: ['langgraph', '  依据', 'AUTOGEN'], mustNot: [] };
    expect(filterUnsupportedMarkers(draft, output)).toEqual({ must: ['langgraph', '  依据', 'AUTOGEN'], mustNot: [] });
  });

  it('paraphrase 出来的 must 被丢弃，不烧 base 重跑', () => {
    // 产出说"质量还行"，草稿写"代码质量很高"——判分器永远找不到支撑。
    const draft = { must: ['代码质量很高', 'LangGraph'], mustNot: [] };
    expect(filterUnsupportedMarkers(draft, output)!.must).toEqual(['LangGraph']);
  });

  it('must 被滤空 → 整个草稿不可用', () => {
    const draft = { must: ['深度学习框架横评'], mustNot: ['TODO'] };
    expect(filterUnsupportedMarkers(draft, output)).toBeUndefined();
  });

  it('mustNot 不受原文约束（失败特征本就不该在好产出里）', () => {
    const draft = { must: ['LangGraph'], mustNot: ['均已核实', '据我所知'] };
    const filtered = filterUnsupportedMarkers(draft, output);
    expect(filtered!.mustNot).toEqual(['均已核实', '据我所知']);
  });
});

describe('gateAdmits', () => {
  it('过半收录，平票与不过半皆拒（宁可漏收）', () => {
    expect(gateAdmits([true, true, false])).toBe(true);
    expect(gateAdmits([true, false, false])).toBe(false);
    expect(gateAdmits([true, false])).toBe(false);
    expect(gateAdmits([false, false])).toBe(false);
  });

  it('首跑挂不等于拒：后两跑全过即 2/3 过半收录（多数票语义的分歧票型）', () => {
    expect(gateAdmits([false, true, true])).toBe(true);
  });

  it('K=1 退化为单次判定；空跑恒不过（无「跑 0 次全收录」）', () => {
    expect(gateAdmits([true])).toBe(true);
    expect(gateAdmits([false])).toBe(false);
    expect(gateAdmits([])).toBe(false);
  });
});
