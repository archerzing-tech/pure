// src/coding-agent/ToolRegistry.ts
// v0.3 — Flat tagged tool registry implementing ToolAdapter.
// Each tool carries tags for permission control, risk classification, and routing.
// Subagent tools (Tags.AGENT) and MCP tools (Tags.MCP) are routed to separate executors.
// Tool schemas/descriptions live in shared/toolDefs.ts (single source of truth
// shared with the CLI/GUI adapters); this module only adds the permission-layer
// tags + risk levels on top.

import type { ToolAdapter, ToolCall, ToolResult, ToolDefinition } from '../shared/types';
import type { TaggedTool, PermissionContext } from './types';
import type { WorkspaceSnapshotPort } from '../shared/workspaceSnapshot';
import type { PermissionManager } from './PermissionManager';
import { BUILT_IN_TOOL_DEFS, CORE_TOOL_NAMES, isPublicToolName } from '../shared/toolDefs';
import { isDynamicCapabilityTool } from '../shared/dynamicCapabilityTools';
import { safeParseArgs } from '../shared/format';
import { withRelaySchema } from '../engine/relayPipeline';
import { matchPresentationCards, renderPresentationCard, renderPresentationCatalog } from '../shared/presentationLibrary';

// ── Tag constants ──

export const Tags = {
  READ: 'read',
  WRITE: 'write',
  DESTRUCTIVE: 'destructive',
  SHELL: 'shell',
  AGENT: 'agent',
  PLAN: 'plan',
  FS: 'fs',
  SEARCH: 'search',
  MCP: 'mcp',
  DOWNLOAD: 'download',
  EXTERNAL: 'external',
} as const;

// ── Built-in tool definitions with tags ──
// The LLM-visible schema (name/description/input_schema) comes from the shared
// BUILT_IN_TOOL_DEFS; only the permission annotations live here, keyed by tool
// name so a new shared def can never silently run without its gate.

// Keyed by the exact tool-name union from BUILT_IN_TOOL_DEFS (`as const` in
// toolDefs.ts): adding a tool there without a permission mapping here is a
// compile error, so a new tool can never silently run un-gated.
type BuiltinToolName = (typeof BUILT_IN_TOOL_DEFS)[number]['name'];

