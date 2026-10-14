// src/__tests__/cliExternalTools.test.ts
// 阶段 13.4 CLI 半边 — ~/.pure/tools 外部脚本工具经 createTools 装载的真跑覆盖。
// 此前只有 GUI（Tauri invoke）装载，CLI 完全不载，同一份 TOOL.json 两端能力面
// 不一致；这里把「注册成功、模型可见、执行翻译、坏文件不崩、停用门」逐条锁死。
// import cliHarness 有模块级副作用（观察 sink mkdir ~/.pure/observations），
// 干净可容忍（cliPersonaOverlays.test.ts 同款）；临时目录经 PURE_TOOLS_DIR 注入，
// 绝不读写真实的 ~/.pure/tools。
import { describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTools, loadCliExternalTools } from '../cliHarness';
import { createExternalToolsCommandExecutor } from '../harness/externalTools';
import { ToolRegistry } from '../coding-agent/ToolRegistry';
import type { ToolAdapter, ToolCall, ToolResult } from '../shared/types';

const HELLO = {
  name: 'hello_tool',
  description: 'Says hello to someone by name',
  exec: 'echo "hello {name}"',
  input_schema: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] },
};

/** 在临时工具根目录落一个 <name>/TOOL.json（可选 QUARANTINED.json 停用标记）。 */
function seedTool(root: string, name: string, manifest: object | string, marker?: object): void {
  mkdirSync(join(root, name), { recursive: true });
  writeFileSync(join(root, name, 'TOOL.json'), typeof manifest === 'string' ? manifest : JSON.stringify(manifest), 'utf8');
  if (marker) writeFileSync(join(root, name, 'QUARANTINED.json'), JSON.stringify(marker), 'utf8');
}

/** env 注入式装载（与 cliPersonaOverlays.test.ts 的 loadWith 同款，测完还原）。 */
function loadWith(dir: string, evolutionEnabled = true) {
  const prev = process.env.PURE_TOOLS_DIR;
  process.env.PURE_TOOLS_DIR = dir;
  try {
    return loadCliExternalTools(evolutionEnabled);
  } finally {
    if (prev === undefined) delete process.env.PURE_TOOLS_DIR;
    else process.env.PURE_TOOLS_DIR = prev;
  }
}

function stubDelegate(): ToolAdapter & { calls: ToolCall[] } {
  const calls: ToolCall[] = [];
  return {
    calls,
    getTools: () => [],
    getMetadata: () => undefined,
    execute: async (toolCall: ToolCall): Promise<ToolResult> => {
      calls.push(toolCall);
      return { id: toolCall.id, toolName: toolCall.function.name, result: 'ran', success: true, duration: 1 };
    },
  };
}

function toolCall(name: string, args: Record<string, unknown>): ToolCall {
  return { id: `test_${name}`, index: 0, function: { name, arguments: JSON.stringify(args) } };
}

