// src/shared/repoMap.ts
// 仓库符号地图的纯函数面（2026-11-21）。中大型仓库里「先看结构再动手」目前的
// 唯一办法是模型自己 list/glob/grep 摸一遍：每次开工都要重新摸，摸偏了就绕远。
// 这里做其中的机械部分——从一次递归清单里挑源码、把每个文件的声明压成名字、
// 按字符预算排成一张紧凑地图，随动手类回合注入 envFacts（用户回合动态层，
// 不碰 system 缓存前缀）。
//
// 判据与 symbolOutline 同源：地图里出现的符号必须能在大纲里找到，否则模型会
// 看到两套事实。不解析 AST、不做语义判断——漏一个局部函数只是地图不完整，
// 把正文行当符号塞进去才是污染。
//
// 地图只陈述「扫描时有什么」：新建的文件可能不在图上。措辞里写明这一点，
// 免得模型拿地图当存在性核对而否认刚写的文件。

import { extractSymbolOutline, outlineFamilyFor } from './symbolOutline';

/** 触发地图的最小仓库规模：小仓库一次 list_files 就看完，地图是纯开销。 */
export const REPO_MAP_MIN_SOURCE_FILES = 60;
/** 单个文件展示的声明名上限：再多就不是结构而是第二份大纲。 */
export const REPO_MAP_SYMBOLS_PER_FILE = 6;
/** 逐个读大纲的文件上限：每次一读都是真实 IO，宁可少读也不拖慢首字。 */
export const REPO_MAP_SYMBOL_FILES = 16;
/** 地图总字符预算（≈900 tokens）。超了就从尾部截断并如实说明省略了多少。 */
export const REPO_MAP_MAX_CHARS = 3200;
/** 树区每个目录展示的文件名条数。 */
export const REPO_MAP_NAMES_PER_DIR = 6;
/** Key files 区的条数上限：采集只读这么多个大纲，地图不能比采集更贪。 */
export const REPO_MAP_KEY_FILES = 16;
/** 单条 Key file 行的字符上限：超长声明名列表压成一行反而更难扫。 */
const KEY_LINE_MAX_CHARS = 140;
/** 树区单行字符上限：目录行铺太开会挤掉后面的目录。 */
const TREE_LINE_MAX_CHARS = 120;

/** 与 delivery.isIgnoredWorkspacePath 同一批目录：地图里出现依赖目录等于
 *  让模型把 node_modules 当源码读。生成物目录同理（改了也会被覆盖）。 */
const IGNORED_SEGMENTS = new Set([
  'node_modules', 'dist', 'build', 'target', 'coverage', 'vendor',
  '.next', '.nuxt', '.git', '.venv', 'venv', '__pycache__', '.turbo', '.cache',
  'out', '.idea', '.vscode', 'Pods', 'DerivedData',
]);

/** 清单里出现即丢弃的生成物后缀（锁文件、压缩产物、sourcemap）。 */
const IGNORED_SUFFIXES = [
  '.min.js', '.min.css', '.map', '.lock', '.lockb', '.log', '.svg', '.png',
  '.jpg', '.jpeg', '.gif', '.webp', '.ico', '.woff', '.woff2', '.ttf', '.pdf',
];

/** 根目录下值得单独列出的清单文件（不属于任何语言族，但是仓库骨架）。 */
const ROOT_DOC_FILES = new Set([
  'package.json', 'tsconfig.json', 'Cargo.toml', 'pyproject.toml', 'go.mod',
  'requirements.txt', 'Makefile', 'Dockerfile', 'README.md', 'AGENTS.md', 'CLAUDE.md',
]);

/** 入口/骨架文件的命名偏好：同等深度下先展示它们，地图的第一眼就落在这上面。 */
const ENTRY_NAME_PATTERN = /^(?:index|main|app|cli|server|route|routes|api|handler|handlers|store|types|core|config)\.[a-z]+$/i;
/** 这些目录里的文件留在树上，但不占 Key files 名额：脚本/示例/迁移很少是
 *  「要改的那块」，读它们的大纲是白花一次 IO。 */
const AUXILIARY_DIRS = new Set(['scripts', 'examples', 'example', 'docs', 'doc', 'fixtures', 'migrations', 'tools', 'benchmarks', 'demo', 'tmp', 'temp', 'assets', 'public', 'static']);

