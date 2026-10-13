// src/harness/cliCapabilityTools.ts
// CLI 侧的动态能力工具（search/install skill、search/connect/register MCP）。
// GUI 在 TauriToolAdapter 的 switch case 里实现同一组工具；CLI 没有那台
// 适配器，这里用组合适配器拦下五个动态名自己执行、其余转发内层
// NodeToolAdapter——注册表（权限门）与模型清单的接线在 cliHarness.createTools。
// 共享逻辑（hub 搜索/抓取、Registry 解析）直接复用 src/ui/skillHub.ts 与
// shared/mcpRegistry.ts：前者非 Tauri 分支走全局 fetch（isTauriRuntime 明确
// 标注 Node 安全），后者是纯函数。

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ToolAdapter, ToolCall, ToolResult, ToolDefinition } from '../shared/types';
import type { WorkspaceSnapshotPort } from '../shared/workspaceSnapshot';
import { DYNAMIC_CAPABILITY_TOOL_DEFS, isDynamicCapabilityTool } from '../shared/dynamicCapabilityTools';
import type { DynamicMcpConnectionResult } from '../shared/dynamicCapabilityTools';
import type { MCPServerConfig } from '../adapter/mcp/MCPTransport';
import { mcpRegistrySearchUrl, parseMcpRegistryPayload } from '../shared/mcpRegistry';
import { fetchSkillBody, searchHubSkills, splitSkillMarkdown, sanitizeSkillName, normalizeHubRepo } from '../ui/skillHub';
import { skillsRootDir } from '../cliSkillStore';

/** CLI 宿主注入口：MCP 连接 + 持久化在 cliHarness 闭包里实现（那里才有
 *  MCPClient、registry 与 ~/.pure/config.json 的装配语境），适配器只编排。 */
export interface CliCapabilityHost {
  connectMcp(config: MCPServerConfig, signal?: AbortSignal): Promise<DynamicMcpConnectionResult>;
}

/** 30s 连接兜底：MCPClient.connectServer 无信号参数，stdio 进程启动挂死时
 *  调用方不能无限悬着（GUI 侧用 chat.ts 私有的 withAbortTimeout，CLI 不引
 *  ui 模块，这里就地竞速）。 */
function withConnectTimeout<T>(p: Promise<T>, label: string, ms = 30_000): Promise<T> {
  return Promise.race([
    p,
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`${label} timed out after ${ms / 1000}s`)), ms)),
  ]);
}

export class CliCapabilityToolAdapter implements ToolAdapter {
  // search_mcp_servers 的候选表：connect 只认本次会话搜到的 id（与 GUI
  // TauriToolAdapter.mcpCandidates 同语义）。
  private mcpCandidates = new Map<string, { title: string; config?: MCPServerConfig; requiresAuth?: boolean; installHint?: string }>();

  constructor(
    private inner: ToolAdapter,
    private host: CliCapabilityHost,
  ) {}

  getTools(): ToolDefinition[] {
    return [...this.inner.getTools(), ...DYNAMIC_CAPABILITY_TOOL_DEFS];
  }

  getSnapshotPort(): WorkspaceSnapshotPort | undefined {
    return this.inner.getSnapshotPort?.();
  }

  getMetadata(toolName: string): { sideEffects?: boolean; isWrite?: boolean; timeoutMs?: number } | undefined {
    return this.inner.getMetadata(toolName);
  }

  async execute(toolCall: ToolCall, signal?: AbortSignal): Promise<ToolResult> {
    const name = toolCall.function.name;
    if (!isDynamicCapabilityTool(name)) return this.inner.execute(toolCall, signal);
    const start = Date.now();
    const args = (() => {
      try {
        return JSON.parse(toolCall.function.arguments || '{}') as Record<string, unknown>;
      } catch {
        return {} as Record<string, unknown>;
      }
    })();
    try {
      switch (name) {
        case 'search_agent_skills': return await this.searchSkills(toolCall, args, start);
        case 'install_agent_skill': return await this.installSkill(toolCall, args, start, signal);
        case 'search_mcp_servers': return await this.searchMcp(toolCall, args, start, signal);
        case 'connect_mcp_server': return await this.connectMcp(toolCall, args, start, signal);
        case 'register_mcp_server': return await this.registerMcp(toolCall, args, start, signal);
        default:
          return { id: toolCall.id, toolName: name, error: `Unknown dynamic capability tool: ${name}`, success: false, duration: Date.now() - start };
      }
    } catch (err) {
      return { id: toolCall.id, toolName: name, error: err instanceof Error ? err.message : String(err), success: false, duration: Date.now() - start };
    }
  }

