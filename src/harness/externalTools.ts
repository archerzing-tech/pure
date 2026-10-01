// src/harness/externalTools.ts
// 阶段 13.4 (loading half) — external script tools as declarative manifests.
//
// 北极星原则一：进化产物 = 版本化 manifest 文件，经唯一既有注册接缝进入。
// 本模块是接缝的编译器：`~/.pure/tools/<name>/TOOL.json` → TaggedTool，宿主
// (GUI / CLI) 扫描后注册进 ToolRegistry（MCP 同款通路）。零 IO——测试整条
// 覆盖无需 mock 文件系统。
//
// 执行模型（设计文档 capability-self-extension-design.md §13.4）：exec 是一
// 条命令模板，`{param}` 占位符替换为 tool-call 输入参数后经既有
// execute_command 信任模型跑（权限门/超时/取消全部同一套，不新建安全面）。

import { Tags } from '../coding-agent/ToolRegistry';
import type { TaggedTool } from '../coding-agent/types';
import type { ToolDefinition } from '../shared/types';

/** 磁盘上的 manifest 形状。`version` 存在的意义：将来格式变了能检测到而不是
 * 静默错读（原则一：版本化 manifest）。 */
export interface ExternalToolManifest {
  version?: number;
  /** 工具名（LLM 发出的 function-call 名）。kebab/underscore，不与内建/MCP
   *  冲突（编译器拒绝）。 */
  name: string;
  description: string;
  /** JSON-schema for the tool call. */
  input_schema?: ToolDefinition['input_schema'];
  /** 命令模板：`{param}` 替换为输入参数的字符串值。 */
  exec: string;
  /** 注册 tags。只认已知 Tags 值；SHELL 恒定加上（这些就是命令）。声明
   *  'write'/'destructive' 有意义：路由进串行写池 + 权限门判写。 */
  tags?: string[];
  riskLevel?: 'low' | 'medium' | 'high';
  /** 命令墙钟上限（ms）。 */
  timeoutMs?: number;
}

const MANIFEST_VERSION = 1;
const DEFAULT_TIMEOUT_MS = 120_000;
const MIN_TIMEOUT_MS = 5_000;
const MAX_TIMEOUT_MS = 600_000;

const NAME_RE = /^[a-z][a-z0-9_]{1,63}$/;

export interface ExternalToolCompileResult {
  tools: TaggedTool[];
  errors: string[];
}

/** 校验 + 编译一个 TOOL.json 文本。坏文件返回 errors（宿主 warn 不阻断），
 *  好的返回 TaggedTool 供 register。名字冲突检查由宿主做（编译器看不到全
 *  局名册）。 */
export function compileExternalTool(
  source: { file: string; text: string },
  dirExists: (name: string) => boolean,
): ExternalToolCompileResult {
  const errors: string[] = [];
  let parsed: ExternalToolManifest;
  try {
    parsed = JSON.parse(source.text) as ExternalToolManifest;
  } catch (err) {
    return { tools: [], errors: [`${source.file}: JSON parse failed — ${err instanceof Error ? err.message : String(err)}`] };
  }
  if (parsed.version !== undefined && parsed.version !== MANIFEST_VERSION) {
    return { tools: [], errors: [`${source.file}: unsupported manifest version ${String(parsed.version)} (this build understands version 1)`] };
  }
  if (!parsed.name || !NAME_RE.test(parsed.name)) {
    return { tools: [], errors: [`${source.file}: name "${String(parsed.name)}" must match ${String(NAME_RE)}`] };
  }
  if (!parsed.description || parsed.description.trim().length < 8) {
    return { tools: [], errors: [`${source.file}: description too short (≥8 chars so the LLM can pick the tool)`] };
  }
  if (!parsed.exec || !parsed.exec.trim()) {
    return { tools: [], errors: [`${source.file}: exec is required (command template with {param} placeholders)`] };
  }
  // 目录名与工具名同构：~/.pure/tools/<name>/TOOL.json。
  if (!dirExists(parsed.name)) {
    return { tools: [], errors: [`${source.file}: tool directory "~/.pure/tools/${parsed.name}/" not found (name must match the directory)`] };
  }

  const declared = new Set((parsed.tags ?? []).filter((t) => typeof t === 'string'));
  const tags: string[] = [Tags.SHELL, Tags.EXTERNAL];
  if (declared.has(Tags.WRITE)) tags.push(Tags.WRITE);
  if (declared.has(Tags.DESTRUCTIVE)) tags.push(Tags.DESTRUCTIVE);
  if (declared.has(Tags.READ)) tags.push(Tags.READ);

  const timeoutMs = typeof parsed.timeoutMs === 'number'
    ? Math.min(MAX_TIMEOUT_MS, Math.max(MIN_TIMEOUT_MS, Math.floor(parsed.timeoutMs)))
    : DEFAULT_TIMEOUT_MS;

  const tool: TaggedTool = {
    name: parsed.name,
    description: parsed.description.trim(),
    input_schema: parsed.input_schema ?? { type: 'object', properties: {}, required: [] },
    tags,
    riskLevel: parsed.riskLevel ?? 'medium',
  };
  return { tools: [tool], errors };
}

/** 批量编译：逐文件独立（坏文件不拖垮整批），名字先到先得。 */
export function compileExternalTools(
  sources: Array<{ file: string; text: string }>,
  dirExists: (name: string) => boolean,
): ExternalToolCompileResult {
  const tools: TaggedTool[] = [];
  const errors: string[] = [];
  const seen = new Set<string>();
  for (const source of sources.sort((a, b) => a.file.localeCompare(b.file))) {
    const result = compileExternalTool(source, dirExists);
    errors.push(...result.errors);
    for (const tool of result.tools) {
      if (seen.has(tool.name)) {
        errors.push(`${source.file}: duplicate name "${tool.name}" — first one wins`);
        continue;
      }
      seen.add(tool.name);
      tools.push(tool);
    }
  }
  return { tools, errors };
}

// ── 执行适配器 ──
// 把外部工具调用翻译成 execute_command 调用，经宿主 ToolAdapter 执行——
// 权限门/超时/取消/输出格式全部走 execute_command 既有体系（设计立场 3：
// 不新建安全面）。

export interface ExternalToolExec {
  name: string;
  exec: string;
  timeoutMs: number;
}

/** `{param}` 替换：输入参数的字符串值嵌入命令。非字符串的 String() 化。
 *  未知占位符原样保留（命令自己的 shell 变量语法 `{}` 不受影响——只匹配
 *  已知参数名）。 */
export function substituteExec(exec: string, args: Record<string, unknown>): string {
  return exec.replace(/\{([a-zA-Z_][a-zA-Z0-9_]*)\}/g, (whole, key: string) => {
    if (!(key in args)) return whole;
    const v = args[key];
    return typeof v === 'string' ? v : String(v);
  });
}

export function toolCallToCommand(
  exec: string,
  toolCallId: string,
  args: Record<string, unknown>,
): { id: string; command: string } {
  return { id: toolCallId, command: substituteExec(exec, args) };
}
