// src/ui/__tests__/sessionSidebar.test.ts
// 侧栏会话卡片的纯函数测试：短 id 指纹的确定性、批内唯一性与格式。
// （渲染本身依赖 DOM/Tauri，不在这里覆盖。）

import { describe, it, expect } from 'bun:test';
import { assignShortIds } from '../sessionSidebar';

describe('SessionSidebar short id assignment', () => {
  it('每个可见卡片拿到确定的 6 位 base36 短 id', () => {
    const ids = ['session_1758472910342_1', 'session_1758472919999_2', 'session_1758472925000_3'];
    const first = assignShortIds(ids);
    const again = assignShortIds(ids);
    // 渲染顺序无关的确定性：同一批 id 两次指派结果一致。
    expect([...first.entries()]).toEqual([...again.entries()]);
    for (const s of first.values()) {
      expect(s).toMatch(/^[0-9a-z]{6}$/);
    }
  });

  it('批内唯一：同一批可见卡片绝不出现重复短 id', () => {
    // 结构相近的 id（同毫秒不同序号）是最容易碰撞的形状。
    const ids = Array.from({ length: 30 }, (_, i) => `session_1758472910342_${i}`);
    const map = assignShortIds(ids);
    const shorts = [...map.values()];
    expect(new Set(shorts).size).toBe(shorts.length);
  });

  it('不同批次互不影响：单独指派与批量指派结果一致（顺序无关）', () => {
    const ids = ['session_111_1', 'session_222_2'];
    const batch = assignShortIds(ids);
    const solo = assignShortIds([ids[1]]);
    expect(solo.get(ids[1])).toBe(batch.get(ids[1]));
  });
});