const TOOL_TAGS: Record<BuiltinToolName, { tags: string[]; riskLevel?: 'low' | 'medium' | 'high' }> = {
  read_file: { tags: [Tags.FS, Tags.READ], riskLevel: 'low' },
  write_file: { tags: [Tags.FS, Tags.WRITE, Tags.DESTRUCTIVE], riskLevel: 'medium' },
  edit_file: { tags: [Tags.FS, Tags.WRITE, Tags.DESTRUCTIVE], riskLevel: 'medium' },
  list_files: { tags: [Tags.FS, Tags.READ], riskLevel: 'low' },
  find_files: { tags: [Tags.FS, Tags.READ, Tags.SEARCH], riskLevel: 'low' },
  search_files: { tags: [Tags.FS, Tags.READ, Tags.SEARCH], riskLevel: 'low' },
  execute_command: { tags: [Tags.SHELL, Tags.DESTRUCTIVE], riskLevel: 'high' },
  git_diff: { tags: [Tags.SHELL, Tags.READ], riskLevel: 'low' },
  git_log: { tags: [Tags.SHELL, Tags.READ], riskLevel: 'low' },
  git_status: { tags: [Tags.SHELL, Tags.READ], riskLevel: 'low' },
  // Git writes run friction-free: product decision (the owner finds per-commit
  // confirmation cards more costly than the risk — commits are local and
  // revertible, and 3.4's pre-commit code review is the quality gate, not the
  // permission layer). riskLevel 'low' auto-approves in NORMAL; the WRITE tag
  // still keeps the write-lock/snapshot classification and PLAN/DONT_ASK
  // blocking. History-rewriting or remote git (push / reset --hard) stays on
  // execute_command's existing high-risk path — no extra command guard.
  git_commit: { tags: [Tags.SHELL, Tags.WRITE], riskLevel: 'low' },
  git_branch: { tags: [Tags.SHELL, Tags.WRITE], riskLevel: 'low' },
  sys_info: { tags: [Tags.READ], riskLevel: 'low' },
  create_directory: { tags: [Tags.FS, Tags.WRITE], riskLevel: 'low' },
  diff_files: { tags: [Tags.FS, Tags.READ], riskLevel: 'low' },
  researcher_web: { tags: [Tags.SEARCH, Tags.READ], riskLevel: 'low' },
  researcher_docs: { tags: [Tags.SEARCH, Tags.READ], riskLevel: 'low' },
  create_document: { tags: [Tags.WRITE], riskLevel: 'medium' },
  code_searcher: { tags: [Tags.FS, Tags.READ, Tags.SEARCH], riskLevel: 'low' },
  web_search: { tags: [Tags.SEARCH, Tags.READ], riskLevel: 'low' },
  web_fetch: { tags: [Tags.READ], riskLevel: 'low' },
  web_public_api: { tags: [Tags.SEARCH, Tags.READ], riskLevel: 'low' },
  web_scrape: { tags: [Tags.READ], riskLevel: 'low' },
  download_file: { tags: [Tags.DOWNLOAD, Tags.WRITE], riskLevel: 'medium' },
  glob_files: { tags: [Tags.FS, Tags.READ, Tags.SEARCH], riskLevel: 'low' },
  replace_files: { tags: [Tags.FS, Tags.WRITE, Tags.DESTRUCTIVE], riskLevel: 'medium' },
  // diagnose_network 只观测网络，纯只读，永远自动放行。
  //
  // switch_package_source 的风险随 scope 变：session 档不落盘，file 档会改用户
  // 的 ~/.npmrc / pip.conf。原先把它标成 READ + low 是错的——low 会被
  // PermissionManager 直接自动放行，于是「file 级必须显式批准」这道产品决定
  // 在权限层完全落空：confirm:true 是模型自己能填的字段，用户全程没有参与。
  // 改法沿用 git_commit / git_branch 的既有模式（见上方那条断言）：WRITE tag
  // 让 PLAN 与 DONT_ASK 真正拦住它（只读计划期不该被改配置），riskLevel 保持
  // low 以免把 session 档那类零落盘调用也堵在确认卡后面。
  diagnose_network: { tags: [Tags.READ], riskLevel: 'low' },
  switch_package_source: { tags: [Tags.WRITE], riskLevel: 'low' },
  // discover_tools 由注册表自持（索引+激活都在这里完成），永不下沉执行器；
  // 纯只读，无副作用。
  discover_tools: { tags: [Tags.SEARCH, Tags.READ], riskLevel: 'low' },
  // presentation_guide 同为注册表自持（卡片目录住在本仓库
  // shared/presentationLibrary.ts），永不下沉执行器；纯只读。
  presentation_guide: { tags: [Tags.READ], riskLevel: 'low' },
};

export const BUILT_IN_TOOLS: readonly TaggedTool[] = Object.freeze(
  BUILT_IN_TOOL_DEFS.map((def) => ({ ...def, ...TOOL_TAGS[def.name] })),
);

// ── ToolRegistry ──

/** Return true for shell commands that mutate Git repository state. */
export function isGitMutationCommand(command: string): boolean {
  return /\bgit(?:\s+(?:-C\s+\S+|--git-dir(?:=|\s+)\S+|--work-tree(?:=|\s+)\S+))*\s+(?:init|add|commit|reset|clean|checkout|switch|restore|push|pull|config|stash|tag|mv|rm|rebase|merge)\b/i.test(command);
}

export class ToolRegistry implements ToolAdapter {
  private tools: TaggedTool[] = [...BUILT_IN_TOOLS];
  // 工具 deferred 化（框架改革三期）：discover_tools 激活过的长尾/MCP 工具
  // 名单。激活是会话级决定——一旦搜出过，后续请求的 tools 数组持续携带，
  // 模型不必每次用前重搜。
  private activatedDeferred = new Set<string>();
  private subagentExecutor?: ToolAdapter;
  private mcpExecutor?: ToolAdapter;
  private externalToolsExecutor?: ToolAdapter;
  private permissionManager?: PermissionManager;
  private commandGuard?: (command: string) => string | null;
  // 模型可见清单的设置闸（宿主接线 isToolEnabled）：注册表种子是全量
  // BUILT_IN_TOOLS，不经过 delegate 的过滤面——此前「关掉开关工具立刻从
  // 清单消失」的承诺只对设置页 inventory 成立，模型清单里 execute_command
  // 等仍看得见、调用时才被 wrapper 拦（2026-10-31 判例）。谓词对未知名
  // （MCP/子代理/动态/外部）默认放行，连接层排除面不受影响。
  private visibilityGate?: (name: string) => boolean;

  constructor(private delegate: ToolAdapter) {}