export function normalizeRepoMapPath(raw: string): string {
  return raw
    .trim()
    .replaceAll('\\', '/')
    .replace(/^\.\//, '')
    .replace(/\/{2,}/g, '/')
    .replace(/^\/+|\/+$/g, '');
}

export function isRepoMapIgnoredPath(path: string): boolean {
  const normalized = normalizeRepoMapPath(path);
  if (!normalized) return true;
  if (normalized.split('/').some((segment) => IGNORED_SEGMENTS.has(segment))) return true;
  const base = normalized.split('/').pop() ?? normalized;
  const lower = base.toLowerCase();
  return IGNORED_SUFFIXES.some((suffix) => lower.endsWith(suffix));
}

function isSourceFile(path: string): boolean {
  return outlineFamilyFor(path) !== 'none';
}

function isRootDoc(path: string): boolean {
  return !path.includes('/') && ROOT_DOC_FILES.has(path);
}

/** 清单行 → 干净路径（去截断提示、去空行、去依赖目录）。 */
export function parseRepoMapListing(listing: string): string[] {
  const seen = new Set<string>();
  const paths: string[] = [];
  for (const line of listing.split(/\r?\n/)) {
    const trimmed = line.trim();
    // 截断提示与「空目录」句子不是路径；留着会把假文件写进地图。
    if (!trimmed || trimmed.startsWith('[') || trimmed === '(empty directory)') continue;
    if (/^no files? matching/i.test(trimmed)) continue;
    const path = normalizeRepoMapPath(trimmed.replace(/^[-*]\s+/, ''));
    // 目录行（末尾带 /）不进文件表，目录由路径推导。
    if (!path || path.endsWith('/')) continue;
    if (isRepoMapIgnoredPath(path)) continue;
    if (!isSourceFile(path) && !isRootDoc(path)) continue;
    if (seen.has(path)) continue;
    seen.add(path);
    paths.push(path);
  }
  return paths.sort();
}

function depthOf(path: string): number {
  return path.split('/').length - 1;
}

/** 读大纲的文件挑选：浅的、入口名的优先。地图的价值在于「第一眼看到骨架」，
 *  所以先给仓库顶部与入口文件，深层的靠 code_searcher 按需查。 */
export function pickRepoMapSymbolFiles(paths: string[], limit = REPO_MAP_SYMBOL_FILES): string[] {
  const scored = paths
    .filter(isSourceFile)
    .map((path) => {
      const base = path.split('/').pop() ?? path;
      const entryBoost = ENTRY_NAME_PATTERN.test(base) ? -2 : 0;
      const testBoost = /(?:^|\/)(?:__tests__|tests?)(?:\/|$)|\.(?:test|spec)\.[a-z]+$/i.test(path) ? 3 : 0;
      const auxiliaryBoost = path.split('/').slice(0, -1).some((segment) => AUXILIARY_DIRS.has(segment)) ? 2 : 0;
      return { path, score: depthOf(path) + entryBoost + testBoost + auxiliaryBoost };
    })
    .sort((left, right) => left.score - right.score || left.path.localeCompare(right.path));
  return scored.slice(0, Math.max(0, limit)).map((item) => item.path);
}

/** 大纲成稿 → 声明名列表。`formatSymbolOutline` 的每条是 `行号: 原文`，这里只
 *  取名字：地图要的是「有什么」，行号与签名留给 read_file(outline:true)。 */
export function repoMapSymbolNamesFromOutline(outline: string): string[] {
  const names: string[] = [];
  const seen = new Set<string>();
  for (const line of outline.split(/\r?\n/)) {
    const match = line.match(/^\s*\d+:\s*(.+)$/);
    if (!match) continue;
    const name = declarationName(match[1]);
    if (!name || seen.has(name)) continue;
    seen.add(name);
    names.push(name);
    if (names.length >= REPO_MAP_SYMBOLS_PER_FILE) break;
  }
  return names;
}

/** 从一个声明行里取标识符。先认「关键字 + 名字」，再退到「名字 + 圆括号」
 *  （方法行）——与 symbolOutline 的抽取规则同口径，不引入第二套判据。 */
function declarationName(text: string): string {
  const trimmed = text.trim().replace(/^(?:export|default|declare|public|private|protected|internal|static|async|abstract|readonly|final|open|override|unsafe|pub)\s+/g, '');
  const keyword = trimmed.match(/^(?:function\s*\*?|class|interface|type|enum|namespace|struct|trait|impl|mod|fn|def|func|const|let|var|static|module|object)\s+([A-Za-z_$][\w$]*)/);
  if (keyword) return keyword[1];
  const method = trimmed.match(/^([A-Za-z_$][\w$]*)\s*(?:<[^>]*>)?\s*\(/);
  if (method) return method[1];
  const macro = trimmed.match(/^macro_rules!\s*([A-Za-z_]\w*)/);
  return macro ? macro[1] : '';
}

function isTestDir(dir: string): boolean {
  const segments = dir.split('/');
  return segments.some((segment) => segment === '__tests__' || segment === 'tests' || segment === 'test' || segment === 'e2e');
}

/** 目录展示优先级：普通源码 → 辅助目录（脚本/示例/临时）→ 测试。 бюджет 不够时
 *  先丢的是测试目录——模型改代码时最不需要先看全仓测试清单。 */
function dirTier(dir: string): number {
  if (isTestDir(dir)) return 2;
  if (dir.split('/').some((segment) => AUXILIARY_DIRS.has(segment))) return 1;
  return 0;
}

export interface RepoMapEntry {
  path: string;
  symbols: string[];
}

export interface FormatRepoMapInput {
  entries: RepoMapEntry[];
  /** 清单里保留下来的源码/骨架文件总数（不只是带符号的那些）。 */
  totalFiles: number;
  /** 清单是否被工具截断（true 时地图不能当完整事实）。 */
  truncated?: boolean;
  maxChars?: number;
}

/** 排版：先是带符号的关键文件，再是目录树骨架，最后如实说明省略量。 */
export function formatRepoMap(input: FormatRepoMapInput): string {
  const maxChars = input.maxChars ?? REPO_MAP_MAX_CHARS;
  const entries = input.entries.filter((entry) => entry.path).slice().sort((left, right) => left.path.localeCompare(right.path));
  if (entries.length === 0) return '';
  const dirs = new Map<string, string[]>();
  for (const entry of entries) {
    const dir = entry.path.includes('/') ? entry.path.slice(0, entry.path.lastIndexOf('/')) : '.';
    const list = dirs.get(dir) ?? [];
    list.push(entry.path.split('/').pop() ?? entry.path);
    dirs.set(dir, list);
  }

  const header = [
    '<repo_map>',
    `Workspace snapshot: ${input.totalFiles} source/entry files${input.truncated ? ' (listing truncated — not the whole tree)' : ''}. Format: path — top-level declarations.`,
    'This is a scan taken when the turn started, not ground truth: files created since then may be missing. Confirm a path with find_files or code_searcher before concluding it does not exist, and use read_file(outline:true) for line numbers or signatures.',
  ];

  const keyLines: string[] = [];
  const symbolized = entries.filter((entry) => entry.symbols.length > 0).slice(0, REPO_MAP_KEY_FILES);
  if (symbolized.length > 0) {
    keyLines.push('Key files:');
    for (const entry of symbolized) {
      const line = `  ${entry.path} — ${entry.symbols.join(', ')}`;
      keyLines.push(line.length > KEY_LINE_MAX_CHARS ? `${line.slice(0, KEY_LINE_MAX_CHARS - 1)}…` : line);
    }
  }

  const treeLines: string[] = ['Tree:'];
  // 目录按「非测试 → 浅 → 大」排序，而不是字母序：字母序在预算不够时只留下
  // 前半截名字的目录（src/adapter 之后全没了），骨架反而看不到。
  const dirNames = [...dirs.keys()].sort((left, right) => {
    const leftTier = dirTier(left);
    const rightTier = dirTier(right);
    if (leftTier !== rightTier) return leftTier - rightTier;
    const leftDepth = left === '.' ? 0 : left.split('/').length;
    const rightDepth = right === '.' ? 0 : right.split('/').length;
    if (leftDepth !== rightDepth) return leftDepth - rightDepth;
    const leftCount = dirs.get(left)?.length ?? 0;
    const rightCount = dirs.get(right)?.length ?? 0;
    if (leftCount !== rightCount) return rightCount - leftCount;
    return left.localeCompare(right);
  });
  // 目录预算随地图规模浮动：大仓库每目录只给一行摘要，小仓库可以铺开。
  const dirBudget = Math.max(12, Math.floor((maxChars * 0.55) / 40));
  const shownDirs = dirNames.slice(0, dirBudget);
  for (const dir of shownDirs) {
    const names = dirs.get(dir) ?? [];
    const shown: string[] = [];
    // 每行限长：长文件名会吃光目录预算，宁少列几个也要让更多目录看得见。
    let used = dir.length + String(names.length).length + 8;
    for (const name of names) {
      if (shown.length >= REPO_MAP_NAMES_PER_DIR || used + name.length + 2 > TREE_LINE_MAX_CHARS) break;
      shown.push(name);
      used += name.length + 2;
    }
    const rest = names.length - shown.length;
    treeLines.push(`  ${dir}/ (${names.length}) ${shown.join(', ')}${rest > 0 ? ` …(+${rest})` : ''}`);
  }
  const footer = (omittedDirs: number): string[] => {
    const lines: string[] = [];
    if (omittedDirs > 0) lines.push(`…(+${omittedDirs} more directories; use list_files or glob_files on a subtree)`);
    lines.push('</repo_map>');
    return lines;
  };

  // 预算从尾部收：先砍树，再砍 Key files，头尾说明必须留下——一条被截断的
  // 地图比没有地图更误导。
  // 按「最长尾注」计预算：省略量未知时先当它要占一行，否则末尾那句会把地图
  // 顶出预算（测试抓到过 63 字符的溢出）。
  const reservedFooter = footer(dirNames.length);
  while (keyLines.length > 1 && [...header, ...keyLines, ...reservedFooter].join('\n').length > maxChars) keyLines.pop();
  const fixed = [...header, ...keyLines, ...reservedFooter].join('\n');
  // 预算小到装不下头部时，宁可只剩指针也不给出半截地图（缺 </repo_map> 的
  // 围栏会被渲染层当成正文吞掉）。
  if (fixed.length >= maxChars) return [...header, ...footer(dirNames.length)].join('\n');
  const budget = Math.max(maxChars - fixed.length, 0);
  const kept: string[] = [];
  // 给末尾的紧凑目录清单留 20%：目录名比文件名更值得占位，剩下没铺开的
  // 目录用一行 `More: dir/ (n), …` 兜底，模型至少知道仓库有哪几层。
  const nameBudget = budget * 0.8;
  let used = 0;
  for (const line of treeLines) {
    if (used + line.length + 1 > nameBudget) break;
    kept.push(line);
    used += line.length + 1;
  }
  if (kept.length <= 1) return [...header, ...keyLines, ...footer(dirNames.length)].join('\n');
  // kept 里除 'Tree:' 外就是 dirNames 的前缀，剩下的目录从那里接着数。
  const rest = dirNames.slice(Math.max(kept.length - 1, 0));
  let added = 0;
  if (rest.length > 0) {
    let more = 'More: ';
    for (const dir of rest) {
      const label = dir === '.' ? '.' : dir;
      const piece = `${label}/ (${dirs.get(dir)?.length ?? 0})`;
      const candidate = added === 0 ? `${more}${piece}` : `${more}, ${piece}`;
      if (used + candidate.length + 1 > budget) break;
      more = candidate;
      added += 1;
    }
    if (added > 0) {
      kept.push(more);
      used += more.length + 1;
    }
  }
  const omitted = Math.max(dirNames.length - (kept.length - 1 - (added > 0 ? 1 : 0)) - added, 0);
  return [...header, ...keyLines, ...kept, ...footer(omitted)].join('\n');
}

/** 给用户看的一行摘要（GUI 探索气泡）：说清这张图扫了多少文件、挑了哪些
 *  文件做符号、占多少字符。解析失败时退回一个不含数字的说法——宁可少给
 *  一个计数，也不编一个。 */
export function repoMapBubbleText(map: string): string {
  const files = /Workspace snapshot: (\d+) source\/entry files/.exec(map)?.[1];
  const keySection = /Key files:\n([\s\S]*?)(?:\nTree:|\n\u2026\(|\nMore:|\n<\/repo_map>)/.exec(map)?.[1] ?? '';
  const keyFiles = keySection.split('\n').filter((line) => line.startsWith('  ')).length;
  const parts: string[] = [];
  if (files) parts.push(`${files} 个源文件`);
  if (keyFiles > 0) parts.push(`${keyFiles} 个文件带符号`);
  parts.push(`${map.length} 字符`);
  return `已附仓库骨架图：${parts.join(' · ')}`;
}

/** 清单指纹：一次递归清单就是一次全量枚举，指纹相同说明这期间没增删文件，
 *  可以直接复用上一份地图（含已读的大纲）。FNV-1a 足够——这里只防「变了还
 *  用旧图」，不是安全哈希。 */
export function repoMapFingerprint(paths: string[]): string {
  let hash = 0x811c9dc5;
  for (const path of paths) {
    for (let index = 0; index < path.length; index += 1) {
      hash ^= path.charCodeAt(index);
      hash = Math.imul(hash, 0x01000193) >>> 0;
    }
    hash ^= 0x0a;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `${paths.length}:${hash.toString(36)}`;
}
