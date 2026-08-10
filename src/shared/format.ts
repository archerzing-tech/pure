// src/shared/format.ts
// Shared formatting + arg-parsing helpers, used by the GUI adapter
// (TauriToolAdapter), the CLI adapter (NodeToolAdapter) and the engine layers.
// Single source of truth — these were previously duplicated in every adapter
// with identical bodies (and drift risk) on both sides of the runtime split.

/** Parse a tool call's JSON arguments. Malformed input yields {} instead of
 * throwing — the LLM occasionally emits invalid JSON, and the tool then sees
 * no args rather than crashing the turn. The optional onError callback lets a
 * caller keep its own diagnostic logging on parse failure (DeepSeekAnthropic
 * warns with a truncated raw payload) without duplicating the parser. */
export function safeParseArgs(raw: string, onError?: (raw: string) => void): Record<string, unknown> {
  try { return JSON.parse(raw); } catch {
    onError?.(raw);
    return {};
  }
}

/** Build the error message for a failed command (non-zero exit code). */
export function formatCommandError(exitCode: number, output: string): string {
  const tail = output.trim() ? `:\n${output.trim()}` : '';
  return `Command failed with exit code ${exitCode}${tail}`;
}

/** Human-readable byte size ("512 B", "12.3 KB", "1.5 MB") — used by the
 * write_file progress lines and the tool row's pending label. */
export function formatBytes(n: number): string {
  if (n >= 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  if (n >= 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${n} B`;
}
