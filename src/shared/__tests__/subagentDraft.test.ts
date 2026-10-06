// src/shared/__tests__/subagentDraft.test.ts
// E1.4 → 13.2 生成半边 MVP：按失败画像生成收窄版角色草稿。两件事必须同时成立：
// 草稿对失败模式有针对性（超时型教"拆小"，失败型教"带证据"）；草稿必须能通过
// 加载半边（compileExternalSubagents）的同一道校验——自己生成的东西过不了自己
// 的门，落盘就是埋雷。

import { describe, expect, it } from 'bun:test';
import {
  buildDraftRoleManifest,
  buildRoleDraftPrompt,
  draftRoleName,
  parseRoleDraft,
  roleDraftManifest,
  roleDraftPassesCompiler,
  runRoleDraftFlow,
} from '../subagentDraft';
import { compileExternalSubagents } from '../../harness/externalSubagents';
import type { LLMAdapter } from '../types';
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

// ── 完整版（2026-10-06）：模型起草路径 ──
// 纪律与 13.4 逐字同款，四条必须同时成立：
//   ① 拒绝权：模型输出 NONE 就真的不当工具使，不硬凑；
//   ② 草稿必须过加载半边**同一个**校验器（碰内建名一律拒）；
//   ③ 重试上限 2 次，失败后放弃并报明确 outcome，绝不无限重试；
//   ④ 起草素材来自失败画像真实字段，null 时长不许fake 成 0s。
// 另外：这条路径**不写盘**——落盘三道门全在调用方，与确定性路径共用。

describe('模型起草角色 manifest（13.2 完整版，镜像 13.4 纪律）', () => {
  const VALID = JSON.stringify({
    name: 'code_editor_v2',
    description: '只做一个明确小步骤的编辑器角色，交付带验证证据',
    systemPrompt: '你是小粒度编辑器。{prompt} 只做一步，交付必须带证据。',
    input_schema: { type: 'object', properties: { prompt: { type: 'string' } }, required: ['prompt'] },
  });

  // 假 LLM：按调用次序依次返回 replies；onCall 拿到本次是第几次（从 1 开始）。
  function fakeLlm(replies: string[], onCall?: (n: number) => void): LLMAdapter {
    let n = 0;
    return {
      complete: async () => {
        const current = n;
        n += 1;
        onCall?.(current + 1);
        return { content: replies[current] ?? '' };
      },
    } as unknown as LLMAdapter;
  }

  it('起草素材带真实失败画像，超时型与失败型给出不同形状', () => {
    const timeoutPrompt = buildRoleDraftPrompt(advice({ reason: 'timeout', timeoutCount: 4 }));
    expect(timeoutPrompt).toContain('code_editor');
    expect(timeoutPrompt).toContain('62.5%');
    expect(timeoutPrompt).toContain('unit of work is too big');
    const failurePrompt = buildRoleDraftPrompt(advice({ reason: 'failure', timeoutCount: 0, dominantKind: 'failure' }));
    expect(failurePrompt).toContain('must demand evidence');
    expect(failurePrompt).not.toContain('unit of work is too big');
  });

  it('时长无样本时说「未记录」，不伪造一个 0s 数字', () => {
    expect(buildRoleDraftPrompt(advice({ avgDurationMs: null }))).toContain('not recorded');
    expect(buildRoleDraftPrompt(advice({ avgDurationMs: 240_000 }))).toContain('240s');
  });

  it('模型说 NONE 就真的不产出草稿（拒绝权），不当工具使', async () => {
    const outcome = await runRoleDraftFlow({ advice: advice(), llm: fakeLlm(['NONE']), reservedNames: RESERVED });
    expect(outcome).toEqual({ kind: 'none' });
  });

  it('坏 JSON / 缺字段一律 undefined，不半信半疑地补全', () => {
    expect(parseRoleDraft('not json at all')).toBeUndefined();
    expect(parseRoleDraft('```\n{ "name": "x" }\n```')).toBeUndefined();
    expect(parseRoleDraft(JSON.stringify({ name: 'x', description: 'a long enough desc' }))).toBeUndefined();
    expect(parseRoleDraft('')).toBeUndefined();
    expect(parseRoleDraft('NONE')).toBeUndefined();
  });

  it('合法草稿能解析且过加载半边校验', () => {
    const draft = parseRoleDraft(VALID);
    expect(draft?.name).toBe('code_editor_v2');
    expect(roleDraftPassesCompiler(draft!, RESERVED)).toBe(true);
    const { defs, errors } = compileExternalSubagents([{ file: 'code_editor_v2.json', text: roleDraftManifest(draft!) }], RESERVED);
    expect(errors).toEqual([]);
    expect(defs[0].createSystemPrompt({ prompt: '改一个函数' })).toContain('改一个函数');
  });

  it('碰内建名的草稿过不了校验——落盘前就被拦，不靠事后发现', () => {
    const colliding = parseRoleDraft(JSON.stringify({
      name: 'code_reviewer', // 内建角色名
      description: '冒用内建名的草稿',
      systemPrompt: '冒名顶替。{prompt}',
      input_schema: { type: 'object', properties: { prompt: { type: 'string' } }, required: ['prompt'] },
    }))!;
    expect(roleDraftPassesCompiler(colliding, RESERVED)).toBe(false);
  });

  it('校验不过会重试，上限 2 次后放弃并报 invalid（不无限重试）', async () => {
    let calls = 0;
    const bad = JSON.stringify({ name: 'BAD-NAME', description: '名字不合规', systemPrompt: 'x {prompt}' });
    const outcome = await runRoleDraftFlow({ advice: advice(), llm: fakeLlm([bad], () => { calls++; }), reservedNames: RESERVED });
    expect(calls).toBe(2);
    expect(outcome.kind).toBe('invalid');
  });

  it('第一次坏、第二次好就采用好的（重试不是空转）', async () => {
    let calls = 0;
    const outcome = await runRoleDraftFlow({ advice: advice(), llm: fakeLlm(['nope', VALID], () => { calls++; }), reservedNames: RESERVED });
    expect(calls).toBe(2);
    expect(outcome.kind).toBe('drafted');
  });

  it('LLM 报错也计入重试，耗尽后报 invalid 而不是抛出去', async () => {
    const throwing = {
      complete: async () => { throw new Error('network down'); },
    } as unknown as LLMAdapter;
    const outcome = await runRoleDraftFlow({ advice: advice(), llm: throwing, reservedNames: RESERVED });
    expect(outcome.kind).toBe('invalid');
  });

  it('拒绝权只认模型真说的 NONE：校验失败不会被误报成「模型拒绝」', async () => {
    // 回归锚点：首轮输出能解析但过不了校验（内建名），第二轮直接崩。
    // 曾经的实现用 lastError 里是否含 "declined" 反推结局，于是第二轮的崩覆盖了
    // 第一轮的校验失败，用户看到「模型拒绝设计新角色」——而模型从头到尾没说过这句。
    const colliding = JSON.stringify({
      name: 'code_reviewer',
      description: '冒用内建名的草稿',
      systemPrompt: '冒名。{prompt}',
      input_schema: { type: 'object', properties: { prompt: { type: 'string' } }, required: ['prompt'] },
    });
    let calls = 0;
    const llm = {
      complete: async () => {
        calls += 1;
        if (calls === 1) return { content: colliding };
        throw new Error('network down');
      },
    } as unknown as LLMAdapter;
    const outcome = await runRoleDraftFlow({ advice: advice(), llm, reservedNames: RESERVED });
    expect(calls).toBe(2);
    expect(outcome.kind).toBe('invalid');
  });
});
