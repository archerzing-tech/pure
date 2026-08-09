// src/ui/artifactCards.ts
// Smart result display for generated files. After a turn completes, the files
// the agent actually wrote are surfaced at the END of the final assistant
// bubble as clickable cards:
//
//   * ≤ MAX_CARD_FILES artifacts → one card per file/directory. Clicking a
//     file opens it with the system's default app; clicking a directory
//     reveals it in the file manager (both via the existing open_path chain).
//   * more than MAX_CARD_FILES (e.g. a scaffolded project) → collapse to a
//     SINGLE directory card pointing at the common root of everything written,
//     so the user can navigate straight to the project folder instead of
//     staring at a wall of cards.
//
// Artifacts are collected from successful write_file / edit_file /
// replace_files / create_directory tool results during one send() turn — see
// chat.ts's ToolResult handler. Rendering is deliberately declarative (the
// planArtifactDisplay decision is a pure function) so the threshold logic is
// unit-testable without a DOM.

import { resolvePathForOpen, openPathLink } from './pathLink';
import { t } from '../shared/i18n';

export interface ArtifactItem {
  /** Path as the tool received it (relative to workspace or absolute). */
  path: string;
  kind: 'file' | 'dir';
}

/** Show one card per artifact up to this count; beyond it, show a directory card. */
export const MAX_CARD_FILES = 4;

export type ArtifactDisplay =
  | { mode: 'none' }
  | { mode: 'files'; items: ArtifactItem[] }
  | { mode: 'dir'; dir: string };

/**
 * Decide how to surface a turn's written artifacts. Pure — no DOM.
 * - 0 artifacts            → nothing to show
 * - ≤ MAX_CARD_FILES       → one card per file/directory
 * - more                   → a single directory card (common root of all paths)
 */
export function planArtifactDisplay(items: ArtifactItem[]): ArtifactDisplay {
  if (items.length === 0) return { mode: 'none' };
  if (items.length <= MAX_CARD_FILES) return { mode: 'files', items };
  const dir = commonRootDir(items);
  return { mode: 'dir', dir: dir ?? '' };
}

/**
 * Longest common directory prefix of a set of artifacts (the shared project
 * root). Paths may be relative or absolute. A FILE artifact contributes its
 * parent chain (the file's own name is not part of a directory root); a
 * DIRECTORY artifact keeps its own name (a created dir like `proj/src` IS the
 * root). When nothing is shared (files scattered across unrelated top-level
 * dirs), falls back to the first artifact's own parent (file) or itself (dir)
 * so the directory card always points at something real.
 */
export function commonRootDir(items: ArtifactItem[]): string | null {
  if (items.length === 0) return null;
  const segsFor = (item: ArtifactItem): string[] => {
    const segs = resolvePathForOpen(item.path).split(/[\\/]+/).filter(Boolean);
    return item.kind === 'dir' ? segs : segs.slice(0, -1);
  };
  const dirs = items.map(segsFor);
  const first = dirs[0];
  let common = 0;
  while (common < first.length) {
    const seg = first[common];
    if (!dirs.every((d) => d[common] === seg)) break;
    common++;
  }
  if (common === 0) {
    // Nothing shared (e.g. files in different top-level dirs): fall back to the
    // first artifact's own parent directory (or the dir artifact itself).
    return segsFor(items[0]).join('/') || null;
  }
  return first.slice(0, common).join('/');
}

// ── DOM rendering ──

const FILE_ICON =
  '<svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true"><path d="M3 1.5h6l3.5 3.5v9a.5.5 0 0 1-.5.5h-9a.5.5 0 0 1-.5-.5v-12a.5.5 0 0 1 .5-.5z" fill="none" stroke="currentColor" stroke-linejoin="round"/><path d="M9 1.5V5h3.5" fill="none" stroke="currentColor" stroke-linejoin="round"/></svg>';
const DIR_ICON =
  '<svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true"><path d="M1.5 4a1 1 0 0 1 1-1h3.6l1.2 1.5h6.2a1 1 0 0 1 1 1v6.5a1 1 0 0 1-1 1h-12a1 1 0 0 1-1-1V4z" fill="none" stroke="currentColor" stroke-linejoin="round"/></svg>';

/** Card title: the leaf name; secondary line: the path as written. */
function splitNamePath(path: string): { name: string; rest: string } {
  const trimmed = path.trim().replace(/[\\/]+$/, '');
  const idx = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'));
  if (idx < 0) return { name: trimmed, rest: '' };
  return { name: trimmed.slice(idx + 1), rest: trimmed.slice(0, idx + 1) };
}

/**
 * Append the artifact display (file cards or a single directory card) into
 * `host`. Clicking a card opens the path via openPathLink (default app for
 * files, file manager for directories).
 */
export function renderArtifactCards(host: HTMLElement, items: ArtifactItem[]): void {
  const plan = planArtifactDisplay(items);
  if (plan.mode === 'none') return;

  const wrap = document.createElement('div');
  wrap.className = 'artifact-cards';
  wrap.setAttribute('role', 'group');
  wrap.setAttribute('aria-label', t('artifacts.group'));

  if (plan.mode === 'files') {
    for (const item of plan.items) {
      const card = document.createElement('button');
      card.type = 'button';
      card.className = 'artifact-card';
      card.setAttribute('data-path', item.path);
      card.title = item.kind === 'dir' ? t('artifacts.openDir') : t('artifacts.openFile');
      card.innerHTML = `<span class="artifact-icon">${item.kind === 'dir' ? DIR_ICON : FILE_ICON}</span><span class="artifact-text"><span class="artifact-name"></span><span class="artifact-path"></span></span>`;
      const nameEl = card.querySelector<HTMLElement>('.artifact-name')!;
      const pathEl = card.querySelector<HTMLElement>('.artifact-path')!;
      const { name, rest } = splitNamePath(item.path);
      nameEl.textContent = name || item.path;
      pathEl.textContent = rest;
      card.addEventListener('click', () => openPathLink(item.path));
      wrap.appendChild(card);
    }
  } else {
    // Project mode: a single card that opens the common root directory. If the
    // common root could not be resolved at all (nothing shared, not even the
    // first artifact's parent), skip rendering — a card that would open an
    // empty path is worse than no card.
    if (!plan.dir) return;
    const card = document.createElement('button');
    card.type = 'button';
    card.className = 'artifact-card artifact-card-dir';
    card.setAttribute('data-path', plan.dir);
    card.title = t('artifacts.openDir');
    card.innerHTML = `<span class="artifact-icon">${DIR_ICON}</span><span class="artifact-text"><span class="artifact-name"></span><span class="artifact-path"></span></span>`;
    const nameEl = card.querySelector<HTMLElement>('.artifact-name')!;
    const pathEl = card.querySelector<HTMLElement>('.artifact-path')!;
    const { name, rest } = splitNamePath(plan.dir);
    nameEl.textContent = name || plan.dir || t('artifacts.project');
    pathEl.textContent = rest || plan.dir;
    card.addEventListener('click', () => openPathLink(plan.dir));
    wrap.appendChild(card);
  }

  host.appendChild(wrap);
}
