// src/ui/pathLink.ts
// Clickable file paths in the transcript. Any path-shaped text inside a chat
// bubble or tool row becomes a `.path-link` that opens the path — directories
// in the file manager, files with their default app — via the Rust `open_path`
// command (macOS `open` / Linux `xdg-open` / Windows `explorer`). In plain
// browser dev (no Tauri runtime) clicking copies the path to the clipboard.

import { isTauriRuntime, tauriInvoke } from '../shared/tauri';
import { t } from '../shared/i18n';
import { showToast as toast } from '../shared/toast';

// Module-level workspace used to resolve relative paths against. Kept in sync
// by ChatController.setWorkspace so linkify always resolves against the
// session's own workspace at render time.
let activeWorkspace = '';

export function setPathLinkWorkspace(ws: string): void {
  activeWorkspace = ws;
}

export interface PathMatch {
  start: number;
  end: number;
  /** Pure path with any :line / :line:col suffix stripped — what gets opened. */
  path: string;
  /** Full matched text including the suffix — what is displayed. */
  text: string;
}

function isPathChar(ch: string): boolean {
  return /[\w@.+\-~/\\]/.test(ch);
}

/** Scan a run of path characters starting at `start`. */
function scanPathRun(text: string, start: number): number {
  let i = start;
  while (i < text.length && isPathChar(text[i])) i++;
  return i;
}

/** Strip trailing sentence punctuation so `path.ts.` opens `path.ts`. */
function trimTrailingPunct(end: number, text: string): number {
  let e = end;
  while (e > 0 && /[.,;!?)\]}"']/.test(text[e - 1])) e--;
  return e;
}

function finishMatch(text: string, start: number, rawEnd: number): PathMatch | null {
  const end = trimTrailingPunct(rawEnd, text);
  if (end <= start) return null;
  // Consume a trailing :line or :line:col suffix into the display text so the
  // path link keeps the full reference the model wrote, but opens the file.
  const rest = text.slice(end);
  const suffix = rest.match(/^:\d+(?::\d+)?/);
  const displayEnd = suffix ? end + suffix[0].length : end;
  return {
    start,
    end: displayEnd,
    path: text.slice(start, end),
    text: text.slice(start, displayEnd),
  };
}

/**
 * Find path-shaped substrings in `text`. Matches:
 *  - absolute POSIX paths (`/a/b/c.ts`, `~/.config/foo`)
 *  - Windows drive paths (`C:\Users\foo\x.ts`)
 *  - relative paths with a separator AND a file extension (or trailing `/`),
 *    but only when a workspace is configured (otherwise they can't resolve)
 *  - an optional `:line` / `:line:col` suffix on any of the above
 *
 * URLs (`https://…`) and words without separators (`a/b` has no extension) are
 * deliberately NOT matched to avoid false-positive links.
 */
export function findPathMatches(text: string): PathMatch[] {
  const out: PathMatch[] = [];
  const n = text.length;
  let i = 0;
  while (i < n) {
    const ch = text[i];
    // Only attempt a match at plausible path starts; skip everything else fast.
    if (ch !== '/' && ch !== '~' && ch !== '\\' && !/[A-Za-z0-9_@.]/.test(ch)) {
      i++;
      continue;
    }
    // Not a fresh token — inside an existing path-ish run (e.g. the `/x` of
    // `https://x` or the `b` of `a/b/c` would be handled from the token start).
    const prev = i > 0 ? text[i - 1] : '';
    if (prev && /[\w@.+\-~/\\:]/.test(prev)) {
      i++;
      continue;
    }

    let m: PathMatch | null = null;

    if (ch === '/') {
      // Absolute POSIX path. Reject `//` (URL) and require ≥2 components or a
      // trailing file extension so a lone slash isn't clickable.
      const end = scanPathRun(text, i);
      const run = text.slice(i, end);
      if (!run.startsWith('//')) {
        const components = run.split('/').filter(Boolean);
        const lastExt = /\.[A-Za-z0-9]+$/.test(components[components.length - 1] ?? '');
        if (components.length >= 2 || lastExt) m = finishMatch(text, i, end);
      }
    } else if (ch === '~' && text[i + 1] === '/') {
      // Home-relative path.
      const end = scanPathRun(text, i);
      const run = text.slice(i, end);
      if (run.split('/').filter(Boolean).length >= 2) m = finishMatch(text, i, end);
    } else if (/[A-Za-z]/.test(ch) && text[i + 1] === ':' && (text[i + 2] === '/' || text[i + 2] === '\\')) {
      // Windows drive path. The drive colon is not a path char, so scan from
      // after "C:" and slice the drive prefix back in.
      const end = scanPathRun(text, i + 3);
      const run = text.slice(i, end);
      const parts = run.split(/[\\/]/).filter(Boolean);
      if (parts.length >= 2) m = finishMatch(text, i, end);
    } else if (activeWorkspace && /[\w.@~-]/.test(ch)) {
      // Relative path: needs a separator, and either a file extension or a
      // trailing separator (directory). Requires a workspace to resolve.
      const end = scanPathRun(text, i);
      const run = text.slice(i, end);
      if (/[\\/]/.test(run)) {
        const lastSeg = run.split(/[\\/]/).pop() ?? '';
        const hasExt = /\.[A-Za-z0-9]+$/.test(lastSeg);
        if (/[\\/]$/.test(run) || hasExt) m = finishMatch(text, i, end);
      }
    }

    if (m) {
      out.push(m);
      i = m.end;
    } else {
      i++;
    }
  }
  return out;
}

