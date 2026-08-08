// src/shared/paths.ts
// Small shared path helpers used across the UI controllers (workspace picker,
// session sidebar, context panel) so display logic lives in one place.

/** Last path segment (basename) for display, e.g. "/a/b" → "b". */
export function workspaceBase(path: string): string {
  const trimmed = path.replace(/[\\/]+$/, '');
  const idx = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'));
  return idx >= 0 ? trimmed.slice(idx + 1) : trimmed;
}
