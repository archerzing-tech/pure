// src/harness/toolSolidification.ts
// 阶段 13.4 part 2 — procedure → 工具固化流（生成半边）。
//
// 设计文档 capability-self-extension-design.md §13.4：
//   procedure 复用 ≥ 2 次 → 建议卡「固化成工具？」（用户点头才动手）→
//   模型起草 TOOL.json + 脚本 → **试跑**（按 input_schema 造样例参数跑一遍，
//   成功才算起草完成）→ 注册（下一会话生效）。
//
// 纪律（与 13.2 生成半边同款）：
//   - 草稿必须过 P2-1 的同一编译器（compileExternalTools）
//   - 试跑成功才算起草完成（失败退回重写，最多 2 次）
//   - 绝不静默落盘：确认弹窗（或 sleep-time 同意缝）
//   - 执行复用 execute_command 信任模型（不新建安全面）
//
// 本模块纯逻辑（LLM / IO / execute 全注入）——宿主绑定 adapter 和工具面，
// 测试全 fake。写盘缝（Rust write_file / node:fs）与宿主确认缝由调用方注入。

import { compileExternalTools } from './externalTools';
import type { MemoryEntry } from '../shared/types';
import type { LLMAdapter } from '../shared/types';

/** 建议阈值：procedure 检索命中 ≥ 此数才有固化建议资格。 */
export const SOLIDIFY_MIN_REUSES = 2;

/** 起草超时（与 overlay 起草同档：LLM 写一份 TOOL.json 不需要更久）。 */
const DRAFT_TIMEOUT_MS = 60_000;

/** 试跑重试上限：一次失败退回重写，两次都失败放弃（出卡说明原因）。 */
export const MAX_DRAFT_ATTEMPTS = 2;

// ── ① 检测：哪些 procedure 值得固化 ──

export interface SolidifyCandidate {
  procedureId: string;
  content: string;
  hitCount: number;
}

/** 从记忆库里挑出复用够多的 procedure（纯函数，宿主把 list() 结果喂进来）。 */
export function findSolidifyCandidates(entries: readonly MemoryEntry[]): SolidifyCandidate[] {
  return entries
    .filter((e) => e.type === 'procedure' && (e.hitCount ?? 0) >= SOLIDIFY_MIN_REUSES && e.lifecycle !== 'dormant')
    .map((e) => ({ procedureId: e.id, content: e.content, hitCount: e.hitCount ?? 0 }))
    .sort((a, b) => b.hitCount - a.hitCount);
}

// ── ② 起草：LLM 写 TOOL.json ──

const DRAFT_SYSTEM_PROMPT = `You convert a reusable procedure into a TOOL.json manifest for a CLI tool. Output ONLY valid JSON (no markdown fences, no explanation).

The JSON must have these fields:
- name: lowercase_with_underscores, 2-64 chars (becomes the function-call name)
- description: what the tool does, ≥8 chars (the LLM reads this to pick the tool)
- exec: the shell command template; use {param_name} placeholders for input parameters
- input_schema: JSON Schema object with "properties" and "required"

Rules:
- The exec must be a SINGLE shell command that can run standalone (no multi-line scripts in v1).
- Every {placeholder} in exec must appear in input_schema.properties.
- Test the command mentally: substituting reasonable values should produce a valid, runnable command.
- If the procedure cannot be expressed as a single shell command, output the single word: NONE`;

export function buildSolidifyPrompt(procedure: SolidifyCandidate): string {
  return [
    `PROCEDURE (retrieved ${procedure.hitCount} times — worth solidifying into a reusable tool):`,
    procedure.content.slice(0, 2000),
  ].join('\n\n');
}

export interface ToolDraft {
  name: string;
  description: string;
  exec: string;
  input_schema: Record<string, unknown>;
}

/** 解析 LLM 回复为 ToolDraft。NONE / 坏 JSON / 缺字段 → undefined。 */
export function parseToolDraft(reply: string): ToolDraft | undefined {
  const text = reply.trim().replace(/^```[a-zA-Z]*\n?/, '').replace(/\n?```$/, '').trim();
  if (!text || text === 'NONE') return undefined;
  try {
    const parsed = JSON.parse(text) as Partial<ToolDraft>;
    if (typeof parsed.name !== 'string' || typeof parsed.description !== 'string' || typeof parsed.exec !== 'string') {
      return undefined;
    }
    if (!parsed.input_schema || typeof parsed.input_schema !== 'object') return undefined;
    return {
      name: parsed.name,
      description: parsed.description,
      exec: parsed.exec,
      input_schema: parsed.input_schema as Record<string, unknown>,
    };
  } catch {
    return undefined;
  }
}

// ── ③ 编译校验（P2-1 同一编译器）──

export function draftPassesCompiler(draft: ToolDraft): boolean {
  const manifest = JSON.stringify({
    version: 1,
    name: draft.name,
    description: draft.description,
    exec: draft.exec,
    input_schema: draft.input_schema,
  });
  const { tools, errors } = compileExternalTools([{ file: `${draft.name}/TOOL.json`, text: manifest }], () => true);
  return tools.length === 1 && errors.length === 0;
}

