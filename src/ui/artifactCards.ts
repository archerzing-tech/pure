// src/ui/artifactCards.ts
// Smart result display for generated files. After a turn completes, the files
// the agent actually wrote are surfaced at the END of the final assistant
// bubble as clickable cards:
//
//   * A single final deliverable is shown as a clickable card.
//   * Multiple office/text files are shown as cards only when there are at most
//     MAX_FILE_CARDS of them; helper scripts are omitted unless explicitly
//     requested as the deliverable.
//   * A multi-file project is represented by one clickable workspace-directory
//     link, so a generated project never floods the transcript with cards.
//   * Folders are workspace scaffolding and are deliberately omitted from the
//     result area; the project workspace remains available through the context
//     panel and path links in the assistant reply.
//
// Artifacts are collected from successful write_file / edit_file /
// replace_files tool results during one send() turn — see chat.ts's ToolResult
// handler. Rendering is deliberately declarative (the
// planArtifactDisplay decision is a pure function) so the threshold logic is
// unit-testable without a DOM.

import { resolvePathForOpen, openPathLink } from './pathLink';
import { isTauriRuntime, tauriInvoke } from '../shared/tauri';
import { t } from '../shared/i18n';

export interface ArtifactItem {
  /** Generated file path as the tool received it. */
  path: string;
}

export const MAX_FILE_CARDS = 10;

export interface ArtifactDisplayOptions {
  /** The user's request for this turn, used to hide implementation byproducts. */
  userRequest?: string;
}

export type ArtifactDisplay =
  | { mode: 'none' }
  | { mode: 'files'; items: ArtifactItem[] }
  | { mode: 'project'; items: ArtifactItem[] };

/**
 * True when a written file is an INTERMEDIATE byproduct of an information
 * query rather than a user-facing deliverable — e.g. data the model fetched
 * and stashed to disk mid-task (weather_raw.js, raw_*.json, *.raw), or
 * editor/tool scratch files (*.tmp, *.bak, ~). Such files are stripped from
 * the end-of-turn result cards so the transcript only surfaces artifacts the
 * user actually asked for.
 */
export function isIntermediateArtifact(path: string): boolean {
  const leaf = path.split(/[\\/]+/).pop() ?? path;
  const lower = leaf.toLowerCase();
  // Raw-data dump naming the model invents while answering lookups
  // (weather_raw.js, raw_data.json, result.raw, *_raw.sql …).
  if (lower.includes('_raw') || lower.includes('.raw') || lower.startsWith('raw_')) return true;
  // Common scratch / temp-file suffixes.
  if (/(?:^|\.)(tmp|temp|bak|swp|part|crdownload|orig)$/.test(lower)) return true;
  if (lower.endsWith('~')) return true;
  return false;
}

// Data-like extensions that pair with a `*_raw.*` sibling.
const DATA_EXTENSIONS = new Set(['js', 'mjs', 'cjs', 'json', 'txt', 'csv', 'tsv', 'yaml', 'yml', 'xml', 'sql', 'md', 'markdown']);

/**
 * True when `path` is the "tidy" sibling of a raw-data dump written in the
 * same turn: models commonly stash BOTH `{topic}_raw.<ext>` (raw fetch) and
 * `{topic}.js` / `{topic}.json` (processed copy) while answering a lookup.
 * When the pair appears together, neither is a user-facing deliverable.
 * Real artifacts (game.html, index.html, …) are never matched — the sibling
 * must be a data-like extension and the raw twin must share the exact stem.
 */
export function isDataDumpPair(path: string, allPaths: string[]): boolean {
  const leaf = path.split(/[\\/]+/).pop() ?? path;
  const dot = leaf.lastIndexOf('.');
  if (dot <= 0) return false;
  const ext = leaf.slice(dot + 1).toLowerCase();
  if (!DATA_EXTENSIONS.has(ext)) return false;
  const stem = leaf.slice(0, dot).toLowerCase();
  return allPaths.some((other) => {
    if (other === path) return false;
    const otherLeaf = (other.split(/[\\/]+/).pop() ?? other).toLowerCase();
    const otherDot = otherLeaf.lastIndexOf('.');
    if (otherDot <= 0) return false;
    return otherLeaf.slice(0, otherDot) === `${stem}_raw`;
  });
}

