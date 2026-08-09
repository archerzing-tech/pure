// src/ui/statsExportToast.ts
import { t } from '../shared/i18n';
import { escapeHtml } from '../shared/html';

/**
 * Build the post-export toast markup: a plain label plus a clickable
 * `.path-link` for the saved report path — clicking it opens the file with
 * the OS default app (the global .path-link delegation in pathLink.ts routes
 * it through the Rust open_path command). The path is escaped for both the
 * data-path attribute and the visible text.
 */
export function buildExportSavedToast(path: string): string {
  const label = escapeHtml(t('stats.export.done'));
  const safePath = escapeHtml(path);
  return `${label}: <span class="path-link" data-path="${safePath}" title="${safePath}">${safePath}</span>`;
}
