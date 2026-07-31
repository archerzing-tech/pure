// src/shared/html.ts
// Shared HTML utility functions.

export function escapeHtml(text: string): string {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}
