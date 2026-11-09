// src/adapter/node/NodeToolAdapter.ts
// v0.4 — 16 built-in file/command/web/git tools. Schemas come from
// shared/toolDefs.ts (single source of truth shared with the GUI adapter).
// Fixes: handleWriteFile uses proper fs.mkdir() instead of fragile .ensure hack.

import { basename, dirname, isAbsolute, join, normalize, resolve as pathResolve, relative as pathRelative, sep } from 'node:path';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { open, stat, writeFile, readFile, rename, unlink, mkdir, rm, appendFile } from 'node:fs/promises';
import { tmpdir, homedir } from 'node:os';
import type { Readable } from 'node:stream';
import * as http from 'node:http';
import * as https from 'node:https';
import * as tls from 'node:tls';
import { spawn } from 'node:child_process';

import type { ToolAdapter, ToolCall, ToolResult, ToolDefinition } from '../../shared/types';
import { BUILT_IN_TOOL_DEFS, TOOL_METADATA } from '../../shared/toolDefs';
import { runGitTool, type GitToolName } from '../../tools/impl/git';
import { runBrowserTool, runScreenshotTool } from '../../tools/impl/browser';
import { readDevToolsPort } from '../../channels/rasterize/headlessChrome';
import type { ArgvRunOptions, ArgvRunResult, ChromeLaunch } from '../../tools/runtime';
import { readFileHeadFooter, readFileHeadSlice } from '../../shared/readFileHead';
import { generateDocument } from '../../shared/docGen';
import { formatCommandError, isBenignNoMatchExit, safeParseArgs } from '../../shared/format';
import { cacheQualityLiveLine } from '../../shared/endpointCacheQuality';
import { blockedHostMessage, detectResponseHijack, hijackErrorMessage, hostBlocked, isNetworkError, netFailureHint, recordNetFailure, recordNetSuccess } from '../../shared/netGuard';
import { primaryRewrite } from '../../shared/sourceRewrite';
import { condenseToolBody, type SummarizeForExtract } from '../../shared/webExtract';
import { recordNetOutcome, unblockAttemptsBeforeMirror } from '../../shared/netRoute';
import { stripAnsi } from '../../shared/ansi';
import { stripPowerShellStartupProgress } from '../../shared/powershellOutput';
import { BACKGROUND_LOG_MISS_HINT, buildBackgroundLaunchPlan, buildBackgroundResult, buildWrapperScript, isBackgroundLogPath } from '../../shared/backgroundCommand';
import { listTasks, registerTask, unregisterTask } from '../../shared/taskRegistry';
import { IMAGE_READ_MAX_BYTES, imageMimeForPath } from '../../shared/imageFiles';
import { filterResearchSources, isOfficialDocumentationSource, makeResearchPayload, parseWebSearchText, type ResearchSource } from '../../shared/research';
import { isPublicToolName } from '../../shared/toolDefs';
import { downloadHub, type DownloadProgress, type DownloadController } from '../../shared/downloadHub';
import type { WorkspaceRestoreResult, WorkspaceSnapshotBatch, WorkspaceSnapshotEntry, WorkspaceSnapshotPort } from '../../shared/workspaceSnapshot';
import { cachedDirectPublicApi } from './publicApis';
import { pageCacheKey, PAGE_TTL_MS, webCache } from './webCache';
// web_search 执行单源在 tools/impl/webSearch（P2-5）：编排/解析器/CJK 相关性门/
// cookie jar 全在这份模块里，本适配器只注入原语并把结果包成 ToolResult。
import { cookieHeaderFor, decodeBody, runWebSearch } from '../../tools/impl/webSearch';
// 路径解析链单源在 tools/impl/pathPolicy（P2-5 第三子刀）：tilde 展开/词法归一/
// workspace 解析/symlink 守卫全在这份模块里，本适配器只注入 node:fs 原语。
import { expandTilde, resolveWorkspacePath, type PathPolicyFs } from '../../tools/impl/pathPolicy';
import { extractScrapeText, formatFeedText, formatJsonBody, isFeedBody, scrapeViaJina, truncateText } from './webScrape';
import { cliFetch, hostMatchesNoProxy, isPrivateHost, parseProxy } from '../../shared/cliFetch';
import { extractMetaRefreshUrl, extractPdfText, extractPdfViaPdftotext, fetchWithRetry, refererFor, resolveRedirectTarget, scrapeViaFirecrawl, scrapeViaWayback } from './fetchFallback';
import { extractFileText, MAX_SEARCH_FILE_BYTES } from './fileText';
import { BROWSER_UA } from '../../shared/platformUa';
import { isThirdPartyPath, THIRD_PARTY_DIR_NAMES } from '../../shared/thirdPartyScope';
import { ProbeGuardError, diagnoseNetwork, renderProbeReport, renderProbeReportForHuman } from '../../shared/node/netProbe';
import { switchPackageSource } from '../../shared/node/sourceSwitcher';
import type { TrustTier } from '../../shared/mirrorSources';
import { destFromUrl } from '../../shared/network/dest';
import { recordAttempt } from '../../shared/network/ledger';

/** Windows has no POSIX shell (`sh`) or `diff` binary — PowerShell / Git for
 * Windows provide the equivalents. Module-level so every handler branches
 * consistently. */
const IS_WINDOWS = process.platform === 'win32';

/** Bun 的 Windows spawn 不做 PATH 搜索也不补 .exe（CreateProcess 的
 * lpApplicationName 形态）——裸 `'powershell'` 直接 ENOENT，2026-10-14 CI
 * 实测。所以 Windows 的两个内建 shell 都用系统目录绝对路径：PowerShell 与
 * cmd 自 XP 起钉在这两个位置，不依赖用户 PATH。 */
function windowsSystemShell(name: 'powershell.exe' | 'cmd.exe'): string {
  const root = process.env.SystemRoot || 'C:\\Windows';
  return name === 'cmd.exe'
    ? join(root, 'System32', 'cmd.exe')
    : join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
}

/** Encode a command for powershell.exe -EncodedCommand (base64 of UTF-16LE),
 * with the exit-code wrapper appended so a failing command reports non-zero
 * (mirrors Rust powershell_encoded_command). The encoded form bypasses the
 * Windows command-line quoting mangling (CommandLineToArgvW-style `\"`
 * escaping) a plain -Command argument is subject to. Exported for tests. */
export function encodePowerShellCommand(command: string): string {
  return Buffer.from(`${command}; if ($?) { exit $LASTEXITCODE } else { exit 1 }`, 'utf16le').toString('base64');
}

/** Drain a child-process stream to a UTF-8 string (node:child_process shape,
 * where stdout/stderr are node Readables rather than bun's Response-compatible
 * streams). */
function collectStreamText(stream: Readable | null): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    if (!stream) return resolvePromise('');
    const chunks: Buffer[] = [];
    stream.on('data', (chunk: Buffer) => chunks.push(chunk));
    stream.on('error', reject);
    stream.on('end', () => resolvePromise(Buffer.concat(chunks).toString('utf8')));
  });
}

const DEFAULT_MAX_LIST_RESULTS = 2000;
const ABSOLUTE_MAX_LIST_RESULTS = 5000;

/** CJK ideographs (CJK Unified, Ext-A, Compatibility) — the query-tokenizer
 * must split Chinese/Japanese/Korean queries into bigrams because Chinese has
 * no word boundaries; "我的学历" is far less useful as a needle than "学历". */
const CJK_RE = /[\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF]/;

/** Single CJK characters that are grammatical particles / pronouns, never
 * content words ("的了我你他是"). Bigrams containing any of these are dropped
 * from find_files queries, so "学历" survives tokenizing "我的学历" while the
 * noise pairs "我的" / "的学" do not. */
const CJK_STOP_CHARS = new Set(['的', '了', '在', '是', '我', '你', '他', '她', '它', '们', '与', '和', '及', '都', '这', '那', '个', '要', '就', '还', '而', '或', '没', '有', '不', '把', '被', '对', '从', '到', '以', '中', '里', '上', '下', '之', '等', '什', '么', '谁']);

/** Turn a free-form find_files query into searchable needle tokens. Latin
 * queries are lowercased words (len >= 3); CJK queries become length-2
 * bigrams that survive the stop-char filter. Empty / single-char CJK remnants
 * are dropped. Returns a de-duplicated, sorted array. */
