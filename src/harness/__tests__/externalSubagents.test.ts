// src/harness/__tests__/externalSubagents.test.ts
// 阶段 13.2 (loading half) — declarative role manifests from
// ~/.pure/subagents/*.json compile into SubagentDefinitions. The compiler is
// pure (hosts do the IO), so the whole pipeline is covered here: valid
// manifests, template substitution, built-in protection, and per-file error
// isolation (one broken file never takes down the others).

import { describe, expect, it } from 'bun:test';
import { compileExternalSubagents } from '../externalSubagents';
import { Tags } from '../../coding-agent/ToolRegistry';

const RESERVED = ['code_reviewer', 'task_planner'];

function manifest(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    name: 'ui_designer',
    description: 'Design UI mockups and component layouts for a feature request.',
    systemPrompt: 'You are a UI designer. Task: {task}. Scope: {scope}. Keep {"strict": "json"} examples intact and {unknown_token} literal.',
    ...overrides,
  });
}

describe('compileExternalSubagents (阶段 13.2)', () => {
  it('compiles a valid manifest with the documented defaults', () => {
    const { defs, errors } = compileExternalSubagents([{ file: 'ui.json', text: manifest() }], RESERVED);
    expect(errors).toEqual([]);
    expect(defs).toHaveLength(1);
    const def = defs[0];
    expect(def.name).toBe('ui_designer');
    expect(def.tags).toContain(Tags.AGENT);
    expect(def.tags).toContain(Tags.READ);
    expect(def.riskLevel).toBe('low');
    expect(def.defaultTimeoutMs).toBe(1_800_000);
    // Default schema: one required prompt string, like the built-ins are used.
    expect(def.input_schema.required).toEqual(['prompt']);
    expect(typeof def.createSystemPrompt).toBe('function');
  });

  it('substitutes provided input keys, leaves unprovided tokens and JSON braces intact', () => {
    const { defs } = compileExternalSubagents([{ file: 'ui.json', text: manifest() }], RESERVED);
    const prompt = defs[0].createSystemPrompt({ task: 'login page', scope: undefined });
    expect(prompt).toContain('Task: login page');
    // Unprovided key stays a literal token for the subagent to interpret.
    expect(prompt).toContain('{scope}');
    // Braces that aren't identifier-shaped (JSON examples) pass through.
    expect(prompt).toContain('{"strict": "json"}');
    expect(prompt).toContain('{unknown_token}');
  });

  it('renders structured input values as JSON the subagent can read', () => {
    const { defs } = compileExternalSubagents([{ file: 'ui.json', text: manifest() }], RESERVED);
    const prompt = defs[0].createSystemPrompt({ task: 'login', scope: ['a.ts', 'b.ts'] });
    expect(prompt).toContain('Scope: ["a.ts","b.ts"]');
  });

  it('never lets an external role shadow a built-in', () => {
    const { defs, errors } = compileExternalSubagents(
      [{ file: 'imposter.json', text: manifest({ name: 'code_reviewer' }) }],
      RESERVED,
    );
    expect(defs).toHaveLength(0);
    expect(errors[0]).toContain('code_reviewer');
    expect(errors[0]).toContain('built-in');
  });

  it('isolates a broken file: the rest of the directory still loads', () => {
    const { defs, errors } = compileExternalSubagents(
      [
        { file: 'broken.json', text: '{ not json' },
        { file: 'badversion.json', text: manifest({ version: 99 }) },
        { file: 'badname.json', text: manifest({ name: 'Bad Name!' }) },
        { file: 'empty-desc.json', text: manifest({ description: 'short' }) },
        { file: 'good.json', text: manifest() },
      ],
      RESERVED,
    );
    expect(defs.map((d) => d.name)).toEqual(['ui_designer']);
    expect(errors).toHaveLength(4);
    expect(errors[0]).toContain('broken.json: invalid JSON');
    expect(errors[1]).toContain('unsupported manifest version 99');
    expect(errors[2]).toContain('name must match');
    expect(errors[3]).toContain('description is required');
  });

  it('first file wins on duplicate external names (deterministic by source order)', () => {
    const { defs, errors } = compileExternalSubagents(
      [
        { file: 'a_ui.json', text: manifest({ description: 'First definition wins the name.' }) },
        { file: 'b_ui.json', text: manifest({ description: 'Second definition loses the name.' }) },
      ],
      RESERVED,
    );
    expect(defs).toHaveLength(1);
    expect(defs[0].description).toContain('First');
    expect(errors[0]).toContain('duplicate external role');
  });

  it('honors declared tags, forcing agent and dropping unknown ones', () => {
    const { defs } = compileExternalSubagents(
      [{ file: 'w.json', text: manifest({ tags: ['write', 'shell', 'not_a_tag'] }) }],
      RESERVED,
    );
    expect(defs[0].tags).toEqual([Tags.AGENT, Tags.WRITE, Tags.SHELL]);
  });

  it('clamps timeoutMs into a sane window', () => {
    const { defs } = compileExternalSubagents(
      [
        { file: 'tiny.json', text: manifest({ name: 'tiny_worker', timeoutMs: 10 }) },
        { file: 'huge.json', text: manifest({ name: 'huge_worker', timeoutMs: 99_999_999 }) },
        { file: 'custom.json', text: manifest({ name: 'mid_worker', timeoutMs: 600_000 }) },
      ],
      RESERVED,
    );
    const byName = new Map(defs.map((d) => [d.name, d]));
    expect(byName.get('tiny_worker')!.defaultTimeoutMs).toBe(5_000);
    expect(byName.get('huge_worker')!.defaultTimeoutMs).toBe(3_600_000);
    expect(byName.get('mid_worker')!.defaultTimeoutMs).toBe(600_000);
  });

  it('accepts a custom input_schema and passes it through to the tool surface', () => {
    const schema = {
      type: 'object',
      properties: {
        feature: { type: 'string', description: 'What to design' },
        platform: { type: 'string', enum: ['web', 'desktop'] },
      },
      required: ['feature'],
    };
    const { defs } = compileExternalSubagents(
      [{ file: 'ui.json', text: manifest({ input_schema: schema, systemPrompt: 'Design: {feature} for {platform}. Keep {"strict": true}.' }) }],
      RESERVED,
    );
    expect(defs[0].input_schema).toEqual(schema);
    const prompt = defs[0].createSystemPrompt({ feature: 'settings', platform: 'web' });
    expect(prompt).toContain('Design: settings for web.');
    expect(prompt).toContain('{"strict": true}');
  });
});
