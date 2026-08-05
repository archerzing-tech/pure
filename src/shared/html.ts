// src/shared/html.ts
// Shared HTML utility functions.

// Escapes for BOTH text content and double-quoted attribute values. The old
// textContent→innerHTML trick escapes &, <, > but NOT quotes — a path like
// `/a" onmouseover="x` embedded in data-ws="…"/title="…" could break out of
// the attribute and inject extra attributes.
export function escapeHtml(text: string): string {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