// ── ④ 试跑：按 input_schema 造样例参数跑一遍 ──

/** 从 input_schema 的 properties 里造一组样例参数（每个类型一个合理值）。 */
export function sampleArgsFromSchema(schema: Record<string, unknown>): Record<string, unknown> {
  const props = (schema.properties ?? {}) as Record<string, { type?: string; default?: unknown; enum?: unknown[] }>;
  const required = Array.isArray(schema.required) ? (schema.required as string[]) : Object.keys(props);
  const args: Record<string, unknown> = {};
  for (const key of required) {
    const prop = props[key];
    if (!prop) continue;
    if (prop.default !== undefined) {
      args[key] = prop.default;
    } else if (Array.isArray(prop.enum) && prop.enum.length > 0) {
      args[key] = prop.enum[0];
    } else {
      switch (prop.type) {
        case 'number':
        case 'integer':
          args[key] = 1;
          break;
        case 'boolean':
          args[key] = true;
          break;
        default:
          args[key] = 'test';
      }
    }
  }
  return args;
}

export interface SolidifyIo {
  /** 跑一条命令（试跑用；宿主接 execute_command 或 Bun.spawn）。 */
  runCommand(command: string, timeoutMs: number): Promise<{ ok: boolean; output: string }>;
  /** 写盘（宿主接 Rust write_file 或 node:fs）。 */
  writeToolDir(name: string, manifest: string): Promise<void>;
  /** 目标工具目录是否已存在（同名不覆盖）。 */
  toolExists(name: string): Promise<boolean>;
}

export type SolidifyOutcome =
  | { kind: 'written'; name: string }
  | { kind: 'none' }        // 模型拒绝（不适合做工具）
  | { kind: 'invalid'; reason: string }
  | { kind: 'test_failed'; reason: string }
  | { kind: 'exists' }
  | { kind: 'cancelled' };

/**
 * 完整固化流：起草 → 编译校验 → 试跑 → 写盘。每步失败返回明确的 outcome。
 * 起草失败重试（≤ MAX_DRAFT_ATTEMPTS）；试跑失败也重试（换一版草稿）。
 */
export async function runSolidifyFlow(
  input: {
    procedure: SolidifyCandidate;
    llm: LLMAdapter;
    io: SolidifyIo;
    /** 用户确认缝（GUI 弹窗 / sleep-time 自动允许）。返回 false = 取消。 */
    confirm: (info: { name: string; description: string; exec: string }) => Promise<boolean>;
    signal?: AbortSignal;
  },
): Promise<SolidifyOutcome> {
  let draft: ToolDraft | undefined;
  let lastError = '';

  for (let attempt = 1; attempt <= MAX_DRAFT_ATTEMPTS; attempt++) {
    // ① 起草
    let reply: string;
    try {
      const result = await Promise.race([
        input.llm.complete(
          [
            { role: 'system', content: DRAFT_SYSTEM_PROMPT },
            { role: 'user', content: buildSolidifyPrompt(input.procedure) },
          ],
          [],
          input.signal,
        ),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error(`draft timed out after ${DRAFT_TIMEOUT_MS}ms`)), DRAFT_TIMEOUT_MS)),
      ]);
      reply = result.content;
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
      continue;
    }

    draft = parseToolDraft(reply);
    if (!draft) {
      lastError = 'model declined or produced unparseable JSON';
      continue;
    }

    // ② 编译校验
    if (!draftPassesCompiler(draft)) {
      lastError = `draft failed compiler validation (name="${draft.name}")`;
      draft = undefined;
      continue;
    }

    // ③ 试跑：造样例参数跑一遍
    const sampleArgs = sampleArgsFromSchema(draft.input_schema);
    const testCommand = draft.exec.replace(/\{([a-zA-Z_][a-zA-Z0-9_]*)\}/g, (whole, key: string) => {
      if (!(key in sampleArgs)) return whole;
      return String(sampleArgs[key]);
    });
    const testResult = await input.io.runCommand(testCommand, 10_000);
    if (!testResult.ok) {
      lastError = `test run failed: ${testResult.output.slice(0, 200)}`;
      draft = undefined;
      continue;
    }

    break; // 起草 + 校验 + 试跑全部通过
  }

  if (!draft) {
    if (lastError.includes('declined')) return { kind: 'none' };
    if (lastError.includes('test run failed')) return { kind: 'test_failed', reason: lastError };
    return { kind: 'invalid', reason: lastError };
  }

  // ④ 同名不覆盖
  if (await input.io.toolExists(draft.name)) return { kind: 'exists' };

  // ⑤ 确认 + 写盘
  const ok = await input.confirm({ name: draft.name, description: draft.description, exec: draft.exec });
  if (!ok) return { kind: 'cancelled' };

  const manifest = `${JSON.stringify({
    version: 1,
    name: draft.name,
    description: draft.description,
    exec: draft.exec,
    input_schema: draft.input_schema,
  }, null, 2)}\n`;
  try {
    await input.io.writeToolDir(draft.name, manifest);
  } catch (err) {
    return { kind: 'invalid', reason: err instanceof Error ? err.message : String(err) };
  }
  return { kind: 'written', name: draft.name };
}