const CARD_FRIENDLY_EXTENSIONS = new Set([
  // Office and plain-text documents.
  'md', 'markdown', 'txt', 'pdf', 'doc', 'docx', 'rtf', 'odt', 'tex', 'org',
  'ppt', 'pptx', 'odp', 'xls', 'xlsx', 'ods', 'csv', 'tsv',
  // Standalone HTML and shell/script documents explicitly intended for direct
  // opening. General source files stay project-level when there is more than
  // one artifact, avoiding a card wall for coding projects.
  'html', 'htm', 'sh', 'bash', 'zsh', 'bat', 'cmd', 'ps1',
]);

const FINAL_DELIVERABLE_EXTENSIONS = new Set([
  'png', 'jpg', 'jpeg', 'gif', 'svg', 'webp', 'avif', 'heic',
  'md', 'markdown', 'txt', 'pdf', 'doc', 'docx', 'rtf', 'odt', 'tex', 'org',
  'ppt', 'pptx', 'odp', 'xls', 'xlsx', 'ods', 'csv', 'tsv', 'html', 'htm',
]);

const SCRIPT_OR_SOURCE_EXTENSIONS = new Set([
  'js', 'jsx', 'mjs', 'cjs', 'ts', 'tsx', 'py', 'rb', 'php', 'rs', 'go', 'java',
  'kt', 'c', 'h', 'cpp', 'hpp', 'cs', 'css', 'scss', 'sass', 'sh', 'bash', 'zsh',
  'bat', 'cmd', 'ps1', 'json', 'yaml', 'yml', 'xml', 'sql', 'vue', 'svelte',
]);

export function isCardFriendlyArtifact(path: string): boolean {
  const leaf = path.split(/[\\/]+/).pop() ?? path;
  const dot = leaf.lastIndexOf('.');
  return dot > 0 && CARD_FRIENDLY_EXTENSIONS.has(leaf.slice(dot + 1).toLowerCase());
}

function artifactExtension(path: string): string {
  const leaf = path.split(/[\\/]+/).pop() ?? path;
  const dot = leaf.lastIndexOf('.');
  return dot > 0 ? leaf.slice(dot + 1).toLowerCase() : '';
}

export function isFinalDeliverableArtifact(path: string): boolean {
  return FINAL_DELIVERABLE_EXTENSIONS.has(artifactExtension(path));
}

function isScriptOrSourceArtifact(path: string): boolean {
  return SCRIPT_OR_SOURCE_EXTENSIONS.has(artifactExtension(path));
}

function requestLooksLikeProject(request: string): boolean {
  return /(?:项目|工程|网站|网页应用|web\s*app|website|应用|app|dashboard|系统|project|coding)/i.test(request);
}

/** True when the request IMPERATIVELY asks to build code ("开发一个爬虫",
 * "写一个脚本") even without a project noun. Distinguishes a real multi-file
 * build from a lookup/planning request that only left stashed data files. */
function requestLooksLikeBuild(request: string): boolean {
  return /(?:请|帮我|麻烦你|给我)?(?:编写|编|写|开发|制作|创建|搭建|实现|构建|做一个|做个|写一个|写个|开发一个|实现一个|写段|搭一个|重构|重写|修复|部署|迁移)/i.test(request.slice(0, 80));
}

function requestLooksLikeFinalVisualOrDocument(request: string): boolean {
  return /(?:画|绘制|图片|图像|插画|海报|封面|文档|报告|word|ppt|excel|表格|pdf|markdown|文本)/i.test(request);
}

function requestExplicitlyRequestsScript(request: string): boolean {
  if (requestLooksLikeFinalVisualOrDocument(request) && !/(?:脚本|python|javascript|typescript|shell|bash)\s*(?:文件|脚本)?\s*(?:本身|代码|程序)/i.test(request)) return false;
  return /(?:写|编写|生成|创建|实现|开发|write|create|generate|build|implement).{0,24}(?:python|javascript|typescript|js|jsx|ts|tsx|脚本|shell|bash|powershell|script)/i.test(request);
}

function compactArtifactFiles(items: ArtifactItem[]): ArtifactDisplay {
  if (items.length === 0) return { mode: 'none' };
  if (items.length === 1 || (items.length <= MAX_FILE_CARDS && items.every(item => isCardFriendlyArtifact(item.path)))) {
    return { mode: 'files', items };
  }
  return { mode: 'project', items };
}

