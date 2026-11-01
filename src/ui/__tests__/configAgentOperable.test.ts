// src/ui/__tests__/configAgentOperable.test.ts
// 设置 agent 化（2026-11-01 定调：设置面板所有开关对 agent 都可语义操作、
// 可智能化自我操作）的两块机制契约：
// ① mergeConfigPreservingDisk——面板保存不再全量覆盖写盘，agent/手改的
//    字段存活；两边都动盘上赢；apiKey 永不复活。
// ② refreshConfigFromFile——盘上有变即重镜像 + 失效缓存（热生效），
//    没变零动作。

import { describe, it, expect } from 'bun:test';
import { mergeConfigPreservingDisk, type PureConfig } from '../config';

const base = { provider: 'deepseek-openai', model: 'deepseek-chat', autoPermRead: true, mcpServers: [{ name: 'rea' }] } as unknown as PureConfig;

describe('mergeConfigPreservingDisk（面板保存不 clobber agent 的设置改动）', () => {
  it('GUI 改过的字段赢，agent 改过且 GUI 没碰的字段存活', () => {
    const known = { ...base } as unknown as Record<string, unknown>;
    const disk = { ...base, autoPermWrite: true } as unknown as Record<string, unknown>; // agent 只新增了写权限开关
    const incoming = { ...base, model: 'kimi-k2' } as unknown as Record<string, unknown>; // 面板只改了模型
    const merged = mergeConfigPreservingDisk(incoming, disk, known) as unknown as Record<string, unknown>;
    expect(merged.model).toBe('kimi-k2'); // 面板改动存活（盘上没动 model）
    expect(merged.autoPermWrite).toBe(true); // agent 的开关改动不被 clobber
  });

  it('两边都改同一字段：盘上赢（真实源），GUI 下次 loadConfig 看到合并结果', () => {
    const known = { ...base } as unknown as Record<string, unknown>;
    const disk = { ...base, model: 'glm-5.3' } as unknown as Record<string, unknown>;
    const incoming = { ...base, model: 'kimi-k2' } as unknown as Record<string, unknown>;
    expect(mergeConfigPreservingDisk(incoming, disk, known).model).toBe('glm-5.3');
  });

  it('agent 删掉的键（盘上没有而 known 有）不复活；盘上新增的键保留', () => {
    const known = { ...base, legacyFlag: true } as unknown as Record<string, unknown>;
    const disk = { ...base } as unknown as Record<string, unknown>; // agent 删了 legacyFlag
    const incoming = { ...base, legacyFlag: true } as unknown as Record<string, unknown>;
    const merged = mergeConfigPreservingDisk(incoming, disk, known) as unknown as Record<string, unknown>;
    expect('legacyFlag' in merged).toBe(false); // 删除存活（深合并会救回来）
    const withNew = mergeConfigPreservingDisk(incoming, { ...disk, agentAdded: 1 } as unknown as Record<string, unknown>, known) as unknown as Record<string, unknown>;
    expect(withNew.agentAdded).toBe(1);
  });

  it('嵌套对象整体比较：agent 替换了整个 mcpServers 列表，GUI 没碰它 → 列表存活', () => {
    const known = { ...base } as unknown as Record<string, unknown>;
    const disk = { ...base, mcpServers: [] } as unknown as Record<string, unknown>; // agent 清空了 MCP
    const incoming = { ...base, model: 'kimi-k2' } as unknown as Record<string, unknown>;
    expect(mergeConfigPreservingDisk(incoming, disk, known).mcpServers).toEqual([]);
  });

  it('known/disk 缺席（init 未跑）→ 原样返回 incoming；apiKey 永不被盘上复活', () => {
    const incoming = { ...base, apiKey: '' } as unknown as Record<string, unknown>;
    expect(mergeConfigPreservingDisk(incoming, null, null)).toBe(incoming);
    const known = { ...base, apiKey: '' } as unknown as Record<string, unknown>;
    const diskWithSecret = { ...base, apiKey: 'sk-leaked-in-file' } as unknown as Record<string, unknown>;
    const merged = mergeConfigPreservingDisk(incoming, diskWithSecret, known) as unknown as Record<string, unknown>;
    expect(merged.apiKey).toBe(''); // 密钥不参与盘上赢面
  });
});
