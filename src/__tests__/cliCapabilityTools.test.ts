// src/__tests__/cliCapabilityTools.test.ts
// CLI 侧动态能力工具的组合适配器 + ToolRegistry 可见性开口（2026-10-13
// 真机判例：workspace 模式的模型清单走 getTools()，纯 isPublicToolName
// 过滤把注册过的动态/MCP 工具全滤掉——执行路通而模型看不见）。

import { describe, expect, it } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import { join } from 'node:path';
import { ToolRegistry, Tags } from '../coding-agent/ToolRegistry';
import { CliCapabilityToolAdapter, type CliCapabilityHost } from '../harness/cliCapabilityTools';
import { DYNAMIC_CAPABILITY_TOOL_DEFS } from '../shared/dynamicCapabilityTools';
import { skillContentHash } from '../ui/skillHub';
import { readSkillSidecar, skillsRootDir } from '../cliSkillStore';
import type { ToolAdapter, ToolCall, ToolResult } from '../shared/types';

function stubInner(): ToolAdapter & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    getTools: () => [{ name: 'read_file', description: 'x', input_schema: { type: 'object' } }],
    getMetadata: () => undefined,
    execute: async (toolCall: ToolCall): Promise<ToolResult> => {
      calls.push(toolCall.function.name);
      return { id: toolCall.id, toolName: toolCall.function.name, result: 'inner-ok', success: true, duration: 1 };
    },
  } as ToolAdapter & { calls: string[] };
}

function stubHost(): CliCapabilityHost & { configs: unknown[] } {
  const configs: unknown[] = [];
  return {
    configs,
    connectMcp: async (config) => {
      configs.push(config);
      return { tools: [{ name: 'rea__trace', description: 'd', input_schema: { type: 'object' } }], persisted: true };
    },
  };
}

function toolCall(name: string, args: Record<string, unknown>): ToolCall {
  return { id: `test_${name}`, index: 0, function: { name, arguments: JSON.stringify(args) } };
}

describe('ToolRegistry model-visible filter opens for dynamic + MCP tools', () => {
  it('exposes registered dynamic capability tools and MCP-discovered tools', () => {
    const registry = new ToolRegistry(stubInner());
    for (const tool of DYNAMIC_CAPABILITY_TOOL_DEFS) {
      registry.register({ ...tool, tags: [Tags.READ], riskLevel: 'low', serverName: 'pure-capabilities' });
    }
    registry.register({ name: 'rea__trace', description: 'mcp tool', input_schema: { type: 'object' }, tags: [Tags.MCP], riskLevel: 'low' });
    // 未注册进 PUBLIC 名单的普通自定义工具仍被滤（开口只给动态能力与 MCP）。
    registry.register({ name: 'mystery_tool', description: 'nope', input_schema: { type: 'object' }, tags: [Tags.READ], riskLevel: 'low' });
    const names = registry.getTools().map((t) => t.name);
    expect(names).toContain('search_mcp_servers');
    expect(names).toContain('register_mcp_server');
    expect(names).toContain('rea__trace');
    expect(names).not.toContain('mystery_tool');
  });
});

