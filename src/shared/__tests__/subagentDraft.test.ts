// src/shared/__tests__/subagentDraft.test.ts
// E1.4 → 13.2 生成半边 MVP：按失败画像生成收窄版角色草稿。两件事必须同时成立：
// 草稿对失败模式有针对性（超时型教"拆小"，失败型教"带证据"）；草稿必须能通过
// 加载半边（compileExternalSubagents）的同一道校验——自己生成的东西过不了自己
// 的门，落盘就是埋雷。

import { describe, expect, it } from 'bun:test';
import { buildDraftRoleManifest, draftRoleName } from '../subagentDraft';
import { compileExternalSubagents } from '../../harness/externalSubagents';
import type { SubagentAdvice } from '../subagentAdvisory';

const RESERVED = ['code_reviewer', 'project_auditor', 'task_planner', 'code_editor', 'deep_thinker', 'ui_designer', 'researcher', 'bash_executor'];

function advice(overrides: Partial<SubagentAdvice> = {}): SubagentAdvice {
  return {
    role: 'code_editor',
    reason: 'timeout',
    severity: 'high',
    delegations: 8,
    failures: 5,
    failureRate: 62.5,
    timeoutCount: 4,
    dominantKind: 'timeout',
    avgDurationMs: 240_000,
    lastFailureAt: Date.now() - 60_000,
    action: 'prompt',
    ...overrides,
  };
}

describe('buildDraftRoleManifest (13.2 生成半边 MVP)', () => {
  it('names the draft <role>_focused and targets the manifest file convention', () => {
    const draft = buildDraftRoleManifest(advice());
    expect(draftRoleName('code_editor')).toBe('code_editor_focused');
    expect(draft.file).toBe('code_editor_focused.json');
  });

  it('a timeout-shaped failure produces a "split the task" discipline plus a full budget', () => {
    const draft = buildDraftRoleManifest(advice({ reason: 'timeout', timeoutCount: 4 }));
    const manifest = JSON.parse(draft.json);
    expect(manifest.timeoutMs).toBe(1_800_000);
    expect(manifest.systemPrompt).toContain('拆');
    expect(manifest.description).toContain('超时 4 次');
  });

  it('a generic-failure draft demands evidence and omits the timeout budget', () => {
    const draft = buildDraftRoleManifest(advice({ reason: 'failure', timeoutCount: 0, failureRate: 55.6 }));
    const manifest = JSON.parse(draft.json);
    expect(manifest.timeoutMs).toBeUndefined();
    expect(manifest.systemPrompt).toContain('验证');
    expect(manifest.description).toContain('55.6%');
  });

  it('every generated draft passes the same validator the loader uses', () => {
    // 超时型 / 失败型 / 长角色名，三种都过一遍加载半边的校验 + 内建名保护。
    const cases = [
      advice({ reason: 'timeout' }),
      advice({ reason: 'failure', role: 'deep_thinker' }),
      advice({ role: 'researcher', reason: 'timeout', severity: 'medium' }),
    ];
    for (const item of cases) {
      const draft = buildDraftRoleManifest(item);
      const { defs, errors } = compileExternalSubagents([{ file: draft.file, text: draft.json }], RESERVED);
      expect(errors).toEqual([]);
      expect(defs).toHaveLength(1);
      expect(defs[0].name).toBe(draftRoleName(item.role));
      // 模板占位符能被正常委派的输入替换（加载半边的运行时行为）。
      const prompt = defs[0].createSystemPrompt({ prompt: '修复 login 页的空指针' });
      expect(prompt).toContain('修复 login 页的空指针');
    }
  });

  it('a draft colliding with a built-in name is impossible by construction — but the validator still catches hypothetical ones', () => {
    // 防回归锚点：万一命名规则将来变了（比如去掉 _focused 后缀），这条会立刻
    // 在校验闭环里炸出来，而不是上线后悄悄覆盖内建角色。
    const draft = buildDraftRoleManifest(advice({ role: 'code_reviewer' }));
    expect(draft.file).toBe('code_reviewer_focused.json'); // 不等于内建名本身
    const { errors } = compileExternalSubagents([{ file: draft.file, text: draft.json }], RESERVED);
    expect(errors).toEqual([]);
  });
});