  setVisibilityGate(gate: ((name: string) => boolean) | undefined): void {
    this.visibilityGate = gate;
  }

  /** The underlying adapter (NodeToolAdapter / TauriToolAdapter) — used by
   * the external-tools executor to route through execute_command. */
  getDelegate(): ToolAdapter {
    return this.delegate;
  }

  /** Set the executor for subagent (Tags.AGENT) tools. */
  setSubagentExecutor(executor: ToolAdapter): void {
    this.subagentExecutor = executor;
  }

  /** Set the executor for MCP (Tags.MCP) tools. */
  setMCPExecutor(executor: ToolAdapter): void {
    this.mcpExecutor = executor;
  }

  /** Set the executor for external script tools (Tags.EXTERNAL). */
  setExternalToolsExecutor(executor: ToolAdapter): void {
    this.externalToolsExecutor = executor;
  }

  /** Set the permission manager consulted before every tool execution. */
  setPermissionManager(pm: PermissionManager): void {
    this.permissionManager = pm;
  }

  /** Temporarily reject dangerous command patterns for a scoped workflow. */
  setCommandGuard(guard?: (command: string) => string | null): void {
    this.commandGuard = guard;
  }

  /** Register an MCP or custom tool. */
  register(tool: TaggedTool): void {
    const existing = this.tools.findIndex(t => t.name === tool.name);
    if (existing >= 0) {
      this.tools[existing] = tool;
    } else {
      this.tools.push(tool);
    }
  }

  getTools(): ToolDefinition[] {
    // 工具 deferred 化（框架改革三期）：模型可见清单 = 常驻核心（CORE_TOOL_NAMES）
    // + 动态能力工具（skill/MCP 获取回路，二期教学的载体，整体常驻）+ 用户自装
    // 的外部脚本工具（少数派、用户明确装过，藏起来是敌意）+ **已激活**的长尾
    // 内置工具与 MCP 工具。长尾与 MCP 留在注册表里但不再自动可见——rea 一类
    // 两百工具的 MCP server 全量随表是几千 token 的刚需浪费；经 discover_tools
    // 搜索并激活后才进清单。与 2026-10-13「注册即可见」判例不冲突：那次修的
    // 是「执行路通、模型看不见且无发现路径」；现在发现路径（discover_tools）
    // 本身常驻，藏起来的工具都有路可寻。MCP 工具的排除面仍在连接层
    // （mcpExcludedPrefixes），这里不再滤第二次。
    return this.tools
      .filter(({ name, tags }) =>
        (isPublicToolName(name)
          ? name === 'discover_tools' || CORE_TOOL_NAMES.has(name) || this.activatedDeferred.has(name)
          : isDynamicCapabilityTool(name)
            || tags.includes(Tags.EXTERNAL)
            || (tags.includes(Tags.MCP) && this.activatedDeferred.has(name)))
        && (!this.visibilityGate || this.visibilityGate(name)))
      .map(({ name, description, input_schema }) => ({ name, description, input_schema }));
  }

  /** Subagent tools (Tags.AGENT) — the parent LLM's delegation surface. These
   * are deliberately NOT part of getTools() (the public tool list); callers
   * that want the model to actually spawn subagents must merge them into the
   * model-visible tool list (CodingAgent / CLI createHarness do).
   * 接力流水线（北极星第 5 步）：出口处给每个委派工具注入保留参数 relay
   * （as/from）的 schema——这里是所有模型可见路径（CodingAgent / CLI /
   * GUI chat）的单一咽喉，注册表里存的定义保持原样不被污染。 */
  getSubagentTools(): ToolDefinition[] {
    return this.tools
      .filter(({ tags }) => tags.includes(Tags.AGENT))
      .map(({ name, description, input_schema }) => ({ name, description, input_schema: withRelaySchema(input_schema) }));
  }

