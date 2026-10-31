// src/shared/plantumlSource.ts
// PlantUML 源码归一化的唯一实现（2026-10-31 审计 P2-5 收敛）。
// 此前 ui/plantumlDiagram.ts 与 channels/rasterize/headlessRenderer.ts 各养
// 了一份且已分叉（BOM/嵌套 fence/@start 前散文/补哪个结束标签四处行为不一
// 致）：同一段 puml 在图内聊天可能成图、在飞书/钉钉投影里渲染失败。纯字符
// 串函数放 shared/ 没有依赖代价，两处共用单源。

const START_LINE = /^\s*@start([a-z0-9_]+)\b/i;
const END_LINE = /^\s*@end([a-z0-9_]+)\b/i;
// Models sometimes nest a fenced block inside the fenced block they are
// answering with; a fence-only line is never part of a diagram.
const FENCE_LINE = /^\s*```[a-z]*\s*$/i;

function endTagFor(startLine: string): string {
  const tag = START_LINE.exec(startLine)?.[1];
  return tag ? `@end${tag}` : '@enduml';
}

/**
 * Turn a model-authored ```puml block into engine input.
 *
 * The engine renders exactly what it is handed, so the raw block is normalized
 * first: BOM/CRLF stripped, nested fence lines dropped, prose before `@startuml`
 * and anything after `@enduml` discarded, and a MISSING wrapper added — models
 * routinely answer with a bare body (`Alice -> Bob: hi`) or forget `@enduml`,
 * and both used to end in a blank card. Returns [] when nothing is left.
 */
export function normalizePlantumlSource(source: string): string[] {
  const lines = source
    .replace(/\uFEFF/g, '')
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .filter((line) => !FENCE_LINE.test(line));

  const startIndex = lines.findIndex((line) => START_LINE.test(line));
  if (startIndex === -1) {
    // No wrapper: keep the body, drop any stray closing tag, then wrap it.
    const body = lines.filter((line) => !END_LINE.test(line));
    const trimmed = trimBlankLines(body);
    return trimmed.length === 0 ? [] : ['@startuml', ...trimmed, '@enduml'];
  }

  const body = trimBlankLines(lines.slice(startIndex));
  if (body.length === 0) return [];
  let endIndex = -1;
  for (let i = body.length - 1; i >= 0; i--) {
    if (END_LINE.test(body[i])) {
      endIndex = i;
      break;
    }
  }
  return endIndex === -1 ? [...body, endTagFor(body[0])] : body.slice(0, endIndex + 1);
}

function trimBlankLines(lines: string[]): string[] {
  let start = 0;
  let end = lines.length;
  while (start < end && lines[start].trim() === '') start++;
  while (end > start && lines[end - 1].trim() === '') end--;
  return lines.slice(start, end);
}