describe('CliCapabilityToolAdapter', () => {
  it('forwards non-dynamic tool calls to the inner adapter', async () => {
    const inner = stubInner();
    const adapter = new CliCapabilityToolAdapter(inner, stubHost());
    const result = await adapter.execute(toolCall('read_file', { path: 'a.txt' }));
    expect(result.success).toBe(true);
    expect(inner.calls).toEqual(['read_file']);
  });

  it('lists the five dynamic capability tools after the inner tools', () => {
    const adapter = new CliCapabilityToolAdapter(stubInner(), stubHost());
    const names = adapter.getTools().map((t) => t.name);
    expect(names[0]).toBe('read_file');
    for (const def of DYNAMIC_CAPABILITY_TOOL_DEFS) expect(names).toContain(def.name);
  });

  it('registers a custom stdio server through the host with the exact config', async () => {
    const host = stubHost();
    const adapter = new CliCapabilityToolAdapter(stubInner(), host);
    const result = await adapter.execute(toolCall('register_mcp_server', {
      name: 'rea',
      transport: 'stdio',
      command: ['npx', '-y', 'rea-agents@latest', 'mcp'],
      env: { REA_LOG: 'info' },
      requestTimeoutMs: 120000,
    }));
    expect(result.success).toBe(true);
    expect(host.configs).toEqual([{ name: 'rea', transport: 'stdio', command: ['npx', '-y', 'rea-agents@latest', 'mcp'], env: { REA_LOG: 'info' }, requestTimeoutMs: 120000 }]);
    expect(String(result.result)).toContain('rea__trace');
  });

  it('rejects malformed register_mcp_server args before the host is ever reached', async () => {
    const host = stubHost();
    const adapter = new CliCapabilityToolAdapter(stubInner(), host);
    for (const args of [
      { transport: 'stdio', command: ['npx'] },
      { name: 'x', transport: 'stdio' },
      { name: 'x', transport: 'stdio', command: [] },
      { name: 'x', transport: 'http' },
      { name: 'x', transport: 'http', url: 'ftp://nope' },
      { name: 'x', transport: 'websocket' },
    ]) {
      const result = await adapter.execute(toolCall('register_mcp_server', args));
      expect(result.success).toBe(false);
      expect(result.error).toBeTypeOf('string');
    }
    expect(host.configs).toEqual([]);
  });

  it('connect_mcp_server rejects an unknown candidate without touching the host', async () => {
    const host = stubHost();
    const adapter = new CliCapabilityToolAdapter(stubInner(), host);
    const result = await adapter.execute(toolCall('connect_mcp_server', { candidateId: 'never-searched' }));
    expect(result.success).toBe(false);
    expect(String(result.error)).toContain('Unknown MCP candidate');
    expect(host.configs).toEqual([]);
  });

  it('wraps adapter errors as failed tool results instead of throwing', async () => {
    const host: CliCapabilityHost = {
      connectMcp: async () => {
        throw new Error('npx not found');
      },
    };
    const adapter = new CliCapabilityToolAdapter(stubInner(), host);
    const result = await adapter.execute(toolCall('register_mcp_server', { name: 'rea', transport: 'stdio', command: ['npx'] }));
    expect(result.success).toBe(false);
    expect(result.error).toContain('npx not found');
  });
});