  /**
   * discover_tools 的搜索半边：在长尾内置工具与 MCP 工具（未激活、非子代理、
   * 过设置闸）里按关键词打分（名字命中 3 分 / 描述命中 1 分），取前 N 名并
   * **当场激活**。返回的是完整 schema——激活的目的就是让模型下一请求就能照
   * 着调用，省一轮再要详情的往返。
   */
  searchDeferredTools(query: string, limit = 8): ToolDefinition[] {
    const tokens = (query ?? '').toLowerCase().split(/[\s,]+/).filter(Boolean);
    const scored: { tool: TaggedTool; score: number }[] = [];
    for (const tool of this.tools) {
      if (tool.tags.includes(Tags.AGENT)) continue;
      if (isPublicToolName(tool.name) && (tool.name === 'discover_tools' || CORE_TOOL_NAMES.has(tool.name))) continue;
      if (this.activatedDeferred.has(tool.name)) continue;
      if (isDynamicCapabilityTool(tool.name)) continue;
      if (this.visibilityGate && !this.visibilityGate(tool.name)) continue;
      const haystack = `${tool.name} ${tool.description}`.toLowerCase();
      let score = 0;
      for (const token of tokens) {
        if (tool.name.toLowerCase().includes(token)) score += 3;
        else if (haystack.includes(token)) score += 1;
      }
      if (score > 0) scored.push({ tool, score });
    }
    scored.sort((a, b) => b.score - a.score || a.tool.name.localeCompare(b.tool.name));
    const picked = scored.slice(0, Math.max(1, Math.min(Math.floor(limit) || 8, 20)));
    for (const { tool } of picked) this.activatedDeferred.add(tool.name);
    return picked.map(({ tool }) => ({ name: tool.name, description: tool.description, input_schema: tool.input_schema }));
  }

  /** discover_tools 的执行半边：搜索 → 激活 → 把完整 schema 交到对话里。 */
  private executeDiscoverTools(toolCall: ToolCall): ToolResult {
    const started = Date.now();
    const args = safeParseArgs(toolCall.function.arguments);
    const query = typeof args.query === 'string' ? args.query.trim() : '';
    if (!query) {
      return {
        id: toolCall.id,
        toolName: toolCall.function.name,
        error: 'query is required — space-separated keywords matched against tool names and descriptions',
        success: false,
        duration: Date.now() - started,
      };
    }
    const limit = typeof args.limit === 'number' ? args.limit : 8;
    const activated = this.searchDeferredTools(query, limit);
    if (activated.length === 0) {
      // 零命中时把目录亮出来：模型此时最需要的是「还有什么可找」，而不是
      // 一句干巴巴的 no results。目录只在被搜索时进对话，不占常驻预算。
      const catalog = this.tools
        .filter((tool) => !tool.tags.includes(Tags.AGENT)
          && !(isPublicToolName(tool.name) && (tool.name === 'discover_tools' || CORE_TOOL_NAMES.has(tool.name)))
          && !this.activatedDeferred.has(tool.name)
          && !isDynamicCapabilityTool(tool.name)
          && (!this.visibilityGate || this.visibilityGate(tool.name)))
        .map((tool) => tool.name);
      return {
        id: toolCall.id,
        toolName: toolCall.function.name,
        success: true,
        duration: Date.now() - started,
        result: `No deferred tool matches "${query}". The resident tools already cover the everyday loop (file read/write/edit, find_files/code_searcher, execute_command, web_search/web_fetch, download_file). The deferred catalog currently holds: ${catalog.join(', ') || '(empty — everything matching is already activated)'}. Try different or broader keywords.`,
      };
    }
    const rendered = activated
      .map((def) => [`── ${def.name} ──`, def.description, `Arguments: ${JSON.stringify(def.input_schema)}`].join('\n'))
      .join('\n\n');
    return {
      id: toolCall.id,
      toolName: toolCall.function.name,
      success: true,
      duration: Date.now() - started,
      result: `Activated ${activated.length} tool(s) for "${query}" — callable now with the full schemas below, and they stay available for the rest of this session:\n\n${rendered}`,
    };
  }

  /**
   * presentation_guide 的执行半边：form 命中（id/别名/族/子串容错）→ 卡片全文；
   * 省略或零命中 → 目录索引（复制 discover_tools 的「目录只在被搜索时进对话」
   * 模式——展现是 push 型输出语法，卡片是知识不是工具，不需要激活态）。
   */
  private executePresentationGuide(toolCall: ToolCall): ToolResult {
    const started = Date.now();
    const args = safeParseArgs(toolCall.function.arguments);
    const form = typeof args.form === 'string' ? args.form.trim() : '';
    if (!form) {
      return {
        id: toolCall.id,
        toolName: toolCall.function.name,
        success: true,
        duration: Date.now() - started,
        result: renderPresentationCatalog(),
      };
    }
    const matches = matchPresentationCards(form);
    if (matches.length === 0) {
      return {
        id: toolCall.id,
        toolName: toolCall.function.name,
        success: true,
        duration: Date.now() - started,
        result: `No presentation card matches "${form}". The catalog currently holds:\n\n${renderPresentationCatalog()}`,
      };
    }
    const rendered = matches.map(renderPresentationCard).join('\n\n');
    return {
      id: toolCall.id,
      toolName: toolCall.function.name,
      success: true,
      duration: Date.now() - started,
      result: rendered,
    };
  }