  private async searchSkills(toolCall: ToolCall, args: Record<string, unknown>, start: number): Promise<ToolResult> {
    const query = String(args.query ?? '').trim();
    if (!query) return { id: toolCall.id, toolName: 'search_agent_skills', error: 'search_agent_skills requires a query', success: false, duration: Date.now() - start };
    const maxResults = typeof args.maxResults === 'number' && Number.isFinite(args.maxResults) ? Math.min(20, Math.max(1, Math.floor(args.maxResults))) : 8;
    const candidates = await searchHubSkills(query, maxResults);
    return { id: toolCall.id, toolName: 'search_agent_skills', result: JSON.stringify({ query, candidates }, null, 2), success: true, duration: Date.now() - start };
  }

  private async installSkill(toolCall: ToolCall, args: Record<string, unknown>, start: number, signal?: AbortSignal): Promise<ToolResult> {
    const source = String(args.source ?? '').trim();
    const nameArg = String(args.name ?? '').trim();
    if (!/^[A-Za-z0-9_.-]+$/.test(nameArg)) {
      return { id: toolCall.id, toolName: 'install_agent_skill', error: 'install_agent_skill rejected an unsafe skill name', success: false, duration: Date.now() - start };
    }
    const repo = normalizeHubRepo(source) || source;
    const raw = await fetchSkillBody(repo, nameArg);
    if (signal?.aborted) throw new Error('aborted');
    if (!raw) {
      return {
        id: toolCall.id,
        toolName: 'install_agent_skill',
        error: `无法从 ${repo} 获取 ${nameArg}/SKILL.md — raw CDN、GitHub API 和 repo zip 三条路都不可达。不要重复同一调用，换条路：用 download_file 下载 https://codeload.github.com/${repo}/zip/refs/heads/main，解压后把 ${nameArg}/SKILL.md 所在目录拷进 ${skillsRootDir()}/${nameArg}/。`,
        success: false,
        duration: Date.now() - start,
      };
    }
    const split = splitSkillMarkdown(raw);
    const body = split.body.trim();
    if (!body) return { id: toolCall.id, toolName: 'install_agent_skill', error: 'Downloaded SKILL.md has no instruction body', success: false, duration: Date.now() - start };
    // 落盘与 GUI write_app_skill 同位（~/.pure/skills/<name>/SKILL.md，
    // PURE_SKILLS_DIR 可覆盖）：cliRepl 的 loadAppSkills 读同一目录，本轮
    // 结束后即可用；写读同源由 cliSkillStore 单点保证。
    const dir = join(skillsRootDir(), sanitizeSkillName(nameArg));
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'SKILL.md'), raw, 'utf8');
    const promptBody = body.length > 30_000 ? `${body.slice(0, 30_000)}\n[skill body truncated; continue using the installed skill on the next turn]` : body;
    return {
      id: toolCall.id,
      toolName: 'install_agent_skill',
      result: `Installed skill ${nameArg} from ${repo} at ${dir}. Apply these instructions to the current task, then verify the result:\n\n<installed_skill name="${sanitizeSkillName(nameArg)}">\n${promptBody}\n</installed_skill>`,
      success: true,
      duration: Date.now() - start,
    };
  }

  private async fetchViaInner(url: string, maxChars: number, signal?: AbortSignal): Promise<string> {
    // 借内层 NodeToolAdapter 的 web_fetch：代理、重试、劫持检测全套复用，
    // CLI 不再自养一份网络栈。
    const res = await this.inner.execute({
      id: 'cap_internal_fetch',
      index: 0,
      function: { name: 'web_fetch', arguments: JSON.stringify({ url, maxChars }) },
    }, signal);
    if (!res.success) throw new Error(`web_fetch ${url} failed: ${res.error ?? 'unknown error'}`);
    return res.result as string;
  }

  private async searchMcp(toolCall: ToolCall, args: Record<string, unknown>, start: number, signal?: AbortSignal): Promise<ToolResult> {
    const query = String(args.query ?? '').trim();
    if (!query) return { id: toolCall.id, toolName: 'search_mcp_servers', error: 'search_mcp_servers requires a query', success: false, duration: Date.now() - start };
    const maxResults = typeof args.maxResults === 'number' && Number.isFinite(args.maxResults) ? Math.min(20, Math.max(1, Math.floor(args.maxResults))) : 8;
    const registryUrl = mcpRegistrySearchUrl(query, Math.max(12, maxResults * 2));
    const officialRaw = await this.fetchViaInner(registryUrl, 100_000, signal);
    const candidates = parseMcpRegistryPayload(officialRaw, maxResults);
    this.mcpCandidates.clear();
    candidates.forEach((candidate) => this.mcpCandidates.set(candidate.id, candidate));
    // CLI 无 web_search 工具，社区目录（Smithery/mcp.so）这轮不聚合——官方
    // Registry 仍是主路径，且目录搜不到时模型可以直接 register_mcp_server。
    return { id: toolCall.id, toolName: 'search_mcp_servers', result: JSON.stringify({ query, directories: ['official-registry'], candidates }, null, 2), success: true, duration: Date.now() - start };
  }

  private async connectMcp(toolCall: ToolCall, args: Record<string, unknown>, start: number, signal?: AbortSignal): Promise<ToolResult> {
    const candidateId = String(args.candidateId ?? '').trim();
    const candidate = this.mcpCandidates.get(candidateId);
    if (!candidate) return { id: toolCall.id, toolName: 'connect_mcp_server', error: 'Unknown MCP candidate. Search again and use the returned candidateId.', success: false, duration: Date.now() - start };
    if (!candidate.config) return { id: toolCall.id, toolName: 'connect_mcp_server', error: candidate.installHint ?? 'This MCP candidate has no directly usable connection recipe; register it manually via register_mcp_server.', success: false, duration: Date.now() - start };
    if (candidate.requiresAuth) return { id: toolCall.id, toolName: 'connect_mcp_server', error: 'This MCP candidate requires credentials. Configure its secret or use a no-key package/remote recipe first.', success: false, duration: Date.now() - start };
    const connected = await this.host.connectMcp(candidate.config, signal);
    return { id: toolCall.id, toolName: 'connect_mcp_server', result: JSON.stringify({ candidateId, name: candidate.title, persisted: connected.persisted, tools: connected.tools.map((tool) => tool.name) }), success: true, duration: Date.now() - start };
  }

  private async registerMcp(toolCall: ToolCall, args: Record<string, unknown>, start: number, signal?: AbortSignal): Promise<ToolResult> {
    // 六形态校验与 GUI TauriToolAdapter.register_mcp_server 同款：进程启动
    // 前拦截，坏参数永远到不了连接层。
    const serverName = String(args.name ?? '').trim();
    if (!serverName) return { id: toolCall.id, toolName: 'register_mcp_server', error: 'register_mcp_server requires a server name', success: false, duration: Date.now() - start };
    const transport = String(args.transport ?? '').trim();
    const env = (args.env && typeof args.env === 'object' && !Array.isArray(args.env))
      ? Object.fromEntries(Object.entries(args.env as Record<string, unknown>).map(([k, v]) => [k, String(v)]))
      : undefined;
    const requestTimeoutMs = typeof args.requestTimeoutMs === 'number' && Number.isFinite(args.requestTimeoutMs) && args.requestTimeoutMs >= 1000
      ? Math.floor(args.requestTimeoutMs)
      : undefined;
    let serverConfig: MCPServerConfig;
    if (transport === 'stdio') {
      const command = Array.isArray(args.command) ? args.command.map((part) => String(part).trim()).filter(Boolean) : [];
      if (command.length === 0) return { id: toolCall.id, toolName: 'register_mcp_server', error: 'stdio transport requires a command array, e.g. ["npx", "-y", "pkg"]', success: false, duration: Date.now() - start };
      serverConfig = { name: serverName, transport: 'stdio', command, env, requestTimeoutMs };
    } else if (transport === 'http') {
      const url = String(args.url ?? '').trim();
      if (!/^https?:\/\//i.test(url)) return { id: toolCall.id, toolName: 'register_mcp_server', error: 'http transport requires an http(s) URL', success: false, duration: Date.now() - start };
      serverConfig = { name: serverName, transport: 'http', url, env, requestTimeoutMs };
    } else {
      return { id: toolCall.id, toolName: 'register_mcp_server', error: 'transport must be "stdio" or "http"', success: false, duration: Date.now() - start };
    }
    const registered = await this.host.connectMcp(serverConfig, signal);
    return { id: toolCall.id, toolName: 'register_mcp_server', result: JSON.stringify({ name: serverName, transport, persisted: registered.persisted, tools: registered.tools.map((tool) => tool.name) }), success: true, duration: Date.now() - start };
  }
}

export { withConnectTimeout };