/** Choose a compact end-of-turn presentation without exposing implementation files. */
export function planArtifactDisplay(items: ArtifactItem[], options: ArtifactDisplayOptions = {}): ArtifactDisplay {
  const all = items.map((item) => item.path);
  const seen = new Set<string>();
  const kept = items.filter((item) => {
    const path = item.path.trim();
    if (!path) return false;
    const key = path.trim().toLowerCase().replaceAll('\\', '/').replace(/^\.\//, '');
    if (seen.has(key)) return false;
    seen.add(key);
    if (isIntermediateArtifact(path)) return false;
    if (isDataDumpPair(path, all)) return false;
    return true;
  });
  if (kept.length === 0) return { mode: 'none' };

  const request = options.userRequest?.trim() ?? '';
  const explicitScript = request.length > 0 && requestExplicitlyRequestsScript(request);
  const projectRequest = request.length > 0 && requestLooksLikeProject(request);
  const finalDeliverables = kept.filter(item => isFinalDeliverableArtifact(item.path));
  const hasImplementationFiles = kept.some(item => isScriptOrSourceArtifact(item.path));

  // For visual/document tasks, implementation files are working material. Only
  // the requested final files remain visible; if none survived, show nothing.
  if (!explicitScript && requestLooksLikeFinalVisualOrDocument(request) && finalDeliverables.length > 0) {
    return compactArtifactFiles(finalDeliverables);
  }
  if (!explicitScript && requestLooksLikeFinalVisualOrDocument(request) && hasImplementationFiles) {
    return { mode: 'none' };
  }

  // A coding/project request is represented by its directory, never by a wall
  // of source/config cards. This takes precedence even when README/index.html
  // is also present in the generated project.
  if (!explicitScript && projectRequest && hasImplementationFiles) {
    return { mode: 'project', items: kept };
  }

  // Without request context (legacy snapshots), a final document/image next to
  // source files is still safely reduced to the user-facing deliverables.
  if (!explicitScript && finalDeliverables.length > 0 && finalDeliverables.length < kept.length) {
    return compactArtifactFiles(finalDeliverables);
  }

  if (!explicitScript && hasImplementationFiles && kept.every(item => isScriptOrSourceArtifact(item.path))) {
    // Only source/data files remain. A real multi-file build → directory link;
    // a non-build request that only left stashed data behind → nothing.
    if (request.length === 0 || requestLooksLikeBuild(request)) {
      return kept.length === 1 ? { mode: 'none' } : { mode: 'project', items: kept };
    }
    return { mode: 'none' };
  }

  return compactArtifactFiles(kept);
}

// ── DOM rendering ──

// Icons mirror the composer's paste chips: a tinted icon cell whose glyph AND
// color follow the FILE FORMAT (code / image / doc / data / archive), so a
// saved-file card reads like its upload counterpart.
const FILE_ICON =
  '<svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true"><path d="M3 1.5h6l3.5 3.5v9a.5.5 0 0 1-.5.5h-9a.5.5 0 0 1-.5-.5v-12a.5.5 0 0 1 .5-.5z" fill="none" stroke="currentColor" stroke-linejoin="round"/><path d="M9 1.5V5h3.5" fill="none" stroke="currentColor" stroke-linejoin="round"/></svg>';
const CODE_ICON =
  '<svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><path d="M6 3.5 2.5 8 6 12.5"/><path d="M10 3.5 13.5 8 10 12.5"/></svg>';
const IMAGE_ICON =
  '<svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="3" width="12" height="10" rx="1.5"/><circle cx="5.5" cy="6.5" r="1.2"/><path d="M2.5 11.5 6 8l2.5 2.5 2-2 3 3"/></svg>';
const DOC_ICON =
  '<svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><path d="M3.5 2h6L13 5.5V13a1 1 0 0 1-1 1H3.5a1 1 0 0 1-1-1V3a1 1 0 0 1 1-1z"/><path d="M9.5 2v3.5H13"/><path d="M5.5 8.5h5M5.5 11h5"/></svg>';
const DATA_ICON =
  '<svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><rect x="2.5" y="3" width="11" height="10" rx="1.5"/><path d="M2.5 6.5h11M6 6.5V13"/></svg>';
const ARCHIVE_ICON =
  '<svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6 4 3.5h8l1 2.5v7a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V6z"/><path d="M6.5 8h3"/></svg>';
const OPEN_HINT_ICON =
  '<svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><path d="M6.5 3.5H3a.5.5 0 0 0-.5.5v9a.5.5 0 0 0 .5.5h9a.5.5 0 0 0 .5-.5v-3.5"/><path d="M9.5 2.5h4v4"/><path d="M13.5 2.5 8 8"/></svg>';
const PROJECT_ICON =
  '<svg viewBox="0 0 18 18" width="18" height="18" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><path d="M2.5 5.5h4l1.5 1.8h7.5v7.2a1 1 0 0 1-1 1h-11a1 1 0 0 1-1-1z"/><path d="M2.5 5.5v-1a1 1 0 0 1 1-1h3l1.5 1.8h5.5"/></svg>';

/**
 * Pick a format icon (glyph + tint class) for a file path so the card reads
 * like the composer's paste chips. Unknown extensions fall back to the
 * generic file glyph.
 */
const nativeIconCache = new Map<string, string | null>();
const nativeIconRequests = new Map<string, Promise<string | null>>();
const MAX_NATIVE_ICON_CACHE = 128;

function cacheNativeIcon(path: string, icon: string | null): void {
  // Keep this cache bounded: a long session can surface many generated paths,
  // and native icon data URLs are held as full strings rather than tiny handles.
  nativeIconCache.delete(path);
  nativeIconCache.set(path, icon);
  while (nativeIconCache.size > MAX_NATIVE_ICON_CACHE) {
    const oldest = nativeIconCache.keys().next().value;
    if (oldest === undefined) break;
    nativeIconCache.delete(oldest);
  }
}

async function nativeFileIcon(path: string): Promise<string | null> {
  if (!isTauriRuntime()) return null;
  const resolved = resolvePathForOpen(path);
  if (!resolved) return null;
  if (nativeIconCache.has(resolved)) {
    const value = nativeIconCache.get(resolved) ?? null;
    // LRU touch so frequently revisited artifacts remain cheap to render.
    cacheNativeIcon(resolved, value);
    return value;
  }
  const pending = nativeIconRequests.get(resolved);
  if (pending) return pending;
  const request = tauriInvoke<string>('get_file_icon', { path: resolved })
    .then((icon) => {
      const value = icon.startsWith('data:image/') ? icon : null;
      cacheNativeIcon(resolved, value);
      return value;
    })
    .catch(() => {
      cacheNativeIcon(resolved, null);
      return null;
    })
    .finally(() => nativeIconRequests.delete(resolved));
  nativeIconRequests.set(resolved, request);
  return request;
}

export function artifactKindLabel(path: string): string {
  const leaf = path.split(/[\\/]+/).pop() ?? '';
  const dot = leaf.lastIndexOf('.');
  const ext = dot > 0 ? leaf.slice(dot + 1).toUpperCase() : '';
  return ext || t('artifacts.file');
}

export function fileIconMeta(path: string): { svg: string; cls: string } {
  const leaf = path.split(/[\\/]+/).pop() ?? '';
  const dot = leaf.lastIndexOf('.');
  const ext = dot > 0 ? leaf.slice(dot + 1).toLowerCase() : '';
  if (['png', 'jpg', 'jpeg', 'gif', 'svg', 'webp', 'ico', 'bmp', 'avif', 'heic'].includes(ext)) return { svg: IMAGE_ICON, cls: 'artifact-icon-img' };
  if (['ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs', 'json', 'css', 'scss', 'sass', 'html', 'htm', 'py', 'rs', 'go', 'java', 'kt', 'c', 'h', 'cpp', 'hpp', 'cs', 'rb', 'php', 'sh', 'bash', 'zsh', 'zig', 'swift', 'vue', 'svelte'].includes(ext)) return { svg: CODE_ICON, cls: 'artifact-icon-code' };
  if (['md', 'markdown', 'txt', 'pdf', 'doc', 'docx', 'rtf', 'tex', 'org'].includes(ext)) return { svg: DOC_ICON, cls: 'artifact-icon-doc' };
  if (['csv', 'tsv', 'xlsx', 'xls', 'sql', 'db', 'sqlite', 'parquet'].includes(ext)) return { svg: DATA_ICON, cls: 'artifact-icon-data' };
  if (['zip', 'tar', 'gz', 'tgz', '7z', 'rar', 'bz2', 'xz'].includes(ext)) return { svg: ARCHIVE_ICON, cls: 'artifact-icon-archive' };
  return { svg: FILE_ICON, cls: '' };
}

/** Card title: the leaf name; secondary line: the path as written. */
function splitNamePath(path: string): { name: string; rest: string } {
  const trimmed = path.trim().replace(/[\\/]+$/, '');
  const idx = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'));
  if (idx < 0) return { name: trimmed, rest: '' };
  return { name: trimmed.slice(idx + 1), rest: trimmed.slice(0, idx + 1) };
}

/**
 * Build one generated-file card. The native button semantics provide
 * Enter/Space activation and the hover hint makes the action discoverable.
 */
function createArtifactCard(item: ArtifactItem): HTMLButtonElement | null {
  const path = item.path;
  if (!path) return null;
  const meta = fileIconMeta(path);

  const card = document.createElement('button');
  card.type = 'button';
  card.className = `artifact-card ${meta.cls}`;
  card.setAttribute('data-path', path);
  card.title = t('artifacts.clickHint');
  card.setAttribute('aria-label', `${t('artifacts.openFile')}: ${path}`);
  card.innerHTML =
    `<span class="artifact-icon artifact-icon-loading ${meta.cls}">${meta.svg}</span>` +
    `<span class="artifact-text"><span class="artifact-name"></span><span class="artifact-path"></span><span class="artifact-meta"><span class="artifact-kind"></span><span class="artifact-action"></span></span></span>` +
    `<span class="artifact-open-hint" aria-hidden="true">${OPEN_HINT_ICON}</span>`;
  const iconEl = card.querySelector<HTMLElement>('.artifact-icon')!;
  void nativeFileIcon(path).then((icon) => {
    if (!icon || !iconEl.isConnected) return;
    iconEl.classList.add('artifact-icon-native');
    iconEl.innerHTML = '<img src="" alt="" aria-hidden="true">';
    iconEl.querySelector<HTMLImageElement>('img')!.src = icon;
  }).finally(() => {
    iconEl.classList.remove('artifact-icon-loading');
  });
  const nameEl = card.querySelector<HTMLElement>('.artifact-name')!;
  const pathEl = card.querySelector<HTMLElement>('.artifact-path')!;
  const kindEl = card.querySelector<HTMLElement>('.artifact-kind')!;
  const actionEl = card.querySelector<HTMLElement>('.artifact-action')!;
  const { name, rest } = splitNamePath(path);
  nameEl.textContent = name || path;
  pathEl.textContent = rest;
  kindEl.textContent = artifactKindLabel(path);
  actionEl.textContent = t('artifacts.openAction');
  card.addEventListener('click', () => openPathLink(path));
  return card;
}

/** Render one project-directory link instead of expanding a project into file cards. */
function createProjectDirectoryLink(projectPath: string): HTMLButtonElement {
  const target = projectPath.trim() || '.';
  const resolved = resolvePathForOpen(target).replace(/[\\/]\.$/, '') || target;
  const link = document.createElement('button');
  link.type = 'button';
  link.className = 'artifact-project-link';
  link.title = `${t('artifacts.openDir')}: ${resolved}`;
  link.setAttribute('aria-label', `${t('artifacts.openDir')}: ${resolved}`);
  link.innerHTML =
    `<span class="artifact-project-icon">${PROJECT_ICON}</span>` +
    `<span class="artifact-project-text"><span class="artifact-project-label"></span><span class="artifact-project-path"></span><span class="artifact-project-count"></span></span>` +
    `<span class="artifact-open-hint" aria-hidden="true">${OPEN_HINT_ICON}</span>`;
  link.querySelector<HTMLElement>('.artifact-project-label')!.textContent = t('artifacts.project');
  link.querySelector<HTMLElement>('.artifact-project-path')!.textContent = resolved;
  link.querySelector<HTMLElement>('.artifact-project-count')!.textContent = t('artifacts.projectContents');
  link.addEventListener('click', () => openPathLink(target));
  return link;
}

/**
 * Append the compact generated-result presentation into `host`. Folders are
 * filtered before this function is called and again by planArtifactDisplay as
 * a defensive boundary. `projectPath` is absolute for live turns when known;
 * '.' resolves through the active session workspace during replay.
 */
export function renderArtifactCards(
  host: HTMLElement,
  items: ArtifactItem[],
  projectPath = '.',
  options: ArtifactDisplayOptions = {},
): void {
  const plan = planArtifactDisplay(items, options);
  if (plan.mode === 'none') return;

  const wrap = document.createElement('div');
  wrap.className = plan.mode === 'project' ? 'artifact-project' : 'artifact-cards';
  wrap.setAttribute('role', 'group');
  wrap.setAttribute('aria-label', plan.mode === 'project' ? t('artifacts.project') : t('artifacts.group'));

  if (plan.mode === 'project') {
    wrap.appendChild(createProjectDirectoryLink(projectPath));
  } else {
    for (const item of plan.items) {
      const card = createArtifactCard(item);
      if (card) wrap.appendChild(card);
    }
  }

  host.appendChild(wrap);
}
