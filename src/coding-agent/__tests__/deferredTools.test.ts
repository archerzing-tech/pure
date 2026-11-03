// src/coding-agent/__tests__/deferredTools.test.ts
// 工具 deferred 化（框架改革三期 docs/framework-reform-2026-11.md）的注册表
// 契约：常驻核心 + discover_tools 常在；长尾内置与 MCP 工具默认不进模型可见
// 清单，经 discover_tools 搜索当场激活；执行面不受可见性影响；设置闸对被藏
// 工具同样生效；子代理工具永不入搜索结果。

import { describe, expect, it } from 'bun:test';
import { ToolRegistry, Tags } from '../ToolRegistry';
import { BUILT_IN_TOOL_DEFS, CORE_TOOL_NAMES } from '../../shared/toolDefs';
import { DYNAMIC_CAPABILITY_TOOL_DEFS } from '../../shared/dynamicCapabilityTools';

const noopExecutor = {
  getTools: () => [],
  getMetadata: () => ({}),
  execute: async (): Promise<import('../../shared/types').ToolResult> => ({ id: 'x', toolName: 'x', success: true, duration: 0 }),
};

function call(name: string, args: Record<string, unknown>) {
  return { id: `call_${name}`, index: 0, toolName: name, function: { name, arguments: JSON.stringify(args) } };
}

describe('deferred tool table (framework-reform phase 3)', () => {
  it('resident table = core built-ins + discover_tools; long tail stays hidden', () => {
    const registry = new ToolRegistry(noopExecutor);
    const names = registry.getTools().map((t) => t.name);
    for (const core of CORE_TOOL_NAMES) {
      if (core === 'generate_image') continue; // 条件注册，测试注册表里没有
      expect(names, core).toContain(core);
    }
    // 长尾默认缺席：git 家族、深检索变体、诊断、文档写作。
    for (const tail of ['git_commit', 'git_status', 'researcher_web', 'web_scrape', 'diagnose_network', 'switch_package_source', 'create_document', 'sys_info']) {
      expect(names, tail).not.toContain(tail);
    }
  });

  it('discover_tools search activates matches and they become visible + callable', async () => {
    const registry = new ToolRegistry(noopExecutor);
    expect(registry.getTools().map((t) => t.name)).not.toContain('git_commit');
    const result = await registry.execute(call('discover_tools', { query: 'git commit' }));
    expect(result.success).toBe(true);
    const text = String(result.result);
    expect(text).toContain('Activated');
    expect(text).toContain('── git_commit ──');
    expect(text).toContain('VERDICT: PASS / FAIL'); // 激活即带完整 schema 与教学
    // 激活后进可见清单——引擎逐请求重算 toolsDefs，下一请求就能看到。
    expect(registry.getTools().map((t) => t.name)).toContain('git_commit');
    // 幂等：重复搜索不重复计数，已激活工具不再回搜。
    const again = await registry.execute(call('discover_tools', { query: 'git commit' }));
    expect(String(again.result)).not.toContain('── git_commit ──');
  });

  it('zero-result search lists the remaining catalog instead of a bare no', async () => {
    const registry = new ToolRegistry(noopExecutor);
    const result = await registry.execute(call('discover_tools', { query: 'zzz_nonexistent_tool' }));
    expect(result.success).toBe(true);
    const text = String(result.result);
    expect(text).toContain('No deferred tool matches');
    expect(text).toContain('git_commit'); // 目录里点名还藏着什么
  });

  it('MCP tools hide until discovered; EXTERNAL and dynamic tools stay resident', async () => {
    const registry = new ToolRegistry(noopExecutor);
    registry.register({ name: 'rea__do_thing', description: 'rea tool', input_schema: { type: 'object' }, tags: [Tags.MCP] });
    registry.register({ name: 'hello_tool', description: 'user-installed', input_schema: { type: 'object' }, tags: [Tags.EXTERNAL] });
    // 动态能力工具由宿主注册（GUI/CLI 启动时），测试里照同款姿态注册。
    for (const def of DYNAMIC_CAPABILITY_TOOL_DEFS) {
      registry.register({ ...def, tags: [Tags.READ] });
    }
    let names = registry.getTools().map((t) => t.name);
    expect(names).not.toContain('rea__do_thing'); // MCP 强制走 discover（rea 两百工具的刚需）
    expect(names).toContain('hello_tool'); // 用户自装的外部工具藏起来是敌意
    // 动态能力工具（skill/MCP 获取回路）常驻——二期获取令教学刚放进去。
    for (const dyn of ['search_agent_skills', 'install_agent_skill', 'register_mcp_server']) {
      expect(names, dyn).toContain(dyn);
    }
    const found = await registry.execute(call('discover_tools', { query: 'rea thing' }));
    expect(String(found.result)).toContain('rea__do_thing');
    names = registry.getTools().map((t) => t.name);
    expect(names).toContain('rea__do_thing');
  });

  it('the settings visibility gate also hides deferred tools from discovery', async () => {
    const registry = new ToolRegistry(noopExecutor);
    registry.setVisibilityGate((name) => name !== 'switch_package_source');
    const result = await registry.execute(call('discover_tools', { query: 'package source switch' }));
    expect(String(result.result)).not.toContain('switch_package_source');
    expect(registry.getTools().map((t) => t.name)).not.toContain('switch_package_source');
  });

  it('subagent tools never surface in discovery results', async () => {
    const registry = new ToolRegistry(noopExecutor);
    registry.register({ name: 'task_planner', description: 'plan tasks', input_schema: { type: 'object' }, tags: [Tags.AGENT] });
    const result = await registry.execute(call('discover_tools', { query: 'plan tasks' }));
    expect(String(result.result)).not.toContain('task_planner');
  });

  it('discover_tools rejects an empty query and clamps the limit', async () => {
    const registry = new ToolRegistry(noopExecutor);
    const bad = await registry.execute(call('discover_tools', { query: '  ' }));
    expect(bad.success).toBe(false);
    expect(bad.error).toContain('query is required');
    // limit=0/负数回落到默认 8，不产生空结果假成功。
    const result = await registry.execute(call('discover_tools', { query: 'git', limit: 0 }));
    expect(result.success).toBe(true);
    expect(String(result.result)).toContain('Activated');
  });

  it('every non-core built-in is discoverable by its own name — the core/deferred split has no dead zone', () => {
    // 防新增工具漏登记：BUILT_IN_TOOL_DEFS 里每个非常驻工具都必须能被
    // discover_tools 搜出（否则就是「注册了、藏了、还没路可寻」——
    // 2026-10-13 判例的 deferred 版）。generate_image 不在数组里（条件
    // 注册），单独豁免。每个工具用**全新注册表**隔离验证：模糊描述命中会
    // 顺带激活近邻工具（召回优先的预期行为），共享注册表会让后面的名字
    // 假阴性。
    for (const def of BUILT_IN_TOOL_DEFS) {
      if (CORE_TOOL_NAMES.has(def.name)) continue;
      const registry = new ToolRegistry(noopExecutor);
      const found = registry.searchDeferredTools(def.name, 20).map((t) => t.name);
      expect(found, `${def.name} must be discoverable`).toContain(def.name);
    }
  });
});

