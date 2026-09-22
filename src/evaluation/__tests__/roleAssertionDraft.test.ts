// src/evaluation/__tests__/roleAssertionDraft.test.ts
// 13.3 part 3 / 13.1 — 断言起草的纯函数测试（提示词构造 + 回复校验）。

import { describe, expect, it } from 'bun:test';
import {
  buildAssertionDraftPrompt,
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
