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

  // 审计批 5②：裸插值让 `foo; rm -rf /` 这样的参数值直接成为命令文本。
  // 不安全值必须整体引住；安全 token 保持裸露（与历史命令逐字节一致）。
  it('keeps safe tokens bare so common commands stay byte-identical', () => {
    expect(substituteExec('grep {q} {path}', { q: 'error', path: 'src/app.ts' }))
      .toBe('grep error src/app.ts');
  });

  it('quotes an unsafe value so metacharacters stay data, not control', () => {
    const cmd = substituteExec('grep {q} log.txt', { q: 'a; rm -rf /' });
    expect(cmd).toBe(`grep 'a; rm -rf /' log.txt`);
  });

  // 咬合必须咬字面：旧的 round-trip 断言在「根本没引」时是空操作，防不住
  // 回归。POSIX: 'it'\''s here'；PowerShell: 'it''s here'——两种都还原为原值。
  it('escapes embedded single quotes (exact platform form)', () => {
    const cmd = substituteExec('echo {msg}', { msg: "it's here" });
    expect(cmd).toBe(process.platform === 'win32' ? `echo 'it''s here'` : `echo 'it'\\''s here'`);
  });

  // ── 审计批 5② 续刀：两类豁免。全量引号打破了三个真实已装工具——
  // run_with_timeout 的 {command} 契约就是命令行碎片（引住 = 单个词，必坏），
  // check_hello/diagnose_* 的占位符被模板自带引号包住（二次引号改变行为）。
  describe('quoting exemptions', () => {
    it('rawParams bypass quoting — a command-fragment arg stays verbatim', () => {
      expect(substituteExec('{cmd} > /tmp/log & pid=$!', { cmd: 'python3 x.py 10086' }, new Set(['cmd'])))
        .toBe('python3 x.py 10086 > /tmp/log & pid=$!');
    });

    it('without rawParams the same value gets quoted (default stays safe)', () => {
      expect(substituteExec('{cmd}', { cmd: 'echo a b' })).toBe(`'echo a b'`);
    });

    it('a placeholder wrapped in the template quotes substitutes raw (author-quoted forms)', () => {
      expect(substituteExec('[ "{s}" = "hello" ] && echo passed', { s: 'hello world' }))
        .toBe('[ "hello world" = "hello" ] && echo passed');
      expect(substituteExec(`node -e "const f='{file}'"`, { file: '/tmp/my dir/a.js' }))
        .toBe(`node -e "const f='/tmp/my dir/a.js'"`);
    });

    it('mixed: the rawParam stays bare while a plain arg still gets quoted', () => {
      expect(substituteExec('{cmd} {arg}', { cmd: 'echo a', arg: 'a;b' }, new Set(['cmd'])))
        .toBe(`echo a 'a;b'`);
    });

    it('rawParams declared but safe values stay byte-identical', () => {
      expect(substituteExec('grep {q} f', { q: 'err' }, new Set(['q']))).toBe('grep err f');
    });
  });

  it('rawParams entries must reference declared properties', () => {
    const base = {
      name: 'run_with_timeout',
      description: 'Run a command under a hard timeout here',
      input_schema: { type: 'object' as const, properties: { command: { type: 'string' as const } } },
    };
    const ok = compileExternalTool(
      { file: 'rt/TOOL.json', text: JSON.stringify(manifest({ ...base, exec: '{command} & pid=$!', rawParams: ['command'] })) },
      alwaysDir,
    );
    expect(ok.errors).toEqual([]);
    const bad = compileExternalTool(
      { file: 'rt/TOOL.json', text: JSON.stringify(manifest({ ...base, exec: '{command} &', rawParams: ['cmmand'] })) },
      alwaysDir,
    );
    expect(bad.errors[0]).toMatch(/rawParams entry "cmmand" is not a declared input_schema property/);
  });

  // 终审 P2：非数组 rawParams（JSON 侧无类型护栏）在 for..of 直接抛
  // TypeError 且无人承接——宿主外层 catch 会静默弃掉整批外部工具。必须降级
  // 成 per-file error，守住「坏文件不拖垮整批」。
  it('a non-array rawParams degrades to a per-file error, not a thrown batch-killer', () => {
    const base = { name: 'rt_malformed', description: 'Raw params malformed here', exec: '{command}' };
    for (const bad of [5, true, { command: true }, 'command']) {
      const { tools, errors } = compileExternalTool(
        { file: 'rtbad/TOOL.json', text: JSON.stringify(manifest({ ...base, rawParams: bad as unknown as string[] })) },
        alwaysDir,
      );
      expect(tools).toEqual([]);
      expect(errors[0]).toMatch(/rawParams must be an array/);
    }
  });
});