/** Strip any :line/:line:col suffix and resolve relative paths against the workspace. */
export function resolvePathForOpen(raw: string): string {
  let p = raw.trim();
  p = p.replace(/:\d+(?::\d+)?$/, '');
  if (!p) return p;
  const isAbsolute = p.startsWith('/') || /^[A-Za-z]:[\\/]/.test(p) || p.startsWith('~');
  if (!isAbsolute && activeWorkspace) {
    p = activeWorkspace.replace(/[\\/]+$/, '') + '/' + p.replace(/^[\\/]+/, '');
  }
  return p;
}

/** True for links that should be handed to the operating system. */
export function isExternalUrl(raw: string): boolean {
  return /^(?:https?:|mailto:)/i.test(raw.trim());
}

/** Open a raw path match (or copy it in browser dev). */
export function openPathLink(rawPath: string): void {
  const resolved = resolvePathForOpen(rawPath);
  if (isTauriRuntime()) {
    (async () => {
      try {
        await tauriInvoke('open_path', { path: resolved });
      } catch (err) {
        toast(`${t('path.openFailed')}: ${rawPath}`);
        console.error('[pure] open_path failed:', err);
      }
    })();
  } else {
    navigator.clipboard
      ?.writeText(rawPath)
      .then(() => toast(t('path.copied')))
      .catch(() => { /* clipboard unavailable — ignore */ });
  }
}

/**
 * Replace path-shaped text nodes inside `container` with `.path-link` spans.
 * Idempotent: text already inside an `.path-link`, `<a>` or `<button>` is left
 * alone, so re-running on a container that was already processed is a no-op.
 */
export function linkifyPaths(container: HTMLElement): void {
  const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
  const targets: Text[] = [];
  let node: Node | null;
  while ((node = walker.nextNode())) {
    const text = node as Text;
    const parent = text.parentElement;
    if (!parent) continue;
    if (parent.closest('a, button, .path-link')) continue;
    targets.push(text);
  }
  for (const text of targets) {
    const matches = findPathMatches(text.data);
    if (matches.length === 0) continue;
    const frag = document.createDocumentFragment();
    let last = 0;
    for (const m of matches) {
      if (m.start > last) frag.appendChild(document.createTextNode(text.data.slice(last, m.start)));
      const span = document.createElement('span');
      span.className = 'path-link';
      span.setAttribute('data-path', m.path);
      span.title = t('path.open');
      span.textContent = m.text;
      frag.appendChild(span);
      last = m.end;
    }
    if (last < text.data.length) frag.appendChild(document.createTextNode(text.data.slice(last)));
    text.parentNode!.replaceChild(frag, text);
  }
}

let bound = false;

/**
 * Attach the single delegated click handler for every `.path-link` on the
 * page. Safe to call more than once (no duplicate listeners).
 */
export function initPathLinks(): void {
  if (bound) return;
  bound = true;
  document.addEventListener('click', (e) => {
    const target = e.target as HTMLElement | null;
    const pathLink = target?.closest?.('.path-link') as HTMLElement | null;
    if (pathLink) {
      e.preventDefault();
      e.stopPropagation();
      const raw = pathLink.getAttribute('data-path') ?? '';
      if (raw) openPathLink(raw);
      return;
    }

    // Tauri WebViews do not reliably hand target="_blank" anchors to the
    // system browser. Route safe Markdown/search-result links through the same
    // Rust `open_path` command instead; in a normal browser, leave native link
    // behavior untouched so dev mode still opens a new tab.
    const anchor = target?.closest?.('a[href]') as HTMLAnchorElement | null;
    const href = anchor?.getAttribute('href')?.trim() ?? '';
    if (!anchor || !isTauriRuntime() || !isExternalUrl(href)) return;
    e.preventDefault();
    e.stopPropagation();
    void (async () => {
      try {
        await tauriInvoke('open_path', { path: href });
      } catch (err) {
        toast(`${t('path.openFailed')}: ${href}`);
        console.error('[pure] external link open failed:', err);
      }
    })();
  });
}
