// src/ui/pasteChip.ts
// Paste handling for content the textarea should not swallow:
//   • TEXT pastes ≥ PASTE_FILE_THRESHOLD chars → saved to the session tmp
//     workspace (~/.pure/tmp/<session-id>/) and shown as a file chip.
//   • IMAGE pastes (screenshots, copied pictures) → saved the same way and
//     shown as a THUMBNAIL chip (a textarea can't hold an image at all).
// Double-clicking a chip opens a fullscreen viewer (text in a <pre>, images
// rendered). On send the attachments ride along with the typed text (see
// composeMessageWithAttachments, used by main.ts doSend).

import { formatBytes } from '../shared/format';
import { isTauriRuntime, loadTauriCore } from '../shared/tauri';
import { t } from '../shared/i18n';
import { showToast } from '../shared/toast';
import type { MessageImage } from '../shared/types';

export interface PasteAttachment {
  id: string;
  name: string;
  /** Bytes for files/images; character count for text (what the chip shows). */
  size: number;
  /** Text content ('text' kind); '' for images and binary files. */
  content: string;
  /** Absolute tmp path when persisted to disk ('' in browser/dev mode). */
  path: string;
  kind: 'text' | 'image' | 'doc' | 'binary';
  /** data: URL for image thumbnails/viewer ('' for text/binary). */
  dataUrl: string;
  mime?: string;
  truncated?: boolean;
  /** Dropped files open with one click; pasted chips keep their double-click behavior. */
  openOnClick?: boolean;
}

export interface DroppedFileRecord {
  name: string;
  path: string;
  size: number;
  kind: 'text' | 'image' | 'doc' | 'binary';
  content: string;
  dataUrl: string;
  mime: string;
  truncated?: boolean;
  isDirectory?: boolean;
}

/** Text pastes at or above this length become file chips instead of text. */
export const PASTE_FILE_THRESHOLD = 350;
export const LONG_TEXT_MEMORY_FALLBACK_LIMIT = 4 * 1024 * 1024;

/** Images larger than this are rejected (bounds memory + the base64 IPC). */
const MAX_IMAGE_BYTES = 25 * 1024 * 1024;

/** Cap for the image payload that rides into the model context and the
 * persisted session snapshot: ~2 megapixels. A 12MP phone photo becomes
 * ~1630×1225, cutting the base64 payload ~6× while staying sharp on screen.
 * The on-disk tmp copy (Tauri) keeps the original bytes untouched. */
export const MAX_IMAGE_PIXELS = 2 * 1024 * 1024;

/** Raster formats we can downscale losslessly-ish; SVG stays vector, GIF keeps
 * its animation, BMP is too rare to bother re-encoding. */
const RASTER_IMAGE_DATA_URL = /^data:image\/(?:png|jpe?g|webp)(?:;|,)/i;

// ── Upload limits (attach / drop / import) ──
// Only text (code, logs, csv…), images, and document files (pdf/doc/docx/…)
// may be attached. Archives and other binary payloads are rejected outright —
// the agent can't read them and they only bloat the session tmp dir. Per-batch
// count and per-file byte caps keep the composer + IPC sane.
const MAX_ATTACHMENTS = 10;
const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;

/** Document-class extensions allowed to attach (kept as chips, not parsed). */
const DOC_EXTENSIONS = new Set(['pdf', 'doc', 'docx', 'rtf', 'xls', 'xlsx', 'ppt', 'pptx', 'odt']);

/** True when `name`'s extension is a document-class file. */
export function isDocFileName(name: string): boolean {
  return DOC_EXTENSIONS.has((name.toLowerCase().match(/\.([a-z0-9]+)$/)?.[1] ?? ''));
}

/** Viewer display cap — keeps a 50MB log from freezing the webview. */
const VIEWER_MAX_CHARS = 2_000_000;

const FILE_ICON_SVG =
  '<svg class="paste-chip-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">' +
  '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>' +
  '<polyline points="14 2 14 8 20 8"/>' +
  '<line x1="9" y1="13" x2="15" y2="13"/><line x1="9" y1="17" x2="13" y2="17"/></svg>';

