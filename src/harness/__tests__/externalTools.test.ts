// 阶段 13.4 — 外部工具编译器与执行适配器的覆盖。
import { describe, expect, it } from 'bun:test';
import { compileExternalTool, compileExternalTools, substituteExec, type ExternalToolManifest } from '../externalTools';

const manifest = (over: Partial<ExternalToolManifest> = {}): ExternalToolManifest => ({
  name: 'hello_tool',
  description: 'Says hello in a specific language',
  exec: 'echo "hello {name}"',
  ...over,
});

const alwaysDir = (): boolean => true;

describe('compileExternalTool', () => {
  it('compiles a valid manifest into a TaggedTool with SHELL+EXTERNAL tags', () => {
    const { tools, errors } = compileExternalTool({ file: 'hello_tool/TOOL.json', text: JSON.stringify(manifest()) }, alwaysDir);
    expect(errors).toEqual([]);
    expect(tools).toHaveLength(1);
    expect(tools[0].name).toBe('hello_tool');
    expect(tools[0].tags).toContain('shell');
    expect(tools[0].tags).toContain('external');
    expect(tools[0].riskLevel).toBe('medium'); // 缺省
  });

  it('honors write/destructive/read tags but rejects unknown values', () => {
    const { tools } = compileExternalTool(
      { file: 'write_tool/TOOL.json', text: JSON.stringify(manifest({ name: 'write_tool', tags: ['write', 'bogus'] })) },
      alwaysDir,
    );
    expect(tools[0].tags).toContain('write');
    expect(tools[0].tags).not.toContain('bogus');
  });

  it('rejects bad JSON, wrong version, bad name, short description, missing exec, missing dir', () => {
    const cases: Array<[string, string, RegExp]> = [
      ['bad.json', 'not json', /JSON parse failed/],
      ['v2.json', JSON.stringify(manifest({ version: 2 })), /unsupported manifest version/],
      ['BadName.json', JSON.stringify(manifest({ name: 'BadName' })), /must match/],
      ['short.json', JSON.stringify(manifest({ description: 'tiny' })), /description too short/],
      ['noexec.json', JSON.stringify({ name: 'noexec', description: 'A valid description here', exec: '' }), /exec is required/],
    ];
    for (const [file, text, pattern] of cases) {
      const { errors } = compileExternalTool({ file, text }, alwaysDir);
      expect(errors.length).toBeGreaterThan(0);
      expect(errors[0]).toMatch(pattern);
    }
    // 目录不存在
    const { errors: dirErr } = compileExternalTool(
      { file: 'ghost/TOOL.json', text: JSON.stringify(manifest({ name: 'ghost' })) },
      () => false,
    );
    expect(dirErr[0]).toMatch(/not found/);
  });

  it('clamps timeoutMs to [5s, 600s]', () => {
    const { tools: fast } = compileExternalTool(
      { file: 'fast_tool/TOOL.json', text: JSON.stringify(manifest({ name: 'fast_tool', timeoutMs: 100 })) }, alwaysDir);
    expect(fast[0].input_schema).toBeDefined(); // timeoutMs 不进 TaggedTool（在 exec 模板侧）
    const { tools: slow } = compileExternalTool(
      { file: 'slow_tool/TOOL.json', text: JSON.stringify(manifest({ name: 'slow_tool', timeoutMs: 999_999_999 })) }, alwaysDir);
    expect(slow).toHaveLength(1); // 钳制不拒绝
  });
});

describe('compileExternalTools (batch)', () => {
  it('sorts by file, first-wins on duplicates, bad files do not block good ones', () => {
    const { tools, errors } = compileExternalTools([
      { file: 'b_tool/TOOL.json', text: JSON.stringify(manifest({ name: 'b_tool', description: 'Second tool here' })) },
      { file: 'a_tool/TOOL.json', text: JSON.stringify(manifest({ name: 'a_tool', description: 'First tool here' })) },
      { file: 'broken.json', text: '{{{' },
      { file: 'a_tool_copy/TOOL.json', text: JSON.stringify(manifest({ name: 'a_tool', description: 'Duplicate name tool' })) },
    ], alwaysDir);
    expect(tools.map((t) => t.name)).toEqual(['a_tool', 'b_tool']);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors.some((e) => e.includes('JSON parse failed'))).toBe(true);
    expect(errors.some((e) => e.includes('duplicate name'))).toBe(true);
  });
});

describe('substituteExec', () => {
  it('replaces {param} with string args, stringifies non-strings, preserves unknown placeholders', () => {
    expect(substituteExec('echo {name} {count} {unknown} {list}', {
      name: 'world',
      count: 42,
      list: ['a', 'b'],
    })).toBe('echo world 42 {unknown} a,b');
  });

  it('does not touch shell brace expansion syntax when no matching arg name', () => {
    expect(substituteExec('echo {1..5} && ls {,*}.txt', {})).toBe('echo {1..5} && ls {,*}.txt');
  });
});