  getSnapshotPort(): WorkspaceSnapshotPort | undefined {
    return this.delegate.getSnapshotPort?.();
  }

  getMetadata(toolName: string): { sideEffects?: boolean; isWrite?: boolean; timeoutMs?: number } | undefined {
    const tool = this.tools.find(t => t.name === toolName);
    if (!tool) return this.delegate.getMetadata(toolName);
    const meta = {
      sideEffects: tool.tags.includes(Tags.DESTRUCTIVE)
        || tool.tags.includes(Tags.SHELL)
        || tool.tags.includes(Tags.MCP)
        || tool.tags.includes(Tags.AGENT),
      isWrite: tool.tags.includes(Tags.WRITE) || tool.tags.includes(Tags.DESTRUCTIVE),
    };
    // A delegation is one tool call wrapping a whole nested agent loop, so the
    // executor's declared budget must reach the engine's tool-execution cap —
    // otherwise the generic tool timeout kills subagents that were given far
    // more. Delegations are NEVER isWrite: they run concurrently in the
    // parent's reads pool (2026-09-20 — four bash_executor scans must overlap,
    // not queue). Same-file write safety comes from the shared FileLockManager
    // at the inner write_file/edit_file level, not from serializing whole
    // agents — serializing them killed the fan-out delegations exist for.
    if (tool.tags.includes(Tags.AGENT)) {
      const sub = this.subagentExecutor?.getMetadata(toolName);
      if (sub) return { sideEffects: sub.sideEffects ?? true, isWrite: false, timeoutMs: sub.timeoutMs };
    }
    return meta;
  }

  async execute(toolCall: ToolCall, signal?: AbortSignal): Promise<ToolResult> {
    const known = this.tools.find(t => t.name === toolCall.function.name);
    if (!known) {
      return {
        id: toolCall.id,
        toolName: toolCall.function.name,
        error: `Unknown tool: ${toolCall.function.name}`,
        success: false,
        duration: 0,
      };
    }

    if (toolCall.function.name === 'execute_command' && this.commandGuard) {
      const args = safeParseArgs(toolCall.function.arguments);
      const command = typeof args.command === 'string' ? args.command : '';
      const blocked = this.commandGuard(command);
      if (blocked) {
        return {
          id: toolCall.id,
          toolName: toolCall.function.name,
          error: blocked,
          success: false,
          duration: 0,
        };
      }
    }

    // ── Permission gate: consult PermissionManager before executing ──
    if (this.permissionManager) {
      const args = safeParseArgs(toolCall.function.arguments);
      const isWrite = known.tags.includes(Tags.WRITE) || known.tags.includes(Tags.DESTRUCTIVE);
      // 写性未知 ≠ 只读（审计批 5①）：MCP 工具的写性客户端永远无从得知
      // （注册恒 [Tags.MCP]），外部脚本工具执行的是模板+模型参数拼出的任意
      // 命令——两者缺省都不是可证明的读。判成 isRead 让 PLAN/DONT_ASK
      // 放行 MCP 服务的写工具和任意脚本执行（只读模式形同虚设，且外部
      // 执行器把翻译出的 execute_command 直打裸 adapter，不再有第二道闸）。
      // 显式声明 Tags.READ 的外部工具仍算读；NORMAL 不受影响（中风险照旧
      // 弹卡）。
      const unknownSideEffects = known.tags.includes(Tags.MCP)
        || (known.tags.includes(Tags.EXTERNAL) && !known.tags.includes(Tags.READ));
      const preview = buildWritePreview(toolCall.function.name, args);
      const ctx: PermissionContext = {
        tool: toolCall.function.name,
        command: typeof args.command === 'string' ? args.command : undefined,
        description: known.description,
        isRead: !isWrite && !unknownSideEffects,
        riskLevel: known.riskLevel ?? 'medium',
        serverName: known.serverName,
        path: preview?.path,
        contentPreview: preview?.contentPreview,
        signal,
      };
      const decision = await this.permissionManager.askUser(ctx);
      if (!decision.allowed) {
        return {
          id: toolCall.id,
          toolName: toolCall.function.name,
          error: `Permission denied${decision.reason ? `: ${decision.reason}` : ''}`,
          success: false,
          duration: 0,
        };
      }
    }

    // discover_tools 是注册表自持的索引工具：搜索与激活都发生在注册表里，
    // 不下沉任何执行器（delegate 适配器的清单里没有它的实现）。放在权限闸
    // 之后——它带 READ/low，所有模式静默放行，不影响写闸语义。
    if (toolCall.function.name === 'discover_tools') {
      return this.executeDiscoverTools(toolCall);
    }

    // presentation_guide 同为注册表自持：表现形式卡的目录与全文渲染都在
    // 注册表完成（卡片本体在 shared/presentationLibrary.ts），不下沉执行器。
    if (toolCall.function.name === 'presentation_guide') {
      return this.executePresentationGuide(toolCall);
    }

    // Route subagent tools to the orchestrator
    if (known.tags.includes(Tags.AGENT) && this.subagentExecutor) {
      return this.subagentExecutor.execute(toolCall, signal);
    }

    // Route MCP tools to the MCP client
    if (known.tags.includes(Tags.MCP) && this.mcpExecutor) {
      return this.mcpExecutor.execute(toolCall, signal);
    }

    // Route external script tools to their adapter
    if (known.tags.includes(Tags.EXTERNAL) && this.externalToolsExecutor) {
      return this.externalToolsExecutor.execute(toolCall, signal);
    }

    return this.delegate.execute(toolCall, signal);
  }