describe('presentation_guide (presentation capability library, 2026-11-02)', () => {
  it('stays resident (a discovery tool nobody sees is dead weight) and never enters the deferred catalog', () => {
    const registry = new ToolRegistry(noopExecutor);
    const names = registry.getTools().map((t) => t.name);
    expect(names).toContain('presentation_guide');
    // deferred 目录不该收录它：零命中亮目录时也不出现。
    const result = registry.searchDeferredTools('presentation guide cards', 20).map((t) => t.name);
    expect(result).not.toContain('presentation_guide');
  });

  it('a form id returns the full card with the DSL detail text', async () => {
    const registry = new ToolRegistry(noopExecutor);
    const result = await registry.execute(call('presentation_guide', { form: 'chart' }));
    expect(result.success).toBe(true);
    const text = String(result.result);
    expect(text).toContain('── chart (data-viz)');
    expect(text).toContain('Avoid when:'); // 负面判据必须在场（防过度可视化）
    expect(text).toContain('type: on its own line'); // CHART_DSL_PROMPT 全文在场
  });

  it('a family name pulls the whole family; aliases route to the same card', async () => {
    const registry = new ToolRegistry(noopExecutor);
    const family = await registry.execute(call('presentation_guide', { form: 'illustration' }));
    const familyText = String(family.result);
    expect(familyText).toContain('── svg (illustration)');
    expect(familyText).toContain('── paint (illustration)');
    const alias = await registry.execute(call('presentation_guide', { form: 'plantuml' }));
    expect(String(alias.result)).toContain('── puml (diagram)');
  });

  it('no form → catalog index; unknown form → catalog too (directory only enters on search)', async () => {
    const registry = new ToolRegistry(noopExecutor);
    const index = await registry.execute(call('presentation_guide', {}));
    const indexText = String(index.result);
    expect(indexText).toContain('Presentation forms you can deliver');
    expect(indexText).toContain('- routing (meta)'); // 决策卡在目录首位
    expect(indexText).toContain('- mermaid (diagram)');
    expect(indexText).toContain('- table (document)');
    const miss = await registry.execute(call('presentation_guide', { form: 'zzz_no_such' }));
    expect(String(miss.result)).toContain('No presentation card matches');
    expect(String(miss.result)).toContain('Presentation forms you can deliver');
  });

  it('the routing card returns the full decision path (form-choice logic, 2026-11-02)', async () => {
    const registry = new ToolRegistry(noopExecutor);
    const result = await registry.execute(call('presentation_guide', { form: 'routing' }));
    expect(result.success).toBe(true);
    const text = String(result.result);
    expect(text).toContain('── routing (meta)');
    expect(text).toContain('Decision path, in order');
    expect(text).toContain('0. Fence first, file second'); // 双交付纪律（真机复测判例）
    expect(text).toContain('deliver BOTH');
    expect(text).toContain('TOPOLOGY');
    expect(text).toContain('the layout IS the semantic');
    // 别名同路。
    const alias = await registry.execute(call('presentation_guide', { form: 'decision' }));
    expect(String(alias.result)).toContain('── routing (meta)');
  });

  it('custom presentation cards (config.json) join the catalog and matching (刀 3)', async () => {
    // 引擎侧注册走惰性盘上加载；测试直接注注册表验证消费面——目录、匹配、
    // 全卡渲染对自定义卡与内置卡同形态。
    const { registerCustomCards, resetCustomCards } = await import('../../shared/presentationLibrary');
    registerCustomCards([{ id: 'myarch', base: 'paint', whenToUse: '公司内部三层架构' }]);
    try {
      const registry = new ToolRegistry(noopExecutor);
      const catalog = await registry.execute(call('presentation_guide', {}));
      const catalogText = String(catalog.result);
      expect(catalogText).toContain('- myarch (illustration)');
      expect(catalogText).toContain('presentationCards'); // 注册说明句（agent 可语义加卡）
      const full = await registry.execute(call('presentation_guide', { form: 'myarch' }));
      const fullText = String(full.result);
      expect(fullText).toContain('── myarch (illustration)');
      expect(fullText).toContain('公司内部三层架构');
    } finally {
      resetCustomCards();
    }
  });
});
