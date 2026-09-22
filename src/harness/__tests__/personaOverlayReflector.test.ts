// src/harness/__tests__/personaOverlayReflector.test.ts
// 13.3 part 3 — overlay 起草器的纯函数测试（提示词构造 + 回复解析）；LLM 往返不在此覆盖。

import { describe, expect, it } from 'bun:test';
import {
  buildFailureProfile,
  buildOverlayDraftPrompt,
  parseOverlayDraft,
} from '../personaOverlayReflector';
import { MAX_OVERLAY_CHARS } from '../personaOverlays';
import type { SubagentAdvice } from '../../shared/subagentAdvisory';

const advice = (overrides: Partial<SubagentAdvice> = {}): SubagentAdvice => ({
  role: 'code_reviewer',
  reason: 'failure',
  severity: 'high',
  delegations: 10,
  failures: 5,
  failureRate: 50,
  timeoutCount: 0,
  dominantKind: 'tool_error',
  avgDurationMs: 42_000,
  lastFailureAt: Date.now(),
  action: 'skill-gate',
  skillId: 'code-review',
  ...overrides,
});

describe('buildFailureProfile', () => {
  it('把失败画像写成可迁移的结论，不喂原始报文', () => {
    const profile = buildFailureProfile(advice());
    expect(profile).toContain('派发 10 次');
    expect(profile).toContain('失败 5 次（50%）');
    expect(profile).toContain('tool_error');
    expect(profile).toContain('平均耗时约 42 秒');
    expect(profile).toContain('缺少验证证据');
  });

  it('超时型给出"任务体量偏大"的判断', () => {
    const profile = buildFailureProfile(advice({ reason: 'timeout', timeoutCount: 4 }));
    expect(profile).toContain('超时 4 次');
    expect(profile).toContain('任务体量偏大');
  });
});

describe('buildOverlayDraftPrompt', () => {
  it('带上角色、base 契约与失败画像', () => {
    const prompt = buildOverlayDraftPrompt({ role: 'code_reviewer', advice: advice(), baseContract: '你负责代码评审，按严重度分级' });
    expect(prompt).toContain('ROLE: code_reviewer');
    expect(prompt).toContain('按严重度分级');
    expect(prompt).toContain('派发 10 次');
  });

  it('截断超长契约，防止撑爆调用', () => {
    const prompt = buildOverlayDraftPrompt({ role: 'r', advice: advice(), baseContract: 'x'.repeat(5000) });
    expect(prompt.length).toBeLessThan(2000);
  });
});

describe('parseOverlayDraft', () => {
  it('纯文本直接采用', () => {
    expect(parseOverlayDraft('新增约束：交付必须附文件:行号证据。')).toBe('新增约束：交付必须附文件:行号证据。');
  });

  it('剥掉围栏', () => {
    expect(parseOverlayDraft('```markdown\n新增约束：先声明要验证什么。\n```')).toBe('新增约束：先声明要验证什么。');
  });

  it('NONE 表示模型无话可说 → 不可用', () => {
    expect(parseOverlayDraft('NONE')).toBeUndefined();
    expect(parseOverlayDraft('  none  ')).toBeUndefined();
  });

  it('过短或超长 → 不可用', () => {
    expect(parseOverlayDraft('太短')).toBeUndefined();
    expect(parseOverlayDraft('x'.repeat(MAX_OVERLAY_CHARS + 1))).toBeUndefined();
  });
});
