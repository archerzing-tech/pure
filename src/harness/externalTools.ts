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
import type { ToolAdapter, ToolDefinition } from '../shared/types';

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
  /** 逐参数豁免引号（审计批 5② 续刀）：列出的参数原样替换、不加引号。
   *  契约就是「参数 = 一条命令行」的工具（run_with_timeout 的 {command}）
   *  必须声明，否则整条命令被引成一个词；模板自带引号包住占位符的形态
   *  （sed 's|{x}|{y}|g' 的 x/y）不用声明——邻接豁免自动覆盖。 */
  rawParams?: string[];
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
  // rawParams 必须是数组：非数组值（数字/对象）在下面的 for..of 直接抛
  // TypeError，而本函数的契约是「坏文件返回 errors 不抛」——不拦的话一个坏
  // manifest 会经宿主的外层 catch 静默弃掉整批外部工具（终审 P2）。字符串
  // 会被逐字符遍历，同样是错的，一并拦。
  if (parsed.rawParams !== undefined && !Array.isArray(parsed.rawParams)) {
    return { tools: [], errors: [`${source.file}: rawParams must be an array of parameter names`] };
  }
  // rawParams 逐项必须是声明过的参数名：豁免是作者对「这个参数是命令碎片
  // / 已在模板引号里」的显式声明，写错名字等于静默放弃豁免，宁可编译期拦。
  const propertyNames = new Set(Object.keys(parsed.input_schema?.properties ?? {}));
  for (const raw of parsed.rawParams ?? []) {
    if (typeof raw !== 'string' || !propertyNames.has(raw)) {
      return { tools: [], errors: [`${source.file}: rawParams entry "${String(raw)}" is not a declared input_schema property`] };
    }
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
  /** 逐参数引号豁免（manifest 的 rawParams 原样透传）。 */
  rawParams?: string[];
}

const SAFE_BARE_TOKEN = /^[A-Za-z0-9_@%+=:,./-]+$/;

/** 参数值的 shell 安全嵌入（审计批 5②）：裸插值让 `foo; rm -rf /` 这样的
 *  参数值直接成为命令文本。非安全 token 一律加引号——POSIX 用单引号
 *  （`'` → `'\''`），Windows 走 PowerShell 单引号（`'` → `''`；execute_command
 *  的 Windows 面是 powershell -EncodedCommand）。安全 token 保持裸露，让
 *  常见命令与历史逐字节一致。 */
export function shellQuoteValue(value: string): string {
  if (SAFE_BARE_TOKEN.test(value)) return value;
  if (process.platform === 'win32') {
    return `'${value.replace(/'/g, "''")}'`;
  }
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** `{param}` 替换（审计批 5② 续刀收口）：缺省经 shellQuoteValue 嵌入；两类
 *  豁免原样替换——(1) `rawParams` 点名的参数，其契约就是命令碎片（引住即
 *  变单个词，工具必坏）；(2) 模板自带同款引号紧贴占位符两侧的（`"{x}"`、
 *  `'{y}'`），作者是按值逐字进引号里写的，二次引号反而改变行为——这是已
 *  装工具库里的真实形态（check_hello / diagnose_node_*）。非字符串 String()
 *  化；未知占位符原样保留。 */
export function substituteExec(exec: string, args: Record<string, unknown>, rawParams?: ReadonlySet<string>): string {
  return exec.replace(/\{([a-zA-Z_][a-zA-Z0-9_]*)\}/g, (whole, key: string, offset: number, full: string) => {
    if (!(key in args)) return whole;
    const v = typeof args[key] === 'string' ? args[key] as string : String(args[key]);
    const before = offset > 0 ? full[offset - 1] : '';
    const after = full[offset + whole.length] ?? '';
    if (rawParams?.has(key) || (before === after && (before === '"' || before === "'"))) {
      return v;
    }
    return shellQuoteValue(v);
  });
}

export function toolCallToCommand(
  exec: string,
  toolCallId: string,
  args: Record<string, unknown>,
  rawParams?: ReadonlySet<string>,
): { id: string; command: string } {
  return { id: toolCallId, command: substituteExec(exec, args, rawParams) };
}

/** 执行器适配器（CLI 半边）：把外部工具调用翻译成 execute_command 打宿主
 *  传入的 delegate——权限门/超时/取消/输出格式全部走 execute_command 既有
 *  体系（设计立场 3：不新建安全面）。GUI 的执行器住 CodingAgent（带 13.4
 *  停用看门狗的逐次记账），宿主特异性太强不抽共用；这里是同一条翻译链的
 *  无看门狗形态，CLI 装配直接绑进 registry（停用工具在装载层已被
 *  QUARANTINED.json 拦下，执行路不再记第二次账）。 */
export function createExternalToolsCommandExecutor(
  execs: Map<string, ExternalToolExec>,
  delegate: ToolAdapter,
): ToolAdapter {
  return {
    getTools: () => [],
    getMetadata: () => ({ isWrite: false }),
    execute: async (toolCall, signal) => {
      const name = toolCall.function.name;
      const entry = execs.get(name);
      if (!entry) {
        return {
          id: toolCall.id,
          toolName: name,
          error: `External tool "${name}" has no exec template`,
          success: false,
          duration: 0,
        };
      }
      let args: Record<string, unknown>;
      try {
        args = JSON.parse(toolCall.function.arguments || '{}') as Record<string, unknown>;
      } catch {
        args = {};
      }
      // Route as an execute_command call through the same adapter — the
      // permission gate already ran for the tool call itself (Tags.EXTERNAL
      // in the registry), and the adapter's execute_command path handles
      // shell execution, timeout, and output formatting.
      const { command } = toolCallToCommand(entry.exec, toolCall.id, args, entry.rawParams ? new Set(entry.rawParams) : undefined);
      return delegate.execute({
        id: toolCall.id,
        index: toolCall.index,
        function: {
          name: 'execute_command',
          arguments: JSON.stringify({ command, timeout_ms: entry.timeoutMs }),
        },
      }, signal);
    },
  };
}
