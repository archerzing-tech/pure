// src/harness/__tests__/personaOverlays.test.ts
// 阶段 13.3 — persona overlay 纯编译管线：文件名→角色、合法性校验、重名先到先得、
// 合并语义（base 一字不动 + overlay 追加）。宿主 IO（Tauri invoke / node:fs）不在此覆盖。

import { describe, expect, it } from 'bun:test';
import { applyPersonaOverlay, compilePersonaOverlays, MAX_OVERLAY_CHARS, overlayFileRole } from '../personaOverlays';

describe('overlayFileRole', () => {
  it('从 <role>.overlay.md 提取角色名', () => {
    expect(overlayFileRole('code_reviewer.overlay.md')).toBe('code_reviewer');
    expect(overlayFileRole('task_planner.overlay.md')).toBe('task_planner');
  });

  it('不合形的文件名返回 null', () => {
    expect(overlayFileRole('Code_Reviewer.overlay.md')).toBeNull(); // 大写
    expect(overlayFileRole('planner.md')).toBeNull(); // 后缀不对
    expect(overlayFileRole('.overlay.md')).toBeNull(); // 空角色
    expect(overlayFileRole('a b.overlay.md')).toBeNull();
  });
});

describe('compilePersonaOverlays', () => {
  it('合法源编译成 role→overlay 映射，文本去首尾空白', () => {
    const { overlays, errors } = compilePersonaOverlays([
      { file: 'code_reviewer.overlay.md', text: '  新增约束：评审必须给出文件:行号证据。  ' },
    ]);
    expect(errors).toEqual([]);
    expect(overlays.get('code_reviewer')).toBe('新增约束：评审必须给出文件:行号证据。');
  });

  it('过短文本被拒（≥8 字符）', () => {
    const { overlays, errors } = compilePersonaOverlays([{ file: 'planner.overlay.md', text: '太短' }]);
    expect(overlays.size).toBe(0);
    expect(errors[0]).toContain('≥8 chars');
  });

  it(`超过 ${MAX_OVERLAY_CHARS} 字符被拒`, () => {
    const text = '长'.repeat(MAX_OVERLAY_CHARS + 1);
    const { overlays, errors } = compilePersonaOverlays([{ file: 'planner.overlay.md', text }]);
    expect(overlays.size).toBe(0);
    expect(errors[0]).toContain('exceeds');
  });

  it('提供已知角色集时，指向不存在角色的 overlay 被拒；省略时接受一切合法角色名', () => {
    const src = [{ file: 'ghost_role.overlay.md', text: '这条 overlay 指向一个不存在的角色。' }];
    const withKnown = compilePersonaOverlays(src, ['code_reviewer']);
    expect(withKnown.overlays.size).toBe(0);
    expect(withKnown.errors[0]).toContain('ghost_role');

    const withoutKnown = compilePersonaOverlays(src);
    expect(withoutKnown.overlays.has('ghost_role')).toBe(true);
    expect(withoutKnown.errors).toEqual([]);
  });

  it('同一角色多个文件先到先得，后者报重名（目录合并出同名文件的场景）', () => {
    const dup = compilePersonaOverlays([
      { file: 'planner.overlay.md', text: '第一份 overlay，先生效。' },
      { file: 'planner.overlay.md', text: '第二份 overlay，重复角色。' },
    ]);
    expect(dup.overlays.get('planner')).toBe('第一份 overlay，先生效。');
    expect(dup.errors[0]).toContain('duplicate overlay for role "planner"');
  });
});

describe('applyPersonaOverlay', () => {
  it('无 overlay 时逐字节一致', () => {
    const base = 'You are code_reviewer.';
    expect(applyPersonaOverlay(base, undefined)).toBe(base);
    expect(applyPersonaOverlay(base, '')).toBe(base);
  });

  it('有 overlay 时追加在 base 之后（空行分隔），base 不动', () => {
    const base = 'You are code_reviewer.';
    const merged = applyPersonaOverlay(base, '新增约束：先看测试再评审。');
    expect(merged).toBe(`${base}\n\n新增约束：先看测试再评审。`);
  });
});