  /** Get full tagged tool definitions (for permission UI). */
  getTaggedTools(): TaggedTool[] {
    return [...this.tools];
  }

  /** Look up a tool's tags. */
  getTags(toolName: string): string[] {
    return this.tools.find(t => t.name === toolName)?.tags ?? [];
  }
}

/**
 * Build a content preview for write tools so the confirmation dialog can show
 * exactly what will be written:
 * - write_file → the full target path + the content that will be written
 * - edit_file  → the target path + a compact `-old / +new` diff snippet
 * Returns undefined for non-write tools (nothing to preview).
 */
const WRITE_FILE_PREVIEW_MAX = 4000;
const EDIT_SNIPPET_MAX = 200;

function clip(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

/**
 * Build a content preview for write tools so the confirmation dialog can show
 * exactly what will be written:
 * - write_file → the full target path + the content that will be written
 *   (capped so a large generated file doesn't flood the dialog)
 * - edit_file  → the target path + a compact `-old / +new` diff snippet
 * - git_commit → the commit scope + the message itself (the reviewable part)
 * Returns undefined for non-write tools (nothing to preview).
 */
export function buildWritePreview(
  toolName: string,
  args: Record<string, unknown>,
): { path?: string; contentPreview?: string } | undefined {
  if (toolName === 'git_commit') {
    const message = typeof args.message === 'string' ? args.message : '';
    const paths = Array.isArray(args.paths) ? args.paths.map(String) : [];
    return {
      // The card must answer "what exactly am I committing": the message is the
      // reviewable intent, the scope line tells all-changes from a subset.
      path: paths.length > 0 ? paths.join(', ') : '(all changes)',
      contentPreview: clip(message, WRITE_FILE_PREVIEW_MAX),
    };
  }
  if (toolName === 'git_branch') {
    return {
      path: typeof args.name === 'string' ? args.name : undefined,
      contentPreview: typeof args.action === 'string' ? args.action : undefined,
    };
  }
  if (toolName !== 'write_file' && toolName !== 'edit_file' && toolName !== 'replace_files') return undefined;
  if (toolName === 'replace_files') {
    const files = Array.isArray(args.files) ? args.files.map(String) : [];
    const oldStr = typeof args.oldString === 'string' ? args.oldString : '';
    const newStr = typeof args.newString === 'string' ? args.newString : '';
    return {
      path: files.length > 0 ? files.join(', ') : undefined,
      contentPreview: `- ${clip(oldStr, EDIT_SNIPPET_MAX)}\n+ ${clip(newStr, EDIT_SNIPPET_MAX)}`,
    };
  }
  const path = typeof args.path === 'string' ? args.path : undefined;
  if (toolName === 'write_file') {
    const content = typeof args.content === 'string' ? args.content : '';
    return { path, contentPreview: clip(content, WRITE_FILE_PREVIEW_MAX) };
  }
  const oldStr = typeof args.oldString === 'string' ? args.oldString : '';
  const newStr = typeof args.newString === 'string' ? args.newString : '';
  return {
    path,
    contentPreview: `- ${clip(oldStr, EDIT_SNIPPET_MAX)}\n+ ${clip(newStr, EDIT_SNIPPET_MAX)}`,
  };
}