// ── install_agent_skill 的版本戳闭环 ──
// 同名即更新而非拒绝：sidecar（.pure-skill.json）里的内容 hash 决定「同版本
// 不动」「覆盖并报旧→新」。fetch 打桩走 raw CDN 候选位，落盘指到临时目录。
describe('install_agent_skill version stamping (CLI tool path)', () => {
  const RAW_V1 = '---\nname: vision-ocr\ndescription: Extract text from images\n---\n\nDo OCR on images.\n';
  const BODY = 'Do OCR on images.';

  function withTempSkillsDir(): { base: string; restore: () => void } {
    const base = mkdtempSync(join(os.tmpdir(), 'pure-cli-skill-install-'));
    const prev = process.env.PURE_SKILLS_DIR;
    process.env.PURE_SKILLS_DIR = base;
    return { base, restore: () => { if (prev === undefined) delete process.env.PURE_SKILLS_DIR; else process.env.PURE_SKILLS_DIR = prev; rmSync(base, { recursive: true, force: true }); } };
  }

  function stubHubFetch(raw: string): { restore: () => void } {
    return stubHubFetchRaw(() => raw);
  }

  function stubHubFetchRaw(servedRaw: () => string): { restore: () => void } {
    const original = globalThis.fetch;
    globalThis.fetch = (async (url: any) => {
      const target = String(url);
      if (target.includes('raw.githubusercontent.com')) {
        return new Response(servedRaw(), { status: 200 });
      }
      return new Response('not found', { status: 404 });
    }) as unknown as typeof fetch;
    return { restore: () => { globalThis.fetch = original; } };
  }

  function skillDir(): string {
    return join(skillsRootDir(), 'vision-ocr');
  }

  it('installs fresh and stamps the sidecar with source/hash/installedAt', async () => {
    const env = withTempSkillsDir();
    const hub = stubHubFetch(RAW_V1);
    try {
      const adapter = new CliCapabilityToolAdapter(stubInner(), stubHost());
      const result = await adapter.execute(toolCall('install_agent_skill', { source: 'vercel-labs/agent-skills', name: 'vision-ocr' }));
      expect(result.success).toBe(true);
      const text = String(result.result);
      expect(text).toContain(`Installed skill vision-ocr from vercel-labs/agent-skills at ${skillDir()}`);
      expect(text).toContain('<installed_skill name="vision-ocr">');
      // SKILL.md 落盘（存原始 frontmatter），sidecar 与 Rust write_app_skill 同形。
      expect(readFileSync(join(skillDir(), 'SKILL.md'), 'utf8')).toBe(RAW_V1);
      const sidecar = readSkillSidecar(skillDir());
      expect(sidecar).toEqual({ source: 'vercel-labs/agent-skills', hash: skillContentHash(BODY), installedAt: expect.any(String) });
      expect(sidecar!.installedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    } finally {
      hub.restore();
      env.restore();
    }
  });

  it('same-content reinstall is a no-op that says so', async () => {
    const env = withTempSkillsDir();
    const hub = stubHubFetch(RAW_V1);
    try {
      const adapter = new CliCapabilityToolAdapter(stubInner(), stubHost());
      await adapter.execute(toolCall('install_agent_skill', { source: 'vercel-labs/agent-skills', name: 'vision-ocr' }));
      // 手工破坏 SKILL.md：真重写会把它治好，no-op 必须原样保留。
      const skillFile = join(skillDir(), 'SKILL.md');
      writeFileSync(skillFile, 'hand-edited, a no-op must not heal this');
      const before = readSkillSidecar(skillDir());

      const result = await adapter.execute(toolCall('install_agent_skill', { source: 'vercel-labs/agent-skills', name: 'vision-ocr' }));
      expect(result.success).toBe(true);
      const text = String(result.result);
      expect(text).toContain(`Skill vision-ocr is already at this version (hash ${skillContentHash(BODY)}`);
      expect(text).toContain('nothing was changed');
      expect(text).toContain('<installed_skill name="vision-ocr">'); // 本轮仍拿得到正文
      expect(readFileSync(skillFile, 'utf8')).toBe('hand-edited, a no-op must not heal this');
      expect(readSkillSidecar(skillDir())).toEqual(before);
    } finally {
      hub.restore();
      env.restore();
    }
  });

  it('changed content overwrites and reports old → new hash', async () => {
    const env = withTempSkillsDir();
    const RAW_V2 = RAW_V1.replace('Do OCR on images.', 'Do OCR on images, v2.');
    let servedRaw = RAW_V1;
    const hub = stubHubFetchRaw(() => servedRaw);
    try {
      const adapter = new CliCapabilityToolAdapter(stubInner(), stubHost());
      await adapter.execute(toolCall('install_agent_skill', { source: 'vercel-labs/agent-skills', name: 'vision-ocr' }));
      const oldHash = skillContentHash(BODY);
      servedRaw = RAW_V2;

      const result = await adapter.execute(toolCall('install_agent_skill', { source: 'vercel-labs/agent-skills', name: 'vision-ocr' }));
      expect(result.success).toBe(true);
      const text = String(result.result);
      expect(text).toContain(`Updated skill vision-ocr from vercel-labs/agent-skills at ${skillDir()} (skill hash ${oldHash} → ${skillContentHash('Do OCR on images, v2.')})`);
      expect(readSkillSidecar(skillDir())!.hash).toBe(skillContentHash('Do OCR on images, v2.'));
      expect(readFileSync(join(skillDir(), 'SKILL.md'), 'utf8')).toBe(RAW_V2);
    } finally {
      hub.restore();
      env.restore();
    }
  });

  it('leaves the skill loaders untouched: the sidecar is a plain file next to SKILL.md', async () => {
    const env = withTempSkillsDir();
    const hub = stubHubFetch(RAW_V1);
    try {
      const adapter = new CliCapabilityToolAdapter(stubInner(), stubHost());
      await adapter.execute(toolCall('install_agent_skill', { source: 'vercel-labs/agent-skills', name: 'vision-ocr' }));
      // 装载器（cliRepl/chat/list_app_skills）只认 <dir>/SKILL.md；sidecar 是
      // 技能目录里的一个普通文件，不会成为扫描条目，也不影响 SKILL.md 解析。
      expect(existsSync(join(skillDir(), '.pure-skill.json'))).toBe(true);
      const sidecarStat = (await import('node:fs')).statSync(join(skillDir(), '.pure-skill.json'));
      expect(sidecarStat.isFile()).toBe(true);
      expect(readFileSync(join(skillDir(), 'SKILL.md'), 'utf8')).toContain('name: vision-ocr');
    } finally {
      hub.restore();
      env.restore();
    }
  });
});
