// src/harness/cliCapabilityTools.ts
// CLI 侧的动态能力工具（search/install skill、search/connect/register MCP）。
// GUI 在 TauriToolAdapter 的 switch case 里实现同一组工具；CLI 没有那台
// 适配器，这里用组合适配器拦下五个动态名自己执行、其余转发内层
// NodeToolAdapter——注册表（权限门）与模型清单的接线在 cliHarness.createTools。
// 共享逻辑（hub 搜索/抓取、Registry 解析）直接复用 src/ui/skillHub.ts 与
// shared/mcpRegistry.ts：前者非 Tauri 分支走全局 fetch（isTauriRuntime 明确
// 标注 Node 安全），后者是纯函数。

import { mkdirSync, writeFileSync, existsSync, readFileSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import type { ToolAdapter, ToolCall, ToolResult, ToolDefinition } from '../shared/types';
import type { WorkspaceSnapshotPort } from '../shared/workspaceSnapshot';
import { DYNAMIC_CAPABILITY_TOOL_DEFS, isDynamicCapabilityTool } from '../shared/dynamicCapabilityTools';
import type { DynamicMcpConnectionResult } from '../shared/dynamicCapabilityTools';
import type { MCPServerConfig } from '../adapter/mcp/MCPTransport';
import { mcpRegistrySearchUrl, parseMcpRegistryPayload } from '../shared/mcpRegistry';
import { parseCredentialPaste, verifyChannelCredentials, type OnboardChannelId } from '../shared/channelCredentials';
import { fetchSkillBody, searchHubSkills, splitSkillMarkdown, sanitizeSkillName, normalizeHubRepo, skillContentHash } from '../ui/skillHub';
import { skillsRootDir, readSkillSidecar, writeSkillSidecar } from '../cliSkillStore';
import { PURE_DIR } from '../cliConfig';

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
    /** configure_channel 的落盘根（~/.pure）。可注入：bun test 单进程里改
     *  HOME/模块常量会固化进缓存并污染后续文件（顺序地雷判例），测试从
     *  这里给临时目录，生产路径默认 PURE_DIR 不变。 */
    private readonly pureDir: string = PURE_DIR,
    /** 平台探活的 fetch（测试注入桩；缺省全局 fetch）。 */
    private readonly verifyFetch?: typeof fetch,
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
        case 'configure_channel': return await this.configureChannel(toolCall, args, start);
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
    // 同名即更新而非拒绝（与 GUI 工具路、Settings Hub 三处同语义）：
    // 比对 sidecar 里的内容 hash——相同就原样保留并说明，不同（或没有
    // 记录）就覆盖安装，结果里写明旧 hash → 新 hash。
    const hash = skillContentHash(body);
    const previous = readSkillSidecar(dir);
    let headline: string;
    if (previous && previous.hash === hash) {
      headline = `Skill ${nameArg} is already at this version (hash ${hash}, from ${previous.source ?? repo}) at ${dir} — nothing was changed.`;
    } else {
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'SKILL.md'), raw, 'utf8');
      writeSkillSidecar(dir, { source: repo, hash, installedAt: new Date().toISOString() });
      headline = previous
        ? `Updated skill ${nameArg} from ${repo} at ${dir} (skill hash ${previous.hash} → ${hash}).`
        : `Installed skill ${nameArg} from ${repo} at ${dir}.`;
    }
    const promptBody = body.length > 30_000 ? `${body.slice(0, 30_000)}\n[skill body truncated; continue using the installed skill on the next turn]` : body;
    return {
      id: toolCall.id,
      toolName: 'install_agent_skill',
      result: `${headline} Apply these instructions to the current task, then verify the result:\n\n<installed_skill name="${sanitizeSkillName(nameArg)}">\n${promptBody}\n</installed_skill>`,
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

  /** 通道凭据在盘上的槽位与字段名（与 GUI channelSettings 的 SECRETS_KEY、
   *  cliChannels 的 resolveChannelSecret 同一张表——三面漂移即配置失灵）。 */
  private static readonly CHANNEL_SECRETS: Record<OnboardChannelId, { secretsKey: string; primaryField: string; secondaryRefField: string; label: string }> = {
    feishu: { secretsKey: 'feishu.appSecret', primaryField: 'appId', secondaryRefField: 'appSecretRef', label: '飞书' },
    dingtalk: { secretsKey: 'dingtalk.clientSecret', primaryField: 'clientId', secondaryRefField: 'clientSecretRef', label: '钉钉' },
    qq: { secretsKey: 'qq.appSecret', primaryField: 'appId', secondaryRefField: 'appSecretRef', label: 'QQ' },
    // telegram 单 token（token 本身即密钥）：secretsKey 存的是 token 本身，
    // channels.json 只落 tokenRef 指针，明文不进通道配置。
    telegram: { secretsKey: 'telegram.botToken', primaryField: 'token', secondaryRefField: 'tokenRef', label: 'Telegram' },
  };

  /**
   * configure_channel（Bun 侧实现）：粘贴原文 → 解析 → 平台探活 → 写盘
   * （secrets.json 0600 + channels.json 保真直改）。探活先行——凭据被拒时
   * 一个字节都不落盘，用户拿到的永远是「已验证可用」或明确的失败原因，
   * 不再是「存完了但能不能用要自己试」。网关在跑时它自己的 watch 会热载
   * （数秒内生效）；没在跑则明说「启动后生效」，不假装已生效。
   */
  private async configureChannel(toolCall: ToolCall, args: Record<string, unknown>, start: number): Promise<ToolResult> {
    const channel = String(args.channel ?? '').trim() as OnboardChannelId;
    const meta = CliCapabilityToolAdapter.CHANNEL_SECRETS[channel];
    if (!meta) {
      return { id: toolCall.id, toolName: 'configure_channel', error: `configure_channel: channel 必须是 feishu / dingtalk / qq / telegram 之一（收到 "${channel}"）`, success: false, duration: Date.now() - start };
    }
    const credentialsText = String(args.credentials ?? '').trim();
    if (!credentialsText) {
      return { id: toolCall.id, toolName: 'configure_channel', error: `configure_channel 需要 credentials——把用户提供的凭据文本原样传入（不要自己拆字段）`, success: false, duration: Date.now() - start };
    }
    // telegram 单 token（secretOnly）：token 即全部凭据，完整性只查 primary。
    const secretOnly = channel === 'telegram';
    const parsed = parseCredentialPaste(credentialsText, channel);
    const primary = parsed?.primary ?? '';
    const secondary = parsed?.secondary ?? '';
    if (!primary || (!secretOnly && !secondary)) {
      const missingHint = secretOnly
        ? '请用户从 @BotFather 复制 bot token（形如 123456:ABC-DEF… 的一段值）。'
        : `请用户对照平台控制台补齐两段值：${channel === 'dingtalk' ? 'Client ID + Client Secret' : 'AppID + AppSecret'}。`;
      return {
        id: toolCall.id,
        toolName: 'configure_channel',
        error: `凭据解析不完整（${!primary ? `缺 ${meta.primaryField}` : ''}${!primary && !secondary ? '、' : ''}${!secretOnly && !secondary ? '缺密钥' : ''}）。${missingHint}`,
        success: false,
        duration: Date.now() - start,
      };
    }

    // 探活先行：拒绝/网络不通都不写盘。
    const verdict = await verifyChannelCredentials(channel, primary, secondary, this.verifyFetch);
    if (!verdict.ok) {
      const rejectedHint = verdict.kind === 'rejected'
        ? (secretOnly
          ? `${meta.label}凭据被平台拒绝：${verdict.detail}。请在 Telegram 里找 @BotFather /mybots 核对 token（revoke 过旧 token 即失效），核对后再发我一次。没有写入任何配置。`
          : `${meta.label}凭据被平台拒绝：${verdict.detail}。请回平台控制台核对 ${channel === 'dingtalk' ? 'Client ID/Client Secret' : 'AppID/AppSecret'} 是否配对（secret 重置过旧值即失效），核对后再发我一次。没有写入任何配置。`)
        : `${meta.label}平台探活失败（网络不通）：${verdict.detail}。配置未写入——请检查本机网络/代理后再试。`;
      return { id: toolCall.id, toolName: 'configure_channel', error: rejectedHint, success: false, duration: Date.now() - start };
    }

    // secrets.json（0600）+ channels.json 保真直改（与 GUI 同构：raw JSON
    // 直改字段，不经 materialize——用户手写的注释性字段一字不丢）。
    try {
      const secretsPath = join(this.pureDir, 'secrets.json');
      let secrets: Record<string, unknown> = {};
      try {
        secrets = JSON.parse(readFileSync(secretsPath, 'utf8')) as Record<string, unknown>;
      } catch { /* 不存在或损坏——从空表开始 */ }

      const channelsPath = join(this.pureDir, 'channels.json');
      let cfg: Record<string, unknown> = { enabled: true, channels: {} };
      try {
        cfg = JSON.parse(readFileSync(channelsPath, 'utf8')) as Record<string, unknown>;
      } catch { /* 首次配置——从骨架开始 */ }
      if (typeof cfg !== 'object' || cfg === null || Array.isArray(cfg)) cfg = { channels: {} };
      const channels = (cfg.channels && typeof cfg.channels === 'object' && !Array.isArray(cfg.channels) ? cfg.channels : {}) as Record<string, Record<string, unknown>>;
      const entry = (channels[channel] && typeof channels[channel] === 'object' ? channels[channel] : {}) as Record<string, unknown>;
      const accounts = (entry.accounts && typeof entry.accounts === 'object' && !Array.isArray(entry.accounts) ? entry.accounts : {}) as Record<string, Record<string, unknown>>;
      const first = Object.values(accounts)[0] ?? {};
      // telegram（secretOnly）：token 本身进 secrets.json，channels.json 只落
      // tokenRef 指针——明文不进通道配置；其余通道照旧 primary 明文 + secret 指针。
      if (secretOnly) {
        secrets[meta.secretsKey] = primary;
        accounts.main = { ...first, [meta.secondaryRefField]: meta.secretsKey };
      } else {
        secrets[meta.secretsKey] = secondary;
        accounts.main = {
          ...first,
          [meta.primaryField]: primary,
          [meta.secondaryRefField]: meta.secretsKey,
        };
      }
      mkdirSync(this.pureDir, { recursive: true });
      writeFileSync(secretsPath, JSON.stringify(secrets, null, 2), 'utf8');
      try { chmodSync(secretsPath, 0o600); } catch { /* 权限收紧失败不回滚写入 */ }
      entry.enabled = args.enable === false ? false : true;
      entry.accounts = accounts;
      channels[channel] = entry;
      cfg.channels = channels;
      // 顶层 enabled 是 gateway 总开关（CLI 手写场景里它可能缺失）：任一
      // 通道启用即同步为 true（与 GUI syncChannelsEnabled 同语义）。
      cfg.enabled = Object.values(channels).some((e) => e && typeof e === 'object' && (e as Record<string, unknown>).enabled === true);
      writeFileSync(channelsPath, JSON.stringify(cfg, null, 2), 'utf8');
    } catch (err) {
      return { id: toolCall.id, toolName: 'configure_channel', error: `凭据有效但写盘失败：${err instanceof Error ? err.message : String(err)}`, success: false, duration: Date.now() - start };
    }

    const gatewayAlive = this.isGatewayAlive();
    const afterLine = gatewayAlive
      ? '网关正在运行，几秒内自动热载生效（无需重启）。'
      : '网关当前未运行——配置已保存，下次启动网关（设置页「启动」或命令行 `pure gateway`）即生效。';
    const pairingLine = '首次在平台里给机器人发消息会收到一个配对码，把配对码告诉我或运行 `pure channels approve <码>` 即可完成绑定。';
    const result = [
      `✅ ${meta.label}通道已开通（凭据已通过平台验证）`,
      afterLine,
      pairingLine,
    ].join('\n');
    return { id: toolCall.id, toolName: 'configure_channel', result, success: true, duration: Date.now() - start };
  }

  /** 网关死活（读 gateway.lock 的 pid 探活）。读不到/坏文件一律按没跑——
   *  文案退到「下次启动生效」，宁可信其无，不说没把握的「已生效」。 */
  private isGatewayAlive(): boolean {
    try {
      const lock = JSON.parse(readFileSync(join(this.pureDir, 'channels', 'gateway.lock'), 'utf8')) as { pid?: unknown };
      const pid = typeof lock.pid === 'number' ? lock.pid : 0;
      if (pid <= 0) return false;
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  }
}

export { withConnectTimeout };