const CLOSE_ICON_SVG =
  '<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">' +
  '<line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>';

/** Timestamp used in paste filenames (second granularity is fine — a random
 * suffix is appended by the caller to disambiguate same-second pastes). */
function pasteStamp(): string {
  return new Date().toISOString().replace(/[-:]/g, '').replace(/\..+/, '').replace('T', '-');
}

/** Extension for an image MIME type (.png / .jpg / .gif / .webp / …). */
export function imageExtOf(mime: string): string {
  const m = /^image\/([a-z0-9.+-]+)/i.exec(mime);
  const raw = m ? m[1].toLowerCase() : '';
  if (raw === 'jpeg') return 'jpg';
  // 'svg+xml' and friends → the primary subtype ('svg').
  return raw.split('+')[0] || 'png';
}

/** Pick a compact visual marker for a dropped file without trusting its name as HTML. */
export function fileIconOf(name: string, kind: PasteAttachment['kind']): string {
  if (kind === 'image') return '🖼️';
  const ext = name.toLowerCase().match(/\.([a-z0-9]+)$/)?.[1] ?? '';
  if (ext === 'pdf') return '📕';
  if (['zip', 'gz', 'tar', 'rar', '7z'].includes(ext)) return '🗜️';
  if (['xls', 'xlsx', 'csv', 'tsv'].includes(ext)) return '📊';
  if (['doc', 'docx', 'rtf', 'md'].includes(ext)) return '📝';
  if (['js', 'ts', 'jsx', 'tsx', 'py', 'rs', 'go', 'java', 'c', 'cpp', 'h', 'css', 'html', 'json', 'xml', 'sh', 'sql'].includes(ext)) return '💻';
  if (kind === 'binary') return '📦';
  return '📄';
}

/**
 * Pick a sensible extension for a pasted text blob based on its head: JSON
 * objects / arrays, markdown fences or headings, and uniform-delimiter tables
 * (CSV / TSV) get their own extension; everything else falls back to .txt.
 */
