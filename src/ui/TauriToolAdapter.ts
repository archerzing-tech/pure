// src/ui/TauriToolAdapter.ts
// v0.2 — ToolAdapter implementation that uses Tauri IPC invoke() for tool execution.
// For Vite dev (no Tauri runtime), falls back to returning no available tools.
// Built-in schemas stay shared with the CLI; researcher tools wrap the Rust web/file primitives while legacy names remain execution-compatible but hidden from new model tool lists.

import type { ToolAdapter, ToolCall, ToolResult, ToolDefinition, GeneratedImage } from '../shared/types';
import type { Channel } from '@tauri-apps/api/core';
import { BUILT_IN_TOOL_DEFS, TOOL_METADATA, isPublicToolName } from '../shared/toolDefs';
import { DYNAMIC_CAPABILITY_TOOL_DEFS, isDynamicCapabilityTool, type DynamicCapabilityHooks } from '../shared/dynamicCapabilityTools';
import { mcpRegistrySearchUrl, parseMcpRegistryPayload, communityMcpCandidates, type McpCandidate } from '../shared/mcpRegistry';
import { fetchSkillBody, searchHubSkills, splitSkillMarkdown, sanitizeSkillName, normalizeHubRepo } from './skillHub';
import { filterResearchSources, isOfficialDocumentationSource, makeResearchPayload, parseWebSearchText, type ResearchSource } from '../shared/research';
export { filterResearchSources } from '../shared/research';
import { formatBytes, formatCommandError, safeParseArgs } from '../shared/format';
import { buildBackgroundLaunchPlan, buildBackgroundResult, parseBackgroundPid } from '../shared/backgroundCommand';
import { blockedHostMessage, detectHijack, hijackReason, hostBlocked, isNetworkError, netFailureHint, recordNetFailure, recordNetSuccess } from '../shared/netGuard';
import { primaryRewrite } from '../shared/sourceRewrite';
import { netRouteProxyPair, netRouteSurfacePair, recordNetOutcome, recordNetSurfaceOutcome, type NetRoutePair } from '../shared/netRoute';
// 换源工具的 GUI 侧接线。mirrorSources 是纯数据 + 纯函数，没有 node:* 依赖，
// 是这条链上唯一能安全进 WebView 包的共享模块（sourceSwitcher 不行，见下）。
import {
  AUTO_TRUST_TIERS,
  MIRROR_SOURCES,
  candidatesFor,
  fileScopeAllowed,
  type Ecosystem,
  type TrustTier,
} from '../shared/mirrorSources';
import { generateDocument, toBase64 } from '../shared/docGen';

/** curl/wget exit codes that mean "network-level failure" (resolve/connect/
 *  timeout/SSL/send/recv) — these trip the host breaker; disk-full (e.g. 13)
 *  does not, because the host is not the problem. */
const NET_DOWNLOAD_EXIT_CODES = new Set([4, 6, 7, 28, 35, 47, 55, 56]);
import type { WorkspaceRestoreResult, WorkspaceSnapshotBatch, WorkspaceSnapshotEntry, WorkspaceSnapshotPort } from '../shared/workspaceSnapshot';
import { BROWSER_UA } from '../shared/platformUa';

// ── Tool definitions (single source of truth: shared/toolDefs.ts) ──

const TOOL_DEFINITIONS: ToolDefinition[] = [...BUILT_IN_TOOL_DEFS, ...DYNAMIC_CAPABILITY_TOOL_DEFS];

/** Web-only subset of TOOL_DEFINITIONS — exported so chat.ts can pin this
 * exact list as the LLM-visible toolsDef in plain-chat mode without
 * duplicating the schema. Order is stable (matches declaration order). */
export function getWebToolDefs(): ToolDefinition[] {
  return TOOL_DEFINITIONS.filter((t) => t.name === 'researcher_web' || t.name === 'researcher_docs');
}

/** sys_info tool def — workspace-independent (the Rust backend ignores the
 * workspace field), so plain-chat mode can always advertise it regardless of
 * the browser-tool toggle. */
export function getSysInfoToolDefs(): ToolDefinition[] {
  return TOOL_DEFINITIONS.filter((t) => t.name === 'sys_info');
}


export type InvokeFunction = (cmd: string, args?: Record<string, unknown>) => Promise<unknown>;

// Single-quote escaping for the two shells the Rust execute_command backend
// uses (`sh -c` on Unix, PowerShell on Windows): inside single quotes every
// byte is literal except the quote itself — written as '\'' for sh, '' for
// PowerShell. Used by the git_commit/git_branch cases, whose commit messages
// and branch names are arbitrary model-supplied text. Exported for other UI
// callers that rebuild execute_command strings outside the adapter (the 4.1
// auto-worktree resolver in workspace.ts runs plain git the same way).
export function isWindowsHost(): boolean {
  return typeof navigator !== 'undefined' && /Windows/i.test(navigator.userAgent);
}

export function quoteShellArg(value: string): string {
  const escaped = isWindowsHost() ? value.replace(/'/g, "''") : value.replace(/'/g, `'\\''`);
  return `'${escaped}'`;
}

// ── Static Tauri invoke loader ──
// Loads once at module level so adapters don't need async init per-constructor.

let tauriInvoke: InvokeFunction | null = null;
let tauriChannel: typeof Channel | null = null;

async function initTauriInvoke() {
  try {
    const mod = await import('@tauri-apps/api/core');
    if (typeof mod.invoke === 'function') {
      tauriInvoke = mod.invoke as InvokeFunction;
      tauriChannel = (mod as { Channel?: typeof Channel }).Channel ?? null;
    }
  } catch {
    // No Tauri runtime — tools will be unavailable
  }
}
initTauriInvoke();


// ── Live tool output listener ──
// The Rust backend's execute_command_stream pushes stdout/stderr lines over a
// Channel as the command runs (instead of buffering everything until exit).
// chat.ts registers a listener here so each line lands in the matching tool
// row's Output panel in real time — a long-running command shows progress
// instead of a silent wait. Keyed by the LLM tool call id, the same id the
// engine uses for the id-bearing TokenDelta and the ToolResult event.

export type ToolOutputKind = 'stdout' | 'stderr';
// `progress` marks a lone-`\r` in-place redraw (pip/npm/bun progress bars): the
// GUI redraws its last progress line instead of appending another row.
export type ToolOutputListener = (toolCallId: string, kind: ToolOutputKind, line: string, progress?: boolean) => void;

// Fan-out registry: several SESSIONS can run commands concurrently (a hidden
// session streams in the background while the visible one runs its own tool),
// so a single listener slot would let one session's cleanup mute another's.
// Each send() registers its own listener and unregisters it on completion.
const toolOutputListeners = new Set<ToolOutputListener>();

export function registerToolOutputListener(fn: ToolOutputListener): () => void {
  toolOutputListeners.add(fn);
  return () => toolOutputListeners.delete(fn);
}

/** Dispatch one streamed command line to every registered session listener. */
export function dispatchToolOutput(toolCallId: string, kind: ToolOutputKind, line: string, progress?: boolean): void {
  for (const fn of toolOutputListeners) fn(toolCallId, kind, line, progress);
}

/** One message from the Rust execute_command_stream Channel. */
export type CommandStreamChunk =
  | { type: 'stdout' | 'stderr'; line: string; progress: boolean }
  | { type: 'exit'; code: number }
  | null;

/** Parse one Channel message; malformed JSON or unknown shapes return null. */
export function parseCommandStreamChunk(raw: string): CommandStreamChunk {
  let parsed: { type?: string; content?: unknown; code?: unknown; progress?: unknown } | null = null;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed) return null;
  if (parsed.type === 'stdout' || parsed.type === 'stderr') {
    return { type: parsed.type, line: String(parsed.content ?? ''), progress: parsed.progress === true };
  }
  if (parsed.type === 'exit') {
    return { type: 'exit', code: typeof parsed.code === 'number' ? parsed.code : -1 };
  }
  return null;
}

// ── Download progress side channel ──
// download_file reuses execute_command_stream on the native shell; the download
// wrapper prints machine-readable JSON progress lines that chat.ts renders as a
// live progress bar. Keyed by tool call id, matching the engine's ToolResult.

export interface DownloadProgressEvent {
  downloaded: number;
  total: number;
  percent: number;
  speed: number;
  state: 'downloading' | 'paused' | 'done' | 'error' | 'hidden';
  filename?: string;
  path?: string;
  via?: string;
}

export type DownloadProgressListener = (toolCallId: string, p: DownloadProgressEvent) => void;

const downloadProgressListeners = new Set<DownloadProgressListener>();

export function registerDownloadProgressListener(fn: DownloadProgressListener): () => void {
  downloadProgressListeners.add(fn);
  return () => downloadProgressListeners.delete(fn);
}

/** Dispatch one download progress event to every registered session listener. */
export function dispatchDownloadProgress(toolCallId: string, p: DownloadProgressEvent): void {
  for (const fn of downloadProgressListeners) fn(toolCallId, p);
}

/** Pause/cancel a running download: the Rust backend SIGKILLs the command's
 * process group. The partial file is kept, so a re-run with resume:true
 * continues from where it stopped (curl -C - / aria2c -c). */
export function cancelDownload(id: string): Promise<void> {
  const invoke = tauriInvoke ?? null;
  if (!invoke) return Promise.resolve();
  return invoke('kill_command', { id }).then(
    () => undefined,
    () => undefined,
  );
}

// ── download_file helpers ──
// The download runs as a native shell command via execute_command_stream. A small
// POSIX wrapper resolves the destination ($HOME / $PWD available on the Rust side),
// picks aria2c (parallel + resume) or curl (resume via -C -), and prints
// machine-readable JSON progress lines on stdout that the channel forwards to the
// UI. Total size comes from a HEAD; speed is derived by the UI from deltas.

