// Lightweight markdown-adjacent helpers that are safe to keep in the startup chunk.

/**
 * Strip Claude-Code-style XML tool-call blocks out of assistant text for
 * DISPLAY only. Some models leak tool calls as literal text (`<tool_calls>`
 * / `<invoke name=...>`); the engine already parses real function calls, so
 * these blocks are never executed — hide them from the rendered bubble.
 */
export function stripToolCallXml(text: string): string {
  if (!/<tool_calls|<invoke\b|<parameter\b/i.test(text)) return text;
  let out = text.replace(/<tool_calls>([\s\S]*?)<\/tool_calls>/gi, (m, inner: string) => {
    const body = inner.toLowerCase();
    return /<invoke\b|<parameter\b/.test(body) ? '' : m;
  });
  const lower = out.toLowerCase();
  const open = lower.lastIndexOf('<tool_calls>');
  if (open !== -1) {
    const afterOpen = lower.slice(open + '<tool_calls>'.length);
    const hasClose = afterOpen.indexOf('</tool_calls>') !== -1;
    if (!hasClose && /<invoke\b|<parameter\b/.test(afterOpen.slice(0, 500))) {
      out = out.slice(0, open);
    }
  }
  out = out.replace(/<invoke\b[^>]*>[\s\S]*?<\/invoke>/gi, '');
  return out.trim();
}