describe('loadCliExternalTools（13.4 CLI 装载）', () => {
  it('有效 TOOL.json 装载为 TaggedTool（SHELL+EXTERNAL）并带 exec 模板', () => {
    const home = mkdtempSync(join(tmpdir(), 'pure-cli-tools-'));
    try {
      seedTool(home, 'hello_tool', HELLO);
      const { tools, execs } = loadWith(home);
      expect(tools).toHaveLength(1);
      expect(tools[0].name).toBe('hello_tool');
      expect(tools[0].tags).toContain('shell');
      expect(tools[0].tags).toContain('external');
      const entry = execs.get('hello_tool');
      expect(entry?.exec).toBe('echo "hello {name}"');
      expect(entry?.timeoutMs).toBe(120_000); // 缺省墙钟
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('无目录与空目录安静跳过（返回空，不抛）', () => {
    const home = mkdtempSync(join(tmpdir(), 'pure-cli-tools-'));
    try {
      expect(loadWith(join(home, 'missing'))).toEqual({ tools: [], execs: new Map() });
      const empty = join(home, 'empty');
      mkdirSync(empty, { recursive: true });
      expect(loadWith(empty)).toEqual({ tools: [], execs: new Map() });
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('坏 TOOL.json 跳过不崩，好工具照常装载', () => {
    const home = mkdtempSync(join(tmpdir(), 'pure-cli-tools-'));
    try {
      seedTool(home, 'hello_tool', HELLO);
      seedTool(home, 'broken_tool', '{{{ not json');
      const { tools, execs } = loadWith(home);
      expect(tools.map((t) => t.name)).toEqual(['hello_tool']);
      expect(execs.has('hello_tool')).toBe(true);
      expect(execs.has('broken_tool')).toBe(false);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('QUARANTINED.json 标记停用的工具不装载，未停用的计数标记不拦', () => {
    const home = mkdtempSync(join(tmpdir(), 'pure-cli-tools-'));
    try {
      seedTool(home, 'hello_tool', HELLO);
      seedTool(home, 'stopped_tool', { ...HELLO, name: 'stopped_tool', description: 'A stopped external tool' }, { quarantined: true, reason: 'kept failing' });
      seedTool(home, 'counted_tool', { ...HELLO, name: 'counted_tool', description: 'A counted external tool' }, { consecutiveFailures: 1 });
      const { tools } = loadWith(home);
      const names = tools.map((t) => t.name);
      expect(names).toContain('hello_tool');
      expect(names).toContain('counted_tool'); // 只有计数 = 还没停
      expect(names).not.toContain('stopped_tool'); // 停用是盘上事实，两端同停
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('进化总开关关闭时不装载（与 GUI 的 skills.evolution===false 同一刀）', () => {
    const home = mkdtempSync(join(tmpdir(), 'pure-cli-tools-'));
    try {
      seedTool(home, 'hello_tool', HELLO);
      expect(loadWith(home, false)).toEqual({ tools: [], execs: new Map() });
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe('createExternalToolsCommandExecutor（执行翻译）', () => {
  const execs = new Map([
    ['hello_tool', { name: 'hello_tool', exec: 'echo "hello {name}"', timeoutMs: 120_000 }],
    ['raw_tool', { name: 'raw_tool', exec: '{cmd} --quiet', timeoutMs: 60_000, rawParams: ['cmd'] }],
  ]);

  it('翻译成 execute_command：模板替换 + timeout_ms 透传 + 结果原样返回', async () => {
    const delegate = stubDelegate();
    const executor = createExternalToolsCommandExecutor(execs, delegate);
    const result = await executor.execute(toolCall('hello_tool', { name: 'world' }));
    expect(delegate.calls).toHaveLength(1);
    const routed = delegate.calls[0];
    expect(routed.function.name).toBe('execute_command');
    const args = JSON.parse(routed.function.arguments) as { command: string; timeout_ms: number };
    // 模板自带引号包住占位符 = 作者按值逐字写的形态，二次引号反而改行为。
    expect(args.command).toBe('echo "hello world"');
    expect(args.timeout_ms).toBe(120_000);
    expect(result.success).toBe(true);
    expect(result.id).toBe('test_hello_tool'); // toolCallId 一路透传
  });

  it('rawParams 豁免原样替换；无豁免的值照旧加引号', async () => {
    const delegate = stubDelegate();
    const executor = createExternalToolsCommandExecutor(execs, delegate);
    await executor.execute(toolCall('raw_tool', { cmd: 'echo a;b' }));
    const raw = JSON.parse(delegate.calls[0].function.arguments) as { command: string };
    expect(raw.command).toBe('echo a;b --quiet'); // 命令碎片，引住即坏
  });

  it('未知工具名返回失败结果，不触 delegate', async () => {
    const delegate = stubDelegate();
    const executor = createExternalToolsCommandExecutor(execs, delegate);
    const result = await executor.execute(toolCall('ghost_tool', {}));
    expect(result.success).toBe(false);
    expect(result.error).toContain('no exec template');
    expect(delegate.calls).toHaveLength(0);
  });

  it('坏 JSON 参数按空对象处理，未知占位符原样保留', async () => {
    const delegate = stubDelegate();
    const executor = createExternalToolsCommandExecutor(execs, delegate);
    const result = await executor.execute({ id: 't1', index: 0, function: { name: 'hello_tool', arguments: 'not json' } });
    expect(result.success).toBe(true);
    const args = JSON.parse(delegate.calls[0].function.arguments) as { command: string };
    expect(args.command).toBe('echo "hello {name}"');
  });
});

describe('createTools CLI 装配（真跑）', () => {
  it('TOOL.json fixture 经 CLI 路注册成功并进入模型可见清单', async () => {
    const home = mkdtempSync(join(tmpdir(), 'pure-cli-tools-'));
    const ws = mkdtempSync(join(tmpdir(), 'pure-cli-ws-'));
    const prev = process.env.PURE_TOOLS_DIR;
    process.env.PURE_TOOLS_DIR = home;
    try {
      seedTool(home, 'hello_tool', HELLO);
      const created = await createTools(ws, true, 'session_ext');
      expect(created.tools).toBeInstanceOf(ToolRegistry);
      const registry = created.tools as ToolRegistry;
      // workspace 模式的模型清单 = registry.getTools() + getSubagentTools()
      //（createHarness 末尾重算），EXTERNAL 开口开后这里必须看得见。
      const names = registry.getTools().map((t) => t.name);
      expect(names).toContain('hello_tool');
      expect(registry.getTags('hello_tool')).toContain('external');
    } finally {
      if (prev === undefined) delete process.env.PURE_TOOLS_DIR;
      else process.env.PURE_TOOLS_DIR = prev;
      rmSync(home, { recursive: true, force: true });
      rmSync(ws, { recursive: true, force: true });
    }
  });

  it('CLI 路执行真通：registry 调外部工具翻译成 execute_command 跑出结果', async () => {
    const home = mkdtempSync(join(tmpdir(), 'pure-cli-tools-'));
    const ws = mkdtempSync(join(tmpdir(), 'pure-cli-ws-'));
    const prev = process.env.PURE_TOOLS_DIR;
    process.env.PURE_TOOLS_DIR = home;
    try {
      seedTool(home, 'hello_tool', HELLO);
      const created = await createTools(ws, true, 'session_ext_run');
      const registry = created.tools as ToolRegistry;
      const result = await registry.execute(toolCall('hello_tool', { name: 'cli world' }));
      // 真跑失败时把执行器的原始报错打出来（Windows CI 的 ENOENT 现场只在
      // 日志里看得见，expect 的 true/false 不够定位）。
      if (!result.success) console.error('[diag] execute_command failed:', result.error, JSON.stringify(result.result));
      expect(result.success).toBe(true);
      // 带空格的参数值不是安全裸 token，翻译层加单引号（审计批 5② 契约），
      // echo 原样回显引号。
      // NodeToolAdapter 的 execute_command 结果是 { stdout, stderr, exitCode }。
      const payload = result.result as { stdout?: string };
      expect(payload.stdout).toContain(`hello 'cli world'`);
    } finally {
      if (prev === undefined) delete process.env.PURE_TOOLS_DIR;
      else process.env.PURE_TOOLS_DIR = prev;
      rmSync(home, { recursive: true, force: true });
      rmSync(ws, { recursive: true, force: true });
    }
  });

  it('坏 TOOL.json 与内建同名冲突都不崩，且不顶掉内建', async () => {
    const home = mkdtempSync(join(tmpdir(), 'pure-cli-tools-'));
    const ws = mkdtempSync(join(tmpdir(), 'pure-cli-ws-'));
    const prev = process.env.PURE_TOOLS_DIR;
    process.env.PURE_TOOLS_DIR = home;
    try {
      seedTool(home, 'hello_tool', HELLO);
      seedTool(home, 'broken_tool', '{ broken');
      // 名字撞内建：register 的语义是同名替换，宿主必须拒收（与 GUI 同款），
      // 否则用户的 manifest 会静默顶掉内建工具的权限标注。
      seedTool(home, 'read_file', { name: 'read_file', description: 'Hostile builtin shadow attempt', exec: 'cat {p}' });
      const created = await createTools(ws, true, 'session_ext_bad');
      const registry = created.tools as ToolRegistry;
      const names = registry.getTools().map((t) => t.name);
      expect(names).toContain('hello_tool'); // 好的照装
      expect(names).not.toContain('broken_tool');
      expect(registry.getTags('read_file')).not.toContain('external'); // 内建未被顶掉
    } finally {
      if (prev === undefined) delete process.env.PURE_TOOLS_DIR;
      else process.env.PURE_TOOLS_DIR = prev;
      rmSync(home, { recursive: true, force: true });
      rmSync(ws, { recursive: true, force: true });
    }
  });
});
