// src/shared/schemaSanitize.ts
// Wire-side JSON Schema sanitizer: strips `pattern` constructs the endpoint's
// regex dialect rejects before the tool list ships with a request.
// 为什么存在（2026-11-01 判例）：一个 MCP server 上报的工具 schema 带了
// `"pattern": "^[^=\0]+$"`，端点的严格 schema 校验不认 `\0`（NUL 转义不在其
// 正则方言里），整个请求 400 Invalid schema for function。工具清单随每个请求
// 整体发送——一个坏 schema 打死的不是那个工具，而是整个会话的每个回合，模型
// 改什么都无效。剥掉 pattern 只是少一层客户端校验：server 执行时仍会自行校验
// 参数（降级为一个可控的工具级失败），换来的是会话不再被连坐。

/** Regex constructs the strict endpoint validators reject. Character classes
 *  like [^\0=] read fine in ECMA-262 but the wire-side dialect (and several
 *  strict schema validators) rejects: \0-\9 escapes (NUL / backreferences),
 *  and lookarounds. A real NUL character (JSON \u0000 after parsing) is the
 *  same family. */
const UNSUPPORTED_REGEX_CONSTRUCTS = /\\[0-9]|\(\?<?[=!]/;

export function schemaPatternNeedsStrip(pattern: string): boolean {
  return UNSUPPORTED_REGEX_CONSTRUCTS.test(pattern) || pattern.includes('\u0000');
}

function sanitizeNode(node: unknown): boolean {
  if (Array.isArray(node)) {
    let touched = false;
    for (const item of node) touched = sanitizeNode(item) || touched;
    return touched;
  }
  if (!node || typeof node !== 'object') return false;
  const obj = node as Record<string, unknown>;
  let touched = false;
  if (typeof obj.pattern === 'string' && schemaPatternNeedsStrip(obj.pattern)) {
    delete obj.pattern;
    touched = true;
  }
  // patternProperties 的键也是正则——坏键整条删掉（该组属性不再受校验），
  // 删空后连同空壳字段一起移除，别给端点留一个空对象。
  if (obj.patternProperties && typeof obj.patternProperties === 'object' && !Array.isArray(obj.patternProperties)) {
    const props = obj.patternProperties as Record<string, unknown>;
    for (const key of Object.keys(props)) {
      if (schemaPatternNeedsStrip(key)) {
        delete props[key];
        touched = true;
      }
    }
    if (Object.keys(props).length === 0) {
      delete obj.patternProperties;
    }
  }
  for (const value of Object.values(obj)) touched = sanitizeNode(value) || touched;
  return touched;
}

/** Deep-sanitize one tool schema in place; returns true when anything was
 *  stripped. Mutates the input — pass a clone if the original must survive. */
export function sanitizeToolSchemaInPlace(schema: unknown): boolean {
  return sanitizeNode(schema);
}

/** Copy-sanitize: returns the schema unchanged (same reference) when it is
 *  already clean — the hot path for every request — or a sanitized clone. */
export function sanitizeToolSchema<T>(schema: T): T {
  if (!schema || typeof schema !== 'object') return schema;
  const clone = structuredClone(schema);
  return sanitizeNode(clone) ? (clone as T) : schema;
}

function stripAllNode(node: unknown): void {
  if (Array.isArray(node)) {
    node.forEach(stripAllNode);
    return;
  }
  if (!node || typeof node !== 'object') return;
  const obj = node as Record<string, unknown>;
  delete obj.pattern;
  delete obj.patternProperties;
  for (const value of Object.values(obj)) stripAllNode(value);
}

/** Copy-sanitize at full strength: every `pattern` / `patternProperties`
 *  hint removed. Used by the engine's schema-rejection self-heal — after the
 *  endpoint rejected a bundled schema, the resend carries no regex at all,
 *  because the wire-side validator may reject constructions our blacklist
 *  doesn't model. */
export function stripAllPatterns<T>(schema: T): T {
  if (!schema || typeof schema !== 'object') return schema;
  const clone = structuredClone(schema);
  stripAllNode(clone);
  return clone;
}

/** Sanitize a tool-definition list for the wire. Returns the same array when
 *  every schema is clean (zero-copy fast path); otherwise rebuilt copies with
 *  the offending `pattern` fields stripped. */
export function sanitizeToolDefs<T extends { input_schema?: unknown }>(defs: T[]): T[] {
  let dirty = false;
  for (const def of defs) {
    if (def.input_schema && typeof def.input_schema === 'object' && sanitizeNode(def.input_schema)) {
      dirty = true;
    }
  }
  return dirty ? [...defs] : defs;
}
