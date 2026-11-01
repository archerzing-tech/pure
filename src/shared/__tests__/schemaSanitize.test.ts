// src/shared/__tests__/schemaSanitize.test.ts
// Wire-side schema sanitization — 2026-11-01 rea 判例：一个 MCP 工具 schema
// 里的 `"pattern": "^[^=\0]+$"` 被严格校验端点拒收，整个请求 400，会话每个
// 回合连坐。清洗器的契约：剥掉端点正则方言实测拒收的构造，保留实测通过的。

import { describe, expect, it } from 'bun:test';
import {
  sanitizeToolDefs,
  sanitizeToolSchema,
  sanitizeToolSchemaInPlace,
  schemaPatternNeedsStrip,
} from '../schemaSanitize';

describe('schemaPatternNeedsStrip', () => {
  it('strips the digit-escape family the strict validators reject (field-proven \\0 form)', () => {
    expect(schemaPatternNeedsStrip('^[^=\\0]+$')).toBe(true);
    expect(schemaPatternNeedsStrip('^\\d+$')).toBe(false); // \d 不是数字转义
    expect(schemaPatternNeedsStrip('\\1')).toBe(true); // 反向引用
  });

  it('keeps the hex-NUL form rea 6.7.0 actually ships (accepted by GLM/deepseek/openrouter, verified live)', () => {
    expect(schemaPatternNeedsStrip('^[^\\x00]*$')).toBe(false);
    // rea 的嵌套自动机（排除 REA_RUN_ID 保留前缀）必须原样通过。
    const nested = '^(?:[^=\\x00R][^=\\x00]*|R(?:[^=\\x00E][^=\\x00]*|E(?:[^=\\x00A][^=\\x00]*|A(?:[^=\\x00_][^=\\x00]*|_(?:[^=\\x00R][^=\\x00]*|R(?:[^=\\x00U][^=\\x00]*|U(?:[^=\\x00N][^=\\x00]*|N[^=\\x00]+)?)?)?)?)?)?)$';
    expect(schemaPatternNeedsStrip(nested)).toBe(false);
  });

  it('strips lookarounds and real NUL characters', () => {
    expect(schemaPatternNeedsStrip('^(?=foo)')).toBe(true);
    expect(schemaPatternNeedsStrip('(?<=a)b')).toBe(true);
    expect(schemaPatternNeedsStrip('a\u0000b')).toBe(true);
  });
});

describe('sanitizeToolSchema', () => {
  it('returns the same reference for clean schemas (hot path, zero-copy)', () => {
    const clean = { type: 'object', properties: { path: { type: 'string', pattern: '^[^\\x00]*$' } } };
    expect(sanitizeToolSchema(clean)).toBe(clean);
  });

  it('returns a clone with the offending pattern removed, siblings intact', () => {
    const dirty = {
      type: 'object',
      properties: {
        executable: { type: 'string', pattern: '^[^\\x00]*$' },
        key: { type: 'string', pattern: '^[^=\\0]+$' },
      },
    };
    const out = sanitizeToolSchema(dirty) as typeof dirty;
    expect(out).not.toBe(dirty);
    expect(out.properties.key.pattern).toBeUndefined();
    expect(out.properties.executable.pattern).toBe('^[^\\x00]*$'); // 保留
    // 原对象不被改动（copy 语义）
    expect(dirty.properties.key.pattern).toBe('^[^=\\0]+$');
  });

  it('walks nested arrays / oneOf / additionalProperties layers', () => {
    const deep = {
      oneOf: [
        { properties: { session_id: { pattern: '^\\2x' } } },
        { items: { pattern: '^(?!x)' } },
      ],
    } as { oneOf: Array<{ properties?: { session_id?: { pattern?: string } }; items?: { pattern?: string } }> };
    const out = sanitizeToolSchema(deep) as typeof deep;
    expect(out.oneOf[0].properties!.session_id!.pattern).toBeUndefined();
    expect(out.oneOf[1].items!.pattern).toBeUndefined();
  });

  it('drops bad patternProperties keys and removes the emptied shell', () => {
    const dirty = {
      propertyNames: { pattern: '^[^=\\0]+$' },
      patternProperties: {
        '^ok.*': { type: 'string' },
        '^\\0': { type: 'number' },
      },
    };
    const out = sanitizeToolSchema(dirty) as { patternProperties?: Record<string, unknown> };
    expect(out.patternProperties).toEqual({ '^ok.*': { type: 'string' } });
    const allBad = sanitizeToolSchema({ patternProperties: { '^\\0': {} } }) as { patternProperties?: unknown };
    expect('patternProperties' in allBad).toBe(false);
  });
});

describe('sanitizeToolDefs', () => {
  it('passes clean lists through untouched (same array, zero-copy)', () => {
    const defs = [{ name: 'a', input_schema: { pattern: '^[^\\x00]*$' } }, { name: 'b', input_schema: { type: 'object' } }];
    expect(sanitizeToolDefs(defs)).toBe(defs);
  });

  it('strips in place and flags dirtiness only when something matched', () => {
    const bad = { name: 'rea__capture_process_scenario', input_schema: { properties: { environment: { propertyNames: { pattern: '^[^=\\0]+$' } } } } } as unknown as { name: string; input_schema: { properties: { environment: { propertyNames: { pattern?: string } } } } };
    const defs = [bad];
    const out = sanitizeToolDefs(defs as Array<{ name: string; input_schema?: unknown }>);
    expect(bad.input_schema.properties.environment.propertyNames.pattern).toBeUndefined();
    expect(out).not.toBe(defs);
  });
});

describe('sanitizeToolSchemaInPlace', () => {
  it('mutates and reports whether anything was stripped', () => {
    expect(sanitizeToolSchemaInPlace({ pattern: '^[^=\\0]+$' })).toBe(true);
    expect(sanitizeToolSchemaInPlace({ pattern: '^[a-z]+$' })).toBe(false);
    expect(sanitizeToolSchemaInPlace('not an object')).toBe(false);
  });
});