export function guessPasteName(content: string): string {
  const head = content.slice(0, 2000).trim();
  const base = `pasted-${pasteStamp()}`;
  if (/^[\{\[]/.test(head) && /["']/.test(head)) return `${base}.json`;
  if (head.includes('```') || /^#{1,6}\s/m.test(head)) return `${base}.md`;
  const lines = head.split('\n').filter(l => l.trim().length > 0);
  if (lines.length >= 2) {
    const count = (l: string) => l.split(/[,;\t]/).length;
    const first = count(lines[0]);
    if (first >= 2 && lines.every(l => count(l) === first)) return `${base}.csv`;
  }
  return `${base}.txt`;
}

/** Read a pasted File as a data: URL (used for thumbnails and the viewer). */
function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error ?? new Error('read failed'));
    reader.readAsDataURL(file);
  });
}

/** Aspect-preserving fit: the largest dimensions within `maxPixels`. */
export function downscaleDimensions(
  width: number,
  height: number,
  maxPixels = MAX_IMAGE_PIXELS,
): { width: number; height: number } {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return { width, height };
  const pixels = width * height;
  if (pixels <= maxPixels) return { width, height };
  const scale = Math.sqrt(maxPixels / pixels);
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}

/**
 * Downscale a raster image data URL to at most ~MAX_IMAGE_PIXELS before it
 * rides into the model context / session snapshot. PNG and WebP keep their
 * (lossless) format so text screenshots stay crisp; photos are re-encoded as
 * JPEG (quality 0.85) which shrinks them dramatically. Fails OPEN: any decode
 * or canvas problem returns the original URL unchanged.
 */
export async function downscaleImageDataUrl(dataUrl: string, maxPixels = MAX_IMAGE_PIXELS): Promise<string> {
  if (!RASTER_IMAGE_DATA_URL.test(dataUrl)) return dataUrl;
  try {
    if (typeof Image === 'undefined' || typeof document === 'undefined') return dataUrl;
    const image = new Image();
    const loaded = new Promise<HTMLImageElement>((resolve, reject) => {
      image.onload = () => resolve(image);
      image.onerror = () => reject(new Error('image decode failed'));
      image.src = dataUrl;
    });
    const img = await loaded;
    const natural = { width: img.naturalWidth || img.width, height: img.naturalHeight || img.height };
    const target = downscaleDimensions(natural.width, natural.height, maxPixels);
    if (target.width >= natural.width && target.height >= natural.height) return dataUrl;
    const canvas = document.createElement('canvas');
    canvas.width = target.width;
    canvas.height = target.height;
    const ctx = canvas.getContext('2d');
    if (!ctx) return dataUrl;
    ctx.drawImage(img, 0, 0, target.width, target.height);
    const mime = dataUrl.match(/^data:([^;,]+)/i)?.[1] ?? 'image/jpeg';
    const outMime = mime === 'image/png' || mime === 'image/webp' ? mime : 'image/jpeg';
    const out = canvas.toDataURL(outMime, 0.85);
    // `data:,` (empty) or an unsupported webp encode must not replace the URL.
    return out && out.startsWith('data:image/') ? out : dataUrl;
  } catch {
    return dataUrl;
  }
}

/**
 * Build the outgoing user message: the typed text followed by every pasted
 * attachment. Text attachments inline their full content after a marker;
 * image attachments reference the saved tmp file (the text-only adapters in
 * use cannot see the picture, so the path is the honest artifact).
 */
export function attachmentToMessageImage(attachment: PasteAttachment): MessageImage | null {
  if (attachment.kind !== 'image' || !attachment.dataUrl) return null;
  return {
    dataUrl: attachment.dataUrl,
    mimeType: attachment.mime || attachment.dataUrl.match(/^data:([^;,]+)/i)?.[1] || 'image/png',
    name: attachment.name,
    path: attachment.path || undefined,
    sizeBytes: attachment.size,
  };
}

export function composeMessageWithAttachments(text: string, attachments: PasteAttachment[]): string {
  if (attachments.length === 0) return text;
  const parts = [text];
  for (const a of attachments) {
    if (a.kind === 'image' || a.kind === 'binary') {
      const marker = (a.kind === 'image' ? t('paste.imageMarker') : t('paste.attachmentMarker'))
        .replace('{name}', a.name)
        .replace('{size}', formatBytes(a.size));
      parts.push(a.path ? `${marker}\n${a.path}` : marker);
    } else {
      const marker = t('paste.attachmentMarker')
        .replace('{name}', a.name)
        .replace('{size}', formatBytes(a.size));
      if (a.path) {
        parts.push(`${marker}\n${a.path}\n请先使用 read_file 读取这个文件的内容，再继续处理用户请求。`);
      } else {
        const fallback = a.content.slice(0, LONG_TEXT_MEMORY_FALLBACK_LIMIT);
        parts.push(`${marker}\n[浏览器开发模式内存回退，文件未成功保存]\n${fallback}`);
      }
    }
  }
  return parts.filter(p => p.trim().length > 0).join('\n\n');
}

/**
 * Owns the attachment list and the chip rows rendered into every mounted host
 * (the bottom input bar and the landing input share ONE list per session).
 */
export class PasteChipManager {
  private attachments: PasteAttachment[] = [];
  private hosts = new Map<HTMLElement, HTMLDivElement>();
  private viewerEl: HTMLDivElement | null = null;
  private getSessionId: () => string;
  private onChanged: () => void;
  private pendingReads = new Set<Promise<void>>();

  constructor(getSessionId: () => string, onChanged: () => void = () => {}) {
    this.getSessionId = getSessionId;
    this.onChanged = onChanged;
  }

  /** Insert a chip row as the first child of `host` (renders the shared list). */
  mount(host: HTMLElement): void {
    if (this.hosts.has(host)) return;
    const row = document.createElement('div');
    row.className = 'paste-chips';
    host.insertBefore(row, host.firstChild);
    this.hosts.set(host, row);
    this.render();
  }

  getAttachments(): PasteAttachment[] {
    return [...this.attachments];
  }

  /** Wait until pasted files have loaded their data URL and persisted bytes. */
  async prepareForSend(): Promise<PasteAttachment[]> {
    const pending = [...this.pendingReads];
    if (pending.length > 0) await Promise.all(pending);
    return this.getAttachments();
  }

  /** Convert directly typed long text into the same file attachment used by paste. */
  addLongText(text: string): PasteAttachment | null {
    if ([...text].length <= PASTE_FILE_THRESHOLD) return null;
    const id = `text-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    const name = guessPasteName(text).replace(/\.(\w+)$/, `-${id.slice(-6)}.$1`);
    const attachment: PasteAttachment = { id, name, size: text.length, content: text, path: '', kind: 'text', dataUrl: '' };
    this.attachments.push(attachment);
    this.render();
    this.onChanged();
    const sessionId = this.getSessionId();
    if (isTauriRuntime()) {
      const pending = (async () => {
        try {
          const core = await loadTauriCore();
          const path = await core?.invoke<string>('save_paste_file', { sessionId, name, content: text });
          if (path) { attachment.path = path; this.render(); this.onChanged(); }
        } catch (error) {
          console.error('[pure] save long text failed:', error);
        }
      })();
      this.pendingReads.add(pending);
      void pending.finally(() => this.pendingReads.delete(pending)).catch(() => {});
    }
    return attachment;
  }
  /** Whether any pasted file is waiting to be sent (enables send with no text). */
  hasAttachments(): boolean {
    return this.attachments.length > 0;
  }

  /** How many more files may be attached before the batch cap (for pre-flight
   *  checks before an expensive import — e.g. the Tauri drop path). */
  remainingSlots(): number {
    return Math.max(0, MAX_ATTACHMENTS - this.attachments.length);
  }

  remove(id: string): void {
    this.attachments = this.attachments.filter(a => a.id !== id);
    this.render();
    this.onChanged();
  }

  clear(): void {
    if (this.attachments.length === 0) return;
    this.attachments = [];
    this.render();
    this.onChanged();
  }

  /**
   * Intercept a paste on a prompt textarea. Returns true when the paste was
   * consumed (turned into a chip) — the caller must not insert it. Images
   * (screenshots) always win; oversized text falls back to the file chip.
   */
  consumePaste(e: ClipboardEvent): boolean {
    // 1) Image paste: any image/* file in the clipboard becomes a thumbnail
    // chip. No size threshold — a textarea cannot hold a picture at all.
    const images = imageFilesOf(e.clipboardData);
    if (images.length > 0) {
      e.preventDefault();
      this.handleImagePaste(images);
      return true;
    }
    // 2) Oversized text paste → file chip (sync path, disk write async).
    const text = e.clipboardData?.getData('text') ?? '';
    if ([...text].length <= PASTE_FILE_THRESHOLD) return false;
    e.preventDefault();
    // A random suffix keeps two pastes inside the same second from colliding
    // on disk (the second save would otherwise overwrite the first).
    const id = `paste-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    const name = guessPasteName(text).replace(/\.(\w+)$/, `-${id.slice(-6)}.$1`);
    const att: PasteAttachment = { id, name, size: text.length, content: text, path: '', kind: 'text', dataUrl: '' };
    this.attachments.push(att);
    this.render();
    this.onChanged();
    // Capture the session id NOW — a session switch before the write completes
    // must not redirect the file into the newly-opened session's tmp dir.
    const sessionId = this.getSessionId();
    if (isTauriRuntime()) {
      const pending = (async () => {
        try {
          const core = await loadTauriCore();
          const path = await core?.invoke<string>('save_paste_file', { sessionId, name, content: text });
          if (path) {
            att.path = path;
            this.render();
            this.onChanged();
          }
        } catch (err) {
          // Keep the chip (memory copy still works) — just no disk file.
          console.error('[pure] save_paste_file failed:', err);
        }
      })();
      this.pendingReads.add(pending);
      void pending.finally(() => this.pendingReads.delete(pending)).catch(() => {});
    }
    return true;
  }

  /** Add files supplied by a browser drop. Tauri drops use addImportedFile after Rust copies them. */
  addDroppedFiles(files: File[]): void {
    const sessionId = this.getSessionId();
    for (const file of files) {
      const mime = file.type || mimeOfFileName(file.name);
      const kind = classifyUploadFile(file.name, mime, file.size);
      if (kind === null) {
        showToast(t('paste.uploadRejected').replace('{name}', file.name));
        continue;
      }
      if (this.attachments.length >= MAX_ATTACHMENTS) {
        showToast(t('paste.tooManyAttachments').replace('{max}', String(MAX_ATTACHMENTS)));
        break;
      }
      const id = `drop-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
      const att: PasteAttachment = {
        id,
        name: file.name || 'dropped-file',
        size: file.size,
        content: '',
        path: '',
        kind,
        dataUrl: '',
        mime,
        openOnClick: true,
      };
      this.attachments.push(att);
      this.render();
      this.onChanged();
      const pending = (async () => {
        try {
          if (kind === 'image') {
            // Downscale before the payload rides into the model context / session
            // snapshot; the browser File itself is the user's original copy.
            att.dataUrl = await downscaleImageDataUrl(await readFileAsDataUrl(file));
          } else if (kind === 'text') {
            const raw = await file.slice(0, VIEWER_MAX_CHARS + 1).text();
            att.content = raw.slice(0, VIEWER_MAX_CHARS);
            att.truncated = file.size > VIEWER_MAX_CHARS;
          }
          this.render();
          this.onChanged();
        } catch (err) {
          console.error('[pure] dropped browser file failed:', err);
        }
      })();
      this.pendingReads.add(pending);
      void pending.finally(() => this.pendingReads.delete(pending)).catch(() => {});
    }
  }

  /** Add a file that the Tauri backend has copied into the application tmp directory. */
  addImportedFile(record: DroppedFileRecord): void {
    if (record.isDirectory) return;
    // Belt-and-suspenders: never attach a binary the Rust import rejected-or
    // classified as binary, and enforce the batch cap on the Tauri path too.
    if (record.kind === 'binary') {
      showToast(t('paste.uploadRejected').replace('{name}', record.name));
      return;
    }
    if (this.attachments.length >= MAX_ATTACHMENTS) {
      showToast(t('paste.tooManyAttachments').replace('{max}', String(MAX_ATTACHMENTS)));
      return;
    }
    const id = `drop-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    const att: PasteAttachment = {
      id,
      name: record.name,
      size: record.size,
      content: record.content,
      path: record.path,
      kind: record.kind,
      dataUrl: record.dataUrl,
      mime: record.mime,
      truncated: record.truncated,
      openOnClick: true,
    };
    this.attachments.push(att);
    this.render();
    this.onChanged();
    // Cap the in-context data URL for imported images too (the Rust record
    // carries a full-resolution base64). The thumbnail renders immediately;
    // the scaled version replaces it before the send path reads attachments.
    if (record.kind === 'image' && record.dataUrl) {
      const pending = downscaleImageDataUrl(record.dataUrl).then((scaled) => {
        if (scaled && scaled !== att.dataUrl) {
          att.dataUrl = scaled;
          this.render();
        }
      });
      this.pendingReads.add(pending);
      void pending.finally(() => this.pendingReads.delete(pending)).catch(() => {});
    }
  }

  /** Read pasted image files → thumbnail chip each + persist the bytes. */
  private handleImagePaste(files: File[]): void {
    const sessionId = this.getSessionId();
    for (const file of files) {
      // Bounds memory: a giant screenshot becomes a giant data URL + base64
      // IPC payload. Reject with a toast instead of silently attaching.
      if (file.size > MAX_IMAGE_BYTES) {
        showToast(t('paste.imageTooLarge'));
        continue;
      }
      const id = `paste-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
      const name = `pasted-${pasteStamp()}-${id.slice(-6)}.${imageExtOf(file.type)}`;
      const att: PasteAttachment = {
        id, name, size: file.size, content: '', path: '', kind: 'image', dataUrl: '',
      };
      this.attachments.push(att);
      this.render();
      this.onChanged();
      const pending = (async () => {
        try {
          // 1) data URL drives the thumbnail, transcript preview, and vision
          // request. Downscale it so a multi-megapixel screenshot/photo does not
          // blow up the LLM context or the persisted session snapshot.
          const rawDataUrl = await readFileAsDataUrl(file);
          att.dataUrl = await downscaleImageDataUrl(rawDataUrl);
          this.render();
          // 2) Persist the ORIGINAL raw bytes (base64 over IPC) in Tauri mode —
          // the on-disk copy stays the user's exact image; only the in-context
          // data URL is capped.
          if (isTauriRuntime()) {
            const core = await loadTauriCore();
            const dataBase64 = rawDataUrl.slice(rawDataUrl.indexOf(',') + 1);
            const path = await core?.invoke<string>('save_paste_image', { sessionId, name, dataBase64 });
            if (path) {
              att.path = path;
              this.render();
            }
          }
        } catch (err) {
          console.error('[pure] paste image failed:', err);
        }
      })();
      this.pendingReads.add(pending);
      void pending.finally(() => this.pendingReads.delete(pending)).catch(() => {});
    }
  }

  private render(): void {
    for (const row of this.hosts.values()) {
      row.replaceChildren();
      for (const a of this.attachments) {
        const chip = document.createElement('div');
        chip.className = `paste-chip paste-chip-${a.kind}`;
        chip.dataset.id = a.id;
        chip.dataset.kind = a.kind;
        chip.title = `${a.path || t('paste.memory')}\n${a.openOnClick ? t('paste.clickHint') : t('paste.dblclickHint')}`;
        if (a.kind === 'image' && a.dataUrl) {
          const thumb = document.createElement('img');
          thumb.className = 'paste-chip-thumb';
          thumb.alt = '';
          thumb.src = a.dataUrl;
          chip.appendChild(thumb);
        } else {
          if (a.openOnClick) {
            const typeIcon = document.createElement('span');
            typeIcon.className = 'paste-chip-type-icon';
            typeIcon.textContent = fileIconOf(a.name, a.kind);
            chip.appendChild(typeIcon);
          } else {
            chip.innerHTML = FILE_ICON_SVG;
          }
        }
        const name = document.createElement('span');
        name.className = 'paste-chip-name';
        name.textContent = a.name;
        const size = document.createElement('span');
        size.className = 'paste-chip-size';
        size.textContent = formatBytes(a.size);
        const remove = document.createElement('button');
        remove.className = 'paste-chip-remove';
        remove.type = 'button';
        remove.title = t('paste.remove');
        remove.setAttribute('aria-label', t('paste.removeLabel'));
        remove.innerHTML = CLOSE_ICON_SVG;
        remove.addEventListener('click', (ev) => {
          ev.stopPropagation();
          this.remove(a.id);
        });
        chip.append(name, size, remove);
        chip.setAttribute('role', 'button');
        chip.tabIndex = 0;
        const open = () => this.openViewer(a);
        chip.addEventListener(a.openOnClick ? 'click' : 'dblclick', open);
        chip.addEventListener('keydown', (ev) => {
          if (ev.key === 'Enter' || ev.key === ' ') {
            ev.preventDefault();
            open();
          }
        });
        row.appendChild(chip);
      }
    }
  }

  openStoredAttachment(attachment: { name: string; path: string; size: number; kind: PasteAttachment['kind'] }): void {
    this.openViewer({ id: `stored-${attachment.name}`, name: attachment.name, path: attachment.path, size: attachment.size, kind: attachment.kind, content: '', dataUrl: '' });
  }
  private openViewer(att: PasteAttachment): void {
    this.closeViewer();
    // Documents are not viewable in-app — hand them to the OS default app.
    if (att.kind === 'doc' && att.path) {
      void this.openWithDefault(att.path);
      return;
    }
    const overlay = document.createElement('div');
    overlay.className = 'paste-viewer-overlay';
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-label', att.name);

    const header = document.createElement('div');
    header.className = 'paste-viewer-header';
    const title = document.createElement('div');
    title.className = 'paste-viewer-title';
    if (att.kind === 'image') {
      const icon = document.createElement('span');
      icon.className = 'paste-viewer-title-icon';
      icon.textContent = '🖼';
      title.appendChild(icon);
    } else if (att.openOnClick) {
      const icon = document.createElement('span');
      icon.className = 'paste-viewer-title-icon';
      icon.textContent = fileIconOf(att.name, att.kind);
      title.appendChild(icon);
    } else {
      title.innerHTML = FILE_ICON_SVG;
    }
    const nameEl = document.createElement('span');
    nameEl.className = 'paste-viewer-name';
    nameEl.textContent = att.name;
    const meta = document.createElement('span');
    meta.className = 'paste-viewer-meta';
    meta.textContent = `${formatBytes(att.size)}${att.path ? ` · ${att.path}` : ''}`;
    title.append(nameEl, meta);
    const closeBtn = document.createElement('button');
    closeBtn.className = 'paste-viewer-close';
    closeBtn.type = 'button';
    closeBtn.title = t('paste.closeTitle');
    closeBtn.setAttribute('aria-label', t('paste.close'));
    closeBtn.innerHTML = CLOSE_ICON_SVG;
    closeBtn.addEventListener('click', () => this.closeViewer());
    header.append(title, closeBtn);

    const body = document.createElement('div');
    body.className = 'paste-viewer-body';
    if (att.kind === 'image') {
      if (att.dataUrl) {
        const img = document.createElement('img');
        img.className = 'paste-viewer-img';
        img.alt = att.name;
        img.src = att.dataUrl;
        body.appendChild(img);
      } else {
        // Double-click raced the async FileReader — hold a placeholder rather
        // than showing an empty text pane.
        const loading = document.createElement('div');
        loading.className = 'paste-viewer-loading';
        loading.textContent = t('paste.loading');
        body.appendChild(loading);
      }
    } else if (att.kind === 'text') {
      const pre = document.createElement('pre');
      pre.className = 'paste-viewer-pre';
      pre.textContent = att.content.slice(0, VIEWER_MAX_CHARS);
      body.appendChild(pre);
      if (att.truncated || att.content.length > VIEWER_MAX_CHARS) {
        const note = document.createElement('div');
        note.className = 'paste-viewer-truncated';          note.textContent = t('paste.truncatedFile')
            .replace('{shown}', VIEWER_MAX_CHARS.toLocaleString())
            .replace('{total}', formatBytes(att.size));
        body.appendChild(note);
      }
    } else {
      const info = document.createElement('div');
      info.className = 'paste-viewer-binary';
      info.innerHTML = `<span class="paste-viewer-binary-icon" aria-hidden="true">${fileIconOf(att.name, att.kind)}</span>`;
      const message = document.createElement('p');
      message.textContent = t('paste.binaryInfo').replace('{type}', att.mime || t('paste.unknownType'));
      info.appendChild(message);
      if (att.path) {
        const openBtn = document.createElement('button');
        openBtn.className = 'paste-viewer-open-default';
        openBtn.type = 'button';
        openBtn.textContent = t('paste.openWithDefault');
        openBtn.addEventListener('click', async () => {
          if (!isTauriRuntime()) return;
          try {
            const core = await loadTauriCore();
            await core?.invoke('open_path', { path: att.path });
          } catch (err) {
            console.error('[pure] open dropped file failed:', err);
          }
        });
        info.appendChild(openBtn);
      }
      body.appendChild(info);
    }

    overlay.append(header, body);
    document.body.appendChild(overlay);
    this.viewerEl = overlay;
    if (att.kind === 'text' && att.path && !att.content && isTauriRuntime()) {
      void (async () => {
        try {
          const core = await loadTauriCore();
          const absolute = att.path.replace(/\\/g, '/');
          const separator = absolute.lastIndexOf('/');
          const workspace = separator > 0 ? absolute.slice(0, separator) : absolute;
          const content = await core?.invoke<string>('read_file', { workspace, path: absolute });
          const pre = body.querySelector('.paste-viewer-pre');
          if (pre && typeof content === 'string') pre.textContent = content.slice(0, VIEWER_MAX_CHARS);
        } catch {
          const pre = body.querySelector('.paste-viewer-pre');
          if (pre) pre.textContent = t('paste.fileExpired');
        }
      })();
    }
    // Click on the backdrop closes; clicks inside (scroll etc.) do not.
    overlay.addEventListener('mousedown', (e) => {
      if (e.target === overlay) this.closeViewer();
    });
    document.addEventListener('keydown', this.onViewerKeydown);
    closeBtn.focus();
  }

  private onViewerKeydown = (e: KeyboardEvent): void => {
    if (e.key === 'Escape') this.closeViewer();
  };

  private closeViewer(): void {
    if (!this.viewerEl) return;
    this.viewerEl.remove();
    this.viewerEl = null;
    document.removeEventListener('keydown', this.onViewerKeydown);
  }

  private async openWithDefault(path: string): Promise<void> {
    if (!isTauriRuntime() || !path) return;
    try {
      const core = await loadTauriCore();
      await core?.invoke('open_path', { path });
    } catch (err) {
      console.error('[pure] open attachment failed:', err);
    }
  }
}

/** Every image/* file the clipboard exposes (items first, then files). */
function mimeOfFileName(name: string): string {
  const ext = name.toLowerCase().match(/\.([a-z0-9]+)$/)?.[1] ?? '';
  const types: Record<string, string> = {
    txt: 'text/plain', md: 'text/markdown', csv: 'text/csv', tsv: 'text/tab-separated-values',
    json: 'application/json', js: 'text/javascript', ts: 'text/typescript', jsx: 'text/javascript', tsx: 'text/typescript',
    html: 'text/html', css: 'text/css', xml: 'application/xml', py: 'text/x-python', rs: 'text/x-rust',
    pdf: 'application/pdf', zip: 'application/zip',
  };
  return types[ext] || 'application/octet-stream';
}

function isBrowserTextFile(name: string, mime: string): boolean {
  if (mime.startsWith('text/')) return true;
  if (mime === 'application/json' || mime === 'application/xml' || mime === 'application/javascript') return true;
  return ['txt', 'md', 'csv', 'tsv', 'json', 'js', 'ts', 'jsx', 'tsx', 'html', 'css', 'xml', 'py', 'rs', 'go', 'java', 'c', 'cpp', 'h', 'sql', 'sh', 'log'].includes(name.toLowerCase().match(/\.([a-z0-9]+)$/)?.[1] ?? '');
}

/**
 * Classify a dropped/attached file into an attachable kind, or null when it
 * must be REJECTED (binary archives/executables the agent can't read).
 * Images are capped at MAX_IMAGE_BYTES, everything else at MAX_UPLOAD_BYTES.
 */
export function classifyUploadFile(name: string, mime: string, size: number): 'text' | 'image' | 'doc' | null {
  if (size > MAX_UPLOAD_BYTES) return null;
  if (mime.startsWith('image/')) return size > MAX_IMAGE_BYTES ? null : 'image';
  if (isDocFileName(name) || mime === 'application/pdf' || mime.startsWith('application/vnd.')) return 'doc';
  if (isBrowserTextFile(name, mime)) return 'text';
  // Everything else (zip/rar/7z/tar/gz, exe, dmg, octet-stream binaries…) is
  // binary — not attachable.
  return null;
}

export const UPLOAD_LIMITS = { MAX_ATTACHMENTS, MAX_UPLOAD_BYTES, MAX_IMAGE_BYTES } as const;

function imageFilesOf(cd: DataTransfer | null): File[] {
  if (!cd) return [];
  const files: File[] = [];
  for (const item of Array.from(cd.items)) {
    if (item.kind === 'file' && item.type.startsWith('image/')) {
      const f = item.getAsFile();
      if (f) files.push(f);
    }
  }
  // Some platforms (older WebKit) only surface files via `cd.files`.
  if (files.length === 0) {
    for (const f of Array.from(cd.files)) {
      if (f.type.startsWith('image/')) files.push(f);
    }
  }
  return files;
}
