// src/ui/artifactCards.ts
// Smart result display for generated files. After a turn completes, the files
// the agent actually wrote are surfaced at the END of the final assistant
// bubble as clickable cards:
//
//   * Every generated file is shown as a clickable card.
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

export type ArtifactDisplay =
  | { mode: 'none' }
  | { mode: 'files'; items: ArtifactItem[] };

/** Only generated files become result cards; workspace folders never do. */
export function planArtifactDisplay(items: ArtifactItem[]): ArtifactDisplay {
  return items.length === 0 ? { mode: 'none' } : { mode: 'files', items };
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

/**
 * Pick a format icon (glyph + tint class) for a file path so the card reads
 * like the composer's paste chips. Unknown extensions fall back to the
 * generic file glyph.
 */
const nativeIconCache = new Map<string, string | null>();
const nativeIconRequests = new Map<string, Promise<string | null>>();

async function nativeFileIcon(path: string): Promise<string | null> {
  if (!isTauriRuntime()) return null;
  const resolved = resolvePathForOpen(path);
  if (!resolved) return null;
  if (nativeIconCache.has(resolved)) return nativeIconCache.get(resolved) ?? null;
  const pending = nativeIconRequests.get(resolved);
  if (pending) return pending;
  const request = tauriInvoke<string>('get_file_icon', { path: resolved })
    .then((icon) => {
      const value = icon.startsWith('data:image/') ? icon : null;
      nativeIconCache.set(resolved, value);
      return value;
    })
    .catch(() => {
      nativeIconCache.set(resolved, null);
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

/**
 * Append generated-file cards into `host`. Folders are filtered before this
 * function is called and again by planArtifactDisplay as a defensive boundary.
 */
export function renderArtifactCards(host: HTMLElement, items: ArtifactItem[]): void {
  const plan = planArtifactDisplay(items);
  if (plan.mode === 'none') return;

  const wrap = document.createElement('div');
  wrap.className = 'artifact-cards';
  wrap.setAttribute('role', 'group');
  wrap.setAttribute('aria-label', t('artifacts.group'));

  for (const item of plan.items) {
    const card = createArtifactCard(item);
    if (card) wrap.appendChild(card);
  }

  host.appendChild(wrap);
}
