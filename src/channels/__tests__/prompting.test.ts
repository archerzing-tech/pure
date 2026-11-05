// src/channels/__tests__/prompting.test.ts
// 通道面 prompt 装配的 conventions 注入锁。conventions 此前在 prompting.ts
// 早备好入参、harnessFactory.ts 却从未传值（cd26110「三面接线」漏改工厂），
// 飞书/钉钉/QQ/WebChat 实际收不到 AGENTS.md——2026-11-05 补齐。这里锁两件：
// 包裹形状（与 CLI/GUI 的 <project_conventions> 同构）与缺省不注入。

import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { assembleChannelPrompt, buildChannelCapabilities } from '../prompting';
import type { ChannelCapabilities } from '../types';
import type { ToolDefinition } from '../../shared/types';

const CAPS: ChannelCapabilities = {
  markdown: 'basic',
  media: { images: false, files: false, audio: false, video: false },
  maxTextLength: 2000,
  streaming: 'none',
  chatTypes: ['dm', 'group'],
};

const TOOL_DEFS: ToolDefinition[] = [];

function assemble(conventions?: string) {
  return assembleChannelPrompt({
    capabilities: CAPS,
    toolDefinitions: TOOL_DEFS,
    budget: {},
    conventions,
    userText: 'hello',
  });
}

describe('assembleChannelPrompt conventions injection（通道面惯例注入）', () => {
  it('wraps conventions in <project_conventions> inside the user turn (same shape as CLI/GUI)', () => {
    const assembly = assemble('# Build\n\nprefer bun over npm');
    expect(assembly.userPrompt).toContain('<project_conventions>');
    expect(assembly.userPrompt).toContain('prefer bun over npm');
    expect(assembly.userPrompt).toContain('hello');
    // 惯例住 user turn 尾部变动区（P2 下沉），system 前缀保持逐字稳定。
    expect(assembly.systemPrompt).not.toContain('<project_conventions>');
    expect(assembly.systemPrompt).not.toContain('prefer bun over npm');
  });

  it('injects nothing when conventions are absent or blank', () => {
    expect(assemble(undefined).userPrompt).not.toContain('<project_conventions>');
    expect(assemble('   \n  ').userPrompt).not.toContain('<project_conventions>');
  });

  it('trims the merged conventions text', () => {
    expect(assemble('  body text  ').userPrompt).toContain('<project_conventions>\nbody text\n</project_conventions>');
  });
});

describe('harnessFactory wiring lock（工厂必须真的传 conventions）', () => {
  it('the factory loads merged conventions and passes them to the assembly', () => {
    // 源码形状锁（chat.test.ts 同款风格）：cd26110「三面接线」曾在
    // harnessFactory 漏改——入参悬空三个月无人发现。这把锁钉住两处：
    // 装配处真的调 loadMergedConventions，装配输入真的带 conventions。
    const src = readFileSync(join(import.meta.dir, '..', 'harnessFactory.ts'), 'utf8');
    expect(src).toContain('await loadMergedConventions({ globalUserRoot: PURE_DIR, userSpaceRoot: spec.workspace ?? undefined })');
    expect(src).toContain('conventions,\n      hasSubagents');
  });
});

describe('buildChannelCapabilities', () => {
  it('states the length limit and markdown level (capability contract)', () => {
    const text = buildChannelCapabilities(CAPS);
    expect(text).toContain('under 2000 characters');
    expect(text).toContain('renders basic markdown');
  });
});
