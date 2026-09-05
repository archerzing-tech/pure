// src/adapter/node/NodeToolAdapter.ts
// v0.4 — 16 built-in file/command/web/git tools. Schemas come from
// shared/toolDefs.ts (single source of truth shared with the GUI adapter).
// Fixes: handleWriteFile uses proper fs.mkdir() instead of fragile .ensure hack.

import { basename, dirname, isAbsolute, join, resolve as pathResolve, relative as pathRelative, sep } from 'node:path';
import { existsSync, lstatSync, readdirSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { open, stat, writeFile, readFile, rename, unlink, mkdir, rm } from 'node:fs/promises';
import { tmpdir, homedir } from 'node:os';
import * as http from 'node:http';
import * as https from 'node:https';
import * as tls from 'node:tls';
import { spawn } from 'node:child_process';

import type { ToolAdapter, ToolCall, ToolResult, ToolDefinition } from '../../shared/types';
import { BUILT_IN_TOOL_DEFS, TOOL_METADATA } from '../../shared/toolDefs';
import { formatCommandError, safeParseArgs } from '../../shared/format';
import { blockedHostMessage, hostBlocked, isNetworkError, netFailureHint, recordNetFailure, recordNetSuccess } from '../../shared/netGuard';
import { stripAnsi } from '../../shared/ansi';
import { buildBackgroundLaunchPlan, buildBackgroundResult, buildWrapperScript } from '../../shared/backgroundCommand';
import { filterResearchSources, isOfficialDocumentationSource, makeResearchPayload, parseWebSearchText, type ResearchSource } from '../../shared/research';
import { isPublicToolName } from '../../shared/toolDefs';
import { downloadHub, type DownloadProgress, type DownloadController } from '../../shared/downloadHub';
import type { WorkspaceRestoreResult, WorkspaceSnapshotBatch, WorkspaceSnapshotEntry, WorkspaceSnapshotPort } from '../../shared/workspaceSnapshot';
import { cachedDirectPublicApi, parseRssItems, quota } from './publicApis';
import { pageCacheKey, PAGE_TTL_MS, searchCacheKey, SEARCH_TTL_MS, webCache } from './webCache';
import { extractScrapeText, formatFeedText, formatJsonBody, isFeedBody, scrapeViaJina, truncateText } from './webScrape';
import { extractMetaRefreshUrl, extractPdfText, extractPdfViaPdftotext, fetchWithRetry, refererFor, resolveRedirectTarget, scrapeViaFirecrawl, scrapeViaWayback } from './fetchFallback';
import { extractFileText, MAX_SEARCH_FILE_BYTES } from './fileText';
import { BROWSER_UA } from '../../shared/platformUa';

/** Windows has no POSIX shell (`sh`) or `diff` binary — PowerShell / Git for
 * Windows provide the equivalents. Module-level so every handler branches
 * consistently. */
const IS_WINDOWS = process.platform === 'win32';

/** Encode a command for powershell.exe -EncodedCommand (base64 of UTF-16LE),
 * with the exit-code wrapper appended so a failing command reports non-zero
 * (mirrors Rust powershell_encoded_command). The encoded form bypasses the
 * Windows command-line quoting mangling (CommandLineToArgvW-style `\"`
 * escaping) a plain -Command argument is subject to. Exported for tests. */
export function encodePowerShellCommand(command: string): string {
  return Buffer.from(`${command}; if ($?) { exit $LASTEXITCODE } else { exit 1 }`, 'utf16le').toString('base64');
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

export function stripPowerShellStartupProgress(stderr: string): string {
  const text = stderr.trim();
  if (!/^#< CLIXML/i.test(text) || /<S\s+S="Error">/i.test(text)) return stderr;
  return /<AV>Preparing modules for first use\.<\/AV>/i.test(text) ? '' : stderr;
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
}

export class NodeToolAdapter implements ToolAdapter {
  private workspace: string;
  private commandTimeout: number;
  private maxFileSize: number;
  private maxSnapshotBytes: number;
  private location: string;
  private sessionId: string;
  private latestWriteBatch: WorkspaceSnapshotBatch | null = null;
  private snapshotSequence = 0;

  private tools: ToolDefinition[] = [...BUILT_IN_TOOL_DEFS];

  constructor(config: NodeToolConfig) {
    this.workspace = pathResolve(config.workspace);
    this.sessionId = config.sessionId ?? '';
    this.commandTimeout = config.commandTimeout ?? 30000;
    this.maxFileSize = config.maxFileSize ?? 64 * 1024 * 1024; // 64MB — matches the Rust read_file cap
    this.maxSnapshotBytes = config.maxSnapshotBytes ?? 8 * 1024 * 1024;
    this.location = (config.location ?? '').trim();
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
        case 'create_directory': return await this.handleCreateDirectory(args, start);
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
          return await this.handleWebSearch(args, start);
        }
        case 'web_fetch': return await this.handleWebFetch(args, signal, start);
        case 'download_file': return await this.handleDownloadFile(args, signal, start, toolCall.id);
        case 'web_public_api': return await this.handleWebPublicApi(args, start);
        case 'web_scrape': return await this.handleWebScrape(args, signal, start);
        case 'glob_files': return await this.handleGlobFiles(args, start);
        case 'replace_files': return await this.handleReplaceFiles(args, start);
        case 'git_diff': return await this.handleGitCmd(args, ['diff', ...(args.staged ? ['--staged'] : []), ...(typeof args.path === 'string' ? ['--', args.path as string] : [])], signal, start);
        case 'git_log': return await this.handleGitCmd(args, ['log', '-n', String(args.maxCount ?? 10), ...(args.oneline !== false ? ['--oneline'] : [])], signal, start);
        case 'git_status': return await this.handleGitCmd(args, ['status', '--short'], signal, start);
        case 'sys_info': return await this.handleSysInfo(start);
        default:
          return this.fail(toolCall, start, `Unknown tool: ${toolCall.function.name}`);
      }
    } catch (err: any) {
      return this.fail(toolCall, start, err?.message ?? String(err));
    }
  }

  // ── Tool handlers ──

  private async handleReadFile(args: Record<string, unknown>, start: number): Promise<ToolResult> {
    const path = this.resolve(String(args.path));

    if (!existsSync(path)) {
      return this.fail(null!, start, `File not found: ${String(args.path)}`);
    }

    let meta: ReturnType<typeof statSync>;
    try {
      meta = statSync(path);
    } catch {
      return this.fail(null!, start, `File not found: ${String(args.path)}`);
    }
    if (meta.isDirectory()) {
      return this.fail(null!, start, `read_file: '${String(args.path)}' 是目录，不是文件——请用 list_files 查看目录内容，或补全到具体文件名。`);
    }

    if (meta.size > this.maxFileSize) {
      return this.fail(null!, start, `read_file: 文件 ${(meta.size / 1024 / 1024).toFixed(0)}MB 超过读取上限 ${Math.round(this.maxFileSize / 1024 / 1024)}MB；可以改用 search_files 搜索其中的内容，或用 execute_command 分段读取。`);
    }

    const bytes = new Uint8Array(await Bun.file(path).arrayBuffer());
    const { text: extracted, note } = await extractFileText(bytes, path);
    let text = extracted.trim();
    if (!text && note) {
      return this.fail(null!, start, `read_file: '${String(args.path)}' — ${note}`);
    }
    if (!text) {
      text = '(empty file)';
    }

    const lines = text.split('\n');

    const startLine = typeof args.startLine === 'number' ? Math.max(1, args.startLine) : 1;
    const endLine = typeof args.endLine === 'number' ? Math.min(args.endLine, lines.length) : lines.length;

    if (startLine > 1 || endLine < lines.length) {
      text = lines.slice(startLine - 1, endLine).join('\n');
    }

    return {
      id: `tool_${Date.now()}`,
      toolName: 'read_file',
      result: text,
      success: true,
      duration: Date.now() - start,
    };
  }

  private async handleWriteFile(args: Record<string, unknown>, start: number): Promise<ToolResult> {
    const pathArg = String(args.path);
    const path = this.resolve(pathArg);
    const content = String(args.content);
    const batch = await this.captureWriteBatch('write_file', [pathArg]);

    // Ensure parent directory exists
    const dir = dirname(path);
    if (dir && dir !== path) {
      await mkdir(dir, { recursive: true });
    }

    await Bun.write(path, content);
    const undoAvailable = await this.tryFinishWriteBatch(batch, [pathArg]);

    return {
      id: `tool_${Date.now()}`,
      toolName: 'write_file',
      result: `Wrote ${content.length} bytes to ${String(args.path)}${undoAvailable ? '' : ' (当前写入未提供撤销快照)'}`,
      success: true,
      duration: Date.now() - start,
    };
  }

  private async handleEditFile(args: Record<string, unknown>, start: number): Promise<ToolResult> {
    const pathArg = String(args.path);
    const path = this.resolve(pathArg);
    const oldStr = String(args.oldString);
    const newStr = String(args.newString);
    const allowMultiple = Boolean(args.allowMultiple);

    const file = Bun.file(path);
    if (!(await file.exists())) {
      return this.fail(null!, start, `File not found: ${String(args.path)}`);
    }

    const text = await file.text();
    const match = findEditMatch(text, oldStr);
    if (!match) {
      return this.fail(null!, start, editStringNotFoundError(String(args.path), oldStr), 'edit_file');
    }

    const occurrences = match.normalizedText.split(match.normalizedOld).length - 1;
    if (occurrences > 1 && !allowMultiple) {
      return this.fail(null!, start, `Found ${occurrences} occurrences of the string. Set allowMultiple:true to replace all, or provide more context to narrow the match.`);
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
    const searchDir = pathArg.trim() ? this.resolve(pathArg) : this.resolve('.');

    if (!existsSync(searchDir)) {
      return this.fail(null!, start, `search_files: '${pathArg || '.'}' 不存在。若这是 Windows 绝对路径，请确认路径拼写正确且磁盘上确实存在。`);
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
      return this.fail(null!, start, 'find_files: query 不能为空。请给出要查找的主题词，例如 "学历" 或 "education"。');
    }
    const pathArg = args.path ? String(args.path) : '';
    const searchDir = pathArg.trim() ? this.resolve(pathArg) : this.resolve('.');

    if (!existsSync(searchDir)) {
      return this.fail(null!, start, `find_files: '${pathArg || '.'}' 不存在。若这是 Windows 绝对路径，请确认路径拼写正确且磁盘上确实存在。`);
    }

    const max = Math.min(Math.max(1, typeof args.maxResults === 'number' ? Math.floor(args.maxResults) : 10), 30);
    const ignoreCase = args.caseSensitive !== true;
    const needles = tokenizeFindQuery(query);
    if (needles.length === 0) {
      return this.fail(null!, start, `find_files: 无法从查询 "${query}" 中提取有效关键词（只剩助词/停用词）。请换更具体的词，例如 "学历"、"毕业证" 或 "education"。`);
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
      const allFiles: { entry: string; nameScore: number }[] = [];
      for await (const entry of globAll.scan({ cwd: searchDir, absolute: false })) {
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
    const dirPath = this.resolve(String(args.path || '.'));
    const recursive = Boolean(args.recursive);

    // Bun.file(dirPath).exists() returns false for DIRECTORIES (Bun.file only
    // resolves regular files) — every real directory was misreported as
    // missing. existsSync + statSync().isDirectory() accept both; statSync
    // follows symlinks, matching how the glob below resolves the cwd.
    if (!existsSync(dirPath) || !statSync(dirPath).isDirectory()) {
      return this.fail(null!, start, `Directory not found: ${String(args.path || '.')}`);
    }

    const requestedMax = typeof args.maxResults === 'number' && Number.isFinite(args.maxResults)
      ? Math.floor(args.maxResults)
      : DEFAULT_MAX_LIST_RESULTS;
    const maxResults = Math.min(Math.max(1, requestedMax), ABSOLUTE_MAX_LIST_RESULTS);
    const items: string[] = [];
    const glob = new Bun.Glob(recursive ? '**/*' : '*');
    let truncated = false;

    for await (const entry of glob.scan({ cwd: dirPath, absolute: false, onlyFiles: false })) {
      if (items.length >= maxResults) {
        truncated = true;
        break;
      }
      items.push(entry);
    }

    items.sort();
    const listing = items.length > 0 ? items.join('\n') : '(empty directory)';
    const result = truncated
      ? `${listing}\n\n[截断] 仅显示前 ${maxResults} 项；目录还有更多内容，请缩小 path 或使用 search_files/glob_files。`
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
    // background:true → long-lived process (dev/static server, watcher).
    // Spawns detached and returns immediately with the PID + log file instead
    // of blocking until commandTimeout kills the server.
    if (args.background === true) {
      return this.handleBackgroundCommand(command, start);
    }
    const abort = createAbortController(signal, this.commandTimeout);

    try {
      // Windows commands run through powershell.exe -EncodedCommand: the
      // base64-UTF-16LE form bypasses the command-line quoting mangling a
      // plain -Command argument is subject to. The encoding also carries the
      // exit-code wrapper — PowerShell 5.1 exits 0 after a plain -Command
      // unless the script calls `exit` itself, and `$?` is false for both a
      // failing native command and a failing cmdlet, so either reports as
      // non-zero (mirrors Rust powershell_encoded_command).
      const shellArgs = IS_WINDOWS
        ? ['powershell', '-NoProfile', '-NonInteractive', '-EncodedCommand', encodePowerShellCommand(command)]
        : ['sh', '-c', command];
      // Inject the extended probe PATH on Unix so `node` / `bun` / nvm /
      // Homebrew commands resolve even when this process inherited a minimal
      // PATH (IDE integrated terminal, GUI-spawned launcher) — mirrors Rust
      // execute_command. Windows inherits the full system PATH.
      const spawnEnv = IS_WINDOWS ? undefined : { ...process.env, PATH: extendedProbePath() };
      const proc = Bun.spawn(shellArgs, {
        cwd: this.workspace,
        stdout: 'pipe',
        stderr: 'pipe',
        signal: abort.signal,
        env: spawnEnv,
      });

      // Strip ANSI color codes from captured output so logs / colored command
      // output render as plain text instead of mojibake.
      const stdout = stripAnsi((await new Response(proc.stdout).text()).trim());
      const stderr = stripAnsi(stripPowerShellStartupProgress((await new Response(proc.stderr).text()).trim()));
      await proc.exited;
      const exitCode = proc.exitCode ?? -1;

      const result = { stdout, stderr, exitCode };
      // Exit code is the single source of truth for success: a command that
      // printed output but exited non-zero FAILED (a failed `npm install` or
      // `cargo build`). Report it as such so the LLM and the failure policy
      // can react instead of treating the run as successful. stderr stays in
      // the result (and the error message) so the model sees what went wrong.
      if (exitCode !== 0) {
        return {
          id: `tool_${Date.now()}`,
          toolName: 'execute_command',
          result,
          error: formatCommandError(exitCode, [stdout, stderr ? `[stderr]\n${stderr}` : ''].filter(Boolean).join('\n')),
          success: false,
          duration: Date.now() - start,
        };
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
        return this.fail(null!, start, `Command timed out after ${this.commandTimeout}ms`);
      }
      return this.fail(null!, start, err?.message ?? 'Command execution failed');
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
  private async handleBackgroundCommand(command: string, start: number): Promise<ToolResult> {
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
    const shellArgs = IS_WINDOWS ? ['cmd', '/c', scriptFile] : ['sh', scriptFile];
    try {
      const proc = Bun.spawn(shellArgs, {
        cwd: this.workspace,
        stdin: 'ignore',
        stdout: 'ignore',
        stderr: 'ignore',
        detached: true,
        env: IS_WINDOWS ? undefined : { ...process.env, PATH: extendedProbePath() },
      });
      proc.unref();
      return {
        id: `tool_${Date.now()}`,
        toolName: 'execute_command',
        result: buildBackgroundResult(proc.pid ?? null, logFile),
        success: true,
        duration: Date.now() - start,
      };
    } catch (err: any) {
      return this.fail(null!, start, `background launch failed: ${err?.message ?? err}`, 'execute_command');
    }
  }

  private async handleCreateDirectory(args: Record<string, unknown>, start: number): Promise<ToolResult> {
    const pathArg = String(args.path);
    const dirPath = this.resolve(pathArg);
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

  private async handleDiffFiles(args: Record<string, unknown>, signal: AbortSignal | undefined, start: number): Promise<ToolResult> {
    const pathA = this.resolve(String(args.pathA));
    const pathB = this.resolve(String(args.pathB));
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
        return this.fail(null!, start, message);
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

      return this.fail(null!, start, stderr.trim() || `diff failed with exit code ${proc.exitCode}`);
    } catch (err: any) {
      if (err?.name === 'AbortError') {
        const message = signal?.aborted
          ? 'diff_files cancelled by the caller'
          : `diff_files timed out after ${this.commandTimeout}ms`;
        return this.fail(null!, start, message);
      }
      return this.fail(null!, start, err?.message ?? 'diff failed');
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
    if (!query) return this.fail(null!, start, 'Research prompt/query must not be empty', kind);
    const requestedSources = typeof args.maxSources === 'number' && Number.isFinite(args.maxSources)
      ? Math.min(8, Math.max(1, Math.floor(args.maxSources)))
      : 5;
    const maxChars = typeof args.maxCharsPerSource === 'number' && Number.isFinite(args.maxCharsPerSource)
      ? Math.min(12000, Math.max(500, Math.floor(args.maxCharsPerSource)))
      : 4000;
    const allowedDomains = Array.isArray(args.allowedDomains)
      ? args.allowedDomains.map(String).map((domain) => domain.trim().toLowerCase()).filter(Boolean)
      : [];
    const search = await this.handleWebSearch({ query, maxResults: Math.min(20, Math.max(requestedSources, requestedSources * 2)) }, start);
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
      return this.fail(null!, start, `${detail}. Rephrase the query or broaden the allowed domain list; do not repeat the unchanged query.`, kind);
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
    if (!query) return this.fail(null!, start, 'code_searcher query must not be empty', 'code_searcher');
    const searchDir = this.resolve(String(args.path || '.'));
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
    const rgArgs = ['--json', '--no-config', '--line-number', '--color', 'never', '--hidden', '--max-filesize', '8M', '--glob', '!.git/**', '--glob', '!node_modules/**', '--glob', '!dist/**', '--glob', '!build/**', '--glob', '!target/**'];
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
        return this.fail(null!, start, stderr.trim() || `rg failed with exit code ${exitCode}`, 'code_searcher');
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
        return this.fail(null!, start, message, 'code_searcher');
      }
      if (isRipgrepUnavailable(error)) {
        return this.handleCodeSearcherFallback(query, searchDir, scope, args, start);
      }
      return this.fail(null!, start, error?.message ?? 'code_searcher failed', 'code_searcher');
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
      return this.fail(null!, start, `Invalid regular expression: ${error?.message ?? String(error)}`, 'code_searcher');
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
      return this.fail(null!, start, `Invalid code_searcher glob: ${error?.message ?? String(error)}`, 'code_searcher');
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
      return this.fail(null!, start, error?.message ?? 'code_searcher fallback failed', 'code_searcher');
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

  private async handleWebSearch(args: Record<string, unknown>, start: number): Promise<ToolResult> {
    const query = String(args.query);
    const maxResults = Math.min(typeof args.maxResults === 'number' ? args.maxResults : 10, 20);
    const cjk = containsCJK(query);

    // Result cache: identical queries inside an agent loop (or across CLI/GUI
    // sessions) hit the shared ~/.pure/cache/web-cache.json instead of burning
    // free-tier quota or re-hitting rate-limited backends. TTL is 15 minutes;
    // PURE_WEB_CACHE=off disables. The Tier-2 fast path is cached separately
    // (cachedDirectPublicApi) with its own per-intent TTLs.
    const cacheKey = searchCacheKey(query, maxResults);
    const cached = webCache().get(cacheKey);
    if (cached !== undefined) {
      return {
        id: `tool_${Date.now()}`,
        toolName: 'web_search',
        result: `[cached] ${cached}`,
        success: true,
        duration: Date.now() - start,
      };
    }

    // 1) Serper API backend (real Google index — best quality for Chinese AND
    // English): opt-in via the SERPER_API_KEY env var. Mirrors the Rust
    // web_search — on failure or (for CJK) a relevance-gated-out set, degrade
    // to Tavily and then the free HTML backends below. Each API backend is
    // guarded by BackendQuota: a failed/over-budget backend goes into cooldown
    // instead of being retried on every query (free tiers die silently).
    let results: SearchResult[] = [];
    const failed: string[] = [];
    let anyEmpty = false;
    let irrelevant = 0;
    if (process.env.SERPER_API_KEY?.trim() && !quota.isBlocked('serper')) {
      try {
        const r = await serperSearch(query, maxResults);
        if (quota.registerUse('serper', 60_000, 20)) quota.markBlocked('serper', 60_000);
        if (r.length > 0) {
          if (!cjk || resultsRelevant(query, r)) results = dedupeResults(r);
          else irrelevant += 1;
        } else {
          anyEmpty = true;
        }
      } catch (err: any) {
        quota.markBlocked('serper', 300_000);
        failed.push(`Serper: ${err?.message ?? String(err)}`);
      }
    }

    // 2) Tavily API backend (the approach Claude Code / opencode use): opt-in
    // via the TAVILY_API_KEY env var. Mirrors the Rust web_search — on
    // failure or (for CJK) a relevance-gated-out set, degrade to the free
    // HTML backends below.
    if (process.env.TAVILY_API_KEY?.trim() && !quota.isBlocked('tavily')) {
      try {
        const r = await tavilySearch(query, maxResults);
        if (quota.registerUse('tavily', 60_000, 20)) quota.markBlocked('tavily', 60_000);
        if (r.length > 0) {
          // API results are usually on-topic; the CJK relevance gate still
          // applies so a bad API answer degrades to scraping.
          if (!cjk || resultsRelevant(query, r)) results = dedupeResults(r);
          else irrelevant += 1;
        } else {
          anyEmpty = true;
        }
      } catch (err: any) {
        quota.markBlocked('tavily', 300_000);
        failed.push(`Tavily: ${err?.message ?? String(err)}`);
      }
    }

    // 3) Exa neural-search backend: $20 signup credits + $10/month recurring
    // on the free tier (no payment method). Opt-in via the EXA_API_KEY env
    // var; same cooldown/use-cap treatment as Serper and Tavily.
    if (process.env.EXA_API_KEY?.trim() && !quota.isBlocked('exa')) {
      try {
        const r = await exaSearch(query, maxResults);
        if (quota.registerUse('exa', 60_000, 30)) quota.markBlocked('exa', 60_000);
        if (r.length > 0) {
          if (!cjk || resultsRelevant(query, r)) results = dedupeResults(r);
          else irrelevant += 1;
        } else {
          anyEmpty = true;
        }
      } catch (err: any) {
        quota.markBlocked('exa', 300_000);
        failed.push(`Exa: ${err?.message ?? String(err)}`);
      }
    }

    // 4) SearXNG metasearch backend (opt-in via SEARXNG_URL): intranet /
    // self-hosted instances aggregate dozens of upstream engines behind one
    // JSON endpoint — the standard answer for corporate or offline networks
    // where every public engine is blocked. Tried right after the API
    // backends, before scraping.
    if (results.length === 0 && process.env.SEARXNG_URL?.trim() && !quota.isBlocked('SearXNG')) {
      try {
        const r = await searxngSearch(query, maxResults);
        if (r.length > 0) {
          if (!cjk || resultsRelevant(query, r)) results = dedupeResults(r);
          else irrelevant += 1;
        } else {
          anyEmpty = true;
        }
      } catch (err: any) {
        quota.markBlocked('SearXNG', 300_000);
        failed.push(`SearXNG: ${err?.message ?? String(err)}`);
      }
    }

    // 5) Structured free backends (no key): DuckDuckGo Instant Answer,
    // Wikipedia search API, and Google News RSS. Each answers a different query
    // shape (facts/definitions, encyclopedic pages, current news) at near-API
    // quality with no quota — probed in parallel, first relevant set wins.
    // A failed/rate-limited backend sits in cooldown (guarded) so it is not
    // re-probed on every query.
    if (results.length === 0) {
      const structured: Array<{ label: string; fetch: () => Promise<SearchResult[]> }> = [
        { label: 'DuckDuckGo Instant', fetch: guarded('DuckDuckGo Instant', () => ddgInstantSearch(query, maxResults)) },
        { label: 'Wikipedia', fetch: guarded('Wikipedia', () => wikipediaSearch(query, maxResults)) },
        { label: 'Google News RSS', fetch: guarded('Google News RSS', () => googleNewsSearch(query, maxResults)) },
      ];
      const outcome = await firstRelevantResult(query, structured);
      if (outcome.results) {
        results = outcome.results;
      } else {
        failed.push(...outcome.failed);
        anyEmpty = anyEmpty || outcome.anyEmpty;
        irrelevant += outcome.irrelevant;
      }
    }

    // Free HTML backends, probed IN PARALLEL by firstRelevantResult below
    // (first set that passes the CJK relevance gate wins). CJK queries probe
    // the China-relevant engines — Sogou, cn.bing.com, 360 (so.com), Baidu —
    // plus the international ones as safety nets; non-CJK probes DuckDuckGo,
    // Bing, Brave and Mojeek. All fetches ride the shared cookie jar
    // (searchFetch) so session cookies from earlier searches keep anti-bot
    // challenges at bay.
    const backends: Array<{ label: string; fetch: () => Promise<SearchResult[]> }> = [
      ...(cjk
        ? [
            {
              label: 'Sogou',
              fetch: guarded('Sogou', async () => {
                const resp = await searchFetch(`https://www.sogou.com/web?query=${encodeURIComponent(query)}`, {
                  headers: { 'User-Agent': BROWSER_UA, 'Accept-Language': 'zh-CN,zh;q=0.9,en-US;q=0.8' },
                  redirect: 'follow',
                  signal: AbortSignal.timeout(8000),
                });
                if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
                return parseSogouResults(await readResponseText(resp), maxResults);
              }),
            },
            {
              label: 'cn.bing.com',
              fetch: guarded('cn.bing.com', async () => {
                const resp = await searchFetch(`https://cn.bing.com/search?q=${encodeURIComponent(query)}&count=${maxResults}&mkt=zh-CN`, {
                  headers: { 'User-Agent': BROWSER_UA, 'Accept-Language': 'zh-CN,zh;q=0.9,en-US;q=0.8' },
                  redirect: 'follow',
                  signal: AbortSignal.timeout(8000),
                });
                if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
                return parseBingResults(await readResponseText(resp), maxResults);
              }),
            },
            {
              label: '360',
              fetch: guarded('360', async () => {
                const resp = await searchFetch(`https://www.so.com/s?q=${encodeURIComponent(query)}`, {
                  headers: { 'User-Agent': BROWSER_UA, 'Accept-Language': 'zh-CN,zh;q=0.9,en-US;q=0.8' },
                  redirect: 'follow',
                  signal: AbortSignal.timeout(8000),
                });
                if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
                return parseSo360Results(await readResponseText(resp), maxResults);
              }),
            },
            {
              label: 'Baidu',
              fetch: guarded('Baidu', async () => {
                // Warm up a BAIDUID cookie before the first real query —
                // Baidu serves a captcha to cookie-less clients.
                await ensureBaiduCookies();
                const resp = await searchFetch(`https://www.baidu.com/s?wd=${encodeURIComponent(query)}&ie=utf-8`, {
                  headers: { 'User-Agent': BROWSER_UA, 'Accept-Language': 'zh-CN,zh;q=0.9,en-US;q=0.8' },
                  redirect: 'follow',
                  signal: AbortSignal.timeout(8000),
                });
                if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
                return parseBaiduResults(await readResponseText(resp), maxResults);
              }),
            },
          ]
        : []),
      {
        label: 'DuckDuckGo',
        fetch: guarded('DuckDuckGo', async () => {
          const resp = await searchFetch(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`, {
            headers: { 'User-Agent': BROWSER_UA, 'Accept-Language': 'en-US,en;q=0.9,zh-CN;q=0.8' },
            redirect: 'follow',
            signal: AbortSignal.timeout(8000),
          });
          if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
          return parseDuckDuckGoResults(await readResponseText(resp), maxResults);
        }),
      },
      {
        label: 'Bing',
        fetch: guarded('Bing', async () => {
          const mkt = cjk ? '&mkt=zh-CN&setlang=zh-hans' : '';
          const resp = await searchFetch(`https://www.bing.com/search?q=${encodeURIComponent(query)}&count=${maxResults}${mkt}`, {
            headers: { 'User-Agent': BROWSER_UA, 'Accept-Language': 'en-US,en;q=0.9,zh-CN;q=0.8' },
            redirect: 'follow',
            signal: AbortSignal.timeout(8000),
          });
          if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
          return parseBingResults(await readResponseText(resp), maxResults);
        }),
      },
      ...(cjk
        ? []
        : [
            {
              label: 'Brave',
              fetch: guarded('Brave', async () => {
                const resp = await searchFetch(`https://search.brave.com/search?q=${encodeURIComponent(query)}`, {
                  headers: { 'User-Agent': BROWSER_UA, 'Accept-Language': 'en-US,en;q=0.9' },
                  redirect: 'follow',
                  signal: AbortSignal.timeout(8000),
                });
                if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
                return parseBraveResults(await readResponseText(resp), maxResults);
              }),
            },
            {
              label: 'Mojeek',
              fetch: guarded('Mojeek', async () => {
                const resp = await searchFetch(`https://www.mojeek.com/search?q=${encodeURIComponent(query)}`, {
                  headers: { 'User-Agent': BROWSER_UA, 'Accept-Language': 'en-US,en;q=0.9' },
                  redirect: 'follow',
                  signal: AbortSignal.timeout(8000),
                });
                if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
                return parseMojeekResults(await readResponseText(resp), maxResults);
              }),
            },
          ]),
    ];
    // A failed/rate-limited backend sits in cooldown (30s) so the next query
    // skips it instead of re-hitting the same dead endpoint.
    const activeBackends = backends.filter((b) => !quota.isBlocked(b.label));

    // 6) Free HTML backends, probed IN PARALLEL — first relevant set wins
    // ("first win"), so a dead/slow/irrelevant backend no longer serializes
    // the search.
    if (results.length === 0 && activeBackends.length > 0) {
      const outcome = await firstRelevantResult(query, activeBackends);
      if (outcome.results) {
        results = outcome.results;
      } else {
        failed.push(...outcome.failed);
        anyEmpty = anyEmpty || outcome.anyEmpty;
        irrelevant += outcome.irrelevant;
      }
    } else if (results.length === 0) {
      // Every free backend is in cooldown (all failed recently) — retrying
      // now would only re-hit rate limits.
      failed.push('free HTML backends in cooldown (recent failures)');
    }

    // 7) One normalized retry: syntactically heavy queries (quotes,
    // operators, Chinese punctuation) make engines fail or return nothing
    // even when the intent is findable — strip the noise once and re-probe
    // the HTML backends before giving up.
    if (results.length === 0) {
      const simplified = normalizeQueryForRetry(query);
      if (simplified) {
        const retryBackends = backends.filter((b) => !quota.isBlocked(b.label));
        if (retryBackends.length > 0) {
          const outcome = await firstRelevantResult(simplified, retryBackends);
          if (outcome.results) {
            results = outcome.results;
          } else {
            failed.push(...outcome.failed);
            anyEmpty = anyEmpty || outcome.anyEmpty;
            irrelevant += outcome.irrelevant;
          }
        }
      }
    }

    // 8) Last resort: engines rendered through Jina Reader (r.jina.ai, free
    // tier ~20 req/min) — Bing, then Google, then DuckDuckGo. Jina fetches each
    // from its own infrastructure, so this works when every local engine is
    // blocked / rate-limited (China, restrictive networks) as long as r.jina.ai
    // is reachable. Each engine is rate-limited via the shared quota: a failed
    // or over-budget engine cools down instead of being re-hit every query.
    if (results.length === 0) {
      const jinaEngines: Array<{ label: string; run: () => Promise<SearchResult[]> }> = [
        { label: 'Bing via Jina', run: () => jinaBingSearch(query, maxResults) },
        { label: 'Google via Jina', run: () => jinaGoogleSearch(query, maxResults) },
        { label: 'DDG via Jina', run: () => jinaDuckDuckGoSearch(query, maxResults) },
      ];
      for (const engine of jinaEngines) {
        if (results.length > 0) break;
        if (quota.isBlocked(engine.label)) continue;
        try {
          const r = await engine.run();
          if (quota.registerUse(engine.label, 60_000, 20)) quota.markBlocked(engine.label, 60_000);
          if (r.length > 0) {
            results = dedupeResults(r);
          } else {
            anyEmpty = true;
          }
        } catch (err: any) {
          quota.markBlocked(engine.label, 60_000);
          failed.push(`${engine.label}: ${err?.message ?? String(err)}`);
        }
      }
    }

    if (results.length === 0) {
      // Backends answered but nothing usable (empty OR relevance-gated-out OR
      // all unreachable): the actionable guidance is the same — the query
      // itself needs rephrasing, or the search infra is down.
      if (anyEmpty || irrelevant > 0) {
        // When some backends were unreachable, say so — the model should not
        // conclude the query is bad when the real cause was network.
        const unreachable = failed.length > 0 ? ` (some backends unreachable: ${failed.join('; ')})` : '';
        return {
          id: `tool_${Date.now()}`,
          toolName: 'web_search',
          result: `No results found for "${query}" on the available search backends (${searchBackendNames(cjk)}) — the backends returned either no hits or only content unrelated to the query${unreachable}. Do NOT repeat the same query — rephrase it (broader terms, simpler wording, or English), or use web_fetch / web_scrape on a URL you expect to contain the information.`,
          success: true,
          duration: Date.now() - start,
        };
      }
      // Every backend errored (none returned empty): almost always network /
      // rate-limit / geo-block, NOT a bad query — tell the model not to
      // blindly retry, and how to recover. This is the message the failure
      // policy feeds back on.
      const details = failed.length > 0 ? failed.join('; ') : 'all backends unreachable';
      return this.fail(null!, start, `Web search failed on all backends (${details}). This looks like a network or rate-limit issue rather than a bad query — do NOT retry web_search immediately with the same or similar queries. Retry later, or use web_fetch / web_scrape on a URL you expect to contain the information.`);
    }

    const output = results
      .map((r, i) => `${i + 1}. ${r.title}\n   ${r.snippet}\n   ${r.url}`)
      .join('\n\n');
    webCache().set(cacheKey, output, SEARCH_TTL_MS);

    return {
      id: `tool_${Date.now()}`,
      toolName: 'web_search',
      result: output,
      success: true,
      duration: Date.now() - start,
    };
  }

  /**
   * The shared "get the page ANYWAY" chain composed by web_fetch and web_scrape:
   *   1. direct fetch (browser headers, transient-error retry, meta-refresh
   *      follow, feed/JSON formatting, direct PDF text extraction)
   *   2. Jina Reader (r.jina.ai) — blocked / JS-heavy / binary pages
   *   3. Wayback Machine — the closest archived snapshot of a dead/blocked page
   *   4. Firecrawl (opt-in FIRECRAWL_API_KEY) — the hardest anti-bot pages
   * Returns { text, via } on success or null when every tier failed, so both
   * callers degrade uniformly instead of failing on the first obstacle.
   */
  private async fetchPageWithFallbacks(
    url: string,
    opts: { selector?: string; signal?: AbortSignal },
  ): Promise<{ text: string; via: string } | null> {
    // 1) Direct fetch.
    try {
      const resp = await fetchWithRetry(url, { signal: opts.signal });
      if (resp.ok) {
        const contentType = resp.headers.get('content-type') || '';
        if (/pdf/i.test(contentType) || /\.pdf($|\?)/i.test(url)) {
          // PDF payloads: extract text directly before falling through to the
          // rendering tiers (which can also read PDFs but cost rate-limited
          // free quota).
          const pdfText = await this.extractPdfDirect(await resp.arrayBuffer());
          if (pdfText) return { text: pdfText, via: 'pdf' };
        } else if (isTextualContentType(contentType)) {
          let html = await readResponseText(resp);
          // Landing pages that JS-redirect via <meta http-equiv="refresh"> extract
          // to nothing — follow up to 3 hops until the page carries real content.
          for (let hop = 0; hop < 3; hop++) {
            const target = extractMetaRefreshUrl(html);
            if (!target) break;
            const nextUrl = resolveRedirectTarget(url, target);
            if (nextUrl === url) break;
            const nextResp = await fetchWithRetry(nextUrl, { signal: opts.signal });
            if (!nextResp.ok) break;
            html = await readResponseText(nextResp);
          }
          const text = formatPageBody(html, contentType, opts.selector);
          if (text.trim()) return { text: text.trim(), via: 'direct' };
        }
      }
    } catch {
      /* fall through to the next tier */
    }

    // 2) Jina Reader renders blocked / JS-heavy / binary pages as text.
    const jina = await scrapeViaJina(url, process.env.PURE_JINA_API_KEY);
    if (jina) return { text: jina.trim(), via: 'jina' };

    // 3) Wayback Machine: the closest archived snapshot of a dead/blocked page.
    const wayback = await scrapeViaWayback(url);
    if (wayback) {
      const text = formatPageBody(wayback, '', opts.selector);
      if (text.trim()) return { text: text.trim(), via: 'wayback' };
    }

    // 4) Firecrawl (opt-in key): server-side rendering for the hardest pages.
    const firecrawl = await scrapeViaFirecrawl(url, process.env.FIRECRAWL_API_KEY);
    if (firecrawl) return { text: firecrawl.trim(), via: 'firecrawl' };

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
        result: cachedPage,
        success: true,
        duration: Date.now() - start,
      };
    }
    // The full chain (direct + Jina + Wayback + Firecrawl) needs a wider budget
    // than a single direct fetch; the user-cancel signal still aborts it.
    const abort = createAbortController(signal, 60000);

    try {
      const outcome = await this.fetchPageWithFallbacks(url, { signal: abort.signal });
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
      recordNetSuccess(url);
      const truncated = outcome.text.length > maxChars ? outcome.text.slice(0, maxChars) + '\n\n[truncated]' : outcome.text;
      webCache().set(pageKey, truncated || '(empty page)', PAGE_TTL_MS);

      return {
        id: `tool_${Date.now()}`,
        toolName: 'web_fetch',
        result: truncated || '(empty page)',
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

  // ── 代理 / 内网识别 ──
  // 下载应区分「内网直连」与「外网走代理」：命中私有地址或 NO_PROXY 的 URL 直接
  // 连接，其余外部地址才经过代理（命令行显式 proxy 参数 → 标准环境变量）。

  /** 判断主机是否为私有/内网地址（直连，不经代理）。 */
  private isPrivateHost(host: string): boolean {
    const h = host.toLowerCase();
    if (h === 'localhost' || h === '::1' || h.endsWith('.localhost') || h.endsWith('.internal') || h.endsWith('.local')) return true;
    const m = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
    if (m) {
      const a = Number(m[1]);
      const b = Number(m[2]);
      if (a === 10) return true;
      if (a === 127) return true;
      if (a === 169 && b === 254) return true;
      if (a === 172 && b >= 16 && b <= 31) return true;
      if (a === 192 && b === 168) return true;
      if (a === 100 && b >= 64 && b <= 127) return true;
      if (a === 0) return true;
    }
    return false;
  }

  /** 主机是否匹配 NO_PROXY（支持域名后缀与 `*`）。 */
  private hostMatchesNoProxy(host: string, noProxy: string): boolean {
    const h = host.toLowerCase();
    return noProxy
      .split(/[,\s]/)
      .map((s) => s.trim())
      .filter(Boolean)
      .some((entry) => {
        const e = entry.toLowerCase();
        if (e === '*') return true;
        if (e.startsWith('.')) return h === e.slice(1) || h.endsWith(e);
        return h === e;
      });
  }

  /** 解析下载应使用的代理：显式 proxy 参数优先，其次环境变量；内网/匹配
   * NO_PROXY 时返回空串（直连）。返回 undefined 表示无法用标准代理（如 SOCKS）。 */
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
    const bypass = !proxy || this.isPrivateHost(host) || this.hostMatchesNoProxy(host, noProxy);
    return { proxy: bypass ? '' : proxy, bypass };
  }

  /** 将代理字符串规范为 URL；SOCKS 代理返回 'socks'（原生请求无法处理，需交给
   * curl/aria2c），非法值返回 null。 */
  private parseProxy(proxy: string): { url: URL; scheme: string } | 'socks' | null {
    try {
      const u = new URL(proxy);
      if (u.protocol === 'socks5:' || u.protocol === 'socks5h:' || u.protocol === 'socks4:' || u.protocol === 'socks4a:') {
        return 'socks';
      }
      if (['http:', 'https:'].includes(u.protocol)) return { url: u, scheme: u.protocol };
      return null;
    } catch {
      return null;
    }
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
      const pu = proxy ? this.parseProxy(proxy) : null;
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
    if ((res.statusCode ?? 200) >= 400) {
      res.resume();
      throw new Error(`HTTP ${res.statusCode}`);
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
    const done = new Array<boolean>(connections).fill(false);
    let written = 0;
    const runOne = async (i: number): Promise<void> => {
      if (done[i]) return;
      const s = i * chunkSize;
      const e = Math.min(total - 1, s + chunkSize - 1);
       let buf: Buffer;
       try {
         buf = await this.getRangeBuffer(url, s, e, controller.signal, proxy);
       } catch (err) {
        if (controller.paused && !controller.aborted) return;
        throw err;
      }
      await fd.write(buf, 0, buf.length, s);
      done[i] = true;
      written += buf.length;
      emit({ downloaded: written, total, percent: Math.min(100, Math.floor((written / total) * 100)), state: controller.paused ? 'paused' : 'downloading', filename });
    };
    const workers: Promise<void>[] = [];
    for (let i = 0; i < connections; i++) workers.push(runOne(i));
    await Promise.all(workers);
    while (done.includes(false) && !controller.aborted) {
      if (controller.paused) await controller.waitWhilePaused();
      if (controller.aborted) break;
      for (let i = 0; i < connections; i++) if (!done[i]) await runOne(i);
    }
    await fd.close();
    if (controller.aborted && done.includes(false)) throw new Error('已取消');
    return total;
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
          if (opts.controller.paused || opts.controller.aborted) {
          const size = await this.streamRange(url, outPath, (await stat(outPath)).size, opts.controller, opts.emit, total, opts.filename, opts.proxy);
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
      const res = await fetch(url, { signal: controller.signal, headers: this.downloadHeaders(url) });
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

  private downloadOk(outPath: string, size: number, duration: number, via: string, toolCallId: string, expected?: number): ToolResult {
    // Known content-length but a shorter file → the transfer did not complete
    // cleanly; surface it (informational, not a hard failure).
    const sizeMismatch = typeof expected === 'number' && expected > 0 && size < expected;
    const summary: Record<string, unknown> = { kind: 'download', path: outPath, size, durationMs: duration, via };
    if (sizeMismatch) summary.sizeMismatch = true;
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
    let outDir: string;
    if (destination && isAbsolute(destination)) outDir = destination;
    else if (destination === 'workspace') outDir = process.cwd();
    else if (destination && destination !== 'downloads') outDir = join(home, 'Downloads', destination);
    else outDir = join(home, 'Downloads');

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
      const errors: string[] = [];
      // 1) Native multi-threaded downloader (Range + resume + pause).
      const native = await this.downloadNative(url, outPath, { connections, resume, controller, emit, filename, proxy });
      if (native.ok) return this.downloadOk(outPath, native.size ?? 0, Date.now() - start, native.via ?? 'native', toolCallId, native.expected);
      errors.push(native.error ?? '');
      // 2) curl (resume via -C -).
      const curl = await this.downloadViaCurl(url, outPath, { resume, controller, emit, filename, proxy });
      if (curl.ok) return this.downloadOk(outPath, curl.size ?? 0, Date.now() - start, 'curl', toolCallId);
      errors.push(curl.error ?? '');
      // 3) aria2c (parallel + resume), when installed.
      const aria2 = await this.downloadViaAria2(url, outPath, { controller, emit, filename, proxy });
      if (aria2.ok) return this.downloadOk(outPath, aria2.size ?? 0, Date.now() - start, 'aria2c', toolCallId);
      errors.push(aria2.error ?? '');
      // 4) wget (resume via -c), when installed.
      const wget = await this.downloadViaWget(url, outPath, { controller, emit, filename, proxy });
      if (wget.ok) return this.downloadOk(outPath, wget.size ?? 0, Date.now() - start, 'wget', toolCallId);
      errors.push(wget.error ?? '');
      // 5) Plain fetch (small files only).
      const fetched = await this.downloadViaFetch(url, outPath, controller, emit, proxy);
      if (fetched.ok) return this.downloadOk(outPath, fetched.size ?? 0, Date.now() - start, 'fetch', toolCallId);
      errors.push(fetched.error ?? '');
      // 全部方式都失败：移除进度条（失败的下载不应残留进度条，仅成功下载保留）。
      downloadHub.clearProgress(toolCallId);
      const allErrors = errors.filter(Boolean).join('；') || '未知错误';
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
    if (!query) return this.fail(null!, start, 'web_public_api query must not be empty', 'web_public_api');
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
    // round-trip. Opt out with searchOnMiss:false.
    if (args.searchOnMiss !== false) {
      const search = await this.handleWebSearch({ query, maxResults: 8 }, start);
      if (search.success) return { ...search, toolName: 'web_public_api' };
    }
    return this.fail(
      null!,
      start,
      `No structured-data source matched "${query}" and web search also failed. web_public_api covers weather/geocode/news/wiki/IP/FX/stock/GitHub lookups — for anything else use researcher_web instead of retrying this tool with the same query (auto-fallback to search is off when searchOnMiss:false).`,
      'web_public_api',
    );
  }

  private async handleWebScrape(args: Record<string, unknown>, signal: AbortSignal | undefined, start: number): Promise<ToolResult> {
    const url = String(args.url ?? '').trim();
    if (!url) return this.fail(null!, start, 'web_scrape url must not be empty', 'web_scrape');
    const selector = typeof args.selector === 'string' ? args.selector.trim() || undefined : undefined;
    const maxChars = Math.min(typeof args.maxChars === 'number' ? args.maxChars : 20000, 50000);

    // Page cache: same URL + selector + maxChars bucket within the hour.
    const pageKey = pageCacheKey(url, selector, maxChars);
    const cachedPage = webCache().get(pageKey);
    if (cachedPage !== undefined) {
      return this.okResult('web_scrape', cachedPage, start);
    }
    // The full chain (direct + Jina + Wayback + Firecrawl) needs a wider budget
    // than a single direct fetch; the user-cancel signal still aborts it.
    const abort = createAbortController(signal, 60000);

    try {
      const outcome = await this.fetchPageWithFallbacks(url, { selector, signal: abort.signal });
      if (!outcome) {
        return this.fail(null!, start, `No readable content could be obtained from ${url} on any tier (direct / Jina Reader / Wayback / Firecrawl) — the page is blocked, removed, or requires interactive rendering. Do NOT retry web_scrape on this URL; use researcher_web to find a mirror or a different page.`, 'web_scrape');
      }
      const page = truncateText(outcome.text, maxChars);
      webCache().set(pageKey, page, PAGE_TTL_MS);
      return this.okResult('web_scrape', page, start);
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

  private async handleGlobFiles(args: Record<string, unknown>, start: number): Promise<ToolResult> {
    const pattern = String(args.pattern);
    const searchDir = this.resolve(String(args.path || '.'));
    const maxResults = typeof args.maxResults === 'number' ? args.maxResults : 200;

    const results: string[] = [];
    const glob = new Bun.Glob(pattern);

    for await (const entry of glob.scan({ cwd: searchDir, absolute: false, onlyFiles: true })) {
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
      return this.fail(null!, start, 'No files specified');
    }

    const results: string[] = [];
    let totalOccurrences = 0;
    let errors = 0;
    const batch = await this.captureWriteBatch('replace_files', files);

    for (const filePath of files) {
      try {
        const path = this.resolve(filePath);
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

  private async handleGitCmd(_args: Record<string, unknown>, gitArgs: string[], signal: AbortSignal | undefined, start: number): Promise<ToolResult> {
    const abort = createAbortController(signal, this.commandTimeout);

    try {
      const proc = Bun.spawn(['git', ...gitArgs], {
        cwd: this.workspace,
        stdout: 'pipe',
        stderr: 'pipe',
        signal: abort.signal,
      });

      const stdout = await new Response(proc.stdout).text();
      const stderr = await new Response(proc.stderr).text();
      await proc.exited;

      if (proc.exitCode !== 0) {
        return this.fail(null!, start, stderr.trim() || `git failed with exit code ${proc.exitCode}`);
      }

      return {
        id: `tool_${Date.now()}`,
        toolName: `git_${gitArgs[0] ?? 'unknown'}`,
        result: stdout.trim() || '(no output)',
        success: true,
        duration: Date.now() - start,
      };
    } catch (err: any) {
      if (err?.name === 'AbortError') {
        return this.fail(null!, start, `Git command timed out after ${this.commandTimeout}ms`);
      }
      return this.fail(null!, start, err?.message ?? 'Git command failed');
    } finally {
      abort.cleanup();
    }
  }

  private async handleSysInfo(start: number): Promise<ToolResult> {
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || process.env.TZ || 'unknown';
    const lang = Intl.DateTimeFormat().resolvedOptions().locale || process.env.LANG || process.env.LC_ALL || process.env.LC_CTYPE || 'unknown';
    const encoding = detectLocaleEncoding(lang);
    const time = new Date().toString();
    let osVersion = `${process.platform} ${process.arch}`;
    try {
      const uname = Bun.spawnSync({ cmd: ['uname', '-srm'], stdout: 'pipe', stderr: 'pipe' });
      if (uname.exitCode === 0) osVersion = new TextDecoder().decode(uname.stdout).trim();
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

    return {
      id: `tool_${Date.now()}`,
      toolName: 'sys_info',
      result: `timezone:  ${tz}\nlanguage:  ${lang}\nencoding:  ${encoding}\nip:        ${ipLine}\ntime:      ${time}\nos:        ${osVersion}\nlocation:  ${location}\nruntimes:  ${runtimes}\nnetwork:   ${network}`,
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
      const full = this.resolve(path);
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
      const full = this.resolve(entry.path);
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
      try { full = this.resolve(entry.path); } catch { conflicts.push(entry.path); continue; }
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

  private resolve(filePath: string): string {
    const resolved = pathResolve(this.workspace, filePath);
    // Workspace confinement is REMOVED: absolute paths anywhere on disk are
    // allowed (relative paths still resolve against the workspace root). The
    // remaining checks only guard against symlink tricks.

    let existing = resolved;
    const missing: string[] = [];
    while (!existsSync(existing)) {
      if (lstatSync(existing, { throwIfNoEntry: false })?.isSymbolicLink()) {
        throw new Error(`Path uses an unresolved symlink: ${filePath}`);
      }
      const parent = dirname(existing);
      if (parent === existing) throw new Error(`Path cannot be resolved: ${filePath}`);
      missing.push(basename(existing));
      existing = parent;
    }

    let safePath = realpathSync(existing);
    for (const component of missing.reverse()) safePath = pathResolve(safePath, component);
    return safePath;
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
      const res = await fetch(url, { headers: { 'User-Agent': BROWSER_UA }, signal: AbortSignal.timeout(2000) });
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
      const res = await fetch(url, { headers: { 'User-Agent': BROWSER_UA }, signal: AbortSignal.timeout(3000) });
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

// ── Shared cookie jar for HTML search backends ──
// Reusing session cookies (Baidu's BAIDUID, Bing's MUID, Sogou's SUV, …)
// across searches within the process is the single cheapest captcha-avoidance
// lever there is: a fresh cookie-less client trips anti-bot challenges on the
// very first request, which is exactly how "经常搜不到" happens. Mirrors the
// Rust SEARCH_COOKIE_JAR in src-tauri/src/lib.rs. In-memory only (no
// persistence across runs) and carries no credentials.
const searchCookieJar = new Map<string, Map<string, string>>(); // domain -> name -> value

function cookieHeaderFor(url: string): string {
  try {
    const host = new URL(url).host;
    const pairs: string[] = [];
    for (const [domain, cookies] of searchCookieJar) {
      if (host === domain || host.endsWith('.' + domain)) {
        for (const [k, v] of cookies) pairs.push(`${k}=${v}`);
      }
    }
    return pairs.join('; ');
  } catch {
    return '';
  }
}

function storeCookies(url: string, setCookieHeader: string | null): void {
  if (!setCookieHeader) return;
  try {
    const host = new URL(url).host;
    for (const raw of setCookieHeader.split(',')) {
      const [pair, ...attrs] = raw.split(';');
      const eq = pair.indexOf('=');
      if (eq === -1) continue;
      const name = pair.slice(0, eq).trim();
      const value = pair.slice(eq + 1).trim();
      if (!name) continue;
      // Honor an explicit Domain attribute; otherwise scope to the request host.
      let domain = host;
      for (const a of attrs) {
        const t = a.trim().toLowerCase();
        if (t.startsWith('domain=')) {
          const d = t.slice(7).trim().replace(/^\./, '');
          if (d) domain = d;
        }
      }
      if (!searchCookieJar.has(domain)) searchCookieJar.set(domain, new Map());
      searchCookieJar.get(domain)!.set(name, value);
    }
  } catch {
    /* ignore malformed cookie headers */
  }
}

/** fetch() that rides the shared cookie jar: attaches stored cookies for the
 * request host and stores any Set-Cookie the response returns. Used by the
 * HTML search backends (and the Baidu warm-up). */
async function searchFetch(url: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  const cookies = cookieHeaderFor(url);
  if (cookies) headers.set('Cookie', cookies);
  const resp = await fetch(url, { ...init, headers });
  storeCookies(url, resp.headers.get('set-cookie'));
  return resp;
}

// Lazily warmed-up flag: the first Baidu search first fetches the homepage so
// the jar picks up a BAIDUID cookie before the real query — Baidu serves a
// captcha page to cookie-less clients and the warm-up is the documented
// workaround. Best-effort (a failed warm-up just means the search may hit the
// captcha and degrade to the next backend). Mirrors Rust ensure_baidu_cookies.
let baiduWarmed = false;
async function ensureBaiduCookies(): Promise<void> {
  if (baiduWarmed) return;
  baiduWarmed = true;
  try {
    await searchFetch('https://www.baidu.com/', {
      headers: { 'User-Agent': BROWSER_UA, 'Accept-Language': 'zh-CN,zh;q=0.9' },
      signal: AbortSignal.timeout(4000),
    });
  } catch {
    /* best-effort */
  }
}

// ── Charset-aware HTTP body decoding ──
// `Response.text()` always decodes the body as UTF-8 (the Fetch spec mandates
// it), so GBK/GB2312 pages — very common on Chinese sites (Sogou, many 门户
// sites) — would otherwise come back as mojibake. The charset is resolved in
// priority order: Content-Type header charset → HTML <meta> charset sniff →
// UTF-8. Mirrors decode_response_with_charset in src-tauri/src/lib.rs.

/** Extract the charset parameter from a Content-Type header, if declared. */
export function charsetFromContentType(contentType: string): string | undefined {
  const m = contentType.match(/charset\s*=\s*["']?([^;"'\s]+)/i);
  return m?.[1];
}

/** Sniff `<meta charset=…>` / `<meta http-equiv="Content-Type" content="…charset=…">`
 * from the first bytes of an HTML page. The meta tag is ASCII, so scanning a
 * lossily-UTF-8-decoded head slice is safe even when the body is GBK. */
export function sniffHtmlCharset(bytes: Uint8Array): string | undefined {
  const head = new TextDecoder('utf-8').decode(bytes.slice(0, 2048));
  const m = head.match(/<meta[^>]+charset\s*=\s*["']?\s*([a-zA-Z0-9_\-]+)/i);
  return m?.[1];
}

/** Decode a response body with the resolved charset, falling back to UTF-8.
 * `TextDecoder` itself normalizes WHATWG labels (GB2312/gb_2312-80 → GBK), so
 * the declared label is passed through; utf-8-family and latin1 labels (the
 * common mislabel for actually-UTF-8 pages) skip re-decoding to avoid
 * regressions. */
export async function readResponseText(resp: Response): Promise<string> {
  const bytes = new Uint8Array(await resp.arrayBuffer());
  const label = normalizeCharsetLabel(
    charsetFromContentType(resp.headers.get('content-type') || '') ?? sniffHtmlCharset(bytes),
  );
  if (!label) return new TextDecoder('utf-8').decode(bytes);
  try {
    return new TextDecoder(label).decode(bytes);
  } catch {
    return new TextDecoder('utf-8').decode(bytes);
  }
}

function normalizeCharsetLabel(label: string | undefined): string | undefined {
  if (!label) return undefined;
  const l = label.trim().toLowerCase();
  // UTF-8 family needs no re-decode; iso-8859-1/latin1 is the classic
  // mislabel on pages that are actually UTF-8, so keep the UTF-8 behavior
  // rather than windows-1252-decode them into mojibake.
  if (!l || /^(utf-?8|us-ascii|ascii|iso-?8859-?1|latin-?1)$/.test(l)) return undefined;
  return l;
}

// ── DuckDuckGo HTML result parser ──

// ── Web search helpers (Tavily API + parallel first-win, mirrors lib.rs) ──

/**
 * Serper.dev Google SERP API backend: a real Google index — the best quality
 * for both Chinese and English, captcha-free. ~2500 free trial queries, then
 * prepaid credits (~$0.3–1 per 1k). Enabled when SERPER_API_KEY is set;
 * throws otherwise so callers degrade to Tavily / scraping. Mirrors the Rust
 * search_backend_serper in lib.rs (same gl/hl selection for CJK).
 */
export async function serperSearch(query: string, maxResults: number): Promise<SearchResult[]> {
  const apiKey = process.env.SERPER_API_KEY?.trim();
  if (!apiKey) throw new Error('SERPER_API_KEY not set');
  const cjk = containsCJK(query);
  const resp = await fetch('https://google.serper.dev/search', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-API-KEY': apiKey,
    },
    body: JSON.stringify({
      q: query,
      gl: cjk ? 'cn' : 'us',
      hl: cjk ? 'zh-cn' : 'en',
      num: maxResults,
    }),
    signal: AbortSignal.timeout(10000),
  });
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  const data: { organic?: Array<{ title?: string; link?: string; snippet?: string }> } = await resp.json();
  return (data.organic ?? [])
    .filter((r) => r.title && r.link)
    .map((r) => ({ title: r.title!, snippet: r.snippet ?? '', url: r.link! }));
}

/**
 * Tavily Search API backend (used by Claude Code / opencode-class agents):
 * stable index, captcha-free, good Chinese coverage. Enabled when
 * TAVILY_API_KEY is set; throws otherwise so callers degrade to scraping.
 */
export async function tavilySearch(query: string, maxResults: number): Promise<SearchResult[]> {
  const apiKey = process.env.TAVILY_API_KEY?.trim();
  if (!apiKey) throw new Error('TAVILY_API_KEY not set');
  const resp = await fetch('https://api.tavily.com/search', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      query,
      max_results: maxResults,
      search_depth: 'basic',
      include_answer: false,
    }),
    signal: AbortSignal.timeout(10000),
  });
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  const data: { results?: Array<{ title?: string; url?: string; content?: string }> } = await resp.json();
  return (data.results ?? [])
    .filter((r) => r.title && r.url)
    .map((r) => ({ title: r.title!, snippet: r.content ?? '', url: r.url! }));
}

/**
 * Exa neural-search backend: semantic + keyword hybrid search with page
 * contents and publish dates. Free tier = $20 signup credits (~2,800
 * searches) plus $10 in credits every month, no payment method required.
 * Enabled when EXA_API_KEY is set; throws otherwise so callers degrade to
 * the free HTML backends.
 */
export async function exaSearch(query: string, maxResults: number): Promise<SearchResult[]> {
  const apiKey = process.env.EXA_API_KEY?.trim();
  if (!apiKey) throw new Error('EXA_API_KEY not set');
  const resp = await fetch('https://api.exa.ai/search', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
    },
    body: JSON.stringify({
      query,
      numResults: maxResults,
      type: 'auto',
      contents: { text: { maxCharacters: 600 } },
    }),
    signal: AbortSignal.timeout(10000),
  });
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  const data: { results?: Array<{ title?: string; url?: string; text?: string; publishedDate?: string }> } = await resp.json();
  return (data.results ?? [])
    .filter((r) => r.title && r.url)
    .map((r) => {
      const date = typeof r.publishedDate === 'string' && r.publishedDate ? ` (${r.publishedDate.slice(0, 10)})` : '';
      return { title: `${r.title}${date}`, snippet: r.text ?? '', url: r.url! };
    });
}

/** SearXNG metasearch backend (opt-in via SEARXNG_URL): intranet /
 * self-hosted instances aggregate dozens of upstream engines behind one JSON
 * endpoint — the standard answer for corporate or offline networks where
 * every public engine is blocked. Expects an instance with JSON format
 * enabled (settings.yml `formats: [html, json]`). Mirrors the Rust
 * search_backend_searxng in lib.rs. */
export async function searxngSearch(query: string, maxResults: number): Promise<SearchResult[]> {
  const base = process.env.SEARXNG_URL?.trim();
  if (!base) throw new Error('SEARXNG_URL not set');
  const resp = await fetch(
    `${base.replace(/\/+$/, '')}/search?q=${encodeURIComponent(query)}&format=json&safesearch=0`,
    {
      headers: { 'User-Agent': BROWSER_UA },
      signal: AbortSignal.timeout(10000),
    },
  );
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  const data: { results?: Array<{ title?: string; url?: string; content?: string }> } = await resp.json();
  return (data.results ?? [])
    .filter((r) => r.title && r.url)
    .map((r) => ({ title: r.title!, snippet: r.content ?? '', url: r.url! }));
}

/** Google News RSS backend (free, no key): recent news matching the query in
 * structured RSS. Reachable on more networks than full search engines, and the
 * parser is shared with the web_public_api news intent. News-leaning results —
 * the relevance gate drops them for off-topic queries. Mirrors Rust
 * search_backend_google_news_rss. */
export async function googleNewsSearch(query: string, maxResults: number): Promise<SearchResult[]> {
  const cjk = containsCJK(query);
  const hl = cjk ? 'zh-CN' : 'en-US';
  const gl = cjk ? 'CN' : 'US';
  const ceid = cjk ? 'CN:zh-Hans' : 'US:en';
  const resp = await searchFetch(
    `https://news.google.com/rss/search?q=${encodeURIComponent(query)}&hl=${hl}&gl=${gl}&ceid=${ceid}`,
    { headers: { 'User-Agent': BROWSER_UA }, signal: AbortSignal.timeout(8000) },
  );
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  const items = parseRssItems(await resp.text(), maxResults);
  return items.map((item) => ({ title: item.title, snippet: item.description, url: item.link }));
}

/** DuckDuckGo Instant Answer API (free, no key): structured facts/definitions
 * for direct queries ("what is X"). Returns zero results for non-answer
 * queries, so it is a cheap structured tier that drops out harmlessly. Mirrors
 * Rust search_backend_ddg_instant. */
export async function ddgInstantSearch(query: string, maxResults: number): Promise<SearchResult[]> {
  const resp = await searchFetch(
    `https://api.duckduckgo.com/?q=${encodeURIComponent(query)}&format=json&no_html=1&skip_disambig=1`,
    { headers: { 'User-Agent': BROWSER_UA }, signal: AbortSignal.timeout(8000) },
  );
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  const data = (await resp.json()) as {
    Heading?: string; AbstractText?: string; AbstractURL?: string;
    RelatedTopics?: Array<{ Text?: string; FirstURL?: string; Topics?: Array<{ Text?: string; FirstURL?: string }> }>;
  };
  const out: SearchResult[] = [];
  if (data.AbstractText && data.AbstractURL) {
    out.push({ title: data.Heading || query, snippet: data.AbstractText, url: data.AbstractURL });
  }
  const related = Array.isArray(data.RelatedTopics) ? data.RelatedTopics : [];
  for (const topic of related) {
    if (!topic || typeof topic !== 'object') continue;
    if (Array.isArray(topic.Topics)) {
      for (const sub of topic.Topics) {
        if (sub?.Text && sub.FirstURL && out.length < maxResults) {
          out.push({ title: sub.Text.slice(0, 80), snippet: sub.Text, url: sub.FirstURL });
        }
      }
    } else if (topic.Text && topic.FirstURL && out.length < maxResults) {
      out.push({ title: topic.Text.slice(0, 80), snippet: topic.Text, url: topic.FirstURL });
    }
  }
  return out;
}

/** Wikipedia search API (free, no key): fact-oriented page hits. Snippets come
 * with `<span class="searchmatch">` highlights — stripped here. CJK queries hit
 * zh.wikipedia.org. Mirrors Rust search_backend_wikipedia. */
export async function wikipediaSearch(query: string, maxResults: number): Promise<SearchResult[]> {
  const cjk = containsCJK(query);
  const host = cjk ? 'zh.wikipedia.org' : 'en.wikipedia.org';
  const resp = await searchFetch(
    `https://${host}/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(query)}&format=json&srlimit=${Math.min(maxResults, 10)}`,
    { headers: { 'User-Agent': BROWSER_UA }, signal: AbortSignal.timeout(8000) },
  );
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  const data = (await resp.json()) as { query?: { search?: Array<{ title?: string; snippet?: string }> } };
  const hits = data.query?.search ?? [];
  const out: SearchResult[] = [];
  for (const hit of hits) {
    if (out.length >= maxResults) break;
    const title = String(hit.title ?? '').trim();
    if (!title) continue;
    const snippet = stripHtml(String(hit.snippet ?? '')).trim();
    out.push({ title, snippet, url: `https://${host}/wiki/${encodeURIComponent(title.replace(/ /g, '_'))}` });
  }
  return out;
}

/** Shared Jina Reader render: fetch <engineUrl><encodedQuery> through
 * r.jina.ai (free tier, PURE_JINA_API_KEY raises limits) and parse the
 * returned markdown into results. Used by every last-resort engine. */
async function jinaRenderSearch(query: string, maxResults: number, engineUrl: string): Promise<SearchResult[]> {
  const headers: Record<string, string> = {
    'User-Agent': BROWSER_UA,
    'X-Return-Format': 'markdown',
    Accept: 'text/plain',
  };
  const apiKey = process.env.PURE_JINA_API_KEY?.trim();
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
  const resp = await searchFetch(`https://r.jina.ai/${engineUrl}${encodeURIComponent(query)}`, {
    headers,
    signal: AbortSignal.timeout(15000),
  });
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  return parseJinaMarkdownResults(await resp.text(), maxResults);
}

/** Last-resort universal backends: Bing / Google / DuckDuckGo rendered through
 * Jina Reader (`r.jina.ai`, free tier ~20 req/min, no key). Jina fetches each
 * engine from its own infrastructure, so this works when every local engine is
 * blocked or rate-limited (China / restrictive networks), as long as r.jina.ai
 * itself is reachable. Tried in sequence, Bing first. Mirrors the Rust
 * search_backend_jina_bing / search_backend_jina_google / search_backend_jina_ddg. */
export async function jinaBingSearch(query: string, maxResults: number): Promise<SearchResult[]> {
  return jinaRenderSearch(query, maxResults, 'https://www.bing.com/search?q=');
}
export async function jinaGoogleSearch(query: string, maxResults: number): Promise<SearchResult[]> {
  return jinaRenderSearch(query, maxResults, 'https://www.google.com/search?q=');
}
export async function jinaDuckDuckGoSearch(query: string, maxResults: number): Promise<SearchResult[]> {
  return jinaRenderSearch(query, maxResults, 'https://html.duckduckgo.com/html/?q=');
}

/** Human-readable list of the actually-configured backends for the
 * no-results guidance the model feeds back on (mirrors the Rust
 * configured_backend_names). */
export function searchBackendNames(cjk: boolean): string {
  const names: string[] = [
    ...(process.env.SERPER_API_KEY?.trim() ? ['Serper'] : []),
    ...(process.env.TAVILY_API_KEY?.trim() ? ['Tavily'] : []),
    ...(process.env.EXA_API_KEY?.trim() ? ['Exa'] : []),
    ...(process.env.SEARXNG_URL?.trim() ? ['SearXNG'] : []),
    'DuckDuckGo Instant',
    'Wikipedia',
    'Google News RSS',
    ...(cjk ? ['Sogou', 'cn.bing.com', '360', 'Baidu'] : []),
    'DuckDuckGo',
    'Bing',
    ...(cjk ? [] : ['Brave', 'Mojeek']),
  ];
  return names.join(', ');
}

/** Wrap a free-HTML-backend fetch so a failure puts the backend into a short
 * cooldown (30s) — a captcha-walled or geo-blocked engine is otherwise
 * re-probed on every query, wasting latency on a dead endpoint. */
function guarded(label: string, fetch: () => Promise<SearchResult[]>): () => Promise<SearchResult[]> {
  return async () => {
    try {
      return await fetch();
    } catch (err) {
      quota.markBlocked(label, 30_000);
      throw err;
    }
  };
}

/**
 * Probe all HTML backends concurrently and return the first result set that
 * passes the relevance gate ("first win"). A backend that errors, returns
 * empty, or fails the gate just drops out; if none survives, the aggregated
 * failure info lets the caller compose the right message. O(backends) memory
 * for the pending-promise set is fine (≤4 backends).
 */
export async function firstRelevantResult(
  query: string,
  backends: Array<{ label: string; fetch: () => Promise<SearchResult[]> }>,
): Promise<{ results?: SearchResult[]; failed: string[]; anyEmpty: boolean; irrelevant: number }> {
  const failed: string[] = [];
  let anyEmpty = false;
  let irrelevant = 0;
  let pending = backends.map((b, i) =>
    b.fetch().then(
      (r) => ({ i, r }),
      (err: any) => ({ i, error: err?.message ?? String(err) }),
    ),
  );
  while (pending.length > 0) {
    // Race the current pending set; the resolved VALUE carries the ORIGINAL
    // backend index (captured at creation) while pendingIndex is the index
    // within the CURRENT (shrinking) array — the two must stay separate so
    // removing a finished task never mislabels a later one.
    const { value, pendingIndex } = await Promise.race(
      pending.map((p, idx) => p.then((v) => ({ value: v, pendingIndex: idx }))),
    );
    pending = pending.filter((_, k) => k !== pendingIndex);
    if ('error' in value) {
      failed.push(`${backends[value.i].label}: ${value.error}`);
      continue;
    }
    if (value.r.length > 0) {
      // Relevance gate: a set that does not address the query must not be
      // handed to the model — it is what pushed the agent into repeated
      // searches. Gated-out sets drop out like empty ones.
      if (resultsRelevant(query, value.r)) {
        return { results: dedupeResults(value.r), failed, anyEmpty, irrelevant };
      }
      irrelevant += 1;
    } else {
      anyEmpty = true;
    }
  }
  return { failed, anyEmpty, irrelevant };
}

interface SearchResult {
  title: string;
  snippet: string;
  url: string;
}

/** True when the query contains CJK ideographs (CJK Unified Ideographs, CJK
 * Extension A, and CJK Compatibility Ideographs) — the trigger for routing a
 * search through the China Bing backend (cn.bing.com) first. Mirrors
 * src-tauri/src/lib.rs `is_chinese_query`; both sides have matching tests. */
export function containsCJK(query: string): boolean {
  return /[\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF]/.test(query);
}

// ── Sogou HTML result parser (CJK-priority backend) ──

/** Parse Sogou results (`<h3 class="vr-title …">` blocks with a single
 * `<a href="…">TITLE</a>`, snippet in the block's trailing
 * `<p class="star-wiki …">` or `<div class="fz-mid space-txt">`). Sogou
 * highlights matched terms with `<em><!--red_beg-->…<!--red_end--></em>` inside
 * titles — the title is stripped to `</a>` (NOT to the first '<' like the Bing
 * parser, whose titles have no nested tags). `/link?url=…` redirects are
 * absolutized to `https://www.sogou.com/…` so the model can still web_fetch
 * them. Dedupes by URL/title. Mirrors src-tauri/src/lib.rs
 * `parse_sogou_results` — both sides have matching tests. */
export function parseSogouResults(html: string, maxResults: number): SearchResult[] {
  const results: SearchResult[] = [];
  let pos = 0;
  while (results.length < maxResults) {
    const relH3 = html.indexOf('<h3', pos);
    if (relH3 === -1) break;
    // Block = this <h3> through the start of the next <h3> (or end of page):
    // the anchor/title live inside the h3, while the snippet container
    // (<p class="star-wiki"> / <div class="fz-mid space-txt">) sits right
    // AFTER </h3>, before the next result block.
    const afterH3 = relH3 + 3;
    const nextRel = html.indexOf('<h3', afterH3);
    const nextH3 = nextRel === -1 ? html.length : nextRel;
    const block = html.slice(relH3, nextH3);
    const parsed = parseSogouBlock(block);
    if (parsed && !results.some(x => x.url === parsed.url || x.title === parsed.title)) {
      results.push(parsed);
    }
    pos = nextH3;
  }
  return results;
}

function parseSogouBlock(block: string): SearchResult | undefined {
  const aIdx = block.indexOf('<a');
  if (aIdx === -1) return undefined;
  const rawUrl = extractHref(block, aIdx);
  if (!rawUrl) return undefined;
  // Absolutize Sogou's relative redirect links (/link?url=…, //www.sogou.com/…).
  let url = rawUrl;
  if (url.startsWith('//')) url = `https:${url}`;
  else if (url.startsWith('/')) url = `https://www.sogou.com${url}`;

  // Title: anchor text, stripped to </a> — Sogou bolds matched terms with <em>
  // INSIDE the title text, so stripping to the first '<' would cut the title
  // short; strip tags and keep everything up to </a>.
  const afterA = block.slice(aIdx);
  const gt = afterA.indexOf('>');
  if (gt === -1) return undefined;
  const afterGt = afterA.slice(gt + 1);
  const anchorEnd = afterGt.indexOf('</a>');
  if (anchorEnd === -1) return undefined;
  const title = decodeHtmlEntities(stripHtml(afterGt.slice(0, anchorEnd))).trim();

  // Snippet: star-wiki <p> first (organic results), else the fz-mid div
  // (zhihu/other layouts). Both sit after the anchor inside the h3 block.
  let snippet = '';
  const region = afterGt.slice(anchorEnd + '</a>'.length);
  const star = region.indexOf('<p class="star-wiki');
  if (star !== -1) {
    const afterStar = region.slice(star);
    const starGt = afterStar.indexOf('>');
    if (starGt !== -1) {
      const content = afterStar.slice(starGt + 1);
      const end = content.indexOf('</p>');
      if (end !== -1) snippet = content.slice(0, end);
    }
  } else {
    // fz-mid div (zhihu/other layouts). Substring search so a reordered class
    // list ("space-txt fz-mid") still matches; the star-wiki <p> was already
    // ruled out above, so a stray match here is a genuine snippet container.
    const fz = region.indexOf('fz-mid');
    if (fz !== -1) {
      const afterFz = region.slice(fz);
      const fzGt = afterFz.indexOf('>');
      if (fzGt !== -1) {
        const content = afterFz.slice(fzGt + 1);
        const end = content.indexOf('</div>');
        if (end !== -1) snippet = content.slice(0, end);
      }
    }
  }
  snippet = decodeHtmlEntities(stripHtml(snippet)).trim();

  if (!title || !url) return undefined;
  return { title, snippet, url };
}

// ── Relevance gate (keeps garbage result sets from reaching the model) ──

/** Chars that glue Chinese queries together (particles / prepositions /
 * function words) — a CJK bigram containing one is NOT a meaningful content
 * token ("西安到重庆" keeps 西安/重庆; 安到/到重 are dropped). Content words like
 * 时间/价格/大小 are deliberately NOT here — they are what relevance is
 * measured against. Mirrors src-tauri/src/lib.rs `significant_cjk_bigrams`
 * (same table, same semantics). */
const CJK_FUNCTION_CHARS = new Set(
  // Particles / prepositions / function words that glue CJK queries together.
  // Direction/position words (上下左右前后内外中) are deliberately ABSENT — 上/中
  // etc. start too many content words (上海/中国) for them to be safe to drop.
  '到从的与和及了在是这那之而或把被让为对于等些个吗呢吧啊呀过并但可就最很也都' +
  '不没无来去要将会正已经还又请问想有里给做用得着所以且者起向往自从于对'.split(''),
);

function isCJKChar(c: string): boolean {
  return /[\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF]/.test(c);
}

/** Significant CJK content bigrams of a query (deduped, glue chars dropped).
 * Mirrors the Rust side; exported for the mirror tests. */
export function significantCJKBigrams(query: string): string[] {
  const chars = [...query];
  const out = new Set<string>();
  for (let i = 0; i + 1 < chars.length; i++) {
    const a = chars[i];
    const b = chars[i + 1];
    if (isCJKChar(a) && isCJKChar(b) && !CJK_FUNCTION_CHARS.has(a) && !CJK_FUNCTION_CHARS.has(b)) {
      out.add(a + b);
    }
  }
  return [...out];
}

/** Relevance gate: accept a backend's result set only if the top-5 results
 * actually address the query. For CJK queries this means covering the query's
 * significant bigrams (cn.bing.com returning Xi'an tourism guides for
 * "西安到重庆 机票" covers only 西安 → 1/3 → REJECTED, so the chain rolls over
 * instead of handing the model garbage that triggers repeated searches).
 * Accept when ≥2 distinct bigrams are covered, or ≥ half of a short query's
 * bigrams. Non-CJK queries and queries with <2 significant bigrams are always
 * accepted. Mirrors src-tauri/src/lib.rs `results_relevant`. */
export function resultsRelevant(query: string, results: SearchResult[]): boolean {
  const sig = significantCJKBigrams(query);
  if (sig.length < 2) return true;
  const covered = new Set<string>();
  for (const r of results.slice(0, 5)) {
    const hay = `${r.title}\n${r.snippet}\n${r.url}`;
    for (const bg of sig) {
      if (hay.includes(bg)) covered.add(bg);
    }
  }
  if (covered.size >= 2) return true;
  return covered.size / sig.length >= 0.5;
}

/** Drop duplicate results (same URL or same title) — search pages repeat
 * entries across sections, and duplicated titles confuse the LLM. */
export function dedupeResults(results: SearchResult[]): SearchResult[] {
  const seen = new Set<string>();
  return results.filter(r => {
    const key = r.url || r.title;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** Extract a bare double-quoted attribute value from HTML, e.g.
 * `data-mdurl="https://…"` — used where `<a>` hrefs are redirect wrappers.
 * Mirrors the Rust extract_attr. */
function extractAttr(block: string, attr: string): string | undefined {
  const idx = block.indexOf(attr);
  if (idx === -1) return undefined;
  const rest = block.slice(idx + attr.length).trimStart();
  if (!rest.startsWith('=')) return undefined;
  const after = rest.slice(1).trimStart();
  if (after[0] === '"' || after[0] === "'") {
    const end = after.indexOf(after[0], 1);
    if (end === -1) return undefined;
    return after.slice(1, end);
  }
  const m = after.match(/^[^\s>]+/);
  return m?.[0];
}

/** Parse 360 Search (so.com) results (`<li class="res-list">` blocks with a
 * `<h3 class="res-title"><a data-mdurl="REAL_URL" href="…">TITLE</a></h3>`
 * title and a `<p class="res-desc">` snippet). `data-mdurl` carries the real
 * destination (the href is a /link?m=… redirect), so it wins; otherwise the
 * href is absolutized. Mirrors src-tauri/src/lib.rs `parse_so360_results`. */
export function parseSo360Results(html: string, maxResults: number): SearchResult[] {
  const results: SearchResult[] = [];
  const marker = '<li class="res-list';
  let rest = html;
  while (results.length < maxResults) {
    const idx = rest.indexOf(marker);
    if (idx === -1) break;
    const tail = rest.slice(idx);
    const next = tail.indexOf(marker, marker.length);
    const end = next === -1 ? tail.length : next;
    const block = tail.slice(0, end);
    const parsed = parseSo360Block(block);
    if (parsed) results.push(parsed);
    rest = tail.slice(end);
  }
  return results;
}

function parseSo360Block(block: string): SearchResult | undefined {
  const titleStart = block.indexOf('res-title');
  if (titleStart === -1) return undefined;
  const relA = block.slice(titleStart).indexOf('<a');
  if (relA === -1) return undefined;
  const aIdx = titleStart + relA;
  const rawHref = extractHref(block, aIdx);
  if (rawHref === undefined) return undefined;
  // data-mdurl holds the real URL when present (modern markup); else the
  // href is a /link?m=… redirect we absolutize.
  const url = extractAttr(block, 'data-mdurl')
    ?? (rawHref.startsWith('//') ? `https:${rawHref}`
      : rawHref.startsWith('/') ? `https://www.so.com${rawHref}`
      : rawHref);

  const afterA = block.slice(aIdx);
  const gt = afterA.indexOf('>');
  if (gt === -1) return undefined;
  const afterGt = afterA.slice(gt + 1);
  const anchorEnd = afterGt.indexOf('</a>');
  if (anchorEnd === -1) return undefined;
  const title = decodeHtmlEntities(stripHtml(afterGt.slice(0, anchorEnd))).trim();
  if (!title || !url) return undefined;

  // Snippet: <p class="res-desc">…</p> (organic) — the span inside is
  // stripped too. res-desc IS the <p> tag's class, so the content starts at
  // the tag's '>' after the class name.
  let snippet = '';
  const d = block.indexOf('res-desc');
  if (d !== -1) {
    const afterD = block.slice(d);
    const gt = afterD.indexOf('>');
    if (gt !== -1) {
      const content = afterD.slice(gt + 1);
      const end = content.indexOf('</p>');
      if (end !== -1) snippet = decodeHtmlEntities(stripHtml(content.slice(0, end))).trim();
    }
  }

  return { title, snippet, url };
}

/** Parse Baidu results (best-effort — Baidu serves a captcha to cookie-less
 * or foreign clients, so this backend degrades gracefully to the next one).
 * Blocks are `<div class="result c-container …">`; title from
 * `<h3 class="t"><a href="…">TITLE</a></h3>` (or the `data-tools` JSON on
 * some blocks), snippet from `.content-right_…` / `.c-abstract` / `.c-span-last`.
 * Mirrors src-tauri/src/lib.rs `parse_baidu_results`. */
export function parseBaiduResults(html: string, maxResults: number): SearchResult[] {
  const results: SearchResult[] = [];
  const marker = 'class="result c-container';
  let rest = html;
  while (results.length < maxResults) {
    const idx = rest.indexOf(marker);
    if (idx === -1) break;
    const tail = rest.slice(idx);
    const next = tail.indexOf(marker, marker.length);
    const end = next === -1 ? tail.length : next;
    const block = tail.slice(0, end);
    const parsed = parseBaiduBlock(block);
    if (parsed) results.push(parsed);
    rest = tail.slice(end);
  }
  return results;
}

function parseBaiduBlock(block: string): SearchResult | undefined {
  // data-tools='{"title":"…","url":"…"}' is the most reliable source on
  // modern Baidu markup; fall back to the h3 anchor.
  let title = '';
  let url = '';
  const tools = extractAttr(block, 'data-tools');
  if (tools) {
    try {
      const v = JSON.parse(tools.replace(/&quot;/g, '"'));
      title = String(v.title ?? '');
      url = String(v.url ?? '');
    } catch { /* malformed JSON → fall through to h3 */ }
  }
  if (!url) {
    const h3 = block.indexOf('<h3');
    if (h3 !== -1) {
      const afterH3 = block.slice(h3);
      const aIdx = afterH3.indexOf('<a');
      if (aIdx !== -1) {
        url = extractHref(afterH3, aIdx) ?? '';
        const afterA = afterH3.slice(aIdx);
        const gt = afterA.indexOf('>');
        if (gt !== -1) {
          const afterGt = afterA.slice(gt + 1);
          const end = afterGt.indexOf('</a>');
          if (end !== -1) title = decodeHtmlEntities(stripHtml(afterGt.slice(0, end))).trim();
        }
      }
    }
  }
  // Snippet: content-right… / c-abstract / c-span-last containers.
  let snippet = '';
  for (const needle of ['content-right', 'c-abstract', 'c-span-last']) {
    const i = block.indexOf(needle);
    if (i === -1) continue;
    const after = block.slice(i);
    const gt = after.indexOf('>');
    if (gt === -1) continue;
    const content = after.slice(gt + 1);
    const divEnd = content.indexOf('</div>');
    const spanEnd = content.indexOf('</span>');
    const end = divEnd === -1 ? (spanEnd === -1 ? content.length : spanEnd) : (spanEnd === -1 ? divEnd : Math.min(divEnd, spanEnd));
    const s = decodeHtmlEntities(stripHtml(content.slice(0, end))).trim();
    if (s) {
      snippet = s;
      break;
    }
  }
  title = title.trim();
  if (!title || !url) return undefined;
  return { title, snippet, url: decodeHtmlEntities(url) };
}

/** Parse Brave Search results (`<div class="snippet …" data-type="web">`
 * blocks with a `title search-snippet-title` div — the anchor URL lives
 * earlier in the block — and a `generic-snippet` paragraph). The svelte hash
 * suffixes rotate across Brave builds, so blocks are matched on the stable
 * `class="snippet ` prefix and the `search-snippet-title` / `generic-snippet`
 * substrings. Mirrors src-tauri/src/lib.rs `parse_brave_results`. */
export function parseBraveResults(html: string, maxResults: number): SearchResult[] {
  const results: SearchResult[] = [];
  const marker = 'class="snippet ';
  let rest = html;
  while (results.length < maxResults) {
    const idx = rest.indexOf(marker);
    if (idx === -1) break;
    const tail = rest.slice(idx);
    const next = tail.indexOf(marker, marker.length);
    const end = next === -1 ? tail.length : next;
    const block = tail.slice(0, end);
    const parsed = parseBraveBlock(block);
    if (parsed) results.push(parsed);
    rest = tail.slice(end);
  }
  return results;
}

function parseBraveBlock(block: string): SearchResult | undefined {
  const aIdx = block.indexOf('<a');
  if (aIdx === -1) return undefined;
  const url = extractHref(block, aIdx);
  if (url === undefined) return undefined;

  let title = '';
  const ti = block.indexOf('search-snippet-title');
  if (ti !== -1) {
    const rest = block.slice(ti);
    const gt = rest.indexOf('>');
    if (gt !== -1) {
      const content = rest.slice(gt + 1);
      const end = content.indexOf('<');
      if (end !== -1) title = decodeHtmlEntities(stripHtml(content.slice(0, end))).trim();
    }
  }
  if (!title) return undefined;

  let snippet = '';
  const si = block.indexOf('generic-snippet');
  if (si !== -1) {
    const rest = block.slice(si);
    const gt = rest.indexOf('>');
    if (gt !== -1) {
      const content = rest.slice(gt + 1);
      const end = content.indexOf('</p>');
      if (end !== -1) snippet = decodeHtmlEntities(stripHtml(content.slice(0, end))).trim();
    }
  }

  return { title, snippet, url };
}

/** Parse Jina Reader (r.jina.ai) markdown output — the last-resort backend
 * renders `https://www.bing.com/search?q=…` from Jina's infrastructure and
 * returns clean markdown, so it works even when every local engine is
 * blocked (China / restrictive networks) as long as r.jina.ai is reachable.
 * Results are `## [Title](url)` headings (optionally numbered) followed by a
 * snippet paragraph. Mirrors src-tauri/src/lib.rs `parse_jina_markdown_results`. */
export function parseJinaMarkdownResults(text: string, maxResults: number): SearchResult[] {
  const lines = text.split('\n');
  const out: SearchResult[] = [];
  const heading = /^\s*(?:\d+\.\s+)?#{1,4}\s*\[([^\]]+)\]\(([^)]+)\)\s*$/;
  for (let i = 0; i < lines.length && out.length < maxResults; i++) {
    const m = lines[i].match(heading);
    if (!m) continue;
    const title = m[1].replace(/\*\*/g, '').trim();
    const url = resolveBingCkUrl(m[2]);
    // Snippet: the next non-empty, non-heading line.
    let snippet = '';
    let j = i + 1;
    while (j < lines.length) {
      const t = lines[j].trim();
      if (!t) {
        j += 1;
        continue;
      }
      if (t.startsWith('#')) break;
      snippet = t;
      break;
    }
    if (title && url) out.push({ title, snippet, url });
  }
  return out;
}

/** Bing wraps result URLs in `/ck/a` redirects: `…&u=a1aHR0cHM6Ly9ydXN0LWxhbmcub3JnLw&ntb=1`.
 * The `u=` param holds the base64 (URL-safe, sometimes prefixed `a1`) real
 * URL. Decode it when present so the model gets the actual destination
 * (fetchable via web_fetch) instead of a bing.com redirect. Mirrors the Rust
 * resolve_bing_ck_url. */
export function resolveBingCkUrl(url: string): string {
  const idx = url.indexOf('u=');
  if (idx === -1) return url;
  const after = url.slice(idx + 2);
  const end = Math.min(...['&', '#'].map(c => after.indexOf(c)).filter(i => i !== -1), after.length);
  const b64raw = after.slice(0, end).trim();
  if (!b64raw) return url;
  const decoded = percentDecode(b64raw);
  const candidates = [decoded, decoded.startsWith('a1') ? decoded.slice(2) : ''];
  for (const cand of candidates) {
    if (!cand) continue;
    const normalized = cand.replace(/-/g, '+').replace(/_/g, '/');
    const padded = normalized + '='.repeat((4 - (normalized.length % 4)) % 4);
    try {
      const s = new TextDecoder().decode(Uint8Array.from(atob(padded), c => c.charCodeAt(0)));
      if (s.startsWith('http')) return s;
    } catch { /* not valid base64 → try next */ }
  }
  return url;
}

function percentDecode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

/** Strip search operators / quotes / punctuation for a lighter retry query.
 * When every backend fails on a syntactically heavy query (quotes, colons,
 * parens, site: filters), one normalized retry often succeeds — engines are
 * picky about operators and punctuation, and the model shouldn't have to
 * rephrase by hand. Returns null when nothing would change. Mirrors the Rust
 * normalize_query_for_retry. */
export function normalizeQueryForRetry(query: string): string | null {
  const operators = /^(site|filetype|inurl|intitle|intext|lang|before|after|define):/i;
  const filtered = query.split(/\s+/).filter(w => !operators.test(w));
  const cleaned = filtered.join(' ')
    .replace(/["'()（）\[\]{}:|~!?，。？！、；：]/g, ' ');
  const joined = cleaned.split(/\s+/).filter(Boolean).join(' ').trim();
  if (!joined || joined === query) return null;
  return joined;
}

/** Parse DuckDuckGo HTML results (`<div class="result">` blocks containing
 * `<a class="result__a" href="…">TITLE</a>` plus a
 * `<div class="result__snippet">…</div>`). Exported for the mirror tests in
 * searchParser.test.ts, which lock behavior against the Rust parser
 * (src-tauri/src/lib.rs parse_duckduckgo_results). */
export function parseDuckDuckGoResults(html: string, maxResults: number): SearchResult[] {
  const results: SearchResult[] = [];

  // Parse DuckDuckGo HTML search: each result is in a div with class "result"
  const resultBlockRegex = /<div[^>]*class="[^"]*result[^"]*"[^>]*>([\s\S]*?)<\/div>\s*(?=<div[^>]*class="[^"]*result|$)/gi;
  const blocks = html.match(resultBlockRegex);
  if (!blocks) return results;

  for (const block of blocks) {
    if (results.length >= maxResults) break;

    // Extract title + URL from <a class="result__a" href="...">Title</a>
    const linkMatch = block.match(/<a[^>]*class="[^"]*result__a[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i);
    if (!linkMatch) continue;

    const url = decodeHtmlEntities(linkMatch[1].trim());
    const title = decodeHtmlEntities(stripHtml(linkMatch[2])).trim();

    if (!title || !url) continue;

    // Extract snippet from <a class="result__snippet">
    const snippetMatch = block.match(/<[^>]*class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/[^>]+>/i);
    const snippet = snippetMatch ? decodeHtmlEntities(stripHtml(snippetMatch[1])).trim() : '';

    results.push({ title, snippet, url });
  }

  return results;
}

/** Parse Mojeek results (`<li class="result">` blocks with an `<a class="title">`
 * or `<a class="ob">` anchor and a `<p class="s">` snippet). Mojeek is an
 * independent, bot-friendly index serving clean HTML — a useful extra non-CJK
 * backend. Mirrors the Rust parse_mojeek_results. */
export function parseMojeekResults(html: string, maxResults: number): SearchResult[] {
  const results: SearchResult[] = [];
  const marker = '<li class="result';
  let rest = html;
  while (results.length < maxResults) {
    const idx = rest.indexOf(marker);
    if (idx === -1) break;
    const tail = rest.slice(idx);
    const next = tail.indexOf(marker, marker.length);
    const end = next === -1 ? tail.length : next;
    const block = tail.slice(0, end);
    const parsed = parseMojeekBlock(block);
    if (parsed) results.push(parsed);
    rest = tail.slice(end);
  }
  return results;
}

function parseMojeekBlock(block: string): SearchResult | undefined {
  const aMatch = block.match(/<a[^>]*class="[^"]*(?:title|ob)[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i);
  if (!aMatch) return undefined;
  const url = decodeHtmlEntities(aMatch[1].trim());
  const title = decodeHtmlEntities(stripHtml(aMatch[2])).trim();
  if (!title || !url) return undefined;
  let snippet = '';
  const sMatch = block.match(/<p[^>]*class="[^"]*s[^"]*"[^>]*>([\s\S]*?)<\/p>/i);
  if (sMatch) snippet = decodeHtmlEntities(stripHtml(sMatch[1])).trim();
  return { title, snippet, url };
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

/** Parse Bing results (`<li class="b_algo">` blocks): `<h2><a href="…">TITLE</a></h2>`
 * plus a `<p>…</p>` snippet. Mirrors the Rust parser in src-tauri/src/lib.rs — the
 * two MUST stay behaviorally identical (entity decoding, quote handling, block
 * skipping, max cap); tests on both sides lock the shared fixtures. INTENTIONAL
 * divergences: whitespace handling (TS stripHtml collapses block tags to
 * newlines — shared with the DDG/web_fetch paths — while Rust keeps raw
 * whitespace) and unquoted hrefs (TS skips, Rust would parse). Both favor TS
 * in practice and must not be "unified" blindly. */
export function parseBingResults(html: string, maxResults: number): SearchResult[] {
  const results: SearchResult[] = [];
  let rest = html;
  while (results.length < maxResults) {
    const idx = rest.indexOf('<li class="b_algo');
    if (idx === -1) break;
    const tail = rest.slice(idx);
    const liEnd = tail.indexOf('</li>');
    if (liEnd === -1) break;
    const block = tail.slice(0, liEnd + '</li>'.length);
    const parsed = parseBingBlock(block);
    if (parsed) results.push(parsed);
    rest = tail.slice(liEnd + '</li>'.length);
  }
  return results;
}

function parseBingBlock(block: string): SearchResult | undefined {
  // Result link lives inside <h2>: find <h2>, then the first <a after it.
  const h2 = block.indexOf('<h2');
  if (h2 === -1) return undefined;
  const afterH2 = block.slice(h2);
  const aIdx = afterH2.indexOf('<a');
  if (aIdx === -1) return undefined;
  const url = extractHref(afterH2, aIdx);
  if (url === undefined) return undefined;

  // Title: text between the anchor's '>' and the next '<'. A block whose
  // anchor never closes is skipped entirely (mirrors the Rust `?` on find).
  const afterA = afterH2.slice(aIdx);
  const gt = afterA.indexOf('>');
  if (gt === -1) return undefined;
  const afterGt = afterA.slice(gt + 1);
  const titleEnd = afterGt.indexOf('<');
  if (titleEnd === -1) return undefined;
  const title = decodeHtmlEntities(stripHtml(afterGt.slice(0, titleEnd))).trim();
  if (!title || !url) return undefined;

  // Snippet: first <p ...>…</p> in the block. Decoded like the title so
  // numeric/named entities in Bing snippets (&#0183; middle dots, &ensp;)
  // render as characters, matching the Rust parser.
  let snippet = '';
  const pIdx = block.indexOf('<p');
  if (pIdx !== -1) {
    const afterP = block.slice(pIdx);
    const pGt = afterP.indexOf('>');
    if (pGt !== -1) {
      const content = afterP.slice(pGt + 1);
      const pEnd = content.indexOf('</p>');
      if (pEnd !== -1) snippet = decodeHtmlEntities(stripHtml(content.slice(0, pEnd))).trim();
    }
  }

  return { title, snippet, url };
}

/** Extract an href attribute value after a `<a` marker, mirroring the Rust
 * parser's extract_href: read the quote char (single OR double) that follows
 * `href=`, then the text up to the matching quote. Returns undefined when the
 * attribute is missing or unquoted so the block is skipped. */
function extractHref(s: string, from: number): string | undefined {
  const rest = s.slice(from);
  const hrefIdx = rest.indexOf('href=');
  if (hrefIdx === -1) return undefined;
  const afterHref = rest.slice(hrefIdx + 'href='.length);
  const quote = afterHref[0];
  if (quote !== '"' && quote !== "'") return undefined;
  const end = afterHref.indexOf(quote, 1);
  if (end === -1) return undefined;
  return decodeHtmlEntities(afterHref.slice(1, end));
}

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