function shellQuote(s: string): string {
  return "'" + s.replace(/'/g, "'\\''") + "'";
}

/** Map the tool's destination arg to a shell-expandable directory expression.
 * User input is sanitized so it can't inject shell metacharacters.
 * 两条下载链（native download_file_stream / shell wrapper）都把返回值当「目录」
 * 拼 `<dir>/<filename>`，所以这里必须永远吐目录：
 *  - 最后一段带扩展名 = 模型把文件路径当 destination 传了 → 取父目录（裸
 *    文件名 → 默认下载目录），否则文件名会被当目录再嵌一层；
 *  - `~/…` 是模型写「下载文件夹」最自然的形状，`~` 不在消毒白名单里，老
 *    逻辑会把它替换成 `_` 拼出 `$HOME/Downloads/_/…` 嵌套垃圾目录——文件
 *    落进用户找不到的地方（2026-10-09 真机「打开所在文件夹路径是错的」排查所及）。 */
export function resolveDownloadOutSpec(destination: string): string {
  const raw = destination.trim();
  if (/\.[A-Za-z0-9]+$/.test(raw)) {
    if (/[\\/]/.test(raw)) return resolveDownloadOutSpec(raw.replace(/[\\/][^\\/]+$/, ''));
    return '$HOME/Downloads';
  }
  if (raw.startsWith('~')) {
    const rest = raw.slice(1).replace(/[^A-Za-z0-9_.\-\/]/g, '_');
    return '$HOME' + rest;
  }
  if (raw.startsWith('/')) {
    return raw.replace(/[^A-Za-z0-9_.\-\/]/g, '_');
  }
  if (raw === 'workspace') return '$PWD';
  if (raw && raw !== 'downloads') {
    const safe = raw.replace(/[^A-Za-z0-9_.\-\/]/g, '_');
    return `$HOME/Downloads/${safe}`;
  }
  return '$HOME/Downloads';
}

export function buildDownloadCommand(url: string, outSpec: string, connections: number, filenameArg: string, resume: boolean): string {
  const u = shellQuote(url);
  const name = shellQuote(filenameArg);
  const conns = Math.max(1, Math.min(16, connections | 0));
  const resumeFlag = resume ? '-C - ' : '';
  const lines: string[] = [];
  lines.push('url=' + u);
  // Same-origin Referer — many CDNs / hotlink-protected hosts reject clients
  // that don't send one, a common "download fails silently" cause.
  lines.push('origin=$(printf "%s" "$url" | sed \'s#\\([a-z][a-z]*://[^/]*\\).*#\\1#\')');
  // outSpec 以单引号字面量交给 eval 二次解析：`$HOME`/`$PWD` 由 shell 展开，
  // 绝对路径原样通过。老写法 `"${<outSpec>}"` 拼出 `${$HOME/Downloads}` 这
  // 种 bad substitution——outdir 恒为空，整条 shell 链从未落成过一个文件。
  lines.push('outdir=$(eval echo ' + shellQuote(outSpec) + ')');
  lines.push('mkdir -p "$outdir"');
  lines.push('UA=' + shellQuote(BROWSER_UA));
  // File name: explicit arg → server Content-Disposition (one extra HEAD) →
  // URL basename → 'download'.
  lines.push('if [ -n ' + name + ' ]; then fname=' + name + '; else fname=$(curl -sI "$url" | tr -d \'\\r\' | awk -F\'filename=\' \'tolower($0) ~ /^content-disposition:/{split($2,a,";"); gsub(/[" ]/,"",a[1]); print a[1]}\'); [ -z "$fname" ] && fname=$(basename "$url" | sed \'s/[?].*//\'); [ -z "$fname" ] && fname=download; fi');
  lines.push('fpath="$outdir/$fname"');
  lines.push('total=$(curl -sI "$url" | tr -d \'\\r\' | awk \'{l=tolower($0)} l ~ /^content-length:/{c=$2} END{print c+0}\')');
  lines.push('if command -v aria2c >/dev/null 2>&1; then DL="aria2c -x ' + conns + ' -s ' + conns + ' -k 1M -c --max-tries=5 --timeout=30 --retry-wait=3 --header=\\"Referer: $origin\\" --user-agent=\\"$UA\\" -d \\"$outdir\\" -o \\"$fname\\" \\"$url\\""; VIA=aria2c; else if command -v wget >/dev/null 2>&1; then DL="wget -c -q --tries=5 --timeout=30 --header=\\"Referer: $origin\\" --user-agent=\\"$UA\\" -O \\"$fpath\\" \\"$url\\""; VIA=wget; else DL="curl -L ' + resumeFlag + '--retry 3 --retry-delay 2 -H \\"Referer: $origin\\" -A \\"$UA\\" -o \\"$fpath\\" \\"$url\\""; VIA=curl; fi; fi');
  lines.push('( eval "$DL" >/dev/null 2>&1 & PID=$!; while kill -0 $PID 2>/dev/null; do sz=$( (stat -f%z "$fpath" 2>/dev/null) || (stat -c%s "$fpath" 2>/dev/null) || echo 0 ); echo "{\\"type\\":\\"dl\\",\\"downloaded\\":$sz,\\"total\\":${total:-0},\\"filename\\":\\"$fname\\",\\"via\\":\\"$VIA\\"}"; sleep 0.3; done; wait $PID; code=$?; fsz=$( (stat -f%z "$fpath" 2>/dev/null) || (stat -c%s "$fpath" 2>/dev/null) || echo 0 ); echo "{\\"type\\":\\"done\\",\\"code\\":$code,\\"path\\":\\"$fpath\\",\\"filename\\":\\"$fname\\",\\"size\\":$fsz,\\"via\\":\\"$VIA\\"}" )');
  return lines.join('; ');
}

function parseDownloadDone(stdout: string): { code: number; path?: string; size?: number; filename?: string; via?: string } | null {
  for (const line of stdout.split('\n')) {
    const t = line.trim();
    if (!t.startsWith('{"type":"done"')) continue;
    try {
      const o = JSON.parse(t);
      if (o && o.type === 'done') return o;
    } catch {
      /* ignore */
    }
  }
  return null;
}

// ── Generated-image side channel ──
// generate_image's ToolResult.result carries ONLY compact metadata (the engine
// JSON-serializes it back into the LLM's tool message, so base64 image payloads
// must never ride there). The full data URLs are cached here by toolCallId and
// claimed by chat.ts when the ToolResult event arrives (takeGeneratedImages),
// then rendered as <img> cards and persisted for session replay.

const MAX_GENERATED_IMAGE_CACHE = 200;
const generatedImageCache = new Map<string, GeneratedImage[]>();

/** Claim (and remove) the generated images for a tool call id. Returns
 * undefined when nothing was cached — e.g. a non-image tool or an aborted call.
 * Bounded: the Map only ever holds in-flight tool calls plus a small tail. */
export function takeGeneratedImages(toolCallId: string): GeneratedImage[] | undefined {
  const images = generatedImageCache.get(toolCallId);
  generatedImageCache.delete(toolCallId);
  return images;
}

function cacheGeneratedImages(toolCallId: string, images: GeneratedImage[]): void {
  if (images.length === 0) return;
  generatedImageCache.set(toolCallId, images);
  while (generatedImageCache.size > MAX_GENERATED_IMAGE_CACHE) {
    const oldest = generatedImageCache.keys().next().value;
    if (oldest === undefined) break;
    generatedImageCache.delete(oldest);
  }
}

import {
  ProbeGuardError,
  checkProbeTarget,
  diagnoseNetwork,
  httpStepFromClassified,
  isReservedIPv4,
  renderProbeReport,
  renderProbeReportForHuman,
  type NetVerdict,
  type ProbeStepResult,
} from '../shared/netProbeCore';

// ── diagnose_network 的 GUI 侧接线 ─────────────────────────────────────────
//
// 判定核心（护栏 / DoH 判定 / 归因合并 / 置信度 / 报告渲染）直接用
// shared/netProbeCore.ts，与 CLI 同源；本文件只提供 WebView 拿得到的那两个
// 原语：DoH（WebView fetch）与 HTTP（Rust 的 web_fetch_probe，它有代理与
// 劫持判定）。TCP / TLS 两步在浏览器里**真的做不了**（没有套接字、不给读对端
// 证书），如实标 skipped 并自陈，置信度由核心统一降档。
//
// 为什么核心与 node 适配层要分开：shared/node/netProbe.ts 在模块作用域
// import node:net / node:tls，Vite 会把 node:* 变成 __vite-browser-external
// 空壳，rollup 在**解析期**就报 "connect is not exported"，整个 WebView 构建
// 失败（不是运行期降级，已用最小 vite 工程复现）。所以拨号原语住在
// src/shared/node/（路径本身说明「仅 node 宿主」），GUI 永远只碰 core。
//
// 被放弃的方案：让 core 动态 import('node:net') —— Vite 仍会把同样的 external
// 桩打进 chunk，解析期报错不变。

/** 换源测速的单请求预算；并发跑完所有候选，最坏也只花这一个数。 */
const GUI_BENCH_TIMEOUT_MS = 8_000;

/** 测速路径与拼接规则在 shared/mirrorSources（纯函数，CLI 同一份）。 */
import { benchmarkUrlFor } from '../shared/mirrorSources';
export { benchmarkUrlFor };

/** DoH 端点：WebView 里少了裸 IP 那家（1.12.12.12 的证书在浏览器侧校验不
 *  过），其余三家与 core 同一张表——「四家并行、任意一家成功即可」的判据不变，
 * 少一家只是少摊一份概率性阻断。 */
const GUI_DOH_ENDPOINTS: readonly string[] = [
  'https://dns.alidns.com/resolve',
  'https://doh.pub/resolve',
  'https://dns.google/resolve',
];

/** 护栏直接用 core 的 checkProbeTarget：护栏不一致 = GUI 上留了一个能扫内网
 * 的工具（业界已有 network-mcp 因此被当扫描器用的教训），不能因为宿主不同就
 * 各写一份。 */
export const checkGuiProbeTarget = checkProbeTarget;

/** RFC1918 + 回环 + 链路本地 + CGNAT 的判定同样只有一份（DoH 污染判定用）。 */
export const isReservedProbeIp = isReservedIPv4;

/**
 * 把一次 Rust web_fetch_probe 的结果翻译成 HTTP 层**步骤读数**。
 *
 * 归因（哪一层失败、结论是什么）由 netProbeCore 统一合并，这里只回答一件事：
 * 这一步自己读到了什么。`verdict` 是这一步的读数（step-level），不是整份报告
 * 的结论——报告的 verdict 由 core 从四步合成。
 *
 * 关键在于**区分「链路断了」与「链路通了但被拒」**：403 证明 TLS 握手成功 +
 * 请求往返完成（网络层完全正常），把它算成网络失败会让模型去换镜像，而镜像
 * 同样会 403——方向就整个反了。
 */
export function classifyGuiHttpProbe(outcome: {
  ok: boolean;
  error?: string;
  hijackSignal?: string | null;
}): { status: 'pass' | 'fail'; verdict: NetVerdict; summary: string } {
  if (outcome.hijackSignal) {
    return {
      status: 'fail',
      verdict: 'http-fail',
      summary: `应答被判定为劫持/挡板页（${outcome.hijackSignal}）——链路本身是通的，问题在链路中间设备，不在目标站`,
    };
  }
  if (outcome.ok) {
    return { status: 'pass', verdict: 'reachable', summary: '目标站点给出了正常应答（HTTP 层可达）' };
  }
  const msg = outcome.error ?? '未知错误';
  // 403 / 401 / 429 仍属「链路通」：只说明业务层拒绝，换源无济于事。
  if (/\b(401|403|407|429)\b/.test(msg)) {
    return { status: 'fail', verdict: 'http-fail', summary: `HTTP ${msg}——链路是通的（TLS 握手完成、请求往返完成），被业务层/风控拒绝；换镜像无济于事，应换凭据或换用户` };
  }
  if (/\b5\d\d\b/.test(msg)) {
    return { status: 'fail', verdict: 'http-fail', summary: `HTTP ${msg}——服务端 5xx：源侧问题，不是本机网络问题` };
  }
  if (isNetworkError(msg)) {
    return { status: 'fail', verdict: 'inconclusive', summary: `请求失败：${msg}。本宿主无法判定卡在哪一层（TCP/TLS 步已跳过），只能确认 HTTP 层没拿到应答` };
  }
  return { status: 'fail', verdict: 'http-fail', summary: `HTTP 层失败：${msg}` };
}

export interface ImageGenContext {
  /** Provider id (used for proxy-bypass matching). */
  provider: string;
  /** The provider's text-to-image model id (e.g. 'gpt-image-1'). */
  model: string;
  /** Base URL of the OpenAI-compatible endpoint (images API lives under it). */
  baseURL: string;
  /** Rust secrets key for the provider's API key (custom: 'llm.apiKey.<id>'). */
  secretKey?: string;
  /** LLM-scoped proxy URL; generate_image hits the provider's image API. */
  proxyUrl?: string;
  proxyBypassProviders?: string[];
}

export class TauriToolAdapter implements ToolAdapter {
  private workspace: string;
  private tavilyApiKey: string;
  private serperApiKey: string;
  private searxngUrl: string;
  private location: string;
  private proxyUrl: string;
  private sessionId: string;
  private invokeFn: InvokeFunction | null;
  private latestWriteBatch: WorkspaceSnapshotBatch | null = null;
  private snapshotSequence = 0;
  private readonly maxSnapshotBytes = 8 * 1024 * 1024;
  private readonly imageGen?: ImageGenContext;
  private readonly capabilityHooks?: DynamicCapabilityHooks;
  /** Pass `sandbox: true` to shell-command invocations so the Rust backend
   * wraps them in the macOS Seatbelt profile (workspace-confined writes,
   * outbound-only network) when available. Default OFF (config v16,
   * 2026-09-21): auto-approve + kernel write confinement contradicted each
   * other — venv installs into the user home died with EPERM. Explicit
   * opt-in via the config flag only. */
  private readonly sandbox: boolean;
  private readonly mcpCandidates = new Map<string, McpCandidate>();

  constructor(workspace: string, tavilyApiKey = '', serperApiKey = '', location = '', invoke?: InvokeFunction, sessionId = '', proxyUrl = '', imageGen?: ImageGenContext, searxngUrl = '', capabilityHooks?: DynamicCapabilityHooks, sandbox = false) {
    this.workspace = workspace;
    this.tavilyApiKey = tavilyApiKey;
    this.serperApiKey = serperApiKey;
    this.searxngUrl = searxngUrl;
    this.location = location;
    this.proxyUrl = proxyUrl;
    this.invokeFn = invoke ?? null;
    this.sessionId = sessionId;
    this.imageGen = imageGen;
    this.capabilityHooks = capabilityHooks;
    this.sandbox = sandbox;
  }

  private call(command: string, args?: Record<string, unknown>): Promise<unknown> {
    const invoke = this.invokeFn ?? tauriInvoke;
    if (!invoke) return Promise.reject(new Error('Tauri runtime not available — tools disabled'));
    return invoke(command, args);
  }

  /**
   * execute_command / git_* 传给 Rust 的 proxyUrl 会变成子进程的
   * HTTP(S)_PROXY 环境变量，作用于子进程会访问的**任意**主机——没有单一目标
   * 可分类，所以走 command 出口面决策。这个面不提供反向兜底：把同一条命令
   * 换条路重跑是有害的（`git push`、`npm publish`、`rm`），所以一旦押错，
   * 只能靠真失败后的学习翻面，而不是悄悄重跑。
   */
  private shellProxy(): string {
    return netRouteSurfacePair('command', this.proxyUrl).proxyUrl;
  }

  /**
   * diagnose_network 的 GUI 实现：判定完全委托 shared/netProbeCore，这里只
   * 注入 WebView 拿得到的两个原语（DoH 走 WebView fetch，HTTP 走 Rust 的
   * web_fetch_probe），TCP / TLS 如实 skipped。
   *
   * HTTP 层走 Rust 而不是 WebView fetch：后者受 CORS 限制且不认应用代理配置，
   * 而「用户配了代理」正是这个工具最常被调用的场景。
   */
  private async runGuiNetworkProbe(
    toolId: string,
    toolName: string,
    start: number,
    target: string,
    humanReadable: boolean,
  ): Promise<ToolResult> {
    const tcpNote = 'TCP：本宿主（GUI/WebView）没有套接字原语，无法区分 SYN 被丢弃与端口被拒';
    const tlsNote = 'TLS：本宿主无法读取对端证书，无法校验证书与域名是否匹配';
    try {
      const report = await diagnoseNetwork(target, {
        dohEndpoints: GUI_DOH_ENDPOINTS,
        unavailableNotes: {
          dns: 'DNS/DoH：WebView 没有可用的 fetch 原语（CORS 会掐掉 DoH 端点）',
          tcp: tcpNote,
          tls: tlsNote,
        },
        deps: {
          fetchImpl: typeof fetch === 'function' ? fetch : null,
          // 显式 null = 本宿主没有该原语（能力自陈要看这个区别）。
          tcpProbe: null,
          tlsProbe: null,
          // 单次尝试，不走 runRouted 的反向兜底：诊断要回答的是「**当前这条
          // 路径**通不通」，自动换一条路重跑会把故障证据洗掉。
          httpProbe: async (url): Promise<ProbeStepResult> => {
            let outcome: { ok: boolean; error?: string; hijackSignal?: string | null };
            try {
              const payload = await this.call('web_fetch_probe', {
                workspace: this.workspace,
                url,
                maxChars: 2000,
                proxyUrl: this.proxyUrl || null,
              }) as { statusOk?: boolean; hijackSignal?: string | null };
              outcome = { ok: payload?.statusOk === true, hijackSignal: payload?.hijackSignal ?? null };
            } catch (err) {
              outcome = { ok: false, error: err instanceof Error ? err.message : String(err) };
            }
            const step = classifyGuiHttpProbe(outcome);
            if (step.status === 'pass') {
              return { step: 'http', status: 'pass', ms: 0, summary: step.summary };
            }
            // inconclusive = 宿主无法定位成因：交回 core，它会如实报
            // inconclusive 而不是硬凑一个「HTTP 层失败」的结论。
            if (step.verdict === 'inconclusive') {
              return { step: 'http', status: 'fail', ms: 0, summary: step.summary };
            }
            return httpStepFromClassified(step.summary, step.verdict, [
              outcome.hijackSignal
                ? '这是链路中间设备改写应答，不是目标站的问题；换镜像无效，应检查本机网络出口（代理 / DNS / 运营商）。'
                : '先区分「源侧问题」与「本机网络问题」：换一个已知可达的源对照测试最快。',
            ]);
          },
        },
      });
      const text = humanReadable ? renderProbeReportForHuman(report) : renderProbeReport(report);
      // 不可达不是「工具坏了」：success:true 让模型读到归因，而不是把它当成
      // 需要重试的执行错误（与 CLI 侧同一处理）。
      return { id: toolId, toolName, result: text, success: true, duration: Date.now() - start };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (err instanceof ProbeGuardError || /拒绝|不在允许名单/.test(msg)) {
        return { id: toolId, toolName, error: `diagnose_network: ${msg}`, success: false, duration: Date.now() - start };
      }
      return { id: toolId, toolName, error: `diagnose_network: ${msg}`, success: false, duration: Date.now() - start };
    }
  }

  /**
   * switch_package_source 的 GUI 实现。
   *
   * 边界与 CLI 侧完全一致：默认 session 档（纯计算，零落盘零 spawn），
   * file 档必须 confirm:true 且非 dry-run。
   *
   * file 档为什么在这里降级为「去 CLI 执行」：GUI 侧写文件要走 Rust 的
   * write_file，而它的入参是 (workspace, path) 且受 path_policy 约束；
   * ~/.npmrc 这类**用户主目录之外**的路径虽然允许绝对路径，但那样等于让
   * 模型经由 write_file 改写任意外部文件——而 sourceSwitcher 的 journal
   * 契约（写前读旧值 → 记 journal → 才写）依赖 node:fs 的原子追加，WebView
   * 里没有等价原语。所以这里**不假装成功**，而是给出确切的 CLI 命令。
   */
  private async runGuiSwitchSource(
    toolId: string,
    toolName: string,
    start: number,
    args: Record<string, unknown>,
  ): Promise<ToolResult> {
    const ecosystemRaw = String(args.ecosystem ?? '').trim();
    const ecosystem = ecosystemRaw as Ecosystem;
    if (!(ecosystemRaw in MIRROR_SOURCES)) {
      return {
        id: toolId, toolName, success: false, duration: Date.now() - start,
        error: `switch_package_source: 未知生态：${ecosystemRaw || '（空）'}。可用：${Object.keys(MIRROR_SOURCES).join(', ')}`,
      };
    }
    const tiers = Array.isArray(args.enabledTrustTiers)
      ? (args.enabledTrustTiers.map(String).filter((t): t is TrustTier => t === 't0' || t === 't1' || t === 't2' || t === 't3'))
      : undefined;
    const enabledTiers = tiers ?? AUTO_TRUST_TIERS;
    const scope = args.scope === 'file' ? 'file' : 'session';
    const mirrors = MIRROR_SOURCES[ecosystem];
    const requested = String(args.source ?? 'auto').trim();

    // ── 选源 ──
    const candidates = candidatesFor(ecosystem, { enabledTiers });
    let selected = candidates[0];
    let fromInventory = true;
    const warnings: string[] = [];
    let benchmarkLines: string[] = [];
    if (requested === 'auto') {
      // source:'auto' 是**默认档**，不能跳过测速直接取首选项——那等于让 GUI
      // 用户永远拿到「清单里排第一」而不是「当前真的最快的那个」，而 CLI
      // 用户拿到的是测速结果。同一份清单在两端给出不同答案，比不做还糟。
      // 并发跑（不是串行）：串行 8s×N 意味着用户干等 40s。
      const results = await Promise.all(candidates.map(async (c) => {
        const url = benchmarkUrlFor(ecosystem, c.url);
        const started = Date.now();
        try {
          const payload = await this.call('fetch_url_text', {
            url,
            accept: '*/*',
            proxyUrl: netRouteProxyPair(url, this.proxyUrl).proxyUrl || null,
            timeoutSecs: Math.ceil(GUI_BENCH_TIMEOUT_MS / 1000),
          }) as string;
          return `${c.url}\tOK  \t${Date.now() - started}ms\t${String(payload).slice(0, 40).replace(/\s+/g, ' ')}`;
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          // 「拿到了任何状态码」即证明链路通：401/403 说明 TLS 握手成功 +
          // 往返完成，正是最该换源的场景，绝不能算失败。
          const status = /\b([45]\d\d)\b/.exec(msg)?.[1];
          const reachable = Boolean(status) && Number(status) < 500;
          return `${c.url}\t${reachable ? 'OK  ' : 'FAIL'}\t${Date.now() - started}ms\t${reachable ? `HTTP ${status}` : msg.slice(0, 60)}`;
        }
      }));
      // 有有效响应的按延迟升序，没有的排后面——判据与 sourceSwitcher.pickBest
      // 一致（先看「有没有回答」，再比「多快」），否则死源会因为回得快而胜出。
      const ranked = [...results].sort((a, b) => {
        const okA = a.includes('\tOK  ') ? 0 : 1;
        const okB = b.includes('\tOK  ') ? 0 : 1;
        return okA !== okB ? okA - okB : Number(/\t(\d+)ms/.exec(a)?.[1] ?? 1e9) - Number(/\t(\d+)ms/.exec(b)?.[1] ?? 1e9);
      });
      benchmarkLines = ranked;
      const best = ranked.find((r) => r.includes('\tOK  '));
      if (best) {
        const bestUrl = best.split('\t')[0];
        selected = candidates.find((c) => c.url === bestUrl) ?? selected;
      } else {
        warnings.push(`所有候选源测速均未拿到有效响应，回落为生态默认首选 ${selected.url}——请用 diagnose_network 确认是本机网络问题还是源侧问题`);
      }
    } else if (requested && requested !== 'default') {
      const inList = candidates.find((c) => c.url === requested);
      if (inList) {
        selected = inList;
      } else if (requested === candidates[0]?.url) {
        selected = candidates[0];
      } else {
        // 手工 URL 不在**已授权候选集**内：允许，但必须显式说明信任层级未知。
        const looksLikeUrl = /^https?:\/\//.test(requested) || /^sparse\+https?:\/\//.test(requested);
        if (!looksLikeUrl) {
          return {
            id: toolId, toolName, success: false, duration: Date.now() - start,
            error: `switch_package_source: source 必须是合法 URL（收到：${requested}）`,
          };
        }
        // 用户显式点名某个 URL **本身就是这一次的显式选择**，所以 session 档
        // 放行（进程退出即消失，可回退性最高）；file 档要落盘、会长期影响该
        // 用户所有项目，仍需设置里开启 t3。
        if (scope === 'file') {
          return {
            id: toolId, toolName, success: false, duration: Date.now() - start,
            error: 'switch_package_source: file 级写入不接受清单外的自配源：请先显式开启 T3 信任分层，或改用 session 档（不落盘、进程退出即消失）。',
          };
        }
        selected = { url: requested, trust: 't3', notes: '用户手工指定，不在受信任清单内；未做来源核验' };
        // 「在清单内」与「在已授权候选集内」是两件事：T2 源在清单里，但默认
        // 被 AUTO_TRUST_TIERS 过滤掉，于是它落到这条分支并被降级成 t3 自配。
        // 判据必须与 sourceSwitcher 同义（按 URL 查全量清单），否则会出现
        // 「GUI 拒了、CLI 放行」这种两端不一致。
        fromInventory = MIRROR_SOURCES[ecosystem].sources.some((s) => s.url === requested);
        warnings.push(fromInventory
          ? '该源在清单内但其信任分层未获授权，按 T3 用户自配处理：未核验运营方，内容可被任意替换'
          : '该源不在受信任清单内，按 T3 用户自配处理：未核验运营方，内容可被任意替换');
      }
    }
    if (!selected) {
      return { id: toolId, toolName, success: false, duration: Date.now() - start, error: 'switch_package_source: 没有可用候选源' };
    }
    // 只对**清单内**的源卡信任分层闸门：清单外的自配 URL 已在上一步按 scope
    // 分别处理过了，这里再拦一次就是把 session 档也堵死，与 CLI 侧不一致。
    if (fromInventory && (selected.trust === 't2' || selected.trust === 't3') && !enabledTiers.includes(selected.trust)) {
      return {
        id: toolId, toolName, success: false, duration: Date.now() - start,
        error: `switch_package_source: 该源属 ${selected.trust} 信任分层（第三方公益代理 / 用户自配），默认关闭。请在设置里显式开启后再试；开启后下载二进制仍必须校验 sha256。`,
      };
    }
    if (selected.trust === 't2' || selected.trust === 't3') {
      warnings.push(`${selected.trust} 源已由你显式指定：无 SLA、响应体可被任意替换。下载任何二进制后必须校验 sha256。`);
    }

    // ── 生态级陷阱（与 CLI 侧逐字对齐，避免同一模型在两端学到不同的坑）──
    if (ecosystem === 'npm') {
      warnings.push('npm lockfile 陷阱：package-lock.json 里每个包固化了 resolved 完整 URL。换源前生成的 lockfile 会让 npm ci 继续走老 URL——必须重新生成 lockfile，或用 npm install --registry=<url> 单次指定。');
    }
    if (ecosystem === 'pip') {
      warnings.push('影响该用户的所有 Python 项目（不只是当前目录）；绝不要改用 extra-index-url，pip 官方明确警告它会引入依赖混淆。');
    }
    if (ecosystem === 'go') {
      warnings.push('GOPROXY 已补 ,direct 回退：代理全挂时回落到 VCS 直连（慢但不会彻底失败）。');
    }
    const hasEnvSwitch = mirrors.sessionEnvKeys.length > 0;
    if (!hasEnvSwitch) {
      warnings.push(`${mirrors.displayName} 没有环境变量换法：已改为给出命令/配置建议，不做任何注入`);
    }
    if (ecosystem === 'docker' && mirrors.fileScopeBlockedReason) warnings.push(mirrors.fileScopeBlockedReason);

    const envLines = hasEnvSwitch
      ? mirrors.sessionEnvKeys.map((key) => {
          const value = key === 'npm_config_registry' ? selected!.url
            : key === 'GOPROXY' ? (selected!.url.includes(',') ? selected!.url : `${selected!.url},direct`)
              : key === 'CARGO_REGISTRIES_CRATES_IO_INDEX' ? (selected!.url.startsWith('sparse+') ? selected!.url : `sparse+${selected!.url}`)
                : selected!.url;
          return `  ${key}=${value}`;
        })
      : ['  （无）'];

    const summary: string[] = [];
    summary.push(`${mirrors.displayName} → ${selected.url}（信任分层 ${selected.trust}${selected.operator ? ` · ${selected.operator}` : ''}）`);

    if (scope === 'session') {
      if (hasEnvSwitch) {
        summary.push(
          '会话级换源（不落盘、未写入任何文件、未 spawn 任何命令）：',
          ...envLines,
          '要生效，请把这些变量注入子进程（进程退出即失效）。',
          '未写入任何文件；未 spawn 任何命令。',
        );
      } else {
        // 没有环境变量换法的生态（docker / maven / github）：说清「什么都没改」，
        // 而不是列一个空的「注入以下变量」——那会让模型以为注入成功过。
        summary.push(
          `会话级换源：${mirrors.displayName} → ${selected.url}。该生态没有环境变量换法，未做任何改动。`,
          '未写入任何文件；未 spawn 任何命令。',
          '可用的做法见下方「建议」。',
        );
      }
    } else {
      // file 档：护栏与降级说明。绝不在这里「假装写成功了」。
      if (!fileScopeAllowed(ecosystem)) {
        summary.push(`file 级换源被拒绝：${mirrors.fileScopeBlockedReason ?? '该生态不支持 file 级写入'}。未做任何改动。`);
      } else if (args.confirm !== true || args.dryRun !== false) {
        // dry_run 缺省为 true，所以「真要写」必须同时满足 confirm:true 且
        // dry_run:false。任一不满足就只给计划，绝不落盘。
        const gate = args.confirm !== true
          ? '缺少 confirm:true（用户未显式批准）'
          : '缺少 dry_run:false（仍处于 dry-run，未要求真正写入）';
        summary.push(`file 级换源被拒绝：${gate}。未做任何改动。`);
      } else {
        summary.push(
          `file 级换源在 GUI（桌面版）下不可执行，需要在 CLI 环境执行。未做任何改动。`,
          '',
          '确切命令：',
          `  pure --print 换源 ${ecosystem} --source ${selected.url} --scope file --confirm`,
          '',
          '或直接手改配置文件（键名见下）：',
          `  ${ecosystem === 'npm' ? '~/.npmrc' : ecosystem === 'pip' ? '~/.config/pip/pip.conf' : ecosystem === 'cargo' ? '~/.cargo/config.toml' : ecosystem === 'go' ? '~/.config/go/env' : ecosystem === 'composer' ? '~/.config/composer/config.json' : ecosystem === 'rubygems' ? '~/.gemrc' : '~/.huggingface/mirror.env'}`,
          '',
          'CLI 侧会先写 journal（~/.pure/source-switch-journal.jsonl）再落盘，回滚语义是「删键」而不是把上游 URL 写回去。',
          '注意：GUI 不做这次写入，是因为它必须遵守「写前读旧值 → 记 journal → 才写」的契约，而该契约依赖 CLI 的原子文件操作；GUI 侧宁可拒绝，也不做一次没有回滚依据的写入。',
        );
      }
    }

    const lines = [
      ...summary,
      ...(benchmarkLines.length > 0 ? ['', '测速明细（按「先看有没有回答，再比多快」排序）：', ...benchmarkLines.map((r) => `  ${r.split('\t').join('  ')}`)] : []),
      ...(warnings.length > 0 ? ['', '注意：', ...warnings.map((w) => `- ${w}`)] : []),
    ];
    return { id: toolId, toolName, result: lines.join('\n'), success: true, duration: Date.now() - start };
  }

  /**
   * 统一的「先试首选路由、网络类失败（或被劫持伪装成的成功）再试一次反向
   * 路由」执行器。所有 HTTP 出口都走这里，保证「配了代理一定有兜底」这条
   * 契约在工具侧同样成立——历史上 web_search / web_public_api /
   * download_file 直接把 this.proxyUrl 传下去（代理永远优先），而
   * web_fetch 走 netRouteProxyPair（直连优先 + 兜底），同一个配置在两个
   * 出口得到两种相反的答案：代理挂了这几个出口全挂，代理只是备用时它们
   * 又白白绕一圈。
   *
   * `inspect` 用于在「成功」之后仍然判定内容是否为劫持页：Rust 只看
   * status.is_success()，200 的广告页会被当成真内容交给模型。
   */
  private async runRouted<T>(
    route: NetRoutePair,
    run: (proxyUrl: string) => Promise<T>,
    inspect?: (value: T) => string | null,
  ): Promise<T> {
    const host = route.host ?? '';
    // 劫持页是一个「成功但不可信」的结局：HTTP 200，内容不是用户要的东西。
    // 它必须走网络失败那条路（兜底重试 + unlearn 这条错路），但不靠错误文本
    // 传递——那是隐式契约，改一个词就静默失效。
    type Attempt = { ok: true; value: T } | { ok: false; network: boolean; msg: string };
    const attempt = async (proxyUrl: string): Promise<Attempt> => {
      try {
        const value = await run(proxyUrl);
        const hijack = inspect?.(value) ?? null;
        if (!hijack) return { ok: true, value };
        return { ok: false, network: true, msg: `${hijackReason({ hijacked: true, signal: hijack })}（${hijack}）` };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { ok: false, network: isNetworkError(msg), msg };
      }
    };
    const learn = (proxyUrl: string, ok: boolean): void => {
      if (host) recordNetOutcome(host, proxyUrl ? 'proxy' : 'direct', ok);
    };

    const first = await attempt(route.proxyUrl);
    if (first.ok) {
      if (host) recordNetSuccess(host);
      learn(route.proxyUrl, true);
      return first.value;
    }
    // 没有兜底（未配代理 / neutral 主机）或不是网络类失败 —— 原样上报。
    if (route.fallbackProxyUrl === null || !host || !first.network) throw new Error(first.msg);
    learn(route.proxyUrl, false);

    const second = await attempt(route.fallbackProxyUrl);
    if (second.ok) {
      recordNetSuccess(host);
      learn(route.fallbackProxyUrl, true);
      return second.value;
    }
    learn(route.fallbackProxyUrl, false);
    const { tripped } = recordNetFailure(host);
    throw new Error(tripped ? blockedHostMessage(host, second.msg) : second.msg);
  }

  /** 无单一目标 host 的出口（搜索/公共 API 扇出到几十个后端）：用出口面
   *  决策而不是 host 决策，兜底契约不变。 */
  private async runRoutedSurface<T>(
    surface: 'web_search' | 'web_public_api',
    run: (proxyUrl: string) => Promise<T>,
  ): Promise<T> {
    const pair = netRouteSurfacePair(surface, this.proxyUrl);
    const learn = (proxyUrl: string, ok: boolean): void => recordNetSurfaceOutcome(surface, proxyUrl ? 'proxy' : 'direct', ok);
    try {
      const value = await run(pair.proxyUrl);
      learn(pair.proxyUrl, true);
      return value;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (pair.fallbackProxyUrl === null || !isNetworkError(msg)) throw err;
      learn(pair.proxyUrl, false);
      try {
        const value = await run(pair.fallbackProxyUrl);
        learn(pair.fallbackProxyUrl, true);
        return value;
      } catch (err2) {
        learn(pair.fallbackProxyUrl, false);
        throw err2 instanceof Error ? err2 : new Error(String(err2));
      }
    }
  }

  getTools(): ToolDefinition[] {
    return (tauriInvoke || this.invokeFn)
      ? TOOL_DEFINITIONS.filter((tool) => isPublicToolName(tool.name) || isDynamicCapabilityTool(tool.name))
      : [];
  }

  getMetadata(toolName: string): { sideEffects?: boolean; isWrite?: boolean } | undefined {
    if (toolName === 'connect_mcp_server' || toolName === 'install_agent_skill') return { sideEffects: true, isWrite: true };
    return TOOL_METADATA[toolName];
  }

  getSnapshotPort(): WorkspaceSnapshotPort {
    return {
      getLatestWriteBatch: () => this.latestWriteBatch,
      undoLastWriteBatch: () => this.undoLastWriteBatch(),
    };
  }

  /**
   * S2 单请求改写：下载在网络类错误上失败后，若该 URL 有字节一致的镜像端点，
   * 把整次下载换到镜像上重来一遍（无痕、退出即消失）。成功则返回带改写来源的
   * 成功结果；无镜像或镜像也失败时返回 null，由调用方按原样报错。
   *
   * 只在三处网络失败点调用，不在 case 顶部一律重试：404/403/取消换端点没有
   * 意义（镜像答不出同一份字节）。镜像 URL 自身不在改写表内，递归只走一层。
   * 复用 execute 重进同一条下载链，避免把整段 GUI 下载逻辑再抄一遍。
   */
  private async retryDownloadViaMirror(
    toolCall: { id: string; index: number },
    args: Record<string, unknown>,
    signal: AbortSignal | undefined,
  ): Promise<ToolResult | null> {
    const originalUrl = String(args.url ?? '').trim();
    const rw = primaryRewrite(originalUrl);
    if (!rw || rw.url === originalUrl) return null;
    const retried = await this.execute(
      {
        id: toolCall.id,
        index: toolCall.index,
        function: { name: 'download_file', arguments: JSON.stringify({ ...args, url: rw.url }) },
      },
      signal,
    );
    if (!retried.success) return null;
    return this.withRewriteProvenance(retried, originalUrl, rw);
  }

  /** 把「实际来自镜像端点」标注进下载成功结果（结果是一段 JSON），不让一次
   *  字节等价的静默改写被当成「就是原站给的」。 */
  private withRewriteProvenance(result: ToolResult, from: string, rw: { url: string; rule: string }): ToolResult {
    try {
      const parsed = JSON.parse(String(result.result)) as Record<string, unknown>;
      parsed.rewrite = { from, to: rw.url, rule: rw.rule };
      return { ...result, result: JSON.stringify(parsed) };
    } catch {
      return result;
    }
  }

  async execute(toolCall: ToolCall, signal?: AbortSignal): Promise<ToolResult> {
    if (!tauriInvoke && !this.invokeFn) {
      return {
        id: toolCall.id,
        toolName: toolCall.function.name,
        error: 'Tauri runtime not available — tools disabled',
        success: false,
        duration: 0,
      };
    }

    const start = Date.now();
    const args = safeParseArgs(toolCall.function.arguments);
    const name = toolCall.function.name;
    const ws = this.workspace;

    try {
      switch (name) {
        case 'search_agent_skills': {
          const query = String(args.query ?? '').trim();
          if (!query) return { id: toolCall.id, toolName: name, error: 'search_agent_skills requires a query', success: false, duration: Date.now() - start };
          const maxResults = typeof args.maxResults === 'number' && Number.isFinite(args.maxResults) ? Math.min(20, Math.max(1, Math.floor(args.maxResults))) : 8;
          // Hub indexes live on raw.githubusercontent.com — classify that host
          // so a configured proxy actually gets used, and keep the reverse
          // route as a real fallback (it used to be computed then dropped).
          const hubRoute = netRouteProxyPair('https://raw.githubusercontent.com/', this.proxyUrl);
          const candidates = await this.runRouted(
            hubRoute,
            (proxyUrl) => searchHubSkills(query, maxResults, undefined, proxyUrl),
            // 空结果不是劫持（skill 搜索无命中是常态），只看内容是否像挡板页。
            () => null,
          );
          return { id: toolCall.id, toolName: name, result: JSON.stringify({ query, candidates }, null, 2), success: true, duration: Date.now() - start };
        }
        case 'install_agent_skill': {
          const source = String(args.source ?? '').trim();
          const nameArg = String(args.name ?? '').trim();
          if (!/^[A-Za-z0-9_.-]+$/.test(nameArg)) {
            return { id: toolCall.id, toolName: name, error: 'install_agent_skill rejected an unsafe skill name', success: false, duration: Date.now() - start };
          }
          // source may be a search candidate's owner/repo OR a GitHub URL the
          // user pasted — normalize both to owner/repo for the fetch ladder.
          const repo = normalizeHubRepo(source) || source;
          const hubRoute = netRouteProxyPair('https://raw.githubusercontent.com/', this.proxyUrl);
          const raw = await this.runRouted(
            hubRoute,
            (proxyUrl) => fetchSkillBody(repo, nameArg, proxyUrl),
            (text) => detectHijack(text, { url: 'https://raw.githubusercontent.com/', expectContent: true }).signal,
          );
          // Route learning: runRouted 已经按真实结局记过学习；这里额外把
          // 「三条路全灭」也记一次失败，免得一条死记忆长期钉住 raw CDN。
          if (!raw) recordNetOutcome('raw.githubusercontent.com', hubRoute.proxyUrl ? 'proxy' : 'direct', false);
          if (!raw) {
            return {
              id: toolCall.id,
              toolName: name,
              error: `无法从 ${repo} 获取 ${nameArg}/SKILL.md — raw CDN、GitHub API 和 repo zip 三条路都不可达。不要重复同一调用，换条路：用 download_file 下载 https://codeload.github.com/${repo}/zip/refs/heads/main（download_file 走应用代理），解压后把 ${nameArg}/SKILL.md 所在目录拷进 ~/.pure/skills/${nameArg}/。`,
              success: false,
              duration: Date.now() - start,
            };
          }
          const split = splitSkillMarkdown(raw);
          const body = split.body.trim();
          if (!body) return { id: toolCall.id, toolName: name, error: 'Downloaded SKILL.md has no instruction body', success: false, duration: Date.now() - start };
          const path = await this.call('write_app_skill', {
            name: sanitizeSkillName(nameArg),
            description: split.description ?? '',
            body,
          }) as string;
          const promptBody = body.length > 30_000 ? `${body.slice(0, 30_000)}\n[skill body truncated; continue using the installed skill on the next turn]` : body;
          return {
            id: toolCall.id,
            toolName: name,
            result: `Installed skill ${nameArg} from ${source} at ${path}. Apply these instructions to the current task, then verify the result:\n\n<installed_skill name="${sanitizeSkillName(nameArg)}">\n${promptBody}\n</installed_skill>`,
            success: true,
            duration: Date.now() - start,
          };
        }
        case 'search_mcp_servers': {
          const query = String(args.query ?? '').trim();
          if (!query) return { id: toolCall.id, toolName: name, error: 'search_mcp_servers requires a query', success: false, duration: Date.now() - start };
          const maxResults = typeof args.maxResults === 'number' && Number.isFinite(args.maxResults) ? Math.min(20, Math.max(1, Math.floor(args.maxResults))) : 8;
          const registryUrl = mcpRegistrySearchUrl(query, Math.max(12, maxResults * 2));
          const officialRaw = await this.runRouted(
            netRouteProxyPair(registryUrl, this.proxyUrl),
            (proxyUrl) => this.call('web_fetch', {
              workspace: this.workspace,
              url: registryUrl,
              maxChars: 100_000,
              proxyUrl,
            }) as Promise<string>,
            (text) => detectHijack(text, { url: registryUrl, expectContent: true }).signal,
          );
          const official = parseMcpRegistryPayload(officialRaw, maxResults);
          let community = [] as McpCandidate[];
          try {
            const communityRaw = await this.runRoutedSurface('web_search', (proxyUrl) => this.call(
              'web_search',
              buildWebSearchArgs(this.workspace, {
                query: `${query} MCP server (Smithery OR mcp.so)`,
                maxResults: Math.min(8, maxResults),
              }, this.tavilyApiKey, this.serperApiKey, proxyUrl, this.location, this.searxngUrl),
            ) as Promise<string>);
            community = communityMcpCandidates(parseWebSearchText(communityRaw), maxResults);
          } catch {
            // The official Registry remains useful when community search is unavailable.
          }
          const candidates = [...official, ...community].slice(0, maxResults);
          this.mcpCandidates.clear();
          candidates.forEach((candidate) => this.mcpCandidates.set(candidate.id, candidate));
          return { id: toolCall.id, toolName: name, result: JSON.stringify({ query, directories: ['official-registry', 'community-search'], candidates }, null, 2), success: true, duration: Date.now() - start };
        }
        case 'connect_mcp_server': {
          const candidateId = String(args.candidateId ?? '').trim();
          const candidate = this.mcpCandidates.get(candidateId);
          if (!candidate) return { id: toolCall.id, toolName: name, error: 'Unknown MCP candidate. Search again and use the returned candidateId.', success: false, duration: Date.now() - start };
          if (!candidate.config) return { id: toolCall.id, toolName: name, error: candidate.installHint ?? 'This MCP candidate has no directly usable connection recipe; configure it manually first.', success: false, duration: Date.now() - start };
          if (candidate.requiresAuth) return { id: toolCall.id, toolName: name, error: 'This MCP candidate requires credentials. Configure its secret or use a no-key package/remote recipe first.', success: false, duration: Date.now() - start };
          if (!this.capabilityHooks) return { id: toolCall.id, toolName: name, error: 'Dynamic MCP connection is not available in this runtime.', success: false, duration: Date.now() - start };
          const connected = await this.capabilityHooks.connectMcpServer(candidate.config, signal);
          return { id: toolCall.id, toolName: name, result: JSON.stringify({ candidateId, name: candidate.title, persisted: connected.persisted, tools: connected.tools.map((tool) => tool.name) }), success: true, duration: Date.now() - start };
        }
        case 'read_file': {
          const content = await this.call('read_file', { workspace: ws, path: String(args.path ?? '') }) as string;
          const s = typeof args.startLine === 'number' ? args.startLine - 1 : 0;
          const e = typeof args.endLine === 'number' ? args.endLine : undefined;
          if (s > 0 || e !== undefined) {
            const lines = content.split('\n');
            return { id: toolCall.id, toolName: name, result: lines.slice(s, e).join('\n'), success: true, duration: Date.now() - start };
          }
          return { id: toolCall.id, toolName: name, result: content, success: true, duration: Date.now() - start };
        }
        case 'write_file': {
          const path = String(args.path ?? '');
          const content = String(args.content ?? '');
          const batch = await this.captureWriteBatch('write_file', [path]);
          // Stream byte-level progress while the file is written so the tool
          // row shows "正在写入 … 45% (230/512 KB)" instead of a silent
          // "等待输出" wait for the whole (possibly large) write to finish.
          // Progress lines go to the live tool-output listener only — the LLM
          // still gets the single "Wrote N bytes" result, not the noise.
          if (tauriChannel && !this.invokeFn) {
            const channel = new tauriChannel<string>();
            channel.onmessage = (raw: string) => {
              let parsed: { type?: string; written?: number; total?: number } | null = null;
              try { parsed = JSON.parse(raw); } catch { parsed = null; }
              if (!parsed || parsed.type !== 'progress') return;
              dispatchToolOutput(toolCall.id, 'stdout', formatWriteProgress(path, parsed.written ?? 0, parsed.total ?? 0));
            };
            const msg = await this.call('write_file_stream', {
              workspace: ws,
              path,
              content,
              onProgress: channel,
            }) as string;
            const undoAvailable = await this.tryFinishWriteBatch(batch, [path]);
            return { id: toolCall.id, toolName: name, result: `${msg}${undoAvailable ? '' : ' (当前写入未提供撤销快照)'}`, success: true, duration: Date.now() - start };
          }
          const msg = await this.call('write_file', { workspace: ws, path, content }) as string;
          const undoAvailable = await this.tryFinishWriteBatch(batch, [path]);
          return { id: toolCall.id, toolName: name, result: `${msg}${undoAvailable ? '' : ' (当前写入未提供撤销快照)'}`, success: true, duration: Date.now() - start };
        }
        case 'edit_file': {
          const path = String(args.path ?? '');
          const batch = await this.captureWriteBatch('edit_file', [path]);
          const editMsg = await this.call('edit_file', {
            workspace: ws,
            path,
            oldString: String(args.oldString ?? ''),
            newString: String(args.newString ?? ''),
            allowMultiple: Boolean(args.allowMultiple),
          }) as string;
          const undoAvailable = await this.tryFinishWriteBatch(batch, [path]);
          return { id: toolCall.id, toolName: name, result: `${editMsg}${undoAvailable ? '' : ' (当前写入未提供撤销快照)'}`, success: true, duration: Date.now() - start };
        }
        case 'search_files': {
          const searchResult = await this.call('search_files', {
            workspace: ws,
            pattern: String(args.pattern ?? ''),
            path: args.path ?? null,
            filePattern: args.filePattern ?? null,
            maxResults: args.maxResults ?? 50,
            caseSensitive: typeof args.caseSensitive === 'boolean' ? args.caseSensitive : null,
          }) as string;
          return { id: toolCall.id, toolName: name, result: searchResult, success: true, duration: Date.now() - start };
        }
        case 'find_files': {
          const findResult = await this.call('find_files', {
            workspace: ws,
            query: String(args.query ?? ''),
            path: args.path ?? null,
            filePattern: args.filePattern ?? null,
            maxResults: args.maxResults ?? 10,
            caseSensitive: typeof args.caseSensitive === 'boolean' ? args.caseSensitive : null,
          }) as string;
          return { id: toolCall.id, toolName: name, result: findResult, success: true, duration: Date.now() - start };
        }
        case 'list_files': {
          const listing = await this.call('list_files', {
            workspace: ws,
            path: String(args.path ?? '.'),
            recursive: Boolean(args.recursive),
            maxResults: typeof args.maxResults === 'number' ? Math.floor(args.maxResults) : undefined,
          }) as string;
          return { id: toolCall.id, toolName: name, result: listing, success: true, duration: Date.now() - start };
        }
        case 'execute_command': {
          // background:true → long-lived process (dev/static server, watcher).
          // The Rust channel has no native detach mode, so the command travels
          // wrapped in a self-detaching launcher (writes a wrapper file, starts
          // it hidden, echoes PURE_BG_PID) and finishes in well under a second.
          // The wrapper redirects all server output into a log file, so nothing
          // holds the tool call's pipes open.
          if (args.background === true) {
            const plan = buildBackgroundLaunchPlan(String(args.command ?? ''));
            const launch = await this.call('execute_command', { workspace: ws, command: plan.detachCommand, proxyUrl: this.shellProxy(), sandbox: this.sandbox }) as { exitCode: number; stdout: string; stderr: string };
            const pid = parseBackgroundPid(launch.stdout ?? '');
            return {
              id: toolCall.id,
              toolName: name,
              result: buildBackgroundResult(pid, plan.logFile),
              success: pid !== null,
              error: pid === null ? `background launch did not report a PID${launch.stderr ? `: ${launch.stderr.slice(0, 300)}` : ''}` : undefined,
              duration: Date.now() - start,
            };
          }
          // Stream the command's output as it is produced so a long-running
          // command (bundle, install, test) shows live progress in the tool
          // row instead of waiting silently for the full buffered result.
          if (tauriChannel && !this.invokeFn) {
            const channel = new tauriChannel<string>();
            // Collected lines keep their stream identity (stdout vs stderr) so
            // the final result can label stderr sections — the LLM needs to
            // tell a warning from an error even when a command fails.
            const collected: Array<{ kind: 'stdout' | 'stderr'; line: string }> = [];
            channel.onmessage = (raw: string) => {
              const chunk = parseCommandStreamChunk(raw);
              if (!chunk) return;
              if (chunk.type === 'stdout' || chunk.type === 'stderr') {
                collected.push({ kind: chunk.type, line: chunk.line });
                dispatchToolOutput(toolCall.id, chunk.type, chunk.line, chunk.progress);
              }
            };
            // Cancel wiring: when the engine aborts this tool call (user
            // clicked Stop, or the turn was superseded), ask the Rust backend
            // to kill the running shell tree. Without this, the command keeps
            // running in the background after the GUI stopped listening — a
            // ghost process holding locks, ports, and file handles. The exit
            // code then arrives as -1 (signal-killed); we surface a clear
            // "cancelled" result instead of a confusing exit-code error.
            let cancelled = false;
            const onAbort = () => {
              cancelled = true;
              if (tauriInvoke || this.invokeFn) {
                this.call('kill_command', { id: toolCall.id }).catch(() => {});
              }
            };
            if (signal?.aborted) onAbort();
            else signal?.addEventListener('abort', onAbort, { once: true });
            try {
              const code = await this.call('execute_command_stream', {
                id: toolCall.id,
                workspace: ws,
                command: String(args.command ?? ''),
                proxyUrl: this.shellProxy(),
                sandbox: this.sandbox,
                onOutput: channel,
              }) as number;
              if (cancelled) {
                return {
                  id: toolCall.id,
                  toolName: name,
                  result: 'Command cancelled by user.',
                  error: 'Command cancelled by user.',
                  success: false,
                  duration: Date.now() - start,
                };
              }
              return { id: toolCall.id, toolName: name, ...buildCommandResult(code, collected), duration: Date.now() - start };
            } finally {
              // { once: true } already removed it if it fired; this covers the
              // normal-completion case so a reused signal can't fire a stale
              // kill for a command that already exited.
              signal?.removeEventListener('abort', onAbort);
            }
          }
          const exec = await this.call('execute_command', { workspace: ws, command: String(args.command ?? ''), proxyUrl: this.shellProxy(), sandbox: this.sandbox }) as { exitCode: number; stdout: string; stderr: string };
          const execLines: Array<{ kind: 'stdout' | 'stderr'; line: string }> = [
            ...(exec.stdout ? [{ kind: 'stdout' as const, line: exec.stdout }] : []),
            ...(exec.stderr ? [{ kind: 'stderr' as const, line: exec.stderr }] : []),
          ];
          return { id: toolCall.id, toolName: name, ...buildCommandResult(exec.exitCode, execLines), duration: Date.now() - start };
        }
        case 'download_file': {
          const url = String(args.url ?? '').trim();
          if (!/^https?:\/\//i.test(url)) {
            return { id: toolCall.id, toolName: 'download_file', result: '请提供以 http(s):// 开头的下载链接', success: false, duration: Date.now() - start };
          }
          // Host circuit breaker: a known-dead download source fails instantly —
          // unless this URL has a byte-identical mirror, in which case go
          // straight there instead of hitting the dead host first（已知桥在，不必
          // 先探一次水）。镜像自己也熔断时不再转，递归只走一层。
          if (hostBlocked(url)) {
            const rw = primaryRewrite(url);
            if (!rw) {
              return { id: toolCall.id, toolName: name, result: blockedHostMessage(url), success: false, duration: Date.now() - start };
            }
            const retried = await this.execute(
              { id: toolCall.id, index: toolCall.index, function: { name: 'download_file', arguments: JSON.stringify({ ...args, url: rw.url }) } },
              signal,
            );
            return retried.success ? this.withRewriteProvenance(retried, url, rw) : retried;
          }
          const destination = typeof args.destination === 'string' ? args.destination.trim() : '';
          const filenameArg = typeof args.filename === 'string' ? args.filename.trim() : '';
          const connections = Math.max(1, Math.min(16, Number(args.connections) || 4));
          const resume = args.resume !== false;
          const outSpec = resolveDownloadOutSpec(destination);
          const cmd = buildDownloadCommand(url, outSpec, connections, filenameArg, resume);
          const emit = (p: DownloadProgressEvent): void => dispatchDownloadProgress(toolCall.id, p);
          // 下载有明确的 URL，走 host 决策而不是 command 面：直连优先 + 一次
          // 反向兜底。以前这里直接把 this.proxyUrl 传下去（代理永远优先），
          // 代理挂了就一个文件都下不下来，直连正常时又白白绕一圈。
          const dlRoute = netRouteProxyPair(url, this.proxyUrl);

          // ── Native Rust downloader first ──
          // Proxy-aware (app proxy config), resume via Range, bounded retries,
          // browser UA + Referer — none of which the shell chain guarantees.
          // Falls back to the shell chain when the backend predates the
          // download_file_stream command.
          if (tauriChannel) {
            const urlBasename = (() => {
              try {
                const p = new URL(url).pathname.split('/').pop() ?? '';
                return decodeURIComponent(p) || 'download';
              } catch {
                return 'download';
              }
            })();
            const safeName = (filenameArg || urlBasename || 'download').replace(/[\\/:*?"<>|]/g, '_');
            const nativePath = `${outSpec}/${safeName}`;
            // Cancel wiring, same contract as the shell path below: Stop asks
            // the Rust backend to abort the transfer. A download has no child
            // pid — download_file_stream registers a cancel channel under this
            // toolCall id and kill_command fires it — so without this the
            // download kept running to completion in the background after the
            // turn stopped (bandwidth + a file nobody is waiting for).
            let cancelled = false;
            const onAbort = () => {
              cancelled = true;
              if (tauriInvoke || this.invokeFn) {
                this.call('kill_command', { id: toolCall.id }).catch(() => {});
              }
            };
            if (signal?.aborted) onAbort();
            else signal?.addEventListener('abort', onAbort, { once: true });
            try {
              const channel = new tauriChannel<string>();
              const doneHolder: { value: { code: number; path?: string; size?: number; filename?: string; via?: string; error?: string } | null } = { value: null };
              channel.onmessage = (raw: string) => {
                let parsed: { type?: string; content?: unknown } | null = null;
                try { parsed = JSON.parse(raw); } catch { parsed = null; }
                if (!parsed || parsed.type !== 'stdout') return;
                const line = String(parsed.content ?? '');
                let ev: { type?: string; downloaded?: number; total?: number; filename?: string; via?: string; error?: string } | null = null;
                try { ev = JSON.parse(line); } catch { ev = null; }
                if (!ev) return;
                if (ev.type === 'dl') {
                  const total = Number(ev.total ?? -1);
                  emit({
                    downloaded: Number(ev.downloaded ?? 0),
                    total,
                    percent: total > 0 ? Math.min(100, Math.floor((Number(ev.downloaded ?? 0) / total) * 100)) : -1,
                    speed: 0,
                    state: 'downloading',
                    filename: ev.filename,
                    via: ev.via,
                  });
                } else if (ev.type === 'done') {
                  doneHolder.value = ev as { code: number; path?: string; size?: number; filename?: string; via?: string; error?: string };
                }
              };
              // 首选路由失败且是网络类问题时，用反向路由整体重下一次（下载可重跑，与
              // shell 命令不同）。canceled 不重试。
              const runNative = (proxyUrl: string): Promise<number> => this.call('download_file_stream', {
                id: toolCall.id,
                url,
                path: nativePath,
                workspace: ws,
                proxyUrl,
                maxAttempts: 3,
                onOutput: channel,
              }) as Promise<number>;
              let usedProxy = dlRoute.proxyUrl;
              let code = await runNative(usedProxy);
              const nativeDone = () => doneHolder.value;
              if (code !== 0 && dlRoute.fallbackProxyUrl !== null && !cancelled) {
                const detail0 = nativeDone()?.error ?? `退出码 ${code}`;
                if (isNetworkError(detail0)) {
                  recordNetOutcome(url, usedProxy ? 'proxy' : 'direct', false);
                  usedProxy = dlRoute.fallbackProxyUrl;
                  doneHolder.value = null;
                  code = await runNative(usedProxy);
                }
              }
              const done = nativeDone();
              // Cancelled beats every other outcome: the backend answers -1 /
              // "cancelled" after the kill_command fired, and the shell-chain
              // fallback must stay out of the way.
              if (cancelled && code !== 0) {
                return {
                  id: toolCall.id,
                  toolName: 'download_file',
                  result: 'Download cancelled by user.',
                  error: 'Download cancelled by user.',
                  success: false,
                  duration: Date.now() - start,
                };
              }
              if (code === 0 && done?.path) {
                recordNetSuccess(url);
                recordNetOutcome(url, usedProxy ? 'proxy' : 'direct', true);
                emit({ downloaded: Number(done.size ?? 0), total: Number(done.size ?? 0), percent: 100, speed: 0, state: 'done', path: done.path, filename: done.filename, via: done.via ?? 'native' });
                return {
                  id: toolCall.id,
                  toolName: 'download_file',
                  result: JSON.stringify({ kind: 'download', path: done.path, size: Number(done.size ?? 0), durationMs: Date.now() - start, via: done.via ?? 'native' }),
                  success: true,
                  duration: Date.now() - start,
                };
              }
              const detail = done?.error ?? `退出码 ${code}`;
              if (isNetworkError(detail)) {
                recordNetOutcome(url, usedProxy ? 'proxy' : 'direct', false);
                const mirrored = await this.retryDownloadViaMirror(toolCall, args, signal);
                if (mirrored) return mirrored;
                const { tripped } = recordNetFailure(url);
                return {
                  id: toolCall.id,
                  toolName: 'download_file',
                  result: tripped ? blockedHostMessage(url, detail) : netFailureHint(url, detail),
                  success: false,
                  duration: Date.now() - start,
                };
              }
              return { id: toolCall.id, toolName: 'download_file', result: `下载失败：${detail}`, success: false, duration: Date.now() - start };
            } catch {
              // Backend predates download_file_stream — fall through to the
              // shell chain below.
            } finally {
              // { once: true } already removed it if it fired; this covers the
              // normal-completion case so a reused signal can't fire a stale
              // kill for a download that already finished.
              signal?.removeEventListener('abort', onAbort);
            }
          }

          if (tauriChannel && !this.invokeFn) {
            const channel = new tauriChannel<string>();
            // Captured from the async channel closure via a holder object (a bare
            // closure-captured `let` gets narrowed to never by control-flow analysis).
            const doneHolder: { value: { code: number; path?: string; size?: number; filename?: string; via?: string } | null } = { value: null };
            channel.onmessage = (raw: string) => {
              let parsed: { type?: string; content?: unknown } | null = null;
              try { parsed = JSON.parse(raw); } catch { parsed = null; }
              if (!parsed || parsed.type !== 'stdout') return;
              const line = String(parsed.content ?? '');
              let ev: { type?: string; downloaded?: number; total?: number; filename?: string; via?: string } | null = null;
              try { ev = JSON.parse(line); } catch { ev = null; }
              if (!ev) return;
              if (ev.type === 'dl') {
                const total = Number(ev.total ?? -1);
                emit({
                  downloaded: Number(ev.downloaded ?? 0),
                  total,
                  percent: total > 0 ? Math.min(100, Math.floor((Number(ev.downloaded ?? 0) / total) * 100)) : -1,
                  speed: 0,
                  state: 'downloading',
                  filename: ev.filename,
                  via: ev.via,
                });
              } else if (ev.type === 'done') {
                doneHolder.value = ev as { code: number; path?: string; size?: number; filename?: string; via?: string };
              }
            };
            let cancelled = false;
            const onAbort = () => {
              cancelled = true;
              if (tauriInvoke || this.invokeFn) this.call('kill_command', { id: toolCall.id }).catch(() => {});
            };
            if (signal?.aborted) onAbort();
            else signal?.addEventListener('abort', onAbort, { once: true });
            try {
              const runShell = (proxyUrl: string): Promise<number> => this.call('execute_command_stream', {
                id: toolCall.id,
                workspace: ws,
                command: cmd,
                proxyUrl,
                onOutput: channel,
              }) as Promise<number>;
              let usedProxy = dlRoute.proxyUrl;
              let code = await runShell(usedProxy);
              // 网络类退出码 + 有反向兜底 → 换路重下（下载可重跑；已取消的重试
              // 只会让幽灵进程继续跑，所以 cancelled 时不重试）。
              if (NET_DOWNLOAD_EXIT_CODES.has(code) && dlRoute.fallbackProxyUrl !== null && !cancelled) {
                recordNetOutcome(url, usedProxy ? 'proxy' : 'direct', false);
                usedProxy = dlRoute.fallbackProxyUrl;
                doneHolder.value = null;
                code = await runShell(usedProxy);
              }
              if (cancelled) {
                emit({ downloaded: 0, total: -1, percent: -1, speed: 0, state: 'hidden', filename: doneHolder.value?.filename });
                return { id: toolCall.id, toolName: 'download_file', result: '下载已取消。', error: '下载已取消。', success: false, duration: Date.now() - start };
              }
              const done = doneHolder.value;
              const path = done?.path;
              const size = Number(done?.size ?? 0);
              if (code === 0 && path) {
                recordNetSuccess(url);
                recordNetOutcome(url, usedProxy ? 'proxy' : 'direct', true);
                emit({ downloaded: size, total: size, percent: 100, speed: 0, state: 'done', path, filename: done?.filename, via: done?.via });
                return {
                  id: toolCall.id,
                  toolName: 'download_file',
                  result: JSON.stringify({ kind: 'download', path, size, durationMs: Date.now() - start, via: done?.via ?? 'shell' }),
                  success: true,
                  duration: Date.now() - start,
                };
              }
              emit({ downloaded: 0, total: -1, percent: -1, speed: 0, state: 'hidden', filename: done?.filename });
              // curl/wget network-class exit codes trip the host breaker.
              if (NET_DOWNLOAD_EXIT_CODES.has(code)) {
                recordNetOutcome(url, usedProxy ? 'proxy' : 'direct', false);
                const mirrored = await this.retryDownloadViaMirror(toolCall, args, signal);
                if (mirrored) return mirrored;
                const { tripped } = recordNetFailure(url);
                return {
                  id: toolCall.id,
                  toolName: 'download_file',
                  result: tripped ? blockedHostMessage(url, `下载失败（退出码 ${code}）`) : netFailureHint(url, `下载失败（退出码 ${code}）`),
                  success: false,
                  duration: Date.now() - start,
                };
              }
              return { id: toolCall.id, toolName: 'download_file', result: `下载失败（退出码 ${code}）`, success: false, duration: Date.now() - start };
            } finally {
              signal?.removeEventListener('abort', onAbort);
            }
          }
          // Fallback (no channel): run buffered and parse the done line from stdout.
          const runBuffered = (proxyUrl: string): Promise<{ exitCode: number; stdout: string; stderr: string }> => this.call('execute_command', {
            workspace: ws,
            command: cmd,
            proxyUrl,
          }) as Promise<{ exitCode: number; stdout: string; stderr: string }>;
          let usedProxy = dlRoute.proxyUrl;
          let exec = await runBuffered(usedProxy);
          if ((NET_DOWNLOAD_EXIT_CODES.has(exec.exitCode) || isNetworkError(exec.stderr ?? ''))
            && dlRoute.fallbackProxyUrl !== null) {
            recordNetOutcome(url, usedProxy ? 'proxy' : 'direct', false);
            usedProxy = dlRoute.fallbackProxyUrl;
            exec = await runBuffered(usedProxy);
          }
          const doneFb = parseDownloadDone(exec.stdout ?? '');
          if (exec.exitCode === 0 && doneFb?.path) {
            recordNetSuccess(url);
            recordNetOutcome(url, usedProxy ? 'proxy' : 'direct', true);
            return {
              id: toolCall.id,
              toolName: 'download_file',
              result: JSON.stringify({ kind: 'download', path: doneFb.path, size: Number(doneFb.size ?? 0), durationMs: Date.now() - start, via: doneFb.via ?? 'shell' }),
              success: true,
              duration: Date.now() - start,
            };
          }
          dispatchDownloadProgress(toolCall.id, { downloaded: 0, total: -1, percent: -1, speed: 0, state: 'hidden', filename: doneFb?.filename });
          if (NET_DOWNLOAD_EXIT_CODES.has(exec.exitCode) || isNetworkError(exec.stderr ?? '')) {
            recordNetOutcome(url, usedProxy ? 'proxy' : 'direct', false);
            const mirrored = await this.retryDownloadViaMirror(toolCall, args, signal);
            if (mirrored) return mirrored;
            const { tripped } = recordNetFailure(url);
            return {
              id: toolCall.id,
              toolName: 'download_file',
              result: tripped ? blockedHostMessage(url, `下载失败（退出码 ${exec.exitCode}）`) : netFailureHint(url, `下载失败（退出码 ${exec.exitCode}）`),
              success: false,
              duration: Date.now() - start,
            };
          }
          return { id: toolCall.id, toolName: 'download_file', result: `下载失败（退出码 ${exec.exitCode}）`, success: false, duration: Date.now() - start };
        }
        case 'git_diff': {
          const diff = await this.call('git_diff', { workspace: ws, staged: args.staged ?? false, path: args.path ?? null }) as string;
          return { id: toolCall.id, toolName: name, result: diff, success: true, duration: Date.now() - start };
        }
        case 'git_log': {
          const log = await this.call('git_log', { workspace: ws, maxCount: args.maxCount ?? null, oneline: args.oneline ?? true }) as string;
          return { id: toolCall.id, toolName: name, result: log, success: true, duration: Date.now() - start };
        }
        case 'git_status': {
          const status = await this.call('git_status', { workspace: ws }) as string;
          return { id: toolCall.id, toolName: name, result: status, success: true, duration: Date.now() - start };
        }
        case 'git_commit': {
          const message = typeof args.message === 'string' ? args.message.trim() : '';
          if (!message) {
            return { id: toolCall.id, toolName: name, error: 'git_commit requires a non-empty commit message', success: false, duration: Date.now() - start };
          }
          const commitPaths = Array.isArray(args.paths) ? args.paths.map(String).filter((p) => p.trim().length > 0) : [];
          // Shell git via the existing execute_command Rust command — no new
          // Rust surface for git. The single-quote escapers below are the
          // complete escaping story for exactly the two shells the backend
          // picks (`sh -c` on Unix, PowerShell on Windows).
          const addCmd = commitPaths.length > 0 ? `git add -- ${commitPaths.map(quoteShellArg).join(' ')}` : 'git add -A';
          const add = await this.call('execute_command', { workspace: ws, command: addCmd, proxyUrl: this.shellProxy(), sandbox: this.sandbox }) as { exitCode: number; stdout: string; stderr: string };
          if (add.exitCode !== 0) {
            return { id: toolCall.id, toolName: name, error: add.stderr || add.stdout || 'git add failed', success: false, duration: Date.now() - start };
          }
          const commit = await this.call('execute_command', { workspace: ws, command: `git commit -m ${quoteShellArg(message)}`, proxyUrl: this.shellProxy(), sandbox: this.sandbox }) as { exitCode: number; stdout: string; stderr: string };
          if (commit.exitCode !== 0) {
            return { id: toolCall.id, toolName: name, error: commit.stderr || commit.stdout || 'git commit failed', success: false, duration: Date.now() - start };
          }
          return { id: toolCall.id, toolName: name, result: (commit.stdout || commit.stderr || 'Committed.').trim(), success: true, duration: Date.now() - start };
        }
        case 'git_branch': {
          const action = typeof args.action === 'string' ? args.action : 'list';
          const branchName = typeof args.name === 'string' ? args.name.trim() : '';
          if ((action === 'create' || action === 'switch') && !branchName) {
            return { id: toolCall.id, toolName: name, error: `git_branch action "${action}" requires a branch name`, success: false, duration: Date.now() - start };
          }
          if ((action === 'create' || action === 'switch') && branchName.startsWith('-')) {
            return { id: toolCall.id, toolName: name, error: `invalid branch name: ${branchName}`, success: false, duration: Date.now() - start };
          }
          const branchCmd = action === 'create' ? `git checkout -b ${quoteShellArg(branchName)}`
            : action === 'switch' ? `git checkout ${quoteShellArg(branchName)}`
            : 'git branch';
          const branchOut = await this.call('execute_command', { workspace: ws, command: branchCmd, proxyUrl: this.shellProxy(), sandbox: this.sandbox }) as { exitCode: number; stdout: string; stderr: string };
          if (branchOut.exitCode !== 0) {
            return { id: toolCall.id, toolName: name, error: branchOut.stderr || branchOut.stdout || 'git branch failed', success: false, duration: Date.now() - start };
          }
          return { id: toolCall.id, toolName: name, result: (branchOut.stdout || branchOut.stderr || '').trim() || '(no output)', success: true, duration: Date.now() - start };
        }
        case 'create_directory': {
          const path = String(args.path ?? '');
          const batch = await this.captureWriteBatch('create_directory', [path]);
          const dirMsg = await this.call('create_directory', { workspace: ws, path }) as string;
          if (!batch.entries[0]?.existed) await this.tryFinishWriteBatch(batch, [path]);
          return { id: toolCall.id, toolName: name, result: dirMsg, success: true, duration: Date.now() - start };
        }
        case 'diff_files': {
          const diff = await this.call('diff_files', {
            workspace: ws,
            pathA: String(args.pathA ?? ''),
            pathB: String(args.pathB ?? ''),
          }) as string;
          return { id: toolCall.id, toolName: name, result: diff, success: true, duration: Date.now() - start };
        }
        case 'researcher_web': {
          const prompt = String(args.prompt ?? args.query ?? '').trim();
          const limits = researchLimits(args);
          const searchData = await this.runRoutedSurface('web_search', (proxyUrl) => this.call(
            'web_search',
            buildWebSearchArgs(ws, { ...args, query: prompt, maxResults: Math.min(20, limits.maxSources * 2) }, this.tavilyApiKey, this.serperApiKey, proxyUrl, this.location, this.searxngUrl),
          ) as Promise<string>);
          const rawSources = parseWebSearchText(searchData);
          const filteredSources = filterResearchSources(rawSources, args.allowedDomains);
          const filtered = rawSources.length - filteredSources.length;
          let sources = filteredSources;
          const failed: string[] = [];
          const selected = sources.slice(0, limits.maxSources);
          if (args.fetchContent !== false) {
            const enriched = await Promise.all(selected.map(async (source): Promise<ResearchSource> => {
              try {
                // 逐源走 host 决策：搜索命中可能同时包含国内站与境外站，
                // 统一传 this.proxyUrl 会让其中一半白绕代理。
                const content = await this.runRouted(
                  netRouteProxyPair(source.url, this.proxyUrl),
                  (proxyUrl) => this.call('web_fetch', { workspace: ws, url: source.url, maxChars: limits.maxCharsPerSource, proxyUrl }) as Promise<string>,
                  (text) => detectHijack(text, { url: source.url, expectContent: true }).signal,
                );
                return { ...source, content };
              } catch (error) {
                failed.push(`${source.url}: ${error instanceof Error ? error.message : String(error)}`);
                return source;
              }
            }));
            sources = enriched;
          } else {
            sources = selected;
          }
          if (sources.length === 0) {
            return researchFailure(toolCall.id, name, start, 'No usable research sources were returned by the available search backends or allowed domain filter. Rephrase the query or broaden allowedDomains; do not repeat the unchanged query.');
          }
          const result = makeResearchPayload('researcher_web', prompt, sources, {
            failed,
            filtered,
            truncated: filteredSources.length > selected.length,
          });
          return { id: toolCall.id, toolName: name, result, success: true, duration: Date.now() - start };
        }
        case 'researcher_docs': {
          const library = String(args.library ?? '').trim();
          const topic = String(args.topic ?? '').trim();
          const version = typeof args.version === 'string' ? args.version.trim() : '';
          const prompt = [library, topic, version, 'official documentation API reference'].filter(Boolean).join(' ');
          if (!library || !topic) {
            return researchFailure(toolCall.id, name, start, 'researcher_docs requires both library and topic');
          }
          const limits = researchLimits(args);
          const searchData = await this.runRoutedSurface('web_search', (proxyUrl) => this.call(
            'web_search',
            buildWebSearchArgs(ws, { ...args, query: prompt, maxResults: Math.min(20, limits.maxSources * 2) }, this.tavilyApiKey, this.serperApiKey, proxyUrl, this.location, this.searxngUrl),
          ) as Promise<string>);
          const rawSources = parseWebSearchText(searchData);
          const filteredSources = filterResearchSources(rawSources, args.allowedDomains);
          const filtered = rawSources.length - filteredSources.length;
          let sources = filteredSources;
          const selected = sources.slice(0, limits.maxSources);
          const failed: string[] = [];
          if (args.fetchContent !== false) {
            const enriched = await Promise.all(selected.map(async (source): Promise<ResearchSource> => {
              try {
                const content = await this.runRouted(
                  netRouteProxyPair(source.url, this.proxyUrl),
                  (proxyUrl) => this.call('web_fetch', { workspace: ws, url: source.url, maxChars: limits.maxCharsPerSource, proxyUrl }) as Promise<string>,
                  (text) => detectHijack(text, { url: source.url, expectContent: true }).signal,
                );
                return { ...source, content };
              } catch (error) {
                failed.push(`${source.url}: ${error instanceof Error ? error.message : String(error)}`);
                return source;
              }
            }));
            sources = enriched;
          } else {
            sources = selected;
          }
          if (sources.length === 0) {
            return researchFailure(toolCall.id, name, start, 'No usable documentation sources were returned by the available search backends or allowed domain filter. Rephrase the query or broaden allowedDomains; do not repeat the unchanged query.');
          }
          const result = makeResearchPayload('researcher_docs', prompt, sources, {
            library,
            topic,
            version,
            failed,
            filtered,
            officialVerified: sources.some((source) => isOfficialDocumentationSource(library, source.url)),
            versionMatched: version ? sources.some((source) => `${source.url} ${source.snippet} ${source.content ?? ''}`.includes(version)) : true,
            truncated: filteredSources.length > selected.length,
          });
          return { id: toolCall.id, toolName: name, result, success: true, duration: Date.now() - start };
        }
        case 'code_searcher': {
          const query = String(args.query ?? args.pattern ?? '').trim();
          if (!query) return researchFailure(toolCall.id, name, start, 'code_searcher query must not be empty');
          const raw = await this.call('code_searcher', buildCodeSearchArgs(ws, args)) as string;
          return { id: toolCall.id, toolName: name, result: raw, success: true, duration: Date.now() - start };
        }
        case 'web_search': {
          // 搜索后端是一整个扇出（API + 结构化 + HTML 多引擎），没有单一目标
          // host：走 web_search 出口面 —— 直连优先 + 一次反向兜底。以前是
          // this.proxyUrl 直传，代理一挂所有后端一起死（web_search 尤其惨：
          // 同一个坏代理喂给全部后端，无一幸免）。
          const searchData = await this.runRoutedSurface('web_search', (proxyUrl) => this.call(
            'web_search',
            buildWebSearchArgs(ws, args, this.tavilyApiKey, this.serperApiKey, proxyUrl, this.location, this.searxngUrl),
          ) as Promise<string>);
          return { id: toolCall.id, toolName: name, result: searchData, success: true, duration: Date.now() - start };
        }
        case 'web_fetch': {
          const fetchUrl = String(args.url ?? '');
          // Host circuit breaker: a known-dead host fails instantly with a
          // skip directive instead of burning another full timeout.
          if (hostBlocked(fetchUrl)) {
            return { id: toolCall.id, toolName: name, result: blockedHostMessage(fetchUrl), success: false, duration: Date.now() - start };
          }
          // 唯一决策点：netRouteProxyPair 决定首选并给出反向兜底。200 的
          // 劫持页在这里被 inspect 拦下（Rust 只看 status.is_success），
          // 归类为网络失败 → 走兜底路由重试 → unlearn 这条错路。
          const route = netRouteProxyPair(fetchUrl, this.proxyUrl);
          try {
            const pageText = await this.runRouted(
              route,
              (proxyUrl) => this.call('web_fetch', {
                workspace: ws,
                url: fetchUrl,
                maxChars: args.maxChars ?? 20000,
                proxyUrl,
              }) as Promise<string>,
              (text) => detectHijack(text, { url: fetchUrl, expectContent: true }).signal,
            );
            return { id: toolCall.id, toolName: name, result: pageText, success: true, duration: Date.now() - start };
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            // Non-network failure — not the proxy's fault; surface as-is.
            return { id: toolCall.id, toolName: name, result: netFailureHint(fetchUrl, msg), success: false, duration: Date.now() - start };
          }
        }
        case 'web_public_api': {
          // Structured direct lookups (Tier-2) with the same search keys so
          // searchOnMiss escalation hits Serper/Tavily first, like web_search.
          // 同样是「多后端 + searchOnMiss 升级」的扇出，出口面决策。
          const data = await this.runRoutedSurface('web_public_api', (proxyUrl) => this.call('web_public_api', {
            workspace: ws,
            query: String(args.query ?? ''),
            category: typeof args.category === 'string' ? args.category : null,
            location: this.location,
            apiKey: this.tavilyApiKey,
            serperApiKey: this.serperApiKey,
            searchOnMiss: args.searchOnMiss !== false,
            proxyUrl,
            searxngUrl: this.searxngUrl || null,
          }) as Promise<string>);
          return { id: toolCall.id, toolName: name, result: data, success: true, duration: Date.now() - start };
        }
        case 'web_scrape': {
          // 与 web_fetch 同一个执行器：首选路由 → 网络类失败/劫持页 → 反向兜底。
          const scrapeUrl = String(args.url ?? '');
          const data = await this.runRouted(
            netRouteProxyPair(scrapeUrl, this.proxyUrl),
            (proxyUrl) => this.call('web_scrape', {
              workspace: ws,
              url: scrapeUrl,
              selector: typeof args.selector === 'string' ? args.selector : null,
              maxChars: args.maxChars ?? 20000,
              proxyUrl: proxyUrl || null,
            }) as Promise<string>,
            (text) => detectHijack(text, { url: scrapeUrl, expectContent: true }).signal,
          );
          return { id: toolCall.id, toolName: name, result: data, success: true, duration: Date.now() - start };
        }
        case 'glob_files': {
          const globResult = await this.call('glob_files', {
            workspace: ws,
            pattern: String(args.pattern ?? ''),
            path: args.path ?? null,
            maxResults: args.maxResults ?? 200,
          }) as string;
          return { id: toolCall.id, toolName: name, result: globResult, success: true, duration: Date.now() - start };
        }
        case 'replace_files': {
          const files = Array.isArray(args.files) ? args.files.map(String) : [];
          const batch = await this.captureWriteBatch('replace_files', files);
          const replaceResult = await this.call('replace_files', {
            workspace: ws,
            files,
            oldString: String(args.oldString ?? ''),
            newString: String(args.newString ?? ''),
            allowMultiple: Boolean(args.allowMultiple),
          }) as string;
          const undoAvailable = await this.tryFinishWriteBatch(batch, files);
          const replaceText = String(replaceResult);
          const errorCount = Number(replaceText.match(/,\s*(\d+)\s+error\(s\)/)?.[1] ?? 0);
          return {
            id: toolCall.id,
            toolName: name,
            result: `${replaceText}${errorCount === 0 && !undoAvailable ? ' (当前写入未提供撤销快照)' : ''}`,
            ...(errorCount > 0 ? { error: replaceText } : {}),
            success: errorCount === 0,
            duration: Date.now() - start,
          };
        }
        case 'sys_info': {
          // The user-configured location (Settings → General → Environment) is
          // forwarded so the model gets the location baseline without a round
          // trip — the Rust command treats it as optional.
          const info = await this.call('sys_info', { workspace: ws, location: this.location }) as string;
          return { id: toolCall.id, toolName: name, result: info, success: true, duration: Date.now() - start };
        }
        case 'create_document': {
          const { format, path: docPath, spec } = args as { format: string; path: string; spec: unknown };
          if (!format || !docPath) {
            return { id: toolCall.id, toolName: name, result: 'format 与 path 为必填字段', success: false, duration: Date.now() - start };
          }
          const bytes = await generateDocument(format, spec);
          const b64 = toBase64(bytes);
          // Tauri v2 matches JS keys as the camelCase form of the Rust param
          // (data_base64) — the snake_case spelling is rejected as a missing
          // required key. Same call shape as markdown.ts / toolRow.ts.
          await this.call('save_file_binary', { path: docPath, dataBase64: b64 });
          return {
            id: toolCall.id,
            toolName: name,
            result: `文档已生成：${docPath}（${format.toUpperCase()}，${(bytes.length / 1024).toFixed(1)} KB）`,
            success: true,
            duration: Date.now() - start,
          };
        }
        case 'generate_image': {
          if (!this.imageGen) {
            return {
              id: toolCall.id,
              toolName: name,
              error: 'generate_image is not configured — the connected provider has no text-to-image model enabled. Fall back to SVG.',
              success: false,
              duration: Date.now() - start,
            };
          }
          const prompt = String(args.prompt ?? '').trim();
          if (!prompt) {
            return { id: toolCall.id, toolName: name, error: 'generate_image: prompt is required', success: false, duration: Date.now() - start };
          }
          const n = typeof args.n === 'number' && Number.isFinite(args.n)
            ? Math.min(4, Math.max(1, Math.floor(args.n)))
            : 1;
          const size = typeof args.size === 'string' ? args.size.trim() : '';
          const payload = await this.call('generate_image', {
            provider: this.imageGen.provider,
            model: this.imageGen.model,
            baseUrl: this.imageGen.baseURL,
            secretKey: this.imageGen.secretKey ?? '',
            apiKey: '',
            prompt,
            n,
            size,
            proxyUrl: this.imageGen.proxyUrl ?? '',
            proxyBypassProviders: this.imageGen.proxyBypassProviders ?? [],
          }) as { images: GeneratedImage[] };
          const images = Array.isArray(payload?.images) ? payload.images : [];
          if (images.length === 0) {
            return { id: toolCall.id, toolName: name, error: 'generate_image: no images returned', success: false, duration: Date.now() - start };
          }
          // Full payloads go to the UI via the side channel; the LLM sees only
          // the compact summary (never megabytes of base64 in its context).
          cacheGeneratedImages(toolCall.id, images);
          return {
            id: toolCall.id,
            toolName: name,
            result: {
              prompt,
              count: images.length,
              images: images.map((img) => ({ mimeType: img.mimeType, sizeBytes: img.sizeBytes })),
              summary: `Generated ${images.length} image(s) for prompt "${prompt.slice(0, 120)}" — rendered in the chat UI for the user.`,
            },
            success: true,
            duration: Date.now() - start,
          };
        }
        case 'diagnose_network': {
          const target = String(args.target ?? '').trim();
          if (!target) {
            return { id: toolCall.id, toolName: name, error: 'diagnose_network: target must not be empty — pass the URL or domain that is failing.', success: false, duration: Date.now() - start };
          }
          return await this.runGuiNetworkProbe(toolCall.id, name, start, target, args.humanReadable === true);
        }
        case 'switch_package_source': {
          return await this.runGuiSwitchSource(toolCall.id, name, start, args);
        }
        default:
          return {
            id: toolCall.id,
            toolName: name,
            error: `Unknown tool: ${name}. Available: read_file, write_file, edit_file, search_files, list_files, execute_command, create_directory, diff_files, web_search, web_fetch, web_public_api, web_scrape, glob_files, replace_files, git_diff, git_log, git_status, git_commit, git_branch, sys_info, diagnose_network, switch_package_source`,
            success: false,
            duration: Date.now() - start,
          };
      }
    } catch (err: any) {
      return { id: toolCall.id, toolName: name, error: err?.message ?? String(err), success: false, duration: Date.now() - start };
    }
  }

  private async captureWriteBatch(toolName: string, paths: string[]): Promise<WorkspaceSnapshotBatch> {
    this.latestWriteBatch = null;
    const entries: WorkspaceSnapshotEntry[] = [];
    for (const path of [...new Set(paths)]) {
      const info = await this.call('path_info', { workspace: this.workspace, path }) as { exists?: boolean; isDirectory?: boolean; size?: number; isSymlink?: boolean };
      if (info.isSymlink) {
        throw new Error(`Snapshot refuses symlink path: ${path}`);
      }
      if (!info.exists) {
        entries.push({ path, existed: false, kind: 'file' });
      } else if (info.isDirectory) {
        entries.push({ path, existed: true, kind: 'directory' });
      } else {
        if ((info.size ?? 0) > this.maxSnapshotBytes) {
          throw new Error(`Snapshot too large for ${path}; write was not performed.`);
        }
        const content = await this.call('read_file', { workspace: this.workspace, path }) as string;
        entries.push({ path, existed: true, kind: 'file', content });
      }
    }
    return {
      id: `snapshot_${this.sessionId || 'session'}_${++this.snapshotSequence}`,
      sessionId: this.sessionId,
      workspace: this.workspace,
      toolName,
      createdAt: Date.now(),
      entries,
    };
  }

  private async finishWriteBatch(batch: WorkspaceSnapshotBatch, changedPaths: string[]): Promise<boolean> {
    const changed = new Set(changedPaths);
    const finished: WorkspaceSnapshotEntry[] = [];
    for (const entry of batch.entries) {
      if (!changed.has(entry.path)) continue;
      const info = await this.call('path_info', { workspace: this.workspace, path: entry.path }) as { exists?: boolean; isDirectory?: boolean; size?: number; isSymlink?: boolean };
      if (info.exists && !info.isDirectory) {
        entry.afterContent = await this.call('read_file', { workspace: this.workspace, path: entry.path }) as string;
        if (new TextEncoder().encode(entry.afterContent).byteLength > this.maxSnapshotBytes) continue;
        if (!entry.existed || entry.afterContent !== entry.content) finished.push(entry);
      } else if (!entry.existed && info.exists) {
        finished.push(entry);
      }
    }
    batch.entries = finished;
    if (finished.length > 0) this.latestWriteBatch = batch;
    return finished.length > 0;
  }

  private async tryFinishWriteBatch(batch: WorkspaceSnapshotBatch, changedPaths: string[]): Promise<boolean> {
    try {
      return await this.finishWriteBatch(batch, changedPaths);
    } catch {
      return false;
    }
  }

  private async undoLastWriteBatch(): Promise<WorkspaceRestoreResult> {
    const batch = this.latestWriteBatch;
    if (!batch) {
      return { restored: false, restoredPaths: [], removedPaths: [], conflicts: [], message: '没有可撤销的写入。' };
    }
    this.latestWriteBatch = null;
    const restoredPaths: string[] = [];
    const removedPaths: string[] = [];
    const conflicts: string[] = [];
    for (const entry of [...batch.entries].reverse()) {
      try {
      let info: { exists?: boolean; isDirectory?: boolean; isSymlink?: boolean };
      try {
        info = await this.call('path_info', { workspace: this.workspace, path: entry.path }) as { exists?: boolean; isDirectory?: boolean };
      } catch {
        conflicts.push(entry.path);
        continue;
      }
      if (!entry.existed) {
        if (!info.exists) continue;
        if (info.isSymlink || (entry.kind === 'directory') !== Boolean(info.isDirectory)) {
          conflicts.push(entry.path);
          continue;
        }
        if (entry.kind === 'directory') {
          try {
            await this.call('remove_path', { workspace: this.workspace, path: entry.path, recursive: false });
            removedPaths.push(entry.path);
          } catch {
            conflicts.push(entry.path);
          }
          continue;
        }
        if (entry.afterContent !== undefined) {
          const current = await this.call('read_file', { workspace: this.workspace, path: entry.path }) as string;
          if (current !== entry.afterContent) {
            conflicts.push(entry.path);
            continue;
          }
        }
        try {
          await this.call('remove_path', { workspace: this.workspace, path: entry.path, recursive: false });
          removedPaths.push(entry.path);
        } catch {
          conflicts.push(entry.path);
        }
        continue;
      }
      if (entry.kind === 'directory') {
        if (!info.exists || !info.isDirectory || info.isSymlink) {
          conflicts.push(entry.path);
          continue;
        }
        await this.call('create_directory', { workspace: this.workspace, path: entry.path });
        restoredPaths.push(entry.path);
        continue;
      }
      if (!info.exists || info.isDirectory || info.isSymlink) {
        conflicts.push(entry.path);
        continue;
      }
      if (entry.afterContent !== undefined) {
        const current = await this.call('read_file', { workspace: this.workspace, path: entry.path }) as string;
        if (current !== entry.afterContent) {
          conflicts.push(entry.path);
          continue;
        }
      }
      await this.call('write_file', { workspace: this.workspace, path: entry.path, content: entry.content ?? '' });
      restoredPaths.push(entry.path);
      } catch {
        conflicts.push(entry.path);
      }
    }
    this.latestWriteBatch = conflicts.length > 0
      ? { ...batch, entries: batch.entries.filter((entry) => conflicts.includes(entry.path)) }
      : null;
    const restored = conflicts.length === 0;
    return {
      restored,
      batchId: batch.id,
      restoredPaths,
      removedPaths,
      conflicts,
      message: restored
        ? `已撤销最近一次写入：${[...restoredPaths, ...removedPaths].join('、') || '无文件变化'}`
        : `撤销遇到并发修改，未覆盖：${conflicts.join('、')}`,
    };
  }
}

export function buildCodeSearchArgs(workspace: string, args: Record<string, unknown>): Record<string, unknown> {
  return {
    workspace,
    query: String(args.query ?? args.pattern ?? '').trim(),
    path: args.path ?? null,
    globs: Array.isArray(args.globs) ? args.globs : null,
    caseSensitive: args.caseSensitive !== false,
    maxResults: args.maxResults ?? 15,
    globalMaxResults: args.globalMaxResults ?? 250,
    timeoutSeconds: args.timeoutSeconds ?? 10,
  };
}

export function researchLimits(args: Record<string, unknown>): { maxSources: number; maxCharsPerSource: number } {
  const maxSources = typeof args.maxSources === 'number' && Number.isFinite(args.maxSources)
    ? Math.min(8, Math.max(1, Math.floor(args.maxSources)))
    : 5;
  const maxCharsPerSource = typeof args.maxCharsPerSource === 'number' && Number.isFinite(args.maxCharsPerSource)
    ? Math.min(12000, Math.max(500, Math.floor(args.maxCharsPerSource)))
    : 4000;
  return { maxSources, maxCharsPerSource };
}

function researchFailure(id: string, toolName: string, start: number, error: string): ToolResult {
  return { id, toolName, error, success: false, duration: Date.now() - start };
}

/** Pure arg builder for the web_search invoke. Exported so a unit test locks
 * the exact Tauri arg names (apiKey → Rust api_key, serperApiKey → Rust
 * serper_api_key) — a typo here would only fail at runtime in the packaged
 * app, since tauriInvoke is unavailable in tests. */
export function buildWebSearchArgs(
  workspace: string,
  args: Record<string, unknown>,
  tavilyApiKey: string,
  serperApiKey: string,
  proxyUrl = '',
  location = '',
  searxngUrl = '',
): Record<string, unknown> {
  return {
    workspace,
    query: String(args.query ?? ''),
    maxResults: args.maxResults ?? 10,
    // Optional API keys from Settings → Tools: when set, the Rust backend
    // searches via Serper (Google index) then Tavily first, falling back to
    // the free HTML backends otherwise.
    apiKey: tavilyApiKey,
    serperApiKey,
    // Optional SearXNG instance (Settings → Tools → Web Tools): intranet /
    // self-hosted metasearch, tried after the API backends.
    ...(searxngUrl ? { searxngUrl } : {}),
    ...(proxyUrl ? { proxyUrl } : {}),
    // User-configured city (Settings → General → Environment): the Tier-2
    // fast path uses it as the weather fallback when the query names no city.
    ...(location ? { location } : {}),
  };
}

// ── Command output formatting (shared by the streamed and buffered paths) ──
// Streamed lines are captured with their stream identity; the final result
// must keep stderr distinguishable so the LLM sees errors as errors. Grouping
// stderr sections under a `[stderr]` marker (mirroring the old Rust-side
// execute_command text format) keeps output readable without interleaving.

/** Build the ToolResult fields for an execute_command run: success is decided
 * by the exit code (the single source of truth), the result keeps the full
 * output, and a non-zero exit produces an error naming the code + output.
 * Pure so the exit-code → success mapping is unit-testable without a Tauri
 * runtime. */
export function buildCommandResult(
  exitCode: number,
  lines: Array<{ kind: 'stdout' | 'stderr'; line: string }>,
): Pick<ToolResult, 'result' | 'error' | 'success'> {
  const output = formatCommandOutput(lines);
  if (exitCode !== 0) {
    return { result: output, error: formatCommandError(exitCode, output), success: false };
  }
  return { result: output, success: true };
}

/** Format ONE write_file progress event (the exact protocol the Rust
 * write_file_stream command pushes over its Channel: `{ type: 'progress',
 * written, total }`) as the live tool-row line. Pure + exported so the
 * Rust/TS protocol is locked by a unit test, mirroring buildCommandResult. */
export function formatWriteProgress(path: string, written: number, total: number): string {
  const pct = total > 0 ? Math.round((written / total) * 100) : 100;
  return `正在写入 ${path} — ${pct}% (${formatBytes(written)}/${formatBytes(total)})`;
}

export function formatCommandOutput(lines: Array<{ kind: 'stdout' | 'stderr'; line: string }>): string {
  const out: string[] = [];
  let inStderr = false;
  for (const { kind, line } of lines) {
    if (kind === 'stderr') {
      if (!inStderr) {
        if (out.length > 0) out.push('');
        out.push('[stderr]');
        inStderr = true;
      }
    } else {
      inStderr = false;
    }
    out.push(line);
  }
  return out.join('\n');
}