export function tokenizeFindQuery(query: string): string[] {
  const out = new Set<string>();
  const segments = query.split(/[\s,，。;；:：、|/\\()（）"']+/).filter((s) => s.length > 0);
  for (let seg of segments) {
    if (CJK_RE.test(seg)) {
      seg = seg.toLowerCase();
      if (seg.length >= 2) {
        for (let i = 0; i + 1 < seg.length; i++) {
          const pair = seg.slice(i, i + 2);
          if ([...pair].some((ch) => CJK_STOP_CHARS.has(ch))) continue;
          out.add(pair);
        }
      }
    } else {
      const word = seg.toLowerCase();
      if (word.length >= 3 || /[0-9]/.test(word)) out.add(word);
    }
  }
  return [...out].sort();
}

// Lives in shared/powershellOutput.ts since the user-hook runner captures
// PowerShell output the same way; re-exported here because the adapter is
// where callers (and the Windows quality-gate tests) expect to find it.
export { stripPowerShellStartupProgress };

/** Resolve the download destination directory for the Node chain (CLI /
 * sidecar). 口径与 GUI 的 resolveDownloadOutSpec 对齐（2026-10-11）：裸文件名
 * 是「名字」不是目录——落 ~/Downloads，不再套出 `name.ext/name.ext` 一层同
 * 名嵌套；`~/…` 按真实 home 展开，不再在 Downloads 里孵出字面量 `~` 目录；
 * 带扩展名的绝对路径视作文件本身、落点取其父目录。 */
export function resolveDownloadOutDir(destination: string, home: string, cwd: string): string {
  const raw = destination.trim();
  if (!raw || raw === 'downloads') return join(home, 'Downloads');
  const inner = raw === '~' ? '' : raw.slice(2);
  const expanded = raw.startsWith('~/') || raw === '~'
    ? join(home, inner.replace(/[^A-Za-z0-9_.\-\/]/g, '_'))
    : raw;
  if (isAbsolute(expanded)) {
    // `/a/b/c.png` 读作文件本身：下载进它的父目录。
    if (/\.[A-Za-z0-9]+$/.test(expanded)) {
      const parent = expanded.replace(/[\\/][^\\/]+$/, '');
      return parent && isAbsolute(parent) ? parent : join(home, 'Downloads');
    }
    return expanded;
  }
  if (expanded === 'workspace') return cwd;
  // 裸文件名（无路径分隔）：是文件名，落 Downloads。
  if (/\.[A-Za-z0-9]+$/.test(expanded) && !expanded.includes('/')) return join(home, 'Downloads');
  return join(home, 'Downloads', expanded.replace(/[^A-Za-z0-9_.\-\/]/g, '_'));
}

/** create_document 的落点解析（Node/CLI 链）。语义逐条对齐 Rust 侧
 * resolve_document_path（src-tauri/src/lib.rs，其单测
 * resolve_document_path_matches_the_delivery_semantics 是权威口径）：
 * `~`/`$HOME` 前缀展开（Node 侧统一走 expandTilde，另认 `~\` 与
 * `%USERPROFILE%`）；绝对路径原样（全盘可达契约）；相对路径有工作区锚
 * 工作区、没工作区落 ~/Downloads，子目录结构保留——绝不落进程 cwd
 * （2026-10-12 刀 9 判例：交付卡报「已生成」而文件在没人找得到的地方）。
 * 与 Rust 同款「三不」：不安全化文件名、重名不加序号（直接覆盖）、不补
 * 扩展名——落点即报告路径。改必须与 Rust 侧同步。home 可注入，测试不碰
 * 进程环境。 */
export function resolveDocumentPath(spec: string, workspace: string, home = homedir()): string {
  const expanded = expandTilde(spec, home);
  if (isAbsolute(expanded)) return expanded;
  const ws = workspace.replace(/[/\\]+$/, '');
  return ws ? `${ws}/${expanded}` : join(home, 'Downloads', expanded);
}

/** Size of a file for ordering find_files scans, or Number.MAX_SAFE_INTEGER
 * if the stat fails (unreadable files sort last and get skipped). */
function statSafeSize(p: string): number {
  try {
    const meta = statSync(p);
    return meta.isFile() ? meta.size : Number.MAX_SAFE_INTEGER;
  } catch {
    return Number.MAX_SAFE_INTEGER;
  }
}

export interface NodeToolConfig {
  workspace: string;
  sessionId?: string;
  commandTimeout?: number;
  maxFileSize?: number;
  maxSnapshotBytes?: number;
  /**
   * User-configured location/city (CLI: PURE_LOCATION / PURE_CITY env var).
   * Reported by sys_info() as the location baseline for answers that depend
   * on where the user is (trip planning, weather, local services).
   */
  location?: string;
  /** 主目录替身（测试注入）。create_document 无工作区时的 ~/Downloads 锚、
   * 路径参数里的 `~`/`$HOME` 展开都用它；缺省 = 真实 homedir()。 */
  homeDir?: string;
  /** sys_info 追加的预算行（promptBudgetLiveLine 产物）。CLI 面的 adapter
   * 不持有 LLM config，由 cliHarness 装配会话时算好传入；缺省不拼。 */
  llmBudgetLine?: string;
  /** sys_info 追加的缓存质量行的取数键（2026-11-05 感知手脚）。行文案在
   * sys_info 时现算（滑动窗口是活的，装配态快照会失真）；adapter 仍不持有
   * config，只拿键。缺省不拼。 */
  cacheQualityKeys?: { provider: string; model: string };
  /** web_fetch/web_scrape 超长正文的提炼回调（shared/webExtract 编排）。
   * CLI 侧由 cliAdapter 按当前会话配置构造；缺席 = 原文直返（与未接线时
   * 行为一致），工具 description 的 auto-condensed 承诺必须有这个回调才
   * 兑现。 */
  summarizeForExtract?: SummarizeForExtract;
}

// ── 代理 / 内网识别 ──
// 实现住在 src/shared/cliFetch.ts（此前这里与 fetchFallback.ts 各有一份，两份
// 都在用，SOCKS 文案已经漂移）。这里只做 re-export：调用点（下载链的 node:http
// 路径、搜索后端、结构化 API）都从这一个入口拿，语义不可能再分叉。
export {
  cliFetch,
  cliProxyFor,
  hostMatchesNoProxy,
  isPrivateHost,
  parseProxy,
  resolveEnvProxy,
  type CliProxyRoute,
} from '../../shared/cliFetch';

export class NodeToolAdapter implements ToolAdapter {
  private workspace: string;
  /** 原始 config.workspace 是否非空（CLI 裸会话没带工作区）。pathResolve 会
   * 把空串吞成进程 cwd，而 create_document 的相对路径在无工作区时必须落
   * ~/Downloads 而不是 cwd（刀 9 判例），所以这个布尔要在解析前记下。 */
  private workspaceGiven: boolean;
  /** create_document 的 ~/Downloads 锚与 `~` 展开所用的主目录；可注入让测试
   * 不碰真实 Downloads（与 expandTilde 的注入式 home 同一约定）。 */
  private homeDir: string;
  private commandTimeout: number;
  private maxFileSize: number;
  private maxSnapshotBytes: number;
  private location: string;
  private readonly llmBudgetLine: string | undefined;
  private readonly cacheQualityKeys: { provider: string; model: string } | undefined;
  private readonly summarizeForExtract: SummarizeForExtract | undefined;
  private sessionId: string;
  private latestWriteBatch: WorkspaceSnapshotBatch | null = null;
  private snapshotSequence = 0;

  private tools: ToolDefinition[] = [...BUILT_IN_TOOL_DEFS];

  constructor(config: NodeToolConfig) {
    this.workspaceGiven = config.workspace.trim().length > 0;
    this.workspace = pathResolve(config.workspace);
    this.homeDir = config.homeDir || homedir();
    this.sessionId = config.sessionId ?? '';
    this.commandTimeout = config.commandTimeout ?? 30000;
    this.maxFileSize = config.maxFileSize ?? 64 * 1024 * 1024; // 64MB — matches the Rust read_file cap
    this.maxSnapshotBytes = config.maxSnapshotBytes ?? 8 * 1024 * 1024;
    this.location = (config.location ?? '').trim();
    this.llmBudgetLine = config.llmBudgetLine;
    this.cacheQualityKeys = config.cacheQualityKeys;
    this.summarizeForExtract = config.summarizeForExtract;
  }

  getTools(): ToolDefinition[] {
    return this.tools.filter((tool) => isPublicToolName(tool.name));
  }

  getMetadata(toolName: string): { sideEffects?: boolean; isWrite?: boolean } | undefined {
    return TOOL_METADATA[toolName];
  }

  getSnapshotPort(): WorkspaceSnapshotPort {
    return {
      getLatestWriteBatch: () => this.latestWriteBatch,
      undoLastWriteBatch: () => this.undoLastWriteBatch(),
    };
  }

  async execute(toolCall: ToolCall, signal?: AbortSignal): Promise<ToolResult> {
    const start = Date.now();
    const args = safeParseArgs(toolCall.function.arguments);

    try {
      switch (toolCall.function.name) {
        case 'read_file': return await this.handleReadFile(args, start);
        case 'write_file': return await this.handleWriteFile(args, start);
        case 'edit_file': return await this.handleEditFile(args, start);
        case 'search_files': return await this.handleSearchFiles(args, start);
        case 'find_files': return await this.handleFindFiles(args, start);
        case 'list_files': return await this.handleListFiles(args, start);
        case 'execute_command': return await this.handleExecuteCommand(args, signal, start);
        case 'task_list': return await this.handleTaskList(start);
        case 'task_kill': return await this.handleTaskKill(args, start);
        case 'create_directory': return await this.handleCreateDirectory(args, start);
        case 'create_document': return await this.handleCreateDocument(args, start);
        case 'diff_files': return await this.handleDiffFiles(args, signal, start);
        case 'researcher_web': return await this.handleResearcherWeb(args, signal, start);
        case 'researcher_docs': return await this.handleResearcherDocs(args, signal, start);
        case 'code_searcher': return await this.handleCodeSearcher(args, signal, start);
        case 'web_search': {
          // Tier-2 fast path: structured intents (weather/geocode/news/wiki/IP/
          // FX/stock/GitHub) are answered from curated no-key public APIs
          // instead of search backends; only general queries fall through to
          // a real search. researcher_web calls handleWebSearch directly, so
          // this fast path never hijacks research queries.
          const direct = await cachedDirectPublicApi(String(args.query ?? ''));
          if (direct.outcome) {
            return {
              id: `tool_${Date.now()}`,
              toolName: 'web_search',
              result: `${direct.cached ? '[cached] ' : ''}[${direct.outcome.source}] ${direct.outcome.text}`,
              success: true,
              duration: Date.now() - start,
            };
          }
          return await this.runSearchTool(
            String(args.query ?? ''),
            Math.min(typeof args.maxResults === 'number' ? args.maxResults : 10, 20),
            'web_search',
            start,
          );
        }
        case 'web_fetch': return await this.handleWebFetch(args, signal, start);
        case 'download_file': return await this.handleDownloadFile(args, signal, start, toolCall.id);
        case 'web_public_api': return await this.handleWebPublicApi(args, start);
        case 'web_scrape': return await this.handleWebScrape(args, signal, start);
        case 'glob_files': return await this.handleGlobFiles(args, start);
        case 'replace_files': return await this.handleReplaceFiles(args, start);
        case 'git_diff':
        case 'git_log':
        case 'git_status':
        case 'git_commit':
        case 'git_branch': return await this.handleGitTool(toolCall.function.name as GitToolName, args, signal, start);
        case 'browser':
        case 'screenshot': return await this.handleBrowserTool(toolCall.function.name as 'browser' | 'screenshot', args, toolCall.id, start);
        case 'sys_info': return await this.handleSysInfo(start);
        case 'diagnose_network': return await this.handleDiagnoseNetwork(args, start);
        case 'switch_package_source': return await this.handleSwitchPackageSource(args, start);
        default:
          return this.fail(toolCall, start, `Unknown tool: ${toolCall.function.name}`);
      }
    } catch (err: any) {
      return this.fail(toolCall, start, err?.message ?? String(err));
    }
  }

  // ── Tool handlers ──

  private async handleReadFile(args: Record<string, unknown>, start: number): Promise<ToolResult> {
    const path = await this.resolve(String(args.path));

    if (!existsSync(path)) {
      // 后台日志的引用悬空（见 BACKGROUND_LOG_MISS_HINT）：给结构化出路，别让
      // 模型对同一路径反复重试绕圈。
      if (isBackgroundLogPath(String(args.path))) {
        return this.fail(null, start, `read_file: ${BACKGROUND_LOG_MISS_HINT}`);
      }
      return this.fail(null, start, `File not found: ${String(args.path)}`);
    }

    let meta: ReturnType<typeof statSync>;
    try {
      meta = statSync(path);
    } catch {
      if (isBackgroundLogPath(String(args.path))) {
        return this.fail(null, start, `read_file: ${BACKGROUND_LOG_MISS_HINT}`);
      }
      return this.fail(null, start, `File not found: ${String(args.path)}`);
    }
    if (meta.isDirectory()) {
      // 目录不报错（2026-10-22）：模型经常只把 path 精确到目录层——过去
      // 报「是目录，请用 list_files」等于整轮白跑 + 一次空转往返。这里
      // 直接以 list_files 同款非递归格式给出目录内容，一次往返就能继续。
      return this.readDirectoryListing(path, String(args.path), start);
    }

    // 图片视觉输入（电脑端操作能力 P2）：read_file 读本机图片直接走
    // ToolResult.images 通道（screenshot 的 W4-2 回路同款），模型亲眼看到
    // 图，不经过文本抽取。startLine/endLine 对图片无意义，忽略。
    const imageMime = imageMimeForPath(path);
    if (imageMime) {
      if (meta.size > IMAGE_READ_MAX_BYTES) {
        return this.fail(null, start, `read_file: 图片 ${(meta.size / 1024 / 1024).toFixed(1)}MB 超过视觉读取上限 ${Math.round(IMAGE_READ_MAX_BYTES / 1024 / 1024)}MB。先用 execute_command 压缩再读：macOS 'sips -Z 1600 <path> --out <smaller.png>'，Windows PowerShell 用 System.Drawing 缩放。`);
      }
      const bytes = new Uint8Array(await Bun.file(path).arrayBuffer());
      let binary = '';
      for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
      const dataUrl = `data:${imageMime};base64,${btoa(binary)}`;
      return {
        id: `tool_${Date.now()}`,
        toolName: 'read_file',
        result: `[image: ${String(args.path)} — ${imageMime}, ${(meta.size / 1024).toFixed(0)}KB — returned as a visible image attachment]`,
        success: true,
        duration: Date.now() - start,
        images: [{ dataUrl, mimeType: imageMime, path, sizeBytes: meta.size }],
      };
    }

    if (meta.size > this.maxFileSize) {
      // Points at code_searcher, not search_files: the model-facing tool list
      // deliberately hides search_files (superseded), and a recommendation the
      // model cannot follow ends in "Unknown tool".
      return this.fail(null, start, `read_file: 文件 ${(meta.size / 1024 / 1024).toFixed(0)}MB 超过读取上限 ${Math.round(this.maxFileSize / 1024 / 1024)}MB；可以改用 code_searcher 搜索其中的内容，或用 execute_command 分段读取。`);
    }

    const bytes = new Uint8Array(await Bun.file(path).arrayBuffer());
    const { text: extracted, note } = await extractFileText(bytes, path);
    let text = extracted.trim();
    if (!text && note) {
      return this.fail(null, start, `read_file: '${String(args.path)}' — ${note}`);
    }
    if (!text) {
      text = '(empty file)';
    }

    const lines = text.split('\n');

    const startLine = typeof args.startLine === 'number' ? Math.max(1, args.startLine) : 1;
    const endLine = typeof args.endLine === 'number' ? Math.min(args.endLine, lines.length) : lines.length;

    if (startLine > 1 || endLine < lines.length) {
      // 模型点名要的范围：原样给，不加脚注。
      return {
        id: `tool_${Date.now()}`,
        toolName: 'read_file',
        result: lines.slice(startLine - 1, endLine).join('\n'),
        success: true,
        duration: Date.now() - start,
      };
    }

    // 刀 D1（2026-10-10）真杠杆：默认（未给范围）大文件只回头部切片 + 总行数
    // + 建议范围，不做硬截断——小文件零变化，真大文件不再整份进上下文逼出
    // 引擎 40k 盲截（截掉的尾巴连总行数都不知道）。头部预算按引擎
    // capToolResult 的 40k chars 留足余量，脚注在引擎截断下也能存活。
    const head = readFileHeadSlice(lines);
    if (head.count < lines.length) {
      return {
        id: `tool_${Date.now()}`,
        toolName: 'read_file',
        result: `${head.text}\n\n${readFileHeadFooter(head.count, lines.length)}`,
        success: true,
        duration: Date.now() - start,
      };
    }

    return {
      id: `tool_${Date.now()}`,
      toolName: 'read_file',
      result: text,
      success: true,
      duration: Date.now() - start,
    };
  }

  /**
   * read_file打到目录时的降级路径：给出目录一级内容（与 list_files 非递归
   * 同款式：排序 + 截断上限 + 截断脚注）。返回 success=true——这不是错误，
   * 是模型少跑一轮就能用上的信息。CLI(Node)与 GUI(Rust read_file_impl)
   * 两侧语义必须一致，改哪边都同步另一边。
   */
  private readDirectoryListing(path: string, displayPath: string, start: number): ToolResult {
    const DIR_LISTING_MAX = 2000;
    const entries = readdirSync(path, { withFileTypes: true })
      .map((entry) => entry.name)
      .sort();
    const truncated = entries.length > DIR_LISTING_MAX;
    const items = entries.slice(0, DIR_LISTING_MAX);
    const listing = items.length > 0 ? items.join('\n') : '(empty directory)';
    const head = `[read_file：'${displayPath}' 是目录，以下为其内容${truncated ? `（前 ${DIR_LISTING_MAX} 项）` : ''}；读具体文件请在 path 补全到文件名。]`;
    const footnote = truncated ? `\n\n[截断] 仅显示前 ${DIR_LISTING_MAX} 项；目录还有更多内容，请缩小 path 或使用 glob_files。` : '';
    return {
      id: `tool_${Date.now()}`,
      toolName: 'read_file',
      result: `${head}\n\n${listing}${footnote}`,
      success: true,
      duration: Date.now() - start,
    };
  }

  private async handleWriteFile(args: Record<string, unknown>, start: number): Promise<ToolResult> {
    const pathArg = String(args.path);
    const path = await this.resolve(pathArg);
    const content = String(args.content);
    const append = args.append === true;
    const batch = await this.captureWriteBatch('write_file', [pathArg]);

    // Ensure parent directory exists
    const dir = dirname(path);
    if (dir && dir !== path) {
      await mkdir(dir, { recursive: true });
    }

    if (append) await appendFile(path, content);
    else await Bun.write(path, content);
    const undoAvailable = await this.tryFinishWriteBatch(batch, [pathArg]);

    return {
      id: `tool_${Date.now()}`,
      toolName: 'write_file',
      result: `${append ? 'Appended' : 'Wrote'} ${content.length} bytes to ${String(args.path)}${undoAvailable ? '' : ' (当前写入未提供撤销快照)'}`,
      success: true,
      duration: Date.now() - start,
    };
  }

  private async handleEditFile(args: Record<string, unknown>, start: number): Promise<ToolResult> {
    const pathArg = String(args.path);
    const path = await this.resolve(pathArg);
    const oldStr = String(args.oldString);
    const newStr = String(args.newString);
    const allowMultiple = Boolean(args.allowMultiple);

    const file = Bun.file(path);
    if (!(await file.exists())) {
      return this.fail(null, start, `File not found: ${String(args.path)}`);
    }

    const text = await file.text();
    const match = findEditMatch(text, oldStr);
    if (!match) {
      return this.fail(null, start, editStringNotFoundError(String(args.path), oldStr), 'edit_file');
    }

    const occurrences = match.normalizedText.split(match.normalizedOld).length - 1;
    if (occurrences > 1 && !allowMultiple) {
      return this.fail(null, start, `Found ${occurrences} occurrences of the string. Set allowMultiple:true to replace all, or provide more context to narrow the match.`);
    }

    const replacement = match.lineEnding === 'crlf' ? newStr.replace(/\r?\n/g, '\r\n') : newStr.replace(/\r\n/g, '\n');
    const newText = allowMultiple
      ? match.text.replaceAll(match.old, replacement)
      : match.text.slice(0, match.index) + replacement + match.text.slice(match.index + match.old.length);
    const batch = await this.captureWriteBatch('edit_file', [pathArg]);
    await Bun.write(path, newText);
    const undoAvailable = await this.tryFinishWriteBatch(batch, [pathArg]);

    return {
      id: `tool_${Date.now()}`,
      toolName: 'edit_file',
      result: `Replaced ${allowMultiple ? occurrences : 1} occurrence(s) in ${String(args.path)}${match.lineEnding === 'crlf' ? ' (matched CRLF line endings)' : ''}${undoAvailable ? '' : ' (当前写入未提供撤销快照)'}`,
      success: true,
      duration: Date.now() - start,
    };
  }

  private async handleSearchFiles(args: Record<string, unknown>, start: number): Promise<ToolResult> {
    const pattern = String(args.pattern);
    const pathArg = args.path ? String(args.path) : '';
    const searchDir = pathArg.trim() ? await this.resolve(pathArg) : await this.resolve('.');

    if (!existsSync(searchDir)) {
      return this.fail(null, start, `search_files: '${pathArg || '.'}' 不存在。若这是 Windows 绝对路径，请确认路径拼写正确且磁盘上确实存在。`);
    }

    const max = Math.min(Math.max(1, typeof args.maxResults === 'number' ? Math.floor(args.maxResults) : 50), 500);
    const ignoreCase = args.caseSensitive !== true;
    const needle = ignoreCase ? pattern.toLowerCase() : pattern;

    const results: string[] = [];
    const skipped: string[] = [];

    // Search one file: extract text via the format-aware engine (PDF/DOCX/
    // XLSX/GBK text now searchable), report skip reasons instead of silently
    // ignoring unreadable files.
    const searchOneFile = async (entryPath: string, base: string): Promise<void> => {
      let meta: ReturnType<typeof statSync>;
      try {
        meta = statSync(entryPath);
      } catch {
        skipped.push(`${basename(entryPath)}（无法读取文件信息）`);
        return;
      }
      if (!meta.isFile()) return;
      if (meta.size > MAX_SEARCH_FILE_BYTES) {
        skipped.push(`${basename(entryPath)}（文件 ${(meta.size / 1024 / 1024).toFixed(1)}MB 超过搜索上限 32MB）`);
        return;
      }
      const bytes = new Uint8Array(await Bun.file(entryPath).arrayBuffer());
      const { text: fileText, note } = await extractFileText(bytes, entryPath);
      if (!fileText.trim() && note) {
        skipped.push(`${basename(entryPath)}（${note}）`);
        return;
      }
      const relPath = pathRelative(base, entryPath) || basename(entryPath);
      for (const [idx, line] of fileText.split('\n').entries()) {
        if (results.length >= max) break;
        const hay = ignoreCase ? line.toLowerCase() : line;
        if (hay.includes(needle)) {
          results.push(`${relPath}:${idx + 1}: ${line.trim()}`);
        }
      }
    };

    // A `path` pointing at a single FILE searches that file directly — models
    // often point search_files at the document they think contains the answer.
    if (statSync(searchDir).isFile()) {
      const base = dirname(searchDir);
      await searchOneFile(searchDir, base);
    } else {
      let fileGlob = String(args.filePattern || '**/*');
      // Models echo Windows paths (D:\tmp\*.docx) verbatim; on non-Windows
      // platforms backslashes are literal filename characters, so normalize.
      if (!IS_WINDOWS) fileGlob = fileGlob.replace(/\\/g, '/');
      const glob = new Bun.Glob(fileGlob);
      for await (const entry of glob.scan({ cwd: searchDir, absolute: false })) {
        if (results.length >= max) break;
        await searchOneFile(join(searchDir, entry), searchDir);
      }
    }

    let out = results.length > 0 ? results.join('\n') : `No matches found for "${pattern}"`;
    if (skipped.length > 0) {
      const display = skipped.slice(0, 8);
      const more = skipped.length - 8;
      if (more > 0) display.push(`…等共 ${skipped.length} 个`);
      out += `\n\n[提示] ${skipped.length} 个文件无法解析文本内容（扫描版 PDF / 加密文档 / 旧版二进制 / 超大文件），已跳过：${display.join('、')}\n如需读取这些文件，请单独 read_file 它们查看具体原因。`;
    }

    return {
      id: `tool_${Date.now()}`,
      toolName: 'search_files',
      result: out,
      success: true,
      duration: Date.now() - start,
    };
  }

  private async handleFindFiles(args: Record<string, unknown>, start: number): Promise<ToolResult> {
    const query = String(args.query ?? '').trim();
    if (!query) {
      return this.fail(null, start, 'find_files: query 不能为空。请给出要查找的主题词，例如 "学历" 或 "education"。');
    }
    const pathArg = args.path ? String(args.path) : '';
    const searchDir = pathArg.trim() ? await this.resolve(pathArg) : await this.resolve('.');

    if (!existsSync(searchDir)) {
      return this.fail(null, start, `find_files: '${pathArg || '.'}' 不存在。若这是 Windows 绝对路径，请确认路径拼写正确且磁盘上确实存在。`);
    }

    const max = Math.min(Math.max(1, typeof args.maxResults === 'number' ? Math.floor(args.maxResults) : 10), 30);
    const ignoreCase = args.caseSensitive !== true;
    const needles = tokenizeFindQuery(query);
    if (needles.length === 0) {
      return this.fail(null, start, `find_files: 无法从查询 "${query}" 中提取有效关键词（只剩助词/停用词）。请换更具体的词，例如 "学历"、"毕业证" 或 "education"。`);
    }

    // ── Stage 0: filename scan (cheap — no content reads) ────────────────
    // Collect every file's path + a filename score = how many needles appear
    // in the (case-folded) basename. A file named 学历证明.pdf is the strongest
    // possible signal and costs zero extraction time.
    type Candidate = {
      rel: string;
      nameScore: number;
      hits: number;
      snippets: string[];
      skipNote?: string;
    };
    const candidates: Candidate[] = [];
    const skipped: string[] = [];

    const fold = (s: string) => (ignoreCase ? s.toLowerCase() : s);
    const nameScoreOf = (name: string): number => {
      const folded = fold(name);
      let score = 0;
      for (const n of needles) if (folded.includes(n)) score++;
      return score;
    };

    // Scan one file for content hits, capturing up to 3 snippet lines. Never
    // returns full file content — that's what read_file is for.
    const scanOneFile = async (entryPath: string, base: string): Promise<Candidate | undefined> => {
      let meta: ReturnType<typeof statSync>;
      try {
        meta = statSync(entryPath);
      } catch {
        return undefined;
      }
      if (!meta.isFile()) return undefined;
      const relPath = pathRelative(base, entryPath) || basename(entryPath);
      const nameScore = nameScoreOf(basename(entryPath));
      if (meta.size > MAX_SEARCH_FILE_BYTES) {
        return { rel: relPath, nameScore, hits: 0, snippets: [], skipNote: `文件 ${(meta.size / 1024 / 1024).toFixed(1)}MB 超过搜索上限 32MB` };
      }
      const bytes = new Uint8Array(await Bun.file(entryPath).arrayBuffer());
      const { text: fileText, note } = await extractFileText(bytes, entryPath);
      if (!fileText.trim() && note) {
        return { rel: relPath, nameScore, hits: 0, snippets: [], skipNote: note };
      }
      let hits = 0;
      const snippets: string[] = [];
      for (const [idx, line] of fileText.split('\n').entries()) {
        const hay = fold(line);
        if (needles.some((n) => hay.includes(n))) {
          hits++;
          if (snippets.length < 3) snippets.push(`${relPath}:${idx + 1}: ${line.trim().slice(0, 200)}`);
        }
      }
      return { rel: relPath, nameScore, hits, snippets };
    };

    // ── Stage 1: ranked content scan with a budget ───────────────────────
    // Content extraction is the expensive part (PDF/DOCX/XLSX all parse).
    // The budget: scan filename-matching files first (highest signal), then
    // keep going until either we've found `max` files with content hits or
    // we've scanned `budget` files total — never the whole tree blindly.
    const budget = max * 6 + 20;
    const found: Candidate[] = [];
    const seen = new Set<string>();

    const consider = async (entryPath: string, base: string): Promise<void> => {
      if (found.length >= max) return;
      if (seen.has(entryPath)) return;
      seen.add(entryPath);
      const cand = await scanOneFile(entryPath, base);
      if (!cand) return;
      const isEmptyHit = cand.snippets.length === 0 && cand.hits === 0 && cand.nameScore === 0;
      if (cand.hits > 0 || cand.nameScore > 0) {
        found.push(cand);
      }
      if (isEmptyHit && cand.skipNote) {
        skipped.push(`${basename(entryPath)}（${cand.skipNote}）`);
      }
    };

    if (statSync(searchDir).isFile()) {
      await consider(searchDir, dirname(searchDir));
    } else {
      // 1) Filename matches first — cheapest and strongest signal.
      const fileGlob = String(args.filePattern || '**/*');
      const globAll = new Bun.Glob(!IS_WINDOWS ? fileGlob.replace(/\\/g, '/') : fileGlob);
      // 三方件默认不在理解范围：搜索目录或 filePattern 明确指名依赖目录才进去。
      const explicitScope = isThirdPartyPath(pathRelative(this.workspace, searchDir)) || isThirdPartyPath(fileGlob);
      const allFiles: { entry: string; nameScore: number }[] = [];
      for await (const entry of globAll.scan({ cwd: searchDir, absolute: false })) {
        if (!explicitScope && isThirdPartyPath(entry)) continue;
        const folded = fold(basename(entry));
        let nameScore = 0;
        for (const n of needles) if (folded.includes(n)) nameScore++;
        allFiles.push({ entry, nameScore });
      }
      allFiles.sort((a, b) => b.nameScore - a.nameScore);
      // Only content-scan files whose NAME contains a needle (typically a
      // handful) — the long tail goes to the budgeted phase below so a
      // no-match query never degenerates into a full-tree content scan.
      for (const f of allFiles) {
        if (found.length >= max || f.nameScore === 0) break;
        await consider(join(searchDir, f.entry), searchDir);
      }
      // 2) Fall back to scanning until budget exhausts, size-ascending so the
      //    cheap files get checked before the slow multi-MB documents.
      const unscanned = allFiles
        .filter((f) => !seen.has(join(searchDir, f.entry)))
        .sort((a, b) => {
          const sa = statSafeSize(join(searchDir, a.entry));
          const sb = statSafeSize(join(searchDir, b.entry));
          return sa - sb;
        });
      for (const f of unscanned) {
        if (found.length >= max || seen.size >= budget) break;
        await consider(join(searchDir, f.entry), searchDir);
      }
    }

    // ── Ranking + output ─────────────────────────────────────────────────
    // Sort: content-hit files first (strongest proof), then filename-only
    // matches. Within a tier, more hits wins.
    found.sort((a, b) => {
      const aProof = a.hits > 0 ? 1 : 0;
      const bProof = b.hits > 0 ? 1 : 0;
      if (aProof !== bProof) return bProof - aProof;
      if (a.hits !== b.hits) return b.hits - a.hits;
      return a.rel.localeCompare(b.rel);
    });
    const top = found.slice(0, max);

    let out: string;
    if (top.length === 0) {
      // ── Fallback (兜底) ────────────────────────────────────────────────
      out = `find_files "${query}": 在 ${searchDir} 未找到匹配文件。`;
      const scannedTotal = seen.size;
      out += `\n已扫描 ${scannedTotal} 个文件（${skipped.length} 个无法解析文本，已跳过）。`;
      out += `\n[兜底建议] 换更宽泛的关键词（如 "学历" 的同类词：毕业证/学位/education），关闭大小写（caseSensitive:false），或用 filePattern 缩小范围（如 "*.{docx,pdf,txt}"）；若文件在子目录，可先 list_files 查看目录结构。`;
    } else {
      out = `find_files "${query}": 找到 ${top.length} 个候选文件`;
      const scannedTotal = seen.size;
      out += `（扫描 ${scannedTotal} 个文件，${skipped.length} 个跳过）。以下为最可能包含 "${query}" 的文件，按相关度排序，每个仅附前 3 行命中片段：`;
      top.forEach((c, i) => {
        const tag = c.hits > 0 ? `${c.hits} 处命中` : '仅文件名命中';
        out += `\n\n${i + 1}. ${c.rel}（${tag}${c.nameScore > 0 ? ' · 文件名包含关键词' : ''}）`;
        for (const s of c.snippets) out += `\n   ${s}`;
        if (c.snippets.length === 0) out += `\n   （${c.skipNote ?? '文件名包含关键词，但内容无命中'}）`;
      });
      out += `\n\n[提示] 需查看完整内容时，用 read_file 读取以上文件（可用 startLine/endLine 只读片段）。`;
    }

    if (skipped.length > 0) {
      const display = skipped.slice(0, 8);
      const more = skipped.length - 8;
      if (more > 0) display.push(`…等共 ${skipped.length} 个`);
      out += `\n\n[提示] ${skipped.length} 个文件无法解析文本内容（扫描版 PDF / 加密文档 / 旧版二进制 / 超大文件），已跳过：${display.join('、')}\n如需读取这些文件，请单独 read_file 它们查看具体原因。`;
    }

    return {
      id: `tool_${Date.now()}`,
      toolName: 'find_files',
      result: out,
      success: true,
      duration: Date.now() - start,
    };
  }

  private async handleListFiles(args: Record<string, unknown>, start: number): Promise<ToolResult> {
    const dirPath = await this.resolve(String(args.path || '.'));
    const recursive = Boolean(args.recursive);

    // Bun.file(dirPath).exists() returns false for DIRECTORIES (Bun.file only
    // resolves regular files) — every real directory was misreported as
    // missing. existsSync + statSync().isDirectory() accept both; statSync
    // follows symlinks, matching how the glob below resolves the cwd.
    if (!existsSync(dirPath) || !statSync(dirPath).isDirectory()) {
      return this.fail(null, start, `Directory not found: ${String(args.path || '.')}`);
    }

    const requestedMax = typeof args.maxResults === 'number' && Number.isFinite(args.maxResults)
      ? Math.floor(args.maxResults)
      : DEFAULT_MAX_LIST_RESULTS;
    const maxResults = Math.min(Math.max(1, requestedMax), ABSOLUTE_MAX_LIST_RESULTS);
    const items: string[] = [];
    const glob = new Bun.Glob(recursive ? '**/*' : '*');
    let truncated = false;
    // 三方件默认不在理解范围：请求本身落在依赖目录里（明确指名）才不过滤。
    const explicitScope = isThirdPartyPath(pathRelative(this.workspace, dirPath));
    let skippedThirdParty = false;

    for await (const entry of glob.scan({ cwd: dirPath, absolute: false, onlyFiles: false })) {
      if (!explicitScope && isThirdPartyPath(entry)) {
        skippedThirdParty = true;
        continue;
      }
      if (items.length >= maxResults) {
        truncated = true;
        break;
      }
      items.push(entry);
    }

    items.sort();
    const listing = items.length > 0 ? items.join('\n') : '(empty directory)';
    const result = truncated
      ? `${listing}\n\n[截断] 仅显示前 ${maxResults} 项；目录还有更多内容，请缩小 path 或使用 glob_files。${skippedThirdParty ? '依赖目录（node_modules 等）默认跳过。' : ''}`
      : listing;
    return {
      id: `tool_${Date.now()}`,
      toolName: 'list_files',
      result,
      success: true,
      duration: Date.now() - start,
    };
  }

  private async handleExecuteCommand(args: Record<string, unknown>, signal: AbortSignal | undefined, start: number): Promise<ToolResult> {
    const command = String(args.command);
    // Per-call cwd (absolute, or relative to the workspace) and timeout —
    // both default to the resident behavior (workspace / commandTimeout).
    const cwd = resolveCommandCwd(args.cwd, this.workspace);
    if (typeof cwd === 'string') return this.fail(null, start, cwd); // validation error message
    const timeoutMs = clampCommandTimeoutMs(args.timeoutMs);
    // background:true → long-lived process (dev/static server, watcher).
    // Spawns detached and returns immediately with the PID + log file instead
    // of blocking until the timeout kills the server.
    if (args.background === true) {
      return this.handleBackgroundCommand(command, cwd.value, start);
    }
    const abort = createAbortController(signal, timeoutMs);

    try {
      // Windows commands run through powershell.exe -EncodedCommand: the
      // base64-UTF-16LE form bypasses the command-line quoting mangling a
      // plain -Command argument is subject to. The encoding also carries the
      // exit-code wrapper — PowerShell 5.1 exits 0 after a plain -Command
      // unless the script calls `exit` itself, and `$?` is false for both a
      // failing native command and a failing cmdlet, so either reports as
      // non-zero (mirrors Rust powershell_encoded_command).
      const shellArgs = IS_WINDOWS
        ? [windowsSystemShell('powershell.exe'), '-NoProfile', '-NonInteractive', '-EncodedCommand', encodePowerShellCommand(command)]
        : ['sh', '-c', command];
      // Inject the extended probe PATH on Unix so `node` / `bun` / nvm /
      // Homebrew commands resolve even when this process inherited a minimal
      // PATH (IDE integrated terminal, GUI-spawned launcher) — mirrors Rust
      // execute_command. Windows inherits the full system PATH.
      const spawnEnv = IS_WINDOWS ? undefined : { ...process.env, PATH: extendedProbePath() };
      // node:child_process 而不是 Bun.spawn：后者在 Windows 不做 PATH 搜索、
      // 不补 .exe，连系统目录绝对路径都报 ENOENT（2026-10-14 CI 两轮实锤，
      // bun 的 spawn 层自身问题）；node 这条路在本仓库有 Windows CI 在跑的
      // 先例（tauriToolAdapter.test.ts 的 sh 展开探针）。语义对齐旧形态：
      // stdin 不喂（PowerShell -NonInteractive / sh -c 都不读），stdout/
      // stderr 全量收管，abort.signal 保留超时取消。
      const proc = spawn(shellArgs[0]!, shellArgs.slice(1), {
        cwd: cwd.value,
        env: spawnEnv ?? undefined,
        signal: abort.signal,
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      });
      const [stdoutRaw, stderrRaw, exitCode] = await Promise.all([
        collectStreamText(proc.stdout),
        collectStreamText(proc.stderr),
        new Promise<number>((resolve, reject) => {
          proc.on('error', reject);
          proc.on('exit', (code) => resolve(code ?? -1));
        }),
      ]);

      // Strip ANSI color codes from captured output so logs / colored command
      // output render as plain text instead of mojibake.
      const stdout = stripAnsi(stdoutRaw.trim());
      const stderr = stripAnsi(stripPowerShellStartupProgress(stderrRaw.trim()));
      // 超量输出落盘不硬截：>30k 的 stdout/stderr 全文进 tmp 文件，返回体只
      // 带头尾预览+文件路径（模型要全文用 read_file）。烧穿上下文的命令输出
      // 不该让模型看不见全貌——CC 同款形态。
      const stdoutView = spillOversizeOutput(stdout, 'stdout');
      const stderrView = spillOversizeOutput(stderr, 'stderr');

      const result: Record<string, unknown> = { stdout: stdoutView.text, stderr: stderrView.text, exitCode };
      if (stdoutView.spillFile || stderrView.spillFile) {
        result.outputFiles = [stdoutView.spillFile, stderrView.spillFile].filter(Boolean);
      }

      // Exit code is the single source of truth for success: a command that
      // printed output but exited non-zero FAILED (a failed `npm install` or
      // `cargo build`). Report it as such so the LLM and the failure policy
      // can react instead of treating the run as successful. stderr stays in
      // the result (and the error message) so the model sees what went wrong.
      // 良性例外（CC 同款白名单）：grep/rg/find/diff/test/[ 与 `git diff|grep`
      // 的 exit 1 语义是「无匹配/有差异」，不是执行失败——按失败报会把
      // 「没找到」烧进失败策略。只有 exit 1 豁免，exit ≥2 仍是真失败。
      if (exitCode !== 0 && !isBenignNoMatchExit(command, exitCode)) {
        return {
          id: `tool_${Date.now()}`,
          toolName: 'execute_command',
          result,
          error: formatCommandError(exitCode, [stdoutView.text, stderrView.text ? `[stderr]\n${stderrView.text}` : ''].filter(Boolean).join('\n')),
          success: false,
          duration: Date.now() - start,
        };
      }
      if (exitCode !== 0) {
        result.note = `exit ${exitCode} treated as success (no-match / difference semantics for this command family)`;
      }
      return {
        id: `tool_${Date.now()}`,
        toolName: 'execute_command',
        result,
        success: true,
        duration: Date.now() - start,
      };
    } catch (err: any) {
      if (err?.name === 'AbortError') {
        return this.fail(null, start, `Command timed out after ${timeoutMs}ms`);
      }
      return this.fail(null, start, err?.message ?? 'Command execution failed');
    } finally {
      abort.cleanup();
    }
  }

  /**
   * background:true — start a long-lived process detached and return at once.
   * The wrapper script redirects all output into a temp log file, so the
   * spawned child holds no pipes back to us: it survives this process exiting
   * AND survives turn aborts (a server must keep serving after the task ends).
   * Deliberately NOT wired to `signal` for the same reason.
   */
  private async handleBackgroundCommand(command: string, cwd: string, start: number): Promise<ToolResult> {
    const plan = buildBackgroundLaunchPlan(command, { isWindows: IS_WINDOWS });
    // The plan's Windows paths are %TEMP% literals — placeholders for the
    // Tauri/PowerShell channel where $env:TEMP resolves ON the target machine
    // at launch time. This adapter runs in a real Node/Bun process and writes
    // + reports those files DIRECTLY, so it must expand them here (writing to
    // a literal `%TEMP%\...` path fails with ENOENT).
    const winTemp = IS_WINDOWS ? tmpdir() : '';
    let scriptFile = plan.scriptFile;
    let logFile = plan.logFile;
    if (!IS_WINDOWS) {
      writeFileSync(scriptFile, buildWrapperScript(command, logFile), { mode: 0o755 });
    } else {
      // Node path runs cmd.exe (the plan's .ps1 file is only for the Tauri
      // incantation), so generate the cmd wrapper under its own name.
      scriptFile = scriptFile.replace(/^%TEMP%/, winTemp).replace(/\.ps1$/, '.cmd');
      logFile = logFile.replace(/^%TEMP%/, winTemp);
      writeFileSync(scriptFile, buildWrapperScript(command, logFile, { isWindows: true }));
    }
    const shellArgs = IS_WINDOWS ? [windowsSystemShell('cmd.exe'), '/c', scriptFile] : ['sh', scriptFile];
    // 与上面的主路同因：Bun.spawn 在 Windows 无法启动进程，走 node 的 spawn
    // （detached + stdio ignore + unref，子进程脱离本进程存活，语义不变）。
    try {
      const child = spawn(shellArgs[0]!, shellArgs.slice(1), {
        cwd,
        env: IS_WINDOWS ? undefined : { ...process.env, PATH: extendedProbePath() },
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
      });
      child.unref();
      // 会话任务登记：pid 入表（task_list/task_kill 的数据源）。指引已由
      // buildBackgroundResult 的 hint 单源携带（两侧适配器同文）。
      const pid = child.pid ?? null;
      if (pid !== null) registerTask(pid, command, logFile);
      return {
        id: `tool_${Date.now()}`,
        toolName: 'execute_command',
        result: buildBackgroundResult(pid, logFile),
        success: true,
        duration: Date.now() - start,
      };
    } catch (err: any) {
      return this.fail(null, start, `background launch failed: ${err?.message ?? err}`, 'execute_command');
    }
  }

  /** 会话后台任务列表（task_list）：registry 逐 pid 探活，死任务顺手清账。 */
  private async handleTaskList(start: number): Promise<ToolResult> {
    const tasks = await listTasks((pid) => {
      try {
        process.kill(pid, 0);
        return true;
      } catch (err: any) {
        return err?.code === 'EPERM'; // EPERM=进程在但无权信号，也算活着
      }
    });
    return {
      id: `tool_${Date.now()}`,
      toolName: 'task_list',
      result: { tasks, count: tasks.length },
      success: true,
      duration: Date.now() - start,
    };
  }

  /** 停掉一个本会话起的后台任务（task_kill）。Unix 优先杀进程组（负 pid——
   * detached spawn 自成组，wrapper 里的 dev server 是孙进程，单杀 wrapper 会
   * 留孤儿），失败退化为单进程；Windows 走 taskkill /T /F（tree kill，等价
   * 组杀）。进程已不在时不算失败：清理掉登记项即达成目的。 */
  private async handleTaskKill(args: Record<string, unknown>, start: number): Promise<ToolResult> {
    const pid = Number(args.pid);
    if (!Number.isInteger(pid) || pid <= 0) {
      return this.fail(null, start, 'task_kill requires a positive integer pid — call task_list first');
    }
    try {
      if (IS_WINDOWS) {
        const code = await new Promise<number>((resolve) => {
          const tk = spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
          tk.on('exit', (c) => resolve(c ?? -1));
          tk.on('error', () => resolve(-1));
        });
        if (code !== 0) {
          // taskkill 找不到进程时 exit 128——同样按「已不在」收账。
          unregisterTask(pid);
          return {
            id: `tool_${Date.now()}`,
            toolName: 'task_kill',
            result: { pid, killed: false, note: 'process not running (removed from task list)' },
            success: true,
            duration: Date.now() - start,
          };
        }
      } else {
        try {
          process.kill(-pid, 'SIGTERM');
        } catch {
          process.kill(pid, 'SIGTERM');
        }
      }
      unregisterTask(pid);
      return {
        id: `tool_${Date.now()}`,
        toolName: 'task_kill',
        result: { pid, killed: true, note: 'SIGTERM sent' },
        success: true,
        duration: Date.now() - start,
      };
    } catch (err: any) {
      if (err?.code === 'ESRCH') {
        unregisterTask(pid);
        return {
          id: `tool_${Date.now()}`,
          toolName: 'task_kill',
          result: { pid, killed: false, note: 'process not running (removed from task list)' },
          success: true,
          duration: Date.now() - start,
        };
      }
      return this.fail(null, start, `task_kill failed: ${err?.message ?? err}`);
    }
  }

  private async handleCreateDirectory(args: Record<string, unknown>, start: number): Promise<ToolResult> {
    const pathArg = String(args.path);
    const dirPath = await this.resolve(pathArg);
    const batch = await this.captureWriteBatch('create_directory', [pathArg]);

    await mkdir(dirPath, { recursive: true });
    if (!batch.entries[0]?.existed) await this.tryFinishWriteBatch(batch, [pathArg]);

    return {
      id: `tool_${Date.now()}`,
      toolName: 'create_directory',
      result: `Created directory: ${String(args.path)}`,
      success: true,
      duration: Date.now() - start,
    };
  }

  // create_document 的 Node 侧执行路径（此前只下发不执行，调用必得
  // "Unknown tool"）。GUI 侧经 save_file_binary（IPC + base64 + Rust 落盘），
  // Node 在本进程内直接生成并写盘，参数形状与结果报告文案与 GUI 保持同构
  // ——模型在两端看到同一工具契约。
  private async handleCreateDocument(args: Record<string, unknown>, start: number): Promise<ToolResult> {
    const format = typeof args.format === 'string' ? args.format.trim() : '';
    const pathArg = typeof args.path === 'string' ? args.path.trim() : '';
    if (!format || !pathArg) {
      return {
        id: `tool_${Date.now()}`,
        toolName: 'create_document',
        error: 'create_document: format 与 path 为必填字段',
        success: false,
        duration: Date.now() - start,
      };
    }

    const bytes = await generateDocument(format, args.spec);
    // 相对路径锚定语义与 Rust resolve_document_path 一致（见该函数注释）；
    // 落点再过 this.resolve 拿 symlink 之后的真实路径。报告必须用落盘实路径
    // ——用模型输入报就是「卡片在、文件不在」的 2026-10-11 bug 类。
    // 报告文案走 normalize：Windows 下 this.resolve 保留输入里的正斜杠，
    // 报出去 C:\…\docs/报表.xlsx 混分隔符（2026-11-05 CI 判例）——normalize
    // 给平台原生形态，指向同一文件，落盘语义不变。
    const target = normalize(await this.resolve(resolveDocumentPath(pathArg, this.workspaceGiven ? this.workspace : '', this.homeDir)));
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, bytes);

    return {
      id: `tool_${Date.now()}`,
      toolName: 'create_document',
      result: `文档已生成：${target}（${format.toUpperCase()}，${(bytes.length / 1024).toFixed(1)} KB）`,
      success: true,
      duration: Date.now() - start,
    };
  }

  private async handleDiffFiles(args: Record<string, unknown>, signal: AbortSignal | undefined, start: number): Promise<ToolResult> {
    const pathA = await this.resolve(String(args.pathA));
    const pathB = await this.resolve(String(args.pathB));
    // Diff can hang on huge files or network-mounted workspaces (a stuck NFS
    // read blocks forever) — bound it with the same timeout/abort treatment as
    // the other subprocess tools instead of stalling the whole agent loop.
    const abort = createAbortController(signal, this.commandTimeout);

    try {
      // Windows ships no `diff`; fall back to `git diff --no-index` (Git for
      // Windows ships git.exe) with the same exit-code convention.
      let proc;
      try {
        proc = Bun.spawn(['diff', '-u', pathA, pathB], {
          cwd: this.workspace,
          stdout: 'pipe',
          stderr: 'pipe',
          signal: abort.signal,
        });
      } catch {
        proc = Bun.spawn(['git', 'diff', '--no-index', '--', pathA, pathB], {
          cwd: this.workspace,
          stdout: 'pipe',
          stderr: 'pipe',
          signal: abort.signal,
        });
      }

      const stdout = await new Response(proc.stdout).text();
      const stderr = await new Response(proc.stderr).text();
      await proc.exited;

      // A killed process may exit non-zero without throwing AbortError —
      // report the real reason (timeout vs caller cancel) explicitly.
      if (abort.signal.aborted) {
        const message = signal?.aborted
          ? 'diff_files cancelled by the caller'
          : `diff_files timed out after ${this.commandTimeout}ms`;
        return this.fail(null, start, message);
      }

      if (proc.exitCode === 0) {
        return {
          id: `tool_${Date.now()}`,
          toolName: 'diff_files',
          result: '(files are identical)',
          success: true,
          duration: Date.now() - start,
        };
      }

      if (proc.exitCode === 1) {
        return {
          id: `tool_${Date.now()}`,
          toolName: 'diff_files',
          result: stdout.trim() || '(files differ)',
          success: true,
          duration: Date.now() - start,
        };
      }

      return this.fail(null, start, stderr.trim() || `diff failed with exit code ${proc.exitCode}`);
    } catch (err: any) {
      if (err?.name === 'AbortError') {
        const message = signal?.aborted
          ? 'diff_files cancelled by the caller'
          : `diff_files timed out after ${this.commandTimeout}ms`;
        return this.fail(null, start, message);
      }
      return this.fail(null, start, err?.message ?? 'diff failed');
    } finally {
      abort.cleanup();
    }
  }

  private async handleResearcherWeb(args: Record<string, unknown>, signal: AbortSignal | undefined, start: number): Promise<ToolResult> {
    const prompt = String(args.prompt ?? args.query ?? '').trim();
    return this.runResearch(prompt, 'researcher_web', args, signal, start);
  }

  private async handleResearcherDocs(args: Record<string, unknown>, signal: AbortSignal | undefined, start: number): Promise<ToolResult> {
    const library = String(args.library ?? '').trim();
    const topic = String(args.topic ?? '').trim();
    const version = typeof args.version === 'string' ? args.version.trim() : '';
    const query = [library, topic, version, 'official documentation API reference'].filter(Boolean).join(' ');
    return this.runResearch(query, 'researcher_docs', args, signal, start, { library, topic, version });
  }

  private async runResearch(
    query: string,
    kind: 'researcher_web' | 'researcher_docs',
    args: Record<string, unknown>,
    signal: AbortSignal | undefined,
    start: number,
    context: { library?: string; topic?: string; version?: string } = {},
  ): Promise<ToolResult> {
    if (!query) return this.fail(null, start, 'Research prompt/query must not be empty', kind);
    const requestedSources = typeof args.maxSources === 'number' && Number.isFinite(args.maxSources)
      ? Math.min(8, Math.max(1, Math.floor(args.maxSources)))
      : 5;
    const maxChars = typeof args.maxCharsPerSource === 'number' && Number.isFinite(args.maxCharsPerSource)
      ? Math.min(12000, Math.max(500, Math.floor(args.maxCharsPerSource)))
      : 4000;
    const allowedDomains = Array.isArray(args.allowedDomains)
      ? args.allowedDomains.map(String).map((domain) => domain.trim().toLowerCase()).filter(Boolean)
      : [];
    const search = await this.runSearchTool(query, Math.min(20, Math.max(requestedSources, requestedSources * 2)), 'web_search', start);
    if (!search.success) return { ...search, toolName: kind };

    const rawSources = parseWebSearchText(typeof search.result === 'string' ? search.result : '');
    const filteredSources = filterResearchSources(rawSources, allowedDomains);
    const filtered = rawSources.length - filteredSources.length;
    let sources = filteredSources;
    const failed: string[] = [];
    const fetchContent = args.fetchContent !== false;
    const selected = sources.slice(0, requestedSources);
    if (fetchContent) {
      const enriched = await Promise.all(selected.map(async (source): Promise<ResearchSource> => {
        const page = await this.handleWebFetch({ url: source.url, maxChars }, signal, Date.now());
        if (!page.success) {
          failed.push(`${source.url}: ${page.error ?? 'fetch failed'}`);
          return source;
        }
        return { ...source, content: typeof page.result === 'string' ? page.result : String(page.result ?? '') };
      }))
      .catch((error) => {
        failed.push(error instanceof Error ? error.message : String(error));
        return selected;
      });
      sources = enriched;
    } else {
      sources = selected;
    }

    if (sources.length === 0) {
      const detail = allowedDomains.length > 0
        ? `No usable research sources matched the allowed domains: ${allowedDomains.join(', ')}`
        : 'No usable research sources were returned by the available search backends';
      return this.fail(null, start, `${detail}. Rephrase the query or broaden the allowed domain list; do not repeat the unchanged query.`, kind);
    }

    const result = makeResearchPayload(kind, query, sources, {
      failed,
      filtered,
      officialVerified: kind === 'researcher_docs'
        ? sources.some((source) => isOfficialDocumentationSource(context.library ?? '', source.url))
        : undefined,
      versionMatched: kind === 'researcher_docs' && context.version
        ? sources.some((source) => `${source.url} ${source.snippet} ${source.content ?? ''}`.includes(context.version!))
        : kind === 'researcher_docs',
      truncated: filteredSources.length > selected.length,
      ...context,
    });
    return {
      id: `tool_${Date.now()}`,
      toolName: kind,
      result,
      success: true,
      duration: Date.now() - start,
    };
  }

  private async handleCodeSearcher(args: Record<string, unknown>, signal: AbortSignal | undefined, start: number): Promise<ToolResult> {
    const query = String(args.query ?? args.pattern ?? '').trim();
    if (!query) return this.fail(null, start, 'code_searcher query must not be empty', 'code_searcher');
    const searchDir = await this.resolve(String(args.path || '.'));
    const workspaceRoot = realpathSync(this.workspace);
    const scope = pathRelative(workspaceRoot, searchDir) || '.';
    const perFile = typeof args.maxResults === 'number' && Number.isFinite(args.maxResults)
      ? Math.min(100, Math.max(1, Math.floor(args.maxResults)))
      : 15;
    const globalMax = typeof args.globalMaxResults === 'number' && Number.isFinite(args.globalMaxResults)
      ? Math.min(1000, Math.max(1, Math.floor(args.globalMaxResults)))
      : 250;
    const timeoutSeconds = typeof args.timeoutSeconds === 'number' && Number.isFinite(args.timeoutSeconds)
      ? Math.min(30, Math.max(1, args.timeoutSeconds))
      : 10;
    // 排除表与 THIRD_PARTY_DIR_NAMES 同源：列目录 / glob / find / rg 四条路
    // 口径一致，三方件默认都在理解范围之外。
    const rgArgs = ['--json', '--no-config', '--line-number', '--color', 'never', '--hidden', '--max-filesize', '8M'];
    for (const dir of THIRD_PARTY_DIR_NAMES) rgArgs.push('--glob', `!**/${dir}/**`);
    if (args.caseSensitive === false) rgArgs.push('--ignore-case');
    if (Array.isArray(args.globs)) {
      for (const glob of args.globs) {
        if (typeof glob === 'string' && glob.trim()) rgArgs.push('--glob', glob.trim());
      }
    }
    rgArgs.push('--', query, scope);

    const abort = createAbortController(signal, timeoutSeconds * 1000);
    try {
      const rgPath = Bun.which('rg');
      if (!rgPath) return this.handleCodeSearcherFallback(query, searchDir, scope, args, start);
      const proc = Bun.spawn([rgPath, ...rgArgs], { cwd: this.workspace, stdout: 'pipe', stderr: 'pipe', signal: abort.signal });
      const matches: Array<{ path: string; line: number; column?: number; text: string }> = [];
      const perFileCounts = new Map<string, number>();
      let truncated = false;
      let buffer = '';
      const decoder = new TextDecoder();
      const consumeLine = (line: string): void => {
        if (!line || truncated) return;
        let event: any;
        try { event = JSON.parse(line); } catch { return; }
        if (event.type !== 'match') return;
        const data = event.data ?? {};
        const rawPath = typeof data.path?.text === 'string' ? data.path.text : '';
        if (!rawPath) return;
        const rawRelativePath = isAbsolute(rawPath) ? pathRelative(workspaceRoot, rawPath) : rawPath;
        // Strip a leading ./ or .\ (ripgrep on Windows reports paths as .\app.ts)
        // and normalize to POSIX separators so the LLM sees subdir/app.ts on
        // every platform (no backslash JSON-escaping in tool output).
        const relativePath = rawRelativePath.replace(/^\.(?:[\\/])/, '').replace(/\\/g, '/');
        const count = perFileCounts.get(relativePath) ?? 0;
        if (count >= perFile) return;
        perFileCounts.set(relativePath, count + 1);
        const submatch = Array.isArray(data.submatches) ? data.submatches[0] : undefined;
        matches.push({
          path: relativePath,
          line: Number(data.line_number ?? 0),
          ...(typeof submatch?.start === 'number' ? { column: submatch.start + 1 } : {}),
          text: typeof data.lines?.text === 'string' ? data.lines.text.replace(/\n$/, '') : '',
        });
        if (matches.length >= globalMax) {
          truncated = true;
          abort.abort();
        }
      };

      const reader = proc.stdout.getReader();
      try {
        while (!truncated) {
          const chunk = await reader.read();
          if (chunk.done) break;
          buffer += decoder.decode(chunk.value, { stream: true });
          const lines = buffer.split('\n');
          buffer = lines.pop() ?? '';
          for (const line of lines) {
            consumeLine(line);
            if (truncated) break;
          }
        }
        if (!truncated) {
          buffer += decoder.decode();
          consumeLine(buffer);
        }
      } catch (error: any) {
        if (!truncated) throw error;
      } finally {
        reader.releaseLock();
      }

      const stderr = await new Response(proc.stderr).text();
      await proc.exited;
      const exitCode = proc.exitCode ?? -1;
      if (!truncated && exitCode !== 0 && exitCode !== 1) {
        return this.fail(null, start, stderr.trim() || `rg failed with exit code ${exitCode}`, 'code_searcher');
      }

      return {
        id: `tool_${Date.now()}`,
        toolName: 'code_searcher',
        result: JSON.stringify({
          kind: 'code_search',
          query,
          scope,
          matches,
          truncated,
          diagnostics: [],
          fileSizeLimitBytes: 8 * 1024 * 1024,
          searchedAt: new Date().toISOString(),
        }),
        success: true,
        duration: Date.now() - start,
      };
    } catch (error: any) {
      if (error?.name === 'AbortError') {
        const message = signal?.aborted
          ? 'code_searcher cancelled by the caller'
          : `code_searcher timed out after ${timeoutSeconds}s`;
        return this.fail(null, start, message, 'code_searcher');
      }
      if (isRipgrepUnavailable(error)) {
        return this.handleCodeSearcherFallback(query, searchDir, scope, args, start);
      }
      return this.fail(null, start, error?.message ?? 'code_searcher failed', 'code_searcher');
    } finally {
      abort.cleanup();
    }
  }

  private async handleCodeSearcherFallback(
    query: string,
    searchDir: string,
    scope: string,
    args: Record<string, unknown>,
    start: number,
  ): Promise<ToolResult> {
    const flags = args.caseSensitive === false ? 'i' : '';
    let matcher: RegExp;
    try {
      matcher = new RegExp(query, flags);
    } catch (error: any) {
      return this.fail(null, start, `Invalid regular expression: ${error?.message ?? String(error)}`, 'code_searcher');
    }
    const perFile = typeof args.maxResults === 'number' && Number.isFinite(args.maxResults)
      ? Math.min(100, Math.max(1, Math.floor(args.maxResults)))
      : 15;
    const globalMax = typeof args.globalMaxResults === 'number' && Number.isFinite(args.globalMaxResults)
      ? Math.min(1000, Math.max(1, Math.floor(args.globalMaxResults)))
      : 250;
    const globs = Array.isArray(args.globs)
      ? args.globs.filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
      : [];
    let globMatchers: Bun.Glob[];
    try {
      globMatchers = globs.map((pattern) => new Bun.Glob(pattern));
    } catch (error: any) {
      return this.fail(null, start, `Invalid code_searcher glob: ${error?.message ?? String(error)}`, 'code_searcher');
    }
    const matches: Array<{ path: string; line: number; column?: number; text: string }> = [];
    const workspaceRoot = realpathSync(this.workspace);
    let truncated = false;

    const searchFile = async (fullPath: string, entry: string): Promise<void> => {
      if (truncated || matches.length >= globalMax) {
        truncated = true;
        return;
      }
      if (/(^|[\\/])(?:\.git|node_modules|dist|build|target)(?:[\\/]|$)/.test(entry)) return;
      const globPath = pathRelative(workspaceRoot, fullPath) || entry;
      if (globMatchers.length > 0 && !globMatchers.some((candidate) => candidate.match(entry) || candidate.match(globPath))) return;

      let canonicalPath: string;
      try {
        const stat = lstatSync(fullPath, { throwIfNoEntry: false });
        if (!stat?.isFile() || stat.isSymbolicLink()) return;
        canonicalPath = realpathSync(fullPath);
      } catch {
        return;
      }

      let text: string;
      try {
        const file = Bun.file(canonicalPath);
        if (file.size > 8 * 1024 * 1024) return;
        text = await file.text();
      } catch {
        return;
      }

      // pathRelative() keeps the platform separator on Windows (subdir\app.ts);
      // normalize to POSIX so path fields stay consistent across platforms.
      const relativePath = (pathRelative(workspaceRoot, canonicalPath) || entry).replace(/\\/g, '/');
      let fileMatches = 0;
      for (const [index, line] of text.split(/\r?\n/).entries()) {
        if (fileMatches >= perFile) break;
        if (matches.length >= globalMax) {
          truncated = true;
          break;
        }
        const found = line.search(matcher);
        if (found < 0) continue;
        matches.push({ path: relativePath, line: index + 1, column: found + 1, text: line });
        fileMatches++;
        if (matches.length >= globalMax) truncated = true;
      }
    };

    try {
      const target = lstatSync(searchDir, { throwIfNoEntry: false });
      if (target?.isFile()) {
        await searchFile(searchDir, scope);
      } else {
        const glob = new Bun.Glob('**/*');
        for await (const entry of glob.scan({ cwd: searchDir, absolute: false, onlyFiles: true, dot: true, followSymlinks: false })) {
          if (truncated) break;
          await searchFile(join(searchDir, entry), entry);
        }
      }
    } catch (error: any) {
      return this.fail(null, start, error?.message ?? 'code_searcher fallback failed', 'code_searcher');
    }

    return {
      id: `tool_${Date.now()}`,
      toolName: 'code_searcher',
      result: JSON.stringify({
        kind: 'code_search',
        query,
        scope,
        matches,
        truncated,
        diagnostics: ['ripgrep unavailable; used the Bun filesystem fallback'],
        fileSizeLimitBytes: 8 * 1024 * 1024,
        searchedAt: new Date().toISOString(),
      }),
      success: true,
      duration: Date.now() - start,
    };
  }

  /**
   * web_search 执行单源（tools/impl/webSearch，P2-5）：本适配器注入原语——
   * fetchPage 用 cliFetch（环境代理路由 + 75% 打通预算），env 读 process.env，
   * cache 读写共享盘上 web-cache.json。三条路径共用：web_search case、
   * researcher_web（直调，跳过 Tier-2 fast path）、web_public_api 的
   * searchOnMiss 升级。
   */
  private async runSearchTool(query: string, maxResults: number, toolName: string, start: number): Promise<ToolResult> {
    const outcome = await runWebSearch(query, maxResults, {
      fetchPage: async (url, init) => {
        const resp = await cliFetch(url, {
          headers: init?.headers,
          method: init?.method,
          body: init?.body,
          redirect: 'follow',
          ...(init?.timeoutMs ? { signal: AbortSignal.timeout(init.timeoutMs) } : {}),
        });
        return {
          status: resp.status,
          finalUrl: resp.url || url,
          contentType: resp.headers.get('content-type') || '',
          setCookie: resp.headers.get('set-cookie'),
          body: new Uint8Array(await resp.arrayBuffer()),
        };
      },
      env: (k) => process.env[k]?.trim() ?? '',
      cacheGet: (key) => webCache().get(key),
      cacheSet: (key, value, ttlMs) => webCache().set(key, value, ttlMs),
    });
    return outcome.ok
      ? { id: `tool_${Date.now()}`, toolName, result: outcome.output, success: true, duration: Date.now() - start }
      : this.fail(null, start, outcome.output, toolName);
  }


  /**
   * The shared "get the page ANYWAY" chain composed by web_fetch and web_scrape:
   *   1. direct fetch (browser headers, transient-error retry, meta-refresh
   *      follow, feed/JSON formatting, direct PDF text extraction)
   *   2. Jina Reader (r.jina.ai) — blocked / JS-heavy / binary pages
   *   3. Wayback Machine — the closest archived snapshot of a dead/blocked page
   *   4. Firecrawl (opt-in FIRECRAWL_API_KEY) — the hardest anti-bot pages
   * Returns { text, via } on success, { hijack } when the direct answer was
   * condemned by the response-hijack verdict, or null when every tier failed, so
   * both callers degrade uniformly instead of failing on the first obstacle.
   */
  private async fetchPageWithFallbacks(
    url: string,
    opts: { selector?: string; signal?: AbortSignal },
  ): Promise<{ text: string; via: string } | { hijack: string } | { httpStatus: number } | null> {
    // P0b 账本：链上每一层是一条 transport（direct / reader / mirror:*），
    // 各自留 Attempt 样本——层的产出与否、耗时多长，是 P1 兜底链证据化的地基。
    const dest = destFromUrl(url, 'web-page', 'html');
    // 1) Direct fetch. 早期 return 多，用 settle 防双记：任何一条出路只入一次账。
    const t0 = Date.now();
    let directSettled = false;
    let directHttpStatus: number | undefined;
    const settleDirect = (ok: boolean, hijack?: boolean): void => {
      if (directSettled) return;
      directSettled = true;
      recordAttempt(dest, {
        transport: 'direct',
        ok,
        ms: Date.now() - t0,
        msScope: 'total',
        ...(hijack ? { failure: 'hijack' as const } : {}),
        ...(!ok && directHttpStatus !== undefined ? { status: directHttpStatus } : {}),
      });
    };
    try {
      const resp = await fetchWithRetry(url, { signal: opts.signal });
      if (!resp.ok && resp.status >= 400 && resp.status < 500) directHttpStatus = resp.status;
      if (resp.ok) {
        const contentType = resp.headers.get('content-type') || '';
        if (/pdf/i.test(contentType) || /\.pdf($|\?)/i.test(url)) {
          // PDF payloads: extract text directly before falling through to the
          // rendering tiers (which can also read PDFs but cost rate-limited
          // free quota).
          const pdfText = await this.extractPdfDirect(await resp.arrayBuffer());
          if (pdfText) {
            settleDirect(true);
            return { text: pdfText, via: 'pdf' };
          }
        } else if (isTextualContentType(contentType)) {
          let html = await readResponseText(resp);
          // Landing pages that JS-redirect via <meta http-equiv="refresh"> extract
          // to nothing — follow up to 3 hops until the page carries real content.
          let finalUrl = resp.url || url;
          for (let hop = 0; hop < 3; hop++) {
            const target = extractMetaRefreshUrl(html);
            if (!target) break;
            const nextUrl = resolveRedirectTarget(url, target);
            if (nextUrl === url) break;
            const nextResp = await fetchWithRetry(nextUrl, { signal: opts.signal });
            if (!nextResp.ok) break;
            html = await readResponseText(nextResp);
            finalUrl = nextResp.url || nextUrl;
          }
          // 判定排在一切之前，且用的是**抽文本之前**的原始 body。被改写的 200
          // 广告页既不能进正文，也不能进页面缓存：否则上层会把这次“成功”记到 netRoute，
          // 把 direct 路由钉死。Rust 侧同样在 fetch_page_with_follow 里拒绝继续试兜底渲染层。
          const hijack = detectResponseHijack({ requestUrl: url, finalUrl, contentType, body: html });
          if (hijack) {
            settleDirect(false, true);
            return { hijack: hijackErrorMessage(hijack, { requestUrl: url, finalUrl, contentType, body: html }) };
          }
          const text = formatPageBody(html, contentType, opts.selector);
          if (text.trim()) {
            settleDirect(true);
            return { text: text.trim(), via: 'direct' };
          }
        }
      }
    } catch {
      /* fall through to the next tier */
    }
    settleDirect(false); // 404 / 网络异常 / 正文为空——direct 这条路没产出

    // 2) Jina Reader renders blocked / JS-heavy / binary pages as text.
    const jinaT0 = Date.now();
    const jina = await scrapeViaJina(url, process.env.PURE_JINA_API_KEY);
    recordAttempt(dest, { transport: 'reader', ok: !!jina && jina.trim().length > 0, ms: Date.now() - jinaT0, msScope: 'total' });
    if (jina) return { text: jina.trim(), via: 'jina' };

    // 3) Wayback Machine: the closest archived snapshot of a dead/blocked page.
    const waybackT0 = Date.now();
    const wayback = await scrapeViaWayback(url);
    let waybackText: string | null = null;
    if (wayback) {
      const text = formatPageBody(wayback, '', opts.selector);
      if (text.trim()) waybackText = text.trim();
    }
    recordAttempt(dest, { transport: 'mirror:wayback', ok: waybackText !== null, ms: Date.now() - waybackT0, msScope: 'total' });
    if (waybackText) return { text: waybackText, via: 'wayback' };

    // 4) Firecrawl (opt-in key): server-side rendering for the hardest pages.
    const firecrawlT0 = Date.now();
    const firecrawl = await scrapeViaFirecrawl(url, process.env.FIRECRAWL_API_KEY);
    recordAttempt(dest, { transport: 'mirror:firecrawl', ok: !!firecrawl && firecrawl.trim().length > 0, ms: Date.now() - firecrawlT0, msScope: 'total' });
    if (firecrawl) return { text: firecrawl.trim(), via: 'firecrawl' };

    // direct 层亲见的内容性 4xx 必须带出去：404 是「资源不存在」的回答，
    // 上层不该把它当「路挂了」喂熔断器（recordNetFailure 会翻直连记忆）。
    if (directHttpStatus !== undefined) return { httpStatus: directHttpStatus };
    return null;
  }

  /** Direct PDF text: JS extractor first, then the poppler CLI if installed. */
  private async extractPdfDirect(bytes: ArrayBuffer): Promise<string | null> {
    const text = extractPdfText(new Uint8Array(bytes));
    if (text) return text;
    try {
      const tmp = join(tmpdir(), `pure-pdf-${Date.now()}-${Math.random().toString(36).slice(2)}.pdf`);
      await writeFile(tmp, Buffer.from(bytes));
      const viaPoppler = await extractPdfViaPdftotext(tmp);
      await rm(tmp, { force: true }).catch(() => {});
      return viaPoppler;
    } catch {
      return null;
    }
  }

  private async handleWebFetch(args: Record<string, unknown>, signal: AbortSignal | undefined, start: number): Promise<ToolResult> {
    const url = String(args.url);
    const maxChars = typeof args.maxChars === 'number' ? args.maxChars : 20000;

    // Host circuit breaker: a known-dead host fails instantly with a skip
    // directive instead of walking the full fallback chain again.
    if (hostBlocked(url)) {
      return this.fail(null, start, blockedHostMessage(url), 'web_fetch');
    }

    // Page cache: the same URL (with the same selector/maxChars bucket) served
    // within the hour comes from disk — news pages change but an agent loop
    // re-reading the same article mid-task does not need a second fetch.
    const pageKey = pageCacheKey(url, undefined, maxChars);
    const cachedPage = webCache().get(pageKey);
    if (cachedPage !== undefined) {
      return {
        id: `tool_${Date.now()}`,
        toolName: 'web_fetch',
        result: await condenseToolBody(url, args, cachedPage, this.summarizeForExtract),
        success: true,
        duration: Date.now() - start,
      };
    }
    // The full chain (direct + Jina + Wayback + Firecrawl) needs a wider budget
    // than a single direct fetch; the user-cancel signal still aborts it.
    const abort = createAbortController(signal, 60000);

    try {
      const outcome = await this.fetchPageWithFallbacks(url, { signal: abort.signal });
      if (outcome && 'httpStatus' in outcome) {
        // 内容性 4xx：主机可达、资源不存在——不喂熔断器，如实告诉模型状态码。
        return this.fail(null, start, `HTTP ${outcome.httpStatus} — the page does not exist (or is permanently gone). The host itself is reachable; do NOT retry web_fetch on this URL; use researcher_web to find a mirror or a different source.`, 'web_fetch');
      }
      if (!outcome) {
        // The chain failed everywhere: feed the breaker so a repeat visit to
        // this host fails instantly next time.
        const { tripped } = recordNetFailure(url);
        return this.fail(
          null,
          start,
          tripped
            ? blockedHostMessage(url, 'Fetch failed on all tiers (direct / Jina Reader / Wayback / Firecrawl)')
            : `Fetch failed on all tiers (direct / Jina Reader / Wayback / Firecrawl) — the page is blocked, removed, or requires interactive rendering. Do NOT retry web_fetch on this URL; use researcher_web to find a mirror or a different source.`,
          'web_fetch',
        );
      }
      // 被判定为劫持：不记成功、不进缓存，并把这次失败记给熔断器——
      // recordNetFailure 让 netRoute 把 direct 翻面（走代理），那才是真正能把页面拿回来的路径。
      // 错误文案里必须出现“Network interception”：isNetworkError / classifyFailure 靠它把这次失败归类成网络类。
      if ('hijack' in outcome) {
        recordNetFailure(url);
        return this.fail(null, start, outcome.hijack, 'web_fetch');
      }
      recordNetSuccess(url);
      const truncated = outcome.text.length > maxChars ? outcome.text.slice(0, maxChars) + '\n\n[truncated]' : outcome.text;
      webCache().set(pageKey, truncated || '(empty page)', PAGE_TTL_MS);

      return {
        id: `tool_${Date.now()}`,
        toolName: 'web_fetch',
        result: await condenseToolBody(url, args, truncated || '(empty page)', this.summarizeForExtract),
        success: true,
        duration: Date.now() - start,
      };
    } finally {
      abort.cleanup();
    }
  }

  // ── download_file: 资源下载（多线程加速 / 断点续传 / 暂停 / 失败换方式重试）──
  // 通过 downloadHub 上报实时进度并接收暂停/继续/取消指令；引擎只在完成时回传
  // 一个 ToolResult，所以进度用独立通道推给 GUI。

  /** Browser-like request headers for a download: UA + Accept, a same-origin
   * Referer (many CDNs / hotlink-protected hosts reject referer-less clients)
   * and any cookies the shared jar holds for the host. */
  private downloadHeaders(url: string, extra?: Record<string, string>): Record<string, string> {
    const headers: Record<string, string> = { 'User-Agent': BROWSER_UA, Accept: '*/*' };
    const referer = refererFor(url);
    if (referer) headers.Referer = referer;
    const cookies = cookieHeaderFor(url);
    if (cookies) headers.Cookie = cookies;
    return { ...headers, ...(extra ?? {}) };
  }
  /** 下载专用：显式 proxy 参数优先，其次环境变量。 */
  private resolveDownloadProxy(targetUrl: string, proxyArg?: string): { proxy: string; bypass: boolean } {
    let proxy = (proxyArg && proxyArg.trim()) || '';
    if (!proxy) {
      for (const key of ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy', 'ALL_PROXY', 'all_proxy']) {
        const v = process.env[key]?.trim();
        if (v) {
          proxy = v;
          break;
        }
      }
    }
    const noProxy = process.env['NO_PROXY'] || process.env['no_proxy'] || '';
    let host = '';
    try {
      host = new URL(targetUrl).hostname;
    } catch {
      /* ignore malformed url */
    }
    const bypass = !proxy || isPrivateHost(host) || hostMatchesNoProxy(host, noProxy);
    return { proxy: bypass ? '' : proxy, bypass };
  }

  private requestOnce(
    urlStr: string,
    opts: { method?: string; headers?: Record<string, string>; signal?: AbortSignal },
    proxy?: string,
  ): Promise<http.IncomingMessage> {
    return new Promise((resolve, reject) => {
      let u: URL;
      try {
        u = new URL(urlStr);
      } catch {
        reject(new Error(`无效 URL: ${urlStr}`));
        return;
      }
      const headers = this.downloadHeaders(urlStr, opts.headers);
      const onResponse = (res: http.IncomingMessage): void => {
        const status = res.statusCode ?? 0;
        if (status >= 300 && status < 400 && res.headers.location) {
          res.resume();
          const next = new URL(res.headers.location, u).toString();
          this.requestOnce(next, opts, proxy).then(resolve, reject);
          return;
        }
        resolve(res);
      };
      const pu = proxy ? parseProxy(proxy) : null;
      // SOCKS 代理原生请求无法处理 —— 返回明确错误，让下载链回退到 curl/aria2c。
      if (pu === 'socks') {
        reject(new Error('SOCKS 代理需由 curl/aria2c 处理'));
        return;
      }
      if (pu && u.protocol === 'http:') {
        // HTTP-over-HTTP 正向代理：请求行带绝对 URL，Host 指向目标主机。
        const req = http.request(
          {
            protocol: pu.url.protocol,
            host: pu.url.hostname,
            port: pu.url.port || (pu.url.protocol === 'https:' ? 443 : 80),
            method: opts.method ?? 'GET',
            path: urlStr,
            headers: { ...headers, Host: u.host },
            signal: opts.signal,
          },
          onResponse,
        );
        req.setTimeout(60_000, () => req.destroy(new Error('下载超时（长时间无数据）')));
        req.on('error', reject);
        req.end();
        return;
      }
      if (pu && u.protocol === 'https:') {
        // HTTPS 经 HTTP 代理：先 CONNECT 隧道，再在隧道上做 TLS 握手。
        const connectReq = http.request({
          host: pu.url.hostname,
          port: pu.url.port || (pu.url.protocol === 'https:' ? 443 : 80),
          method: 'CONNECT',
          path: `${u.hostname}:${u.port || 443}`,
          headers: { Host: `${u.hostname}:${u.port || 443}` },
          signal: opts.signal,
        });
        connectReq.on('connect', (res, socket) => {
          if ((res.statusCode ?? 0) !== 200) {
            socket.destroy();
            reject(new Error(`代理 CONNECT 失败（${res.statusCode}）`));
            return;
          }
          const agent = new https.Agent({});
          // 在 CONNECT 隧道上复用 socket 做 TLS 握手（原生 AgentOptions 类型未暴露
          // createConnection，运行时 http.Agent 支持）。
          (agent as unknown as { createConnection: () => tls.TLSSocket }).createConnection = () =>
            tls.connect({ socket, servername: u.hostname, rejectUnauthorized: true });
          const req = https.request(
            {
              host: u.hostname,
              port: u.port || 443,
              path: u.pathname + u.search,
              method: opts.method ?? 'GET',
              headers,
              agent,
              signal: opts.signal,
            },
            onResponse,
          );
          req.setTimeout(60_000, () => req.destroy(new Error('下载超时（长时间无数据）')));
          req.on('error', reject);
          req.end();
        });
        connectReq.on('error', reject);
        connectReq.end();
        return;
      }
      // 直连（内网或无需代理）。
      const lib = u.protocol === 'https:' ? https : http;
      const req = lib.request(
        u,
        {
          method: opts.method ?? 'GET',
          headers,
          signal: opts.signal,
        },
        onResponse,
      );
      req.setTimeout(60_000, () => req.destroy(new Error('下载超时（长时间无数据）')));
      req.on('error', reject);
      req.end();
    });
  }

  private async getHead(url: string, signal?: AbortSignal, proxy?: string): Promise<{ length: number; acceptRanges: boolean; disposition?: string }> {
    try {
      const res = await this.requestOnce(url, { method: 'HEAD', signal }, proxy);
      if ((res.statusCode ?? 0) >= 400) {
        res.resume();
        const r2 = await this.requestOnce(url, { method: 'GET', headers: { Range: 'bytes=0-0' }, signal }, proxy);
        const len = Number((r2.headers['content-range']?.split('/')[1] ?? r2.headers['content-length'] ?? 0) || 0);
        const ar = r2.headers['accept-ranges'] === 'bytes' || !!r2.headers['content-range'];
        const disposition = parseContentDispositionFilename(r2.headers['content-disposition']);
        r2.resume();
        return { length: len, acceptRanges: ar, disposition };
      }
      const len = Number(res.headers['content-length'] ?? 0) || 0;
      const ar = res.headers['accept-ranges'] === 'bytes';
      const disposition = parseContentDispositionFilename(res.headers['content-disposition']);
      res.resume();
      return { length: len, acceptRanges: ar, disposition };
    } catch {
      return { length: -1, acceptRanges: false };
    }
  }

  private async getRangeBuffer(url: string, start: number, end: number, signal?: AbortSignal, proxy?: string): Promise<Buffer> {
    const res = await this.requestOnce(url, { method: 'GET', headers: { Range: `bytes=${start}-${end}` }, signal }, proxy);
    const status = res.statusCode ?? 200;
    if (status >= 400) {
      res.resume();
      throw new Error(`HTTP ${status}`);
    }
    // 服务器无视 Range 回 200 全量 body：喂进分块会把整个文件写错位。报错
    // 让分块路径下走兜底链——单流与外部工具都天然兼容 200。
    if (status !== 206) {
      res.resume();
      throw new Error(`HTTP ${status}（服务器未按 Range 返回分片）`);
    }
    const chunks: Buffer[] = [];
    for await (const c of res as unknown as AsyncIterable<Buffer>) chunks.push(c as Buffer);
    return Buffer.concat(chunks);
  }

  /** Single-connection streaming download with pause/resume + resume support. */
  private async streamRange(
    url: string,
    outPath: string,
    startOffset: number,
    controller: DownloadController,
    emit: (p: Partial<DownloadProgress>) => void,
    total: number,
    filename: string,
    proxy?: string,
  ): Promise<number> {
    const fd = await open(outPath, startOffset > 0 ? 'r+' : 'w');
    let written = startOffset;
    let lastEmit = Date.now();
    let lastBytes = written;
    try {
      while (!controller.aborted) {
        if (controller.paused) {
          await controller.waitWhilePaused();
          if (controller.aborted) break;
        }
        const headers: Record<string, string> = {};
        if (written > 0) headers.Range = `bytes=${written}-`;
        let res: http.IncomingMessage;
        try {
          res = await this.requestOnce(url, { method: 'GET', headers, signal: controller.signal }, proxy);
        } catch (err) {
          if (controller.paused && !controller.aborted) {
            await controller.waitWhilePaused();
            continue;
          }
          throw err;
        }
        if ((res.statusCode ?? 200) >= 400 && (res.statusCode ?? 200) !== 206) {
          res.resume();
          throw new Error(`HTTP ${res.statusCode}`);
        }
        let stopped = false;
        try {
          for await (const chunk of res as unknown as AsyncIterable<Buffer>) {
            if (controller.paused) {
              stopped = true;
              (res as unknown as { destroy?: () => void }).destroy?.();
              break;
            }
            await fd.write(chunk, 0, chunk.length, written);
            written += chunk.length;
            const now = Date.now();
            if (now - lastEmit > 250 || (total > 0 && written >= total)) {
              const dt = (now - lastEmit) / 1000;
              const speed = dt > 0 ? (written - lastBytes) / dt : 0;
              lastEmit = now;
              lastBytes = written;
              emit({ downloaded: written, total, percent: total > 0 ? Math.min(100, Math.floor((written / total) * 100)) : -1, speed, state: controller.paused ? 'paused' : 'downloading', filename });
            }
          }
        } catch (err) {
          res.resume();
          if (controller.paused && !controller.aborted) {
            await controller.waitWhilePaused();
            continue;
          }
          throw err;
        }
        if (stopped) continue;
        break;
      }
    } finally {
      await fd.close();
    }
    return written;
  }

  /** Parallel chunked download (aria2-like) with per-chunk pause/resume. */
  private async downloadChunked(
    url: string,
    outPath: string,
    total: number,
    connections: number,
    controller: DownloadController,
    emit: (p: Partial<DownloadProgress>) => void,
    filename: string,
    proxy?: string,
  ): Promise<number> {
    const chunkSize = Math.ceil(total / connections);
    const fd = await open(outPath, 'w');
    // fd 生命周期收口（2026-10 审计 P0）：任何一条路径都必须关掉句柄，且
    // 关闭后残余 worker 的迟到写入必须被丢弃——否则 fallback 会与幽灵
    // worker 双写同一文件，产出静默损坏。
    let fdOpen = true;
    const closeOnce = async (): Promise<void> => {
      if (!fdOpen) return;
      fdOpen = false;
      await fd.close();
    };
    const done = new Array<boolean>(connections).fill(false);
    let written = 0;
    let firstError: unknown;
    // runOne 不向外抛：错误记进 firstError，让 Promise.all 等全部 worker 落
    // 定。早退会把残余 worker 挂在无人 await 的 promise 上，fd 关闭后还在写。
    const runOne = async (i: number): Promise<void> => {
      if (done[i]) return;
      const s = i * chunkSize;
      const e = Math.min(total - 1, s + chunkSize - 1);
      let buf: Buffer;
      try {
        buf = await this.getRangeBuffer(url, s, e, controller.signal, proxy);
      } catch (err) {
        if (controller.paused && !controller.aborted) return;
        firstError ??= err;
        return;
      }
      // 短供分片（206 但字节数不足）：照单全收会让 done 标记虚真、written
      // 虚报，最终以「成功」落一个带洞文件。判错走失败路径，由兜底链重下。
      if (buf.length !== e - s + 1) {
        firstError ??= new Error(`分片 ${i} 短供：要 ${e - s + 1} 字节，实得 ${buf.length}`);
        return;
      }
      try {
        await fd.write(buf, 0, buf.length, s);
      } catch (err) {
        if (!fdOpen) return; // 关闭后的迟到写入：下载已在失败收场，静默丢弃
        firstError ??= err;
        return;
      }
      done[i] = true;
      written += buf.length;
      emit({ downloaded: written, total, percent: Math.min(100, Math.floor((written / total) * 100)), state: controller.paused ? 'paused' : 'downloading', filename });
    };
    try {
      const workers: Promise<void>[] = [];
      for (let i = 0; i < connections; i++) workers.push(runOne(i));
      await Promise.all(workers);
      // 重试环只在没有真实错误时进入；出错后已决定整体失败，继续重试只会
      // 把失败拖成死循环。
      while (done.includes(false) && !controller.aborted && !firstError) {
        if (controller.paused) await controller.waitWhilePaused();
        if (controller.aborted) break;
        for (let i = 0; i < connections; i++) if (!done[i]) await runOne(i);
      }
    } finally {
      await closeOnce();
    }
    if (firstError) throw firstError;
    if (controller.aborted && done.includes(false)) throw new Error('已取消');
    // 成功路径 written === total（每片都验过字节数）；返回真实写入量，
    // 不再拿 total 虚报。
    return written;
  }

  private async downloadNative(
    url: string,
    outPath: string,
    opts: { connections: number; resume: boolean; controller: DownloadController; emit: (p: Partial<DownloadProgress>) => void; filename: string; proxy?: string },
  ): Promise<{ ok: boolean; size?: number; via?: string; error?: string; expected?: number }> {
    try {
      const head = await this.getHead(url, opts.controller.signal, opts.proxy);
      const total = head.length ?? -1;
      const expected = total > 0 ? total : undefined;
      let startOffset = 0;
      if (opts.resume) {
        try {
          const st = await stat(outPath);
          startOffset = st.size;
          if (total > 0 && startOffset >= total) return { ok: true, size: startOffset, via: 'native-resume', expected };
        } catch {
          /* no partial yet */
        }
      }
      const canRange = head.acceptRanges && total > 0;
      const chunked = canRange && total > 1024 * 1024 && opts.connections > 1 && startOffset === 0;
      if (chunked) {
        try {
          const size = await this.downloadChunked(url, outPath, total, opts.connections, opts.controller, opts.emit, opts.filename, opts.proxy);
          return { ok: true, size, via: 'native-chunked', expected };
        } catch (e: unknown) {
          // 分块失败留下的是稀疏带洞文件：已写分片推高文件尺寸、洞在中途。
          // 所有兜底（curl -C -/wget -c/streamRange）都按尺寸续传，只补尾部
          // 不补洞；尺寸一旦填满 total，兜底拿到的 416 还会被当「无需续传」，
          // 带洞文件就此标成下载成功。删掉残缺件，所有兜底从零开始。
          await unlink(outPath).catch(() => {});
          if (opts.controller.paused || opts.controller.aborted) {
            const size = await this.streamRange(url, outPath, 0, opts.controller, opts.emit, total, opts.filename, opts.proxy);
            // 取消不再走成功路径：abort 下的 streamRange 立即返回 0，报 ok
            // 会把「用户取消」虚报成 0 字节成功。
            if (opts.controller.aborted && !opts.controller.paused) return { ok: false, error: (e as Error)?.message || '已取消' };
            return { ok: true, size, via: 'native-resume', expected };
          }
          return { ok: false, error: (e as Error)?.message };
        }
      }
      const size = await this.streamRange(url, outPath, startOffset, opts.controller, opts.emit, total, opts.filename, opts.proxy);
      return { ok: true, size, via: startOffset > 0 ? 'native-resume' : 'native', expected };
    } catch (e: unknown) {
      return { ok: false, error: (e as Error)?.message };
    }
  }

  /** Infer a download file name: URL basename first, refined by the server's
   * Content-Disposition header when present (best-effort, 8s budget). */
  private async inferDownloadFilename(url: string, proxy?: string): Promise<string> {
    let filename = '';
    try {
      filename = decodeURIComponent(new URL(url).pathname.split('/').pop() || '');
    } catch {
      /* ignore */
    }
    try {
      const head = await this.getHead(url, AbortSignal.timeout(8000), proxy);
      if (head.disposition) filename = head.disposition;
    } catch {
      /* best-effort */
    }
    filename = (filename || 'download').replace(/[^\w.\-一-龥]+/g, '_');
    return filename || 'download';
  }

  private commandExists(cmd: string): Promise<boolean> {
    return new Promise((resolve) => {
      const probe = spawn(process.platform === 'win32' ? 'where' : 'which', [cmd]);
      probe.on('error', () => resolve(false));
      probe.on('close', (code) => resolve(code === 0));
    });
  }

  /** 为 curl/aria2c/wget 构造带代理的环境变量（直连时返回 undefined，沿用原环境）。 */
  private proxyEnv(proxy?: string): NodeJS.ProcessEnv | undefined {
    if (!proxy) return undefined;
    return {
      ...process.env,
      HTTPS_PROXY: proxy,
      HTTP_PROXY: proxy,
      ALL_PROXY: proxy,
      https_proxy: proxy,
      http_proxy: proxy,
      all_proxy: proxy,
    };
  }

  /** 轮询部分文件大小，向 UI 推送实时进度（curl/aria2c/wget 不原生上报进度，
   * 故通过 stat 落盘文件估算）。返回停止函数。 */
  private startDownloadProgressPoller(
    outPath: string,
    controller: DownloadController,
    emit: (p: Partial<DownloadProgress>) => void,
    filename: string,
  ): () => void {
    const timer = setInterval(() => {
      if (controller.aborted) {
        clearInterval(timer);
        return;
      }
      try {
        const size = statSync(outPath).size;
        emit({ downloaded: size, total: -1, percent: -1, speed: 0, state: 'downloading', filename });
      } catch {
        /* 部分文件尚未创建 */
      }
    }, 300);
    return () => clearInterval(timer);
  }

  private async downloadViaCurl(
    url: string,
    outPath: string,
    opts: { resume: boolean; controller: DownloadController; emit: (p: Partial<DownloadProgress>) => void; filename: string; proxy?: string },
  ): Promise<{ ok: boolean; size?: number; error?: string }> {
    const hasCurl = await this.commandExists('curl');
    if (!hasCurl) return { ok: false, error: 'curl 不可用' };
    return new Promise((resolve) => {
      const args = ['-L', '--retry', '3', '--retry-delay', '1', '-C', '-'];
      if (opts.proxy) args.push('--proxy', opts.proxy);
      args.push('-o', outPath, url);
      const child = spawn('curl', args, { signal: opts.controller.signal, env: this.proxyEnv(opts.proxy) } as { signal: AbortSignal; env: NodeJS.ProcessEnv });
      // Bun 1.4.3 Linux：子进程退出后 stdio 管道里滞留未读数据时，child
      // 'close' 事件永不触发——curl 往 stderr 写的进度条（几百字节）就足以
      // 卡死整条兜底链（2026-10 CI 实证：有 data 监听、-s 静默或 stdio
      // ignore 都正常，唯独有输出且无人读必挂；macOS/Windows 不复现）。
      // resume 排干两侧，close 恢复照常。
      child.stdout?.resume();
      child.stderr?.resume();
      const stop = this.startDownloadProgressPoller(outPath, opts.controller, opts.emit, opts.filename);
      child.on('error', (e) => {
        stop();
        resolve({ ok: false, error: e.message });
      });
      child.on('close', async (code) => {
        stop();
        if (code === 0) {
          try {
            const st = await stat(outPath);
            resolve({ ok: true, size: st.size });
          } catch {
            resolve({ ok: false, error: '无法读取下载文件' });
          }
        } else {
          resolve({ ok: false, error: `curl 退出码 ${code}` });
        }
      });
    });
  }

  private async downloadViaAria2(
    url: string,
    outPath: string,
    opts: { controller: DownloadController; emit: (p: Partial<DownloadProgress>) => void; filename: string; proxy?: string },
  ): Promise<{ ok: boolean; size?: number; error?: string }> {
    const hasAria2 = await this.commandExists('aria2c');
    if (!hasAria2) return { ok: false, error: 'aria2c 不可用' };
    return new Promise((resolve) => {
      const args = [
        '-x', '8', '-s', '8', '-k', '1M', '-c',
        '--max-tries=5', '--timeout=30', '--retry-wait=3',
        '--file-allocation=none', '--console-log-level=warn',
      ];
      if (opts.proxy) args.push('--all-proxy', opts.proxy);
      args.push('-d', dirname(outPath), '-o', basename(outPath), url);
      const child = spawn('aria2c', args, { signal: opts.controller.signal, env: this.proxyEnv(opts.proxy) } as { signal: AbortSignal; env: NodeJS.ProcessEnv });
      // 同 downloadViaCurl：Bun 1.4.3 Linux 下无人读的 stdio 管道会让
      // 'close' 永不触发，aria2c 的控制台输出更多，更是必挂。
      child.stdout?.resume();
      child.stderr?.resume();
      const stop = this.startDownloadProgressPoller(outPath, opts.controller, opts.emit, opts.filename);
      child.on('error', (e) => {
        stop();
        resolve({ ok: false, error: e.message });
      });
      child.on('close', async (code) => {
        stop();
        if (code === 0) {
          try {
            const st = await stat(outPath);
            resolve({ ok: true, size: st.size });
          } catch {
            resolve({ ok: false, error: '无法读取下载文件' });
          }
        } else {
          resolve({ ok: false, error: `aria2c 退出码 ${code}` });
        }
      });
    });
  }

  private async downloadViaWget(
    url: string,
    outPath: string,
    opts: { controller: DownloadController; emit: (p: Partial<DownloadProgress>) => void; filename: string; proxy?: string },
  ): Promise<{ ok: boolean; size?: number; error?: string }> {
    const hasWget = await this.commandExists('wget');
    if (!hasWget) return { ok: false, error: 'wget 不可用' };
    return new Promise((resolve) => {
      const args = ['-c', '-q', '--tries=5', '--timeout=30', '-O', outPath, url];
      const child = spawn('wget', args, { signal: opts.controller.signal, env: this.proxyEnv(opts.proxy) } as { signal: AbortSignal; env: NodeJS.ProcessEnv });
      // 同 downloadViaCurl：Bun 1.4.3 Linux 下无人读的 stdio 管道会让
      // 'close' 永不触发（wget -q 时输出少但残留仍足以踩雷）。
      child.stdout?.resume();
      child.stderr?.resume();
      const stop = this.startDownloadProgressPoller(outPath, opts.controller, opts.emit, opts.filename);
      child.on('error', (e) => {
        stop();
        resolve({ ok: false, error: e.message });
      });
      child.on('close', async (code) => {
        stop();
        if (code === 0) {
          try {
            const st = await stat(outPath);
            resolve({ ok: true, size: st.size });
          } catch {
            resolve({ ok: false, error: '无法读取下载文件' });
          }
        } else {
          resolve({ ok: false, error: `wget 退出码 ${code}` });
        }
      });
    });
  }

  private async downloadViaFetch(
    url: string,
    outPath: string,
    controller: DownloadController,
    emit: (p: Partial<DownloadProgress>) => void,
    proxy?: string,
  ): Promise<{ ok: boolean; size?: number; error?: string }> {
    try {
      const res = await cliFetch(url, { signal: controller.signal, headers: this.downloadHeaders(url) });
      if (!res.ok || !res.body) return { ok: false, error: `HTTP ${res.status}` };
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length > 50 * 1024 * 1024) return { ok: false, error: '文件过大，fetch 兜底仅支持小文件' };
      await writeFile(outPath, buf);
      emit({ downloaded: buf.length, total: buf.length, percent: 100, speed: 0, state: 'done' });
      return { ok: true, size: buf.length };
    } catch (e: unknown) {
      return { ok: false, error: (e as Error)?.message };
    }
  }

  /** 对**单个** URL 跑完整条下载链（native → curl → aria2c → wget → fetch），
   *  返回首个成功或聚合错误。抽出成方法是为了让 S2 改写能在原 URL 与镜像
   *  端点之间复用同一条链，而不是各写一份。 */
  private async downloadChain(
    url: string,
    outPath: string,
    opts: { connections: number; resume: boolean; controller: DownloadController; emit: (p: Partial<DownloadProgress>) => void; filename: string; proxy?: string },
  ): Promise<{ ok: boolean; size?: number; via?: string; error?: string; expected?: number }> {
    const errors: string[] = [];
    const native = await this.downloadNative(url, outPath, opts);
    if (native.ok) return { ...native, via: native.via ?? 'native' };
    errors.push(native.error ?? '');
    const curl = await this.downloadViaCurl(url, outPath, opts);
    if (curl.ok) return { ...curl, via: 'curl' };
    errors.push(curl.error ?? '');
    const aria2 = await this.downloadViaAria2(url, outPath, opts);
    if (aria2.ok) return { ...aria2, via: 'aria2c' };
    errors.push(aria2.error ?? '');
    const wget = await this.downloadViaWget(url, outPath, opts);
    if (wget.ok) return { ...wget, via: 'wget' };
    errors.push(wget.error ?? '');
    const fetched = await this.downloadViaFetch(url, outPath, opts.controller, opts.emit, opts.proxy);
    if (fetched.ok) return { ...fetched, via: 'fetch' };
    errors.push(fetched.error ?? '');
    return { ok: false, error: errors.filter(Boolean).join('；') || '未知错误' };
  }

  private downloadOk(
    outPath: string,
    size: number,
    duration: number,
    via: string,
    toolCallId: string,
    expected?: number,
    rewrite?: { from: string; to: string; rule: string },
  ): ToolResult {
    // Known content-length but a shorter file → the transfer did not complete
    // cleanly; surface it (informational, not a hard failure).
    const sizeMismatch = typeof expected === 'number' && expected > 0 && size < expected;
    const summary: Record<string, unknown> = { kind: 'download', path: outPath, size, durationMs: duration, via };
    if (sizeMismatch) summary.sizeMismatch = true;
    // S2 单请求改写：成功时如实标注「实际是从镜像端点取的」，不让字节等价被
    // 静默默认成「就是原站给的」。
    if (rewrite) summary.rewrite = rewrite;
    downloadHub.emitProgress(toolCallId, { downloaded: size, total: size, percent: 100, speed: 0, state: 'done', filename: basename(outPath), via });
    return { id: toolCallId, toolName: 'download_file', result: JSON.stringify(summary), success: true, duration };
  }

  private async handleDownloadFile(
    args: Record<string, unknown>,
    signal: AbortSignal | undefined,
    start: number,
    toolCallId: string,
  ): Promise<ToolResult> {
    const url = String(args.url ?? '').trim();
    if (!/^https?:\/\//i.test(url)) return this.fail(null, start, '请提供以 http(s):// 开头的下载链接');
    // Host circuit breaker: a known-dead download source fails instantly.
    if (hostBlocked(url)) return this.fail(null, start, blockedHostMessage(url));

    const proxyArg = typeof args.proxy === 'string' ? args.proxy.trim() : '';
    const { proxy } = this.resolveDownloadProxy(url, proxyArg);

    const destination = typeof args.destination === 'string' ? args.destination.trim() : '';
    const filenameArg = typeof args.filename === 'string' ? args.filename.trim() : '';
    const connections = Math.max(1, Math.min(16, Number(args.connections) || 4));
    const resume = args.resume !== false;

    const home = homedir();
    const outDir = resolveDownloadOutDir(destination, home, process.cwd());

    // File name: explicit arg \u2192 URL basename refined by the server's
    // Content-Disposition header (best-effort) \u2192 'download'.
    let filename = filenameArg;
    if (!filename) {
      filename = await this.inferDownloadFilename(url, proxy);
    }
    if (!filename) filename = 'download';
    const outPath = join(outDir, filename);
    await mkdir(outDir, { recursive: true });

    const controller = downloadHub.registerController(toolCallId);
    if (signal) signal.addEventListener('abort', () => controller.abort(), { once: true });
    const emit = (p: Partial<DownloadProgress>): void =>
      downloadHub.emitProgress(toolCallId, { downloaded: 0, total: -1, percent: -1, speed: 0, state: 'downloading', filename, ...p } as DownloadProgress);

    try {
      // 打通优先：先穷尽出口路线的 75% 预算（首选 → 反向 → 首选·退避重试），
      // 镜像只是之后的兜底——不再一上来就绕开目标主机。
      const routePlan = unblockAttemptsBeforeMirror(url, proxy);
      let allErrors = '';
      for (let i = 0; i < routePlan.length; i++) {
        const attempt = routePlan[i]!;
        const chain = await this.downloadChain(url, outPath, { connections, resume, controller, emit, filename, proxy: attempt.proxyUrl });
        if (chain.ok) {
          recordNetOutcome(url, attempt.route, true);
          return this.downloadOk(outPath, chain.size ?? 0, Date.now() - start, chain.via ?? 'native', toolCallId, chain.expected);
        }
        const err = chain.error ?? '';
        allErrors = allErrors ? `${allErrors}；[${attempt.route}${attempt.retry ? '·重试' : ''}] ${err}` : err;
        recordNetOutcome(url, attempt.route, false);
        // 非网络类失败（404/403）：换出口答不出同一份字节，直接收场。
        if (!isNetworkError(err)) break;
      }
      // 出口预算用尽仍不行 → 字节一致的镜像端点兜底（仅限网络类失败）。
      const rw = primaryRewrite(url);
      if (rw && isNetworkError(allErrors)) {
        const chain = await this.downloadChain(rw.url, outPath, { connections, resume, controller, emit, filename, proxy: routePlan[0]!.proxyUrl });
        if (chain.ok) {
          recordNetSuccess(rw.url);
          return this.downloadOk(outPath, chain.size ?? 0, Date.now() - start, chain.via ?? 'native', toolCallId, chain.expected,
            { from: url, to: rw.url, rule: rw.rule });
        }
        allErrors = `${allErrors}；[镜像 ${rw.url}] ${chain.error ?? ''}`;
        // 镜像自己也网络失败：把镜像主机一并计入熔断，下一次别再扑上去。
        if (isNetworkError(chain.error ?? '')) recordNetFailure(rw.url);
      }
      // 全部尝试都失败：移除进度条（失败的下载不应残留进度条，仅成功下载保留）。
      downloadHub.clearProgress(toolCallId);
      allErrors = allErrors || '未知错误';
      if (isNetworkError(allErrors)) {
        const { tripped } = recordNetFailure(url);
        return this.fail(null, start, tripped ? blockedHostMessage(url, allErrors) : netFailureHint(url, allErrors));
      }
      return this.fail(null, start, `下载失败：${allErrors}`);
    } catch (err: unknown) {
      // 异常同样清理进度条。
      downloadHub.clearProgress(toolCallId);
      return this.fail(null, start, `下载异常：${err instanceof Error ? err.message : String(err)}`);
    } finally {
      downloadHub.dispose(toolCallId);
    }
  }

  private async handleWebPublicApi(args: Record<string, unknown>, start: number): Promise<ToolResult> {
    const query = String(args.query ?? '').trim();
    if (!query) return this.fail(null, start, 'web_public_api query must not be empty', 'web_public_api');
    const { outcome, cached } = await cachedDirectPublicApi(
      query,
      typeof args.category === 'string' ? args.category : undefined,
      this.location,
    );
    if (outcome) {
      return {
        id: `tool_${Date.now()}`,
        toolName: 'web_public_api',
        result: `${cached ? '[cached] ' : ''}[${outcome.source}] ${outcome.text}`,
        success: true,
        duration: Date.now() - start,
      };
    }
    // Auto-escalation (L2 → L1): the direct tier had nothing for this query,
    // so fall through to web search instead of forcing a second model
    // round-trip. Opt out with searchOnMiss:false. The result is head-marked
    // so the model knows this output came from search, not a structured
    // source — the tool name alone would mislabel it.
    if (args.searchOnMiss !== false) {
      const search = await this.runSearchTool(query, 8, 'web_public_api', start);
      if (search.success) {
        return {
          ...search,
          result: `[auto-fallback: no structured-data source matched "${query}", served by web search]\n${search.result}`,
        };
      }
    }
    return this.fail(
      null,
      start,
      `No structured-data source matched "${query}" and web search also failed. web_public_api covers weather/geocode/news/wiki/IP/FX/stock/GitHub lookups — for anything else use researcher_web instead of retrying this tool with the same query (auto-fallback to search is off when searchOnMiss:false).`,
      'web_public_api',
    );
  }

  private async handleWebScrape(args: Record<string, unknown>, signal: AbortSignal | undefined, start: number): Promise<ToolResult> {
    const url = String(args.url ?? '').trim();
    if (!url) return this.fail(null, start, 'web_scrape url must not be empty', 'web_scrape');
    const selector = typeof args.selector === 'string' ? args.selector.trim() || undefined : undefined;
    const maxChars = Math.min(typeof args.maxChars === 'number' ? args.maxChars : 20000, 50000);

    // Page cache: same URL + selector + maxChars bucket within the hour.
    const pageKey = pageCacheKey(url, selector, maxChars);
    const cachedPage = webCache().get(pageKey);
    if (cachedPage !== undefined) {
      return this.okResult('web_scrape', await condenseToolBody(url, args, cachedPage, this.summarizeForExtract), start);
    }
    // The full chain (direct + Jina + Wayback + Firecrawl) needs a wider budget
    // than a single direct fetch; the user-cancel signal still aborts it.
    const abort = createAbortController(signal, 60000);

    try {
      const outcome = await this.fetchPageWithFallbacks(url, { selector, signal: abort.signal });
      if (outcome && 'hijack' in outcome) {
        recordNetFailure(url);
        return this.fail(null, start, outcome.hijack, 'web_scrape');
      }
      if (outcome && 'httpStatus' in outcome) {
        // 内容性 4xx：主机可达、资源不存在——不喂熔断器，如实告诉模型状态码。
        return this.fail(null, start, `HTTP ${outcome.httpStatus} — no readable content could be obtained from ${url}; the page does not exist (or is permanently gone). The host itself is reachable; do NOT retry web_scrape on this URL; use researcher_web to find a different page.`, 'web_scrape');
      }
      if (!outcome) {
        return this.fail(null, start, `No readable content could be obtained from ${url} on any tier (direct / Jina Reader / Wayback / Firecrawl) — the page is blocked, removed, or requires interactive rendering. Do NOT retry web_scrape on this URL; use researcher_web to find a mirror or a different page.`, 'web_scrape');
      }
      const page = truncateText(outcome.text, maxChars);
      webCache().set(pageKey, page, PAGE_TTL_MS);
      return this.okResult('web_scrape', await condenseToolBody(url, args, page, this.summarizeForExtract), start);
    } finally {
      abort.cleanup();
    }
  }

  private okResult(toolName: string, result: string, start: number): ToolResult {
    return {
      id: `tool_${Date.now()}`,
      toolName,
      result,
      success: true,
      duration: Date.now() - start,
    };
  }

  // ── 网络诊断 / 换源 ──
  // 两者都默认「只读」：诊断不改任何东西，换源默认 session 档（不落盘），
  // file 档必须由模型同时传 confirm:true 与 dry_run:false 才放行。

  private async handleDiagnoseNetwork(args: Record<string, unknown>, start: number): Promise<ToolResult> {
    const target = String(args.target ?? '').trim();
    if (!target) {
      return this.fail(null, start, 'diagnose_network: target must not be empty — pass the URL or domain that is failing.', 'diagnose_network');
    }
    const asStrings = (v: unknown): string[] | undefined =>
      Array.isArray(v) ? v.map(String).filter(Boolean) : undefined;
    try {
      const report = await diagnoseNetwork(target, {
        ...(asStrings(args.allowlist) ? { allowlist: asStrings(args.allowlist) } : {}),
        ...(asStrings(args.denylist) ? { denylist: asStrings(args.denylist) } : {}),
        ...(typeof args.port === 'number' ? { port: args.port } : {}),
        // DNS/DoH 与 HTTP 走同一条出口路由（含用户配的代理），但 TCP/TLS 是裸
        // 套接字拨号、**不经过代理**。如实声明，否则「必须走代理才通」的网络里
        // 会得到「tcp-timeout → 改用代理」的结论，而代理本来就已经配好了。
        exitPathNote: 'TCP/TLS 为直连拨号（不经应用代理）；DNS/DoH 与 HTTP 走应用出口路由（含代理）',
        deps: { fetchImpl: ((input: any, init?: RequestInit) => cliFetch(String(input), init ?? {})) as unknown as typeof fetch },
      });
      const text = args.humanReadable
        ? renderProbeReportForHuman(report)
        : renderProbeReport(report);
      // 不可达不是「工具坏了」：用 success:true + 结构化结论返回，让模型读到
      // 归因而不是把它当成需要重试的执行错误。
      return this.okResult('diagnose_network', text, start);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      if (err instanceof ProbeGuardError || /拒绝|不在允许名单/.test(msg)) {
        return this.fail(null, start, `diagnose_network: ${msg}`, 'diagnose_network');
      }
      return this.fail(null, start, `diagnose_network failed: ${msg}`, 'diagnose_network');
    }
  }

  private async handleSwitchPackageSource(args: Record<string, unknown>, start: number): Promise<ToolResult> {
    const tiers = Array.isArray(args.enabledTrustTiers)
      ? (args.enabledTrustTiers.map(String).filter((t): t is TrustTier => t === 't0' || t === 't1' || t === 't2' || t === 't3'))
      : undefined;
    const scope = args.scope === 'file' ? 'file' : args.scope === 'session' ? 'session' : undefined;
    try {
      const result = await switchPackageSource({
        ecosystem: String(args.ecosystem ?? ''),
        ...(typeof args.source === 'string' ? { source: args.source } : {}),
        ...(scope ? { scope } : {}),
        // 默认 true：只产出计划。模型要真写必须显式关掉它。
        dryRun: args.dryRun !== false,
        confirm: args.confirm === true,
        ...(tiers ? { enabledTiers: tiers } : {}),
      });
      // 报告给人，也给模型：先结论，再 warnings，再细节。
      const lines = [
        result.summary ?? (result.ok ? `${result.ecosystem} → ${result.source?.url}` : '换源未成功'),
        ...(result.warnings.length > 0 ? ['', '注意：', ...result.warnings.map((w) => `- ${w}`)] : []),
        ...(result.sessionEnv && Object.keys(result.sessionEnv).length > 0
          ? ['', '要生效，请把这些变量注入子进程（进程退出即失效）：', ...Object.entries(result.sessionEnv).map(([k, v]) => `  ${k}=${v}`)]
          : []),
        ...(result.benchmark && result.benchmark.length > 0
          ? ['', '测速明细：', ...result.benchmark.map((b) => `  ${b.ok ? 'OK  ' : b.skipped ? 'SKIP' : 'FAIL'} ${String(b.status ?? '-').padEnd(4)} ${String(b.ms).padStart(5)}ms  ${b.url}${b.skipped ? `  （${b.skipped}）` : ''}`)]
          : []),
        ...(result.files && result.files.length > 0
          ? ['', '涉及文件：', ...result.files.map((f) => `  ${f.path}（${f.fileExisted ? '已存在' : '将新建'}，旧值 ${f.previousValue ?? '（未配置）'} → 新值 ${f.newValue}，回滚 ${f.undo.kind}）`)]
          : []),
        ...(result.undoCommand ? ['', `回滚命令：${result.undoCommand}`] : []),
      ];
      return result.ok
        ? this.okResult('switch_package_source', lines.join('\n'), start)
        : this.fail(null, start, `switch_package_source: ${result.error ?? '失败'}\n${result.warnings.join('\n')}`, 'switch_package_source');
    } catch (err: unknown) {
      return this.fail(null, start, `switch_package_source failed: ${err instanceof Error ? err.message : String(err)}`, 'switch_package_source');
    }
  }

  private async handleGlobFiles(args: Record<string, unknown>, start: number): Promise<ToolResult> {
    const pattern = String(args.pattern);
    const searchDir = await this.resolve(String(args.path || '.'));
    const maxResults = typeof args.maxResults === 'number' ? args.maxResults : 200;

    const results: string[] = [];
    const glob = new Bun.Glob(pattern);
    // 三方件默认不在理解范围：path 落在依赖目录里、或 pattern 本身指名了
    // 依赖目录（如 "node_modules/**"）才算明确请求，否则跳过。
    const explicitScope = isThirdPartyPath(pathRelative(this.workspace, searchDir)) || isThirdPartyPath(pattern);

    for await (const entry of glob.scan({ cwd: searchDir, absolute: false, onlyFiles: true })) {
      if (!explicitScope && isThirdPartyPath(entry)) continue;
      if (results.length >= maxResults) break;
      results.push(entry);
    }

    results.sort();

    return {
      id: `tool_${Date.now()}`,
      toolName: 'glob_files',
      result: results.length > 0 ? results.join('\n') : `No files matching "${pattern}"`,
      success: true,
      duration: Date.now() - start,
    };
  }

  private async handleReplaceFiles(args: Record<string, unknown>, start: number): Promise<ToolResult> {
    const files = Array.isArray(args.files) ? args.files.map(String) : [];
    const oldStr = String(args.oldString);
    const newStr = String(args.newString);
    const allowMultiple = Boolean(args.allowMultiple);

    if (files.length === 0) {
      return this.fail(null, start, 'No files specified');
    }

    const results: string[] = [];
    let totalOccurrences = 0;
    let errors = 0;
    const batch = await this.captureWriteBatch('replace_files', files);

    for (const filePath of files) {
      try {
        const path = await this.resolve(filePath);
        const file = Bun.file(path);
        if (!(await file.exists())) {
          results.push(`✗ ${filePath}: file not found`);
          errors++;
          continue;
        }

        const text = await file.text();
        const occurrences = text.split(oldStr).length - 1;

        if (occurrences === 0) {
          results.push(`− ${filePath}: string not found`);
          continue;
        }

        if (occurrences > 1 && !allowMultiple) {
          results.push(`✗ ${filePath}: found ${occurrences} occurrences — set allowMultiple:true or narrow match`);
          errors++;
          continue;
        }

        const newText = allowMultiple ? text.replaceAll(oldStr, newStr) : text.replace(oldStr, newStr);
        await Bun.write(path, newText);
        results.push(`✓ ${filePath}: replaced ${allowMultiple ? occurrences : 1} occurrence(s)`);
        totalOccurrences += allowMultiple ? occurrences : 1;
      } catch (err: any) {
        results.push(`✗ ${filePath}: ${err?.message ?? String(err)}`);
        errors++;
      }
    }

    const summary = `${results.length} file(s) processed, ${totalOccurrences} replacement(s), ${errors} error(s)`;
    const undoAvailable = totalOccurrences > 0 ? await this.tryFinishWriteBatch(batch, files) : false;

    return {
      id: `tool_${Date.now()}`,
      toolName: 'replace_files',
      result: `${summary}${totalOccurrences > 0 && !undoAvailable ? ' (当前写入未提供撤销快照)' : ''}\n${results.join('\n')}`,
      success: errors === 0,
      duration: Date.now() - start,
    };
  }

  /** The five git tools share the single-source implementation; this adapter
   * contributes the runtime primitive only (W3/D1=A). */
  private async handleGitTool(name: GitToolName, args: Record<string, unknown>, signal: AbortSignal | undefined, start: number): Promise<ToolResult> {
    const outcome = await runGitTool(name, args, this, { signal, timeoutMs: this.commandTimeout });
    if (outcome.ok) {
      return { id: `tool_${Date.now()}`, toolName: name, result: outcome.output, success: true, duration: Date.now() - start };
    }
    return this.fail(null, start, outcome.output, name);
  }

  /** ToolRuntime primitive: run an argv array directly — no shell, so quoting
   * never enters the picture. Generalized from the old git spawn skeleton;
   * timeout and user-abort both resolve with exit code 124 + a note on
   * stderr (mirroring execute_command's Rust-side timeout shape). Public:
   * the adapter itself satisfies ToolRuntime, which implementations pass as
   * `this`. */
  async runArgv(argv: string[], options: ArgvRunOptions = {}): Promise<ArgvRunResult> {
    const timeoutMs = options.timeoutMs ?? this.commandTimeout;
    const abort = createAbortController(options.signal, timeoutMs);
    try {
      const proc = Bun.spawn(argv, {
        cwd: options.cwd ?? this.workspace,
        stdout: 'pipe',
        stderr: 'pipe',
        signal: abort.signal,
      });
      const stdout = await new Response(proc.stdout).text();
      const stderr = await new Response(proc.stderr).text();
      await proc.exited;
      return { exitCode: proc.exitCode ?? -1, stdout, stderr };
    } catch (err: any) {
      if (err?.name === 'AbortError') {
        return { exitCode: 124, stdout: '', stderr: `Command timed out after ${timeoutMs}ms` };
      }
      throw err;
    } finally {
      abort.cleanup();
    }
  }

  /** ToolRuntime primitive: existence probe the CLI host can do directly. */
  async resolveExecutable(candidates: string[]): Promise<string | null> {
    for (const candidate of candidates) {
      if (!candidate) continue;
      if (candidate.includes('/') || candidate.includes('\\')) {
        if (existsSync(candidate)) return candidate;
      } else {
        const found = Bun.which(candidate);
        if (found) return found;
      }
    }
    return null;
  }

  /** ToolRuntime primitive: spawn a throwaway-profile headless Chrome and
   * parse the DevTools port off its stderr (same bare-CDP pattern as the
   * channel rasterizer — no puppeteer). The background task reaps the
   * process and removes the profile after Chrome exits (Browser.close or a
   * crash). */
  async launchHeadlessChrome(chromePath: string, args: string[]): Promise<ChromeLaunch | null> {
    const profileDir = mkdtempSync(join(tmpdir(), 'pure-browser-'));
    const proc = Bun.spawn([chromePath, ...args, `--user-data-dir=${profileDir}`], { stdout: 'ignore', stderr: 'pipe' });
    const port = await readDevToolsPort(proc, 30_000);
    if (!port) {
      try { proc.kill(); } catch { /* already gone */ }
      try { rmSync(profileDir, { recursive: true, force: true }); } catch { /* best effort */ }
      return null;
    }
    void (async () => {
      await proc.exited;
      try { rmSync(profileDir, { recursive: true, force: true }); } catch { /* best effort */ }
    })();
    return { port, pid: proc.pid };
  }

  /** ToolRuntime primitive: artifacts persist under ~/.pure/cache/<kind>/ on
   * both hosts (same tree the generated-image cache uses). */
  async writeArtifact(kind: 'screenshot' | 'card', basename: string, bytes: Uint8Array): Promise<string> {
    const dir = join(homedir(), '.pure', 'cache', kind === 'screenshot' ? 'screenshots' : kind);
    mkdirSync(dir, { recursive: true });
    const path = join(dir, basename.replace(/[^a-zA-Z0-9._-]+/g, '-'));
    writeFileSync(path, bytes);
    return path;
  }

  /** browser / screenshot share the single-source headless-Chrome
   * implementation; this adapter contributes the OS primitives only
   * (W3/D1=A + W4). */
  private async handleBrowserTool(name: 'browser' | 'screenshot', args: Record<string, unknown>, toolCallId: string, start: number): Promise<ToolResult> {
    try {
      const outcome = name === 'browser'
        ? await runBrowserTool(args, this)
        : await runScreenshotTool(args, this);
      // W4-2: the screenshot rides ToolResult.images so the engine folds it
      // into the next tool message and the model actually sees the page.
      const images = outcome.screenshot
        ? [{ dataUrl: outcome.screenshot.dataUrl, mimeType: outcome.screenshot.mimeType, path: outcome.screenshot.path }]
        : undefined;
      return { id: toolCallId, toolName: name, result: outcome.output, success: outcome.ok, duration: Date.now() - start, images };
    } catch (err) {
      return this.fail(null, start, err instanceof Error ? err.message : 'browser tool failed', name);
    }
  }

  private async handleSysInfo(start: number): Promise<ToolResult> {
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || process.env.TZ || 'unknown';
    const lang = Intl.DateTimeFormat().resolvedOptions().locale || process.env.LANG || process.env.LC_ALL || process.env.LC_CTYPE || 'unknown';
    const encoding = detectLocaleEncoding(lang);
    // time/os 行与 Rust sys_info 同形（detect_current_time / detect_os_version
    // 是权威侧，2026-11-08 分叉盘点刀 ⑥ 对齐）：时间 "YYYY-MM-DD HH:MM:SS TZ"
    // （此前 toString 的长英文格式与 GUI 同屏两个形状）；macOS 走 sw_vers 出
    // "macOS <ver> (<arch>)"，Linux/其余保持 uname/平台行。
    const time = detectLocalTimeLine(new Date(), tz);
    let osVersion = `${process.platform} ${process.arch}`;
    try {
      if (process.platform === 'darwin') {
        const swVers = Bun.spawnSync({ cmd: ['sw_vers', '-productVersion'], stdout: 'pipe', stderr: 'pipe' });
        if (swVers.exitCode === 0) osVersion = `macOS ${new TextDecoder().decode(swVers.stdout).trim()} (${process.arch})`;
      } else {
        const uname = Bun.spawnSync({ cmd: ['uname', '-srm'], stdout: 'pipe', stderr: 'pipe' });
        if (uname.exitCode === 0) osVersion = new TextDecoder().decode(uname.stdout).trim();
      }
    } catch {}
    // Mirrors the Rust sys_info output shape (timezone/language/time/os
    // aligned under the same 10-char label column) plus the user-configured
    // location when present (CLI: PURE_LOCATION / PURE_CITY env var), the
    // installed runtimes (node / bun / python3 / rustc / git --version), and
    // the network environment (system proxy / env proxy / VPN / reachability).
    const location = this.location
      ? `${this.location} (user-set)`
      : 'not set';
    const runtimes = detectRuntimeVersions().join('  ');
    const network = `${detectNetworkSummary()}; reach: ${await detectReachability()}`;
    const ipLine = await detectIpGeoLine();

    const cacheLine = this.cacheQualityKeys
      ? cacheQualityLiveLine(this.cacheQualityKeys.provider, this.cacheQualityKeys.model)
      : undefined;
    return {
      id: `tool_${Date.now()}`,
      toolName: 'sys_info',
      result: `timezone:  ${tz}\nlanguage:  ${lang}\nencoding:  ${encoding}\nip:        ${ipLine}\ntime:      ${time}\nos:        ${osVersion}\nlocation:  ${location}\nruntimes:  ${runtimes}\nnetwork:   ${network}${this.llmBudgetLine ? `\n\n${this.llmBudgetLine}` : ''}${cacheLine ? `\n${cacheLine}` : ''}`,
      success: true,
      duration: Date.now() - start,
    };
  }

  private async captureWriteBatch(toolName: string, paths: string[]): Promise<WorkspaceSnapshotBatch> {
    this.latestWriteBatch = null;
    const entries: WorkspaceSnapshotEntry[] = [];
    for (const path of [...new Set(paths)]) {
      if (hasSymlinkComponent(this.workspace, path)) {
        throw new Error(`Snapshot refuses symlink path: ${path}`);
      }
      const full = await this.resolve(path);
      if (!existsSync(full)) {
        entries.push({ path, existed: false, kind: 'file' });
        continue;
      }
      const stat = lstatSync(full);
      if (stat.isDirectory()) {
        entries.push({ path, existed: true, kind: 'directory' });
      } else {
        const content = await Bun.file(full).text();
        if (new TextEncoder().encode(content).byteLength > this.maxSnapshotBytes) {
          throw new Error(`Snapshot too large for ${path}; write was not performed.`);
        }
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
      const full = await this.resolve(entry.path);
      if (existsSync(full) && !lstatSync(full).isDirectory()) {
        entry.afterContent = await Bun.file(full).text();
        if (new TextEncoder().encode(entry.afterContent).byteLength > this.maxSnapshotBytes) continue;
        if (!entry.existed || entry.afterContent !== entry.content) finished.push(entry);
      } else if (!entry.existed && existsSync(full)) {
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
      if (hasSymlinkComponent(this.workspace, entry.path)) {
        conflicts.push(entry.path);
        continue;
      }
      let full: string;
      try { full = await this.resolve(entry.path); } catch { conflicts.push(entry.path); continue; }
      const exists = existsSync(full);
      const currentIsDirectory = exists && lstatSync(full).isDirectory();
      if (!entry.existed) {
        if (!exists) continue;
        if ((entry.kind === 'directory') !== currentIsDirectory) {
          conflicts.push(entry.path);
          continue;
        }
        if (entry.kind === 'directory') {
          try { await rm(full, { recursive: false }); removedPaths.push(entry.path); }
          catch { conflicts.push(entry.path); }
          continue;
        }
        if (entry.afterContent !== undefined && (await Bun.file(full).text()) !== entry.afterContent) {
          conflicts.push(entry.path);
          continue;
        }
        try { await rm(full); removedPaths.push(entry.path); } catch { conflicts.push(entry.path); }
        continue;
      }
      if (entry.kind === 'directory') {
        if (!exists || !currentIsDirectory) {
          conflicts.push(entry.path);
          continue;
        }
        await mkdir(full, { recursive: true });
        restoredPaths.push(entry.path);
        continue;
      }
      if (!exists || currentIsDirectory) {
        conflicts.push(entry.path);
        continue;
      }
      if (entry.afterContent !== undefined && (await Bun.file(full).text()) !== entry.afterContent) {
        conflicts.push(entry.path);
        continue;
      }
      await mkdir(dirname(full), { recursive: true });
      await Bun.write(full, entry.content ?? '');
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

  // ── Helpers ──

  // 路径解析链上移 impl/pathPolicy（P2-5 第三子刀）：本适配器只注 node:fs
  // 原语；词法归一/`..` 越根拒绝/workspace 空校验/trim 语义与 GUI 侧 Rust
  // path_policy 由行为锁（pathPolicyFixtures.json）钉住。
  private resolve(filePath: string): Promise<string> {
    return resolveWorkspacePath(this.workspace, filePath, nodePathPolicyFs, this.homeDir);
  }

  private fail(toolCall: ToolCall | null, start: number, error: string, fallbackToolName?: string): ToolResult {
    return {
      id: `tool_${Date.now()}`,
      toolName: toolCall?.function?.name ?? fallbackToolName ?? 'unknown',
      error,
      success: false,
      duration: Date.now() - start,
    };
  }
}

// expandTilde 已上移 impl/pathPolicy（P2-5 第三子刀，与 Rust expand_tilde_with
// 同构互为镜像、行为锁 pathPolicyFixtures.json 两侧同源消费）。旧导入经
// re-export 保持兼容；默认 home 仍是真实 homedir（Windows 只设 USERPROFILE，
// node:os homedir 已处理）。
export { expandTilde };

// path_policy 的 node:fs 原语（同步函数直接注入，async 签名 await 同步值零
// 开销）。symlinkMeta 用 lstatSync(throwIfNoEntry:false)：悬空 symlink 本身
// lstat 得到（isSymlink:true），纯缺失段返回 null——爬升循环靠这个区分。
const nodePathPolicyFs: PathPolicyFs = {
  canonicalize: (p) => realpathSync(p),
  exists: (p) => existsSync(p),
  symlinkMeta: (p) => {
    const s = lstatSync(p, { throwIfNoEntry: false });
    return s ? { isSymlink: s.isSymbolicLink() } : null;
  },
  isDir: (p) => statSync(p, { throwIfNoEntry: false })?.isDirectory() ?? false,
};

type EditMatch = {
  text: string;
  old: string;
  normalizedText: string;
  normalizedOld: string;
  index: number;
  lineEnding: 'lf' | 'crlf';
};

/** Match an exact edit first, then retry only for a line-ending difference.
 * The fallback never changes whitespace or chooses an approximate snippet: it
 * maps the normalized match back to the exact bytes currently on disk. */
function findEditMatch(text: string, oldString: string): EditMatch | null {    const lineEnding = text.includes('\r\n') ? 'crlf' : 'lf';
    const exactIndex = lineEnding === 'crlf' && oldString.includes('\n') && !oldString.includes('\r\n')
      ? -1
      : text.indexOf(oldString);
  if (exactIndex >= 0) {
    return {
      text,
      old: oldString,
      normalizedText: text.replace(/\r\n/g, '\n'),
      normalizedOld: oldString.replace(/\r\n/g, '\n'),
      index: exactIndex,
      lineEnding,
    };
  }

  if (!oldString.includes('\n') && !oldString.includes('\r\n')) return null;
  const normalizedText = text.replace(/\r\n/g, '\n');
  const normalizedOld = oldString.replace(/\r\n/g, '\n');
  const normalizedIndex = normalizedText.indexOf(normalizedOld);
  if (normalizedIndex < 0) return null;

  let normalizedOffset = 0;
  let originalIndex = 0;
  while (normalizedOffset < normalizedIndex) {
    if (text.startsWith('\r\n', originalIndex)) {
      originalIndex += 2;
    } else {
      originalIndex += 1;
    }
    normalizedOffset += 1;
  }
  const old = normalizedText.slice(normalizedIndex, normalizedIndex + normalizedOld.length)
    .replace(/\n/g, lineEnding === 'crlf' ? '\r\n' : '\n');
  return {
    text,
    old,
    normalizedText,
    normalizedOld,
    index: originalIndex,
    lineEnding,
  };
}

function isRipgrepUnavailable(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /\brg\b/i.test(message) && /(?:enoent|no such file|not found|executable|failed to spawn)/i.test(message);
}

function editStringNotFoundError(path: string, oldString: string): string {
  const preview = oldString.replace(/\r?\n/g, '\\n').slice(0, 160);
  return `String not found in file: ${preview}. The file may have changed since it was read. Re-read ${path}, do not retry this identical edit, then use a shorter exact context from the current file.`;
}

/** Probe installed runtime versions (node / bun / python3 / rustc / git --version),
 * mirroring detect_runtime_versions in src-tauri/src/lib.rs. python3 prints
 * to stderr, so both streams are checked. Never throws. The result is cached
 * per process: runtimes cannot change mid-run, so repeated sys_info calls
 * must not re-spawn the five subprocesses. */
export function detectRuntimeVersions(): string[] {
  if (cachedRuntimeVersions === null) cachedRuntimeVersions = probeRuntimeVersions();
  return cachedRuntimeVersions;
}

let cachedRuntimeVersions: string[] | null = null;

/** Directories where user-installed runtimes commonly live, missing from a
 * minimal inherited PATH (GUI-launched processes / IDE terminals). Mirrors
 * Rust probe_extra_path_dirs; missing entries are simply skipped. */
function extraProbePathDirs(): string[] {
  const home = process.env.HOME ?? '';
  const dirs = [
    '/opt/homebrew/bin',
    '/usr/local/bin',
    `${home}/.bun/bin`,
    `${home}/.volta/bin`,
    `${home}/.local/bin`,
    `${home}/.cargo/bin`,
  ];
  // nvm: ~/.nvm/versions/node/<version>/bin — every installed version.
  try {
    for (const entry of readdirSync(`${home}/.nvm/versions/node`, { withFileTypes: true })) {
      if (entry.isDirectory()) dirs.push(`${home}/.nvm/versions/node/${entry.name}/bin`);
    }
  } catch {}
  // fnm: ~/.local/share/fnm/node-versions/<version>/installation/bin.
  try {
    for (const entry of readdirSync(`${home}/.local/share/fnm/node-versions`, { withFileTypes: true })) {
      if (entry.isDirectory()) dirs.push(`${home}/.local/share/fnm/node-versions/${entry.name}/installation/bin`);
    }
  } catch {}
  // asdf: ~/.asdf/installs/{nodejs,bun}/<version>/bin.
  for (const tool of ['nodejs', 'bun']) {
    try {
      for (const entry of readdirSync(`${home}/.asdf/installs/${tool}`, { withFileTypes: true })) {
        if (entry.isDirectory()) dirs.push(`${home}/.asdf/installs/${tool}/${entry.name}/bin`);
      }
    } catch {}
  }
  return dirs;
}

/** PATH for runtime probes: inherited PATH plus the user-install directories
 * above (deduplicated, extras first so a user's nvm node wins over the system
 * node). Mirrors Rust probe_path. Windows inherits the full system PATH
 * (separated by `;`), so it returns the inherited PATH deduped as-is. */
export function extendedProbePath(): string {
  const sep = process.platform === 'win32' ? ';' : ':';
  const inherited = (process.env.PATH ?? '').split(sep).filter(Boolean);
  // Windows inherits the full system PATH; the per-user runtime dirs below
  // are Unix-only (mirrors Rust probe_extra_path_dirs).
  const extras = process.platform === 'win32' ? [] : extraProbePathDirs();
  const parts: string[] = [];
  for (const dir of extras) {
    if (!inherited.includes(dir) && !parts.includes(dir)) parts.push(dir);
  }
  parts.push(...inherited);
  // Dedupe the whole list — the inherited PATH may already repeat entries.
  return [...new Set(parts)].join(sep);
}

function probeRuntimeVersions(): string[] {
  const out: string[] = [];
  // The CLI usually inherits a full PATH, but a parent launcher (IDE
  // integrated terminal, GUI-spawned process) may pass a minimal one that
  // misses nvm/bun/volta/fnm/asdf/Homebrew installs (mirrors Rust).
  const probeEnv = process.platform === 'win32'
    ? undefined
    : { ...process.env, PATH: extendedProbePath() };
  for (const [label, args] of [
    ['node', ['--version']],
    ['bun', ['--version']],
    ['python3', ['--version']],
    ['rustc', ['--version']],
    ['git', ['--version']],
  ] as const) {
    let version = 'not installed';
    try {
      const r = Bun.spawnSync({ cmd: [label, ...args], stdout: 'pipe', stderr: 'pipe', env: probeEnv });
      if (r.exitCode === 0) {
        // Collapse internal whitespace/newlines: version output lands in the
        // system prompt verbatim, so multi-line banners must not break out of
        // the context sentence (also mirrors the chat.ts first-line regex).
        const text = (new TextDecoder().decode(r.stdout).trim() || new TextDecoder().decode(r.stderr).trim()).replace(/\s+/g, ' ');
        if (text) version = text;
      }
    } catch {}
    out.push(`${label}: ${version}`);
  }
  return out;
}

// ── Network environment for sys_info / prompt injection ──
// Mirrors the Rust sys_info `network:` line: system proxy (macOS scutil),
// env proxy vars, connected VPNs, and live direct reachability. The sync
// summary is exported for the CLI prompt pre-seed; sys_info additionally
// probes reachability (async fetch) so the on-demand tool reports it fresh.
const PROXY_ENV_VARS = ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy', 'ALL_PROXY', 'all_proxy', 'NO_PROXY', 'no_proxy'];

function spawnSyncOutput(cmd: string, args: string[]): string {
  try {
    const r = Bun.spawnSync({ cmd: [cmd, ...args], stdout: 'pipe', stderr: 'pipe' });
    if (r.exitCode === 0) return new TextDecoder().decode(r.stdout);
  } catch {}
  return '';
}

/** Value of `key:` in macOS `scutil --proxy` / `--nc list` output. */
function scutilValue(output: string, key: string): string {
  for (const line of output.split('\n')) {
    const idx = line.indexOf(':');
    if (idx < 0) continue;
    if (line.slice(0, idx).trim() === key) return line.slice(idx + 1).trim();
  }
  return '';
}

/** macOS system proxy as `scheme://host:port` (same precedence as the Rust
 * parse_scutil_proxy: HTTPS → HTTP → SOCKS). Non-macOS: "not detected". */
function detectSystemProxySync(): string {
  if (process.platform !== 'darwin') return 'not detected';
  const out = spawnSyncOutput('scutil', ['--proxy']);
  if (!out) return 'not detected';
  for (const [enable, hostKey, portKey, scheme] of [
    ['HTTPSEnable', 'HTTPSProxy', 'HTTPSPort', 'http://'],
    ['HTTPEnable', 'HTTPProxy', 'HTTPPort', 'http://'],
    ['SOCKSEnable', 'SOCKSProxy', 'SOCKSPort', 'socks5://'],
  ] as const) {
    if (scutilValue(out, enable) !== '1') continue;
    const host = scutilValue(out, hostKey);
    if (!host) continue;
    const port = scutilValue(out, portKey);
    return port ? `${scheme}${host}:${port}` : `${scheme}${host}`;
  }
  return 'none';
}

/** Connected VPN service names (macOS `scutil --nc list`); "not detected" on
 * other platforms. */
function detectVpnSync(): string {
  if (process.platform !== 'darwin') return 'not detected';
  const out = spawnSyncOutput('scutil', ['--nc', 'list']);
  const names: string[] = [];
  for (const line of out.split('\n')) {
    if (!line.includes('(Connected)')) continue;
    const name = line.split('(Connected)')[1]?.trim();
    if (name) names.push(name);
  }
  return names.length ? `${names.join(', ')} (connected)` : 'none';
}

/** Raw standard proxy env vars as `NAME=value` pairs; "none" when unset. */
function detectEnvProxySummary(): string {
  const parts: string[] = [];
  for (const name of PROXY_ENV_VARS) {
    const value = process.env[name]?.trim();
    if (value) parts.push(`${name}=${value}`);
  }
  return parts.length ? parts.join(' ') : 'none';
}

/** Sync network summary (no live reachability — that needs async fetch and
 * belongs to sys_info). Exported so the CLI reuses it for its system prompt,
 * keeping the prompt pre-seed and sys_info output consistent. Cached per
 * process: the underlying probes spawn subprocesses (scutil / networksetup),
 * and the summary cannot change mid-run. */
export function detectNetworkSummary(): string {
  if (cachedNetworkSummary === null) {
    cachedNetworkSummary = `proxy: ${detectSystemProxySync()}; env: ${detectEnvProxySummary()}; vpn: ${detectVpnSync()}`;
  }
  return cachedNetworkSummary;
}

let cachedNetworkSummary: string | null = null;

/** Probe connectivity to a domestic and an international endpoint (2s bound
 * each, in parallel). Note: fetch() honors HTTP(S)_PROXY env vars, so on a
 * machine with env proxies set this reflects the env-proxy-routed view — the
 * CLI normally has none set, and the prompt pre-seed reports them separately.
 * Mirrors Rust probe_reachability. The result is cached for REACH_TTL_MS:
 * reachability is network-state that changes slowly (VPN / proxy toggles),
 * and the 2s probe must not re-run on every sys_info call. */
async function detectReachability(): Promise<string> {
  const now = Date.now();
  if (cachedReach && now - cachedReach.at < REACH_TTL_MS) return cachedReach.value;
  const probe = async (url: string): Promise<boolean> => {
    try {
      const res = await cliFetch(url, { headers: { 'User-Agent': BROWSER_UA }, signal: AbortSignal.timeout(2000) });
      return res.ok;
    } catch {
      return false;
    }
  };
  const [domestic, international] = await Promise.all([
    probe('https://www.baidu.com/'),
    probe('https://www.google.com/generate_204'),
  ]);
  const value = `domestic ${domestic ? 'ok' : 'blocked'}, international ${international ? 'ok' : 'blocked'}`;
  cachedReach = { at: now, value };
  return value;
}

let cachedReach: { at: number; value: string } | null = null;
const REACH_TTL_MS = 300_000;

/** Local time as "YYYY-MM-DD HH:MM:SS TZ" — the Rust sys_info shape
 *  (detect_current_time, `date +%Y-%m-%d %H:%M:%S %Z`), via Intl so no
 *  subprocess is needed. Pure on `now` for the format lock. */
export function detectLocalTimeLine(now: Date, tz: string): string {
  const p2 = (n: number) => String(n).padStart(2, '0');
  const tzAbbr = new Intl.DateTimeFormat('en-US', { timeZone: tz, timeZoneName: 'short' })
    .formatToParts(now).find((part) => part.type === 'timeZoneName')?.value ?? tz;
  return `${now.getFullYear()}-${p2(now.getMonth() + 1)}-${p2(now.getDate())} ${p2(now.getHours())}:${p2(now.getMinutes())}:${p2(now.getSeconds())} ${tzAbbr}`;
}

/** Character encoding implied by the locale (en_US.UTF-8 → UTF-8). Modern
 * macOS/Linux default to UTF-8; Windows ANSI code pages are not probed. */
function detectLocaleEncoding(locale: string): string {
  const dot = locale.indexOf('.');
  if (dot >= 0) {
    const enc = locale.slice(dot + 1).trim();
    if (enc) return enc.toUpperCase();
  }
  return 'UTF-8';
}

/** Redact the identifying tail of an IP so sys_info never leaks the exact
 * public address to the model backend. IPv4 → last octet; IPv6 → last hextet. */
function maskIp(ip: string): string {
  if (!ip) return 'unknown';
  if (ip.includes(':')) {
    const first = ip.split(':')[0];
    return first ? `${first}:…` : 'unknown';
  }
  const idx = ip.lastIndexOf('.');
  return idx > 0 ? `${ip.slice(0, idx)}.x` : 'unknown';
}

/** Public IP + city geolocation for sys_info (mirrors Rust detect_ip_geo).
 * Fetched ONCE per process and cached — the public IP is city-stable for the
 * CLI run, so repeated sys_info calls must not re-probe the backends. */
let cachedIpGeoLine: Promise<string> | null = null;

function detectIpGeoLine(): Promise<string> {
  if (!cachedIpGeoLine) {
    cachedIpGeoLine = fetchIpGeoLine();
  }
  return cachedIpGeoLine;
}

/** The raw IP is masked; city/region/country/timezone are the useful parts. */
async function fetchIpGeoLine(): Promise<string> {
  const backends = [
    'https://ipwho.is/',
    'https://ipinfo.io/json',
    'http://ip-api.com/json/?lang=zh-CN',
  ];
  for (const url of backends) {
    let data: any;
    try {
      const res = await cliFetch(url, { headers: { 'User-Agent': BROWSER_UA }, signal: AbortSignal.timeout(3000) });
      if (!res.ok) continue;
      data = await res.json();
    } catch {
      continue;
    }
    const get = (keys: string[]): string => {
      for (const k of keys) {
        const v = data?.[k];
        if (typeof v === 'string' && v.trim() && v !== 'unknown') return v.trim();
      }
      return '';
    };
    const city = get(['city']);
    const region = get(['region', 'regionName']);
    const country = get(['country', 'country_name']);
    const timezone = get(['timezone']);
    const ip = get(['ip', 'query']);
    if (!city && !timezone) continue;
    const parts = [maskIp(ip)];
    const loc = [city, region, country].filter(Boolean);
    if (loc.length) parts.push(loc.join(', '));
    if (timezone) parts.push(timezone);
    return parts.join(' · ');
  }
  return 'unknown (offline or all geolocation backends blocked)';
}

function hasSymlinkComponent(base: string, filePath: string): boolean {
  const candidate = pathResolve(base, filePath);
  // Workspace confinement removed: outside-workspace paths are allowed, so only
  // an ACTUAL symlink component within the path is a reason to refuse. Paths
  // inside the workspace walk their relative components (catches middle-component
  // symlinks like workspace/link -> elsewhere); outside paths only check the
  // deepest existing ancestor itself, so harmless system symlink ancestors
  // (/var -> /private/var on macOS) are never flagged.
  const rel = pathRelative(base, candidate);
  if (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel)) {
    let current = base;
    for (const component of rel.split(sep)) {
      if (!component || component === '.') continue;
      current = join(current, component);
      try {
        if (lstatSync(current).isSymbolicLink()) return true;
      } catch {
        break;
      }
    }
    return false;
  }
  // Outside the workspace: only the deepest existing ancestor can be a symlink.
  let existing = candidate;
  while (!existsSync(existing)) {
    const parent = dirname(existing);
    if (parent === existing) break;
    existing = parent;
  }
  try {
    return lstatSync(existing).isSymbolicLink();
  } catch {
    return false;
  }
}

// ── execute_command 强化（2026-11-08 电脑端操作能力 P1）──

const COMMAND_TIMEOUT_DEFAULT_MS = 120_000;
const COMMAND_TIMEOUT_MAX_MS = 600_000;
/** >30k 的 stdout/stderr 全文落盘，返回体只带头尾预览+路径（CC 同款形态）。 */
const OUTPUT_INLINE_LIMIT = 30_000;
const OUTPUT_PREVIEW_CHARS = 2_000;

function clampCommandTimeoutMs(raw: unknown): number {
  if (typeof raw !== 'number' || !Number.isFinite(raw) || raw <= 0) return COMMAND_TIMEOUT_DEFAULT_MS;
  return Math.min(Math.max(Math.round(raw), 1000), COMMAND_TIMEOUT_MAX_MS);
}

/** cwd 解析：绝对路径直接用（绝对性判 isAbsolute——startsWith('/') 在
 * Windows 把 C:\ 误判为相对，bun-windows 判例）；相对路径拼 workspace。
 * 返回 string=校验错误文案，返回对象=可用 cwd。 */
function resolveCommandCwd(raw: unknown, workspace: string): { value: string } | string {
  const arg = typeof raw === 'string' ? raw.trim() : '';
  if (!arg) return { value: workspace };
  const expanded = expandTilde(arg);
  const cwd = isAbsolute(expanded) ? pathResolve(expanded) : pathResolve(workspace, expanded);
  try {
    if (!statSync(cwd).isDirectory()) return `cwd is not a directory: ${cwd}`;
  } catch {
    return `cwd does not exist: ${cwd}`;
  }
  return { value: cwd };
}

function spillOversizeOutput(text: string, label: string): { text: string; spillFile?: string } {
  if (text.length <= OUTPUT_INLINE_LIMIT) return { text };
  const spillFile = join(tmpdir(), `pure-tool-output-${Date.now()}-${label}.log`);
  try {
    writeFileSync(spillFile, text);
    return {
      text: `${text.slice(0, OUTPUT_PREVIEW_CHARS)}\n...[snip]...\n${text.slice(-OUTPUT_PREVIEW_CHARS)}\n[${label} truncated: ${text.length} chars total — full output saved to ${spillFile} (read_file to see all)]`,
      spillFile,
    };
  } catch {
    // 落盘失败退化为头尾预览：可用性优先，不让 spill 失败丢掉整段输出。
    return { text: `${text.slice(0, OUTPUT_PREVIEW_CHARS)}\n...[snip]...\n${text.slice(-OUTPUT_PREVIEW_CHARS)}\n[${label} truncated: ${text.length} chars total (spill failed)]` };
  }
}

function createAbortController(parent: AbortSignal | undefined, timeoutMs: number): {
  signal: AbortSignal;
  abort: () => void;
  cleanup: () => void;
} {
  const controller = new AbortController();
  const onAbort = () => controller.abort();
  if (parent?.aborted) controller.abort();
  else parent?.addEventListener('abort', onAbort, { once: true });
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  return {
    signal: controller.signal,
    abort: () => controller.abort(),
    cleanup: () => {
      clearTimeout(timer);
      parent?.removeEventListener('abort', onAbort);
    },
  };
}

/** Decode a response body with the resolved charset, falling back to UTF-8.
 * Charset resolution (Content-Type → <meta> sniff → UTF-8, WHATWG label
 * normalization) lives in the single-source decodeBody (tools/impl/webSearch). */
export async function readResponseText(resp: Response): Promise<string> {
  const bytes = new Uint8Array(await resp.arrayBuffer());
  return decodeBody({ contentType: resp.headers.get('content-type') || '', body: bytes });
}

/** True when a Content-Type header is a text-like payload web_fetch can read.
 * Accepts text/* and common text-bearing application subtypes (JSON, XML, JS,
 * SVG, RSS/Atom, form data); a missing/empty header is treated as text so the
 * fetch still works on servers that omit it. Rejects only clearly binary
 * payloads (images, audio/video, fonts, archives, PDF, octet-stream). */
function isTextualContentType(contentType: string): boolean {
  const main = contentType.split(';')[0].trim().toLowerCase();
  if (!main) return true;
  if (main.startsWith('text/')) return true;
  if (main.endsWith('+json') || main.endsWith('+xml')) return true;
  return [
    'application/json',
    'application/xml',
    'application/xhtml+xml',
    'application/javascript',
    'application/x-javascript',
    'application/x-www-form-urlencoded',
    'application/svg+xml',
    'application/rss+xml',
    'application/atom+xml',
  ].includes(main);
}

function decodeHtmlEntities(text: string): string {
  return text
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&ensp;/g, ' ')
    // Numeric character references (common in Bing snippets, e.g. &#0183;).
    .replace(/&#(\d+);/g, (_, d: string) => String.fromCodePoint(Number(d)));
}

// ── Bing HTML result parser (multi-backend fallback) ──

/** Strip HTML to readable text (shared by web_fetch and the DDG/Bing result
 * parsers). Mirror-tested against the Rust strip_html_full in
 * stripHtml.test.ts — the two must agree on the common core (tag stripping,
 * script/style removal, whitespace collapse, block breaks). Intentional
 * divergences (entities, inline tags, script case) are documented there. */
export function stripHtml(html: string): string {
  return html
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n\n')
    .replace(/<\/(?:div|h[1-6]|li|tr|section|article)>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .split('\n')
    .map(line => line.trim())
    .filter(line => line.length > 0)
    .join('\n');
}

/** web_fetch pipeline: strip tags, collapse whitespace, then decode HTML
 * entities — the same output shape as the Rust strip_html_full (which also
 * decodes after stripping). Decoding is intentionally NOT folded into
 * stripHtml (shared with the DDG/Bing parsers, which decode after stripping
 * themselves — decoding in the helper would double-decode). Mirror-tested in
 * stripHtml.test.ts. */
export function extractReadableText(html: string): string {
  return decodeHtmlEntities(stripHtml(html).trim());
}

/** Format a fetched body for the fallback chain: RSS/Atom → numbered list,
 * JSON → pretty-printed, otherwise noise-stripped readable text with an
 * optional selector. Shared by the direct and Wayback tiers. */
function formatPageBody(html: string, contentType: string, selector?: string): string {
  if (isFeedBody(html)) return formatFeedText(html);
  if (/json/i.test(contentType) || /^\s*[\[{]/.test(html)) return formatJsonBody(html);
  return extractScrapeText(html, selector);
}

/** Extract a file name from a `Content-Disposition: attachment; filename="…"` /
 * `filename*=UTF-8''…` header. Returns undefined when absent. */
function parseContentDispositionFilename(header: string | undefined): string | undefined {
  if (!header) return undefined;
  const m = header.match(/filename\*?=(?:UTF-8''|utf-8'')?"?([^";]+)/i);
  if (!m) return undefined;
  let name = m[1].trim();
  try {
    name = decodeURIComponent(name);
  } catch {
    /* keep raw */
  }
  return name || undefined;
}
