// src/shared/__tests__/promptLayers.test.ts
// Covers the layered prompt architecture (L0 system core / L1 behavior
// contracts / L2 per-request user-turn composer).

import { describe, it, expect } from 'bun:test';
import {
  CHART_DSL_PROMPT,
  SYSTEM_CORE_PROMPT,
  WORKFLOW_PROMPT,
  COMPLETION_PROMPT,
  TYPO_TOLERANCE_PROMPT,
  LOGICAL_TRAPS_PROMPT,
  SVG_OUTPUT_PROMPT,
  IMAGE_GEN_OUTPUT_PROMPT,
  HUMAN_TONE_PROMPT,
  FILE_TOOLS_CORE,
  CAPABILITY_GAP_PROMPT,
  composeUserTurn,
  stripUserTurnContext,
} from '../promptLayers';
import { INCREMENTAL_BUILD_PROMPT } from '../agentBehavior';

describe('SYSTEM_CORE_PROMPT (L0)', () => {
  it('carries the immutable identity + operating contract', () => {
    expect(SYSTEM_CORE_PROMPT).toContain('<agent_identity>');
    expect(SYSTEM_CORE_PROMPT).toContain('pure');
    expect(SYSTEM_CORE_PROMPT).toContain('<operating_principles>');
    expect(SYSTEM_CORE_PROMPT).toContain('<permission_modes>');
    expect(SYSTEM_CORE_PROMPT).toContain('<runtime>');
    expect(SYSTEM_CORE_PROMPT).toContain('<response_format>');
  });

  it('keeps the system core free of request-specific content', () => {
    expect(SYSTEM_CORE_PROMPT).not.toContain('web_search');
    expect(SYSTEM_CORE_PROMPT).not.toContain('read_file');
    expect(SYSTEM_CORE_PROMPT).not.toContain('## 阶段');
  });
});

describe('L1 behavior contracts', () => {
  it('re-exports the always-on workflow + completion contracts', () => {
    expect(WORKFLOW_PROMPT).toContain('Proactive problem-solving workflow');
    expect(COMPLETION_PROMPT).toContain('Completion report');
    expect(COMPLETION_PROMPT).toContain('本次完成了什么');
    expect(COMPLETION_PROMPT).toContain('修复了什么');
    expect(COMPLETION_PROMPT).toContain('验证结果');
    expect(COMPLETION_PROMPT).toContain('通过');
    expect(COMPLETION_PROMPT).toContain('不通过');
    expect(COMPLETION_PROMPT).toContain('真实执行过的命令');
  });

  it('shares typo tolerance and logical-traps defense', () => {
    expect(TYPO_TOLERANCE_PROMPT).toContain('Smart typo tolerance');
    expect(LOGICAL_TRAPS_PROMPT).toContain('Logical traps & approach switching');
  });

  it('tells multi-image requests to emit one SVG per image (never a collage)', () => {
    expect(SVG_OUTPUT_PROMPT).toContain('MULTIPLE images');
    expect(SVG_OUTPUT_PROMPT).toContain('ONE separate fenced code block tagged svg PER image');
    expect(SVG_OUTPUT_PROMPT).toContain('NEVER combine several subjects into a single <svg>');
    expect(SVG_OUTPUT_PROMPT).toContain('NO prose between them');
  });

  it('bans saving picture files with write_file and non-svg code blocks', () => {
    // Root cause of the "画一只鸟 → 弹出一个 .svg 文件而不是聊天里渲染图片" bug:
    // the contract must cover SINGLE image requests too, and forbid the model
    // from writing the picture to disk (or emitting it as plain text / other
    // code-block languages) — the fenced svg block IS the deliverable.
    expect(SVG_OUTPUT_PROMPT).toContain('ANY image request');
    expect(SVG_OUTPUT_PROMPT).toContain('NEVER use write_file / edit_file to save the picture');
    expect(SVG_OUTPUT_PROMPT).toContain('must be tagged svg');
  });

  it('replaces the SVG contract with generate_image when the model supports text-to-image', () => {
    expect(IMAGE_GEN_OUTPUT_PROMPT).toContain('generate_image(prompt, n?, size?)');
    expect(IMAGE_GEN_OUTPUT_PROMPT).toContain('创作一个小狗图标');
    expect(IMAGE_GEN_OUTPUT_PROMPT).toContain('NEVER emit fenced svg code blocks for image requests');
    // SVG stays as the automatic fallback when the tool fails / is unavailable.
    expect(IMAGE_GEN_OUTPUT_PROMPT).toContain('fall back to svg code blocks');
  });

  it('never routes attached-image questions (what is this / describe it) to generate_image', () => {
    // Root cause of the "user pastes an image, asks what it is, and the agent
    // generates a NEW image" bug: every image contract stated only the positive
    // half ("image requests → generate_image"), so a question containing 图片
    // pattern-matched into generation. The negative half must be explicit.
    expect(IMAGE_GEN_OUTPUT_PROMPT).toContain('only CREATES a new image from a text prompt');
    expect(IMAGE_GEN_OUTPUT_PROMPT).toContain('do NOT call generate_image');
    expect(IMAGE_GEN_OUTPUT_PROMPT).toContain('inspect the attachment and answer directly');
  });

  it('documents every chart family in the chart DSL and bans script-drawn charts', () => {
    expect(CHART_DSL_PROMPT).toContain('type:');
    expect(CHART_DSL_PROMPT).toContain('scatter');
    expect(CHART_DSL_PROMPT).toContain('kline');
    expect(CHART_DSL_PROMPT).toContain('radar');
    expect(CHART_DSL_PROMPT).toContain('treemap');
    expect(CHART_DSL_PROMPT).toContain('sunburst');
    expect(CHART_DSL_PROMPT).toContain('tree');
    // Charts/pictures are delivered as fenced blocks — never a script that draws them.
    expect(CHART_DSL_PROMPT).toContain('NEVER write a Python/matplotlib');
    expect(CHART_DSL_PROMPT).toContain('IS the deliverable');
  });

  it('asks for a human, conversational tone without canned boilerplate', () => {
    expect(HUMAN_TONE_PROMPT).toContain('Communication tone');
    expect(HUMAN_TONE_PROMPT).toContain('human colleague');
    expect(HUMAN_TONE_PROMPT).toContain('canned');
    expect(HUMAN_TONE_PROMPT).toContain('conversationally');
  });

  it('reports finished work like a colleague, not a changelog', () => {
    expect(HUMAN_TONE_PROMPT).toContain('report back the way a colleague would');
    expect(HUMAN_TONE_PROMPT).toContain('changelog-style list');
  });

  it('uses dynamic capability tools for skills and MCP services', () => {
    expect(CAPABILITY_GAP_PROMPT).toContain('search_agent_skills(query)');
    expect(CAPABILITY_GAP_PROMPT).toContain('install_agent_skill(source, name)');
    expect(CAPABILITY_GAP_PROMPT).toContain('search_mcp_servers(query)');
    expect(CAPABILITY_GAP_PROMPT).toContain('connect_mcp_server(candidateId)');
    expect(CAPABILITY_GAP_PROMPT).toContain('consider a specialist skill as one possible solution');
    expect(CAPABILITY_GAP_PROMPT).toContain('official Registry recipe');
  });
});

describe('composeUserTurn (L2)', () => {
  it('returns the text unchanged with no fragments', () => {
    expect(composeUserTurn('hello')).toBe('hello');
    expect(composeUserTurn('hello', {})).toBe('hello');
  });

  it('wraps each provided fragment in <task_context> before the request', () => {
    const out = composeUserTurn('build me a game', {
      traps: '<trap>contradiction</trap>',
      buildProtocol: '<build>protocol</build>',
    });
    expect(out.startsWith('<task_context>')).toBe(true);
    expect(out).toContain('<trap>contradiction</trap>');
    expect(out).toContain('<build>protocol</build>');
    expect(out.endsWith('build me a game')).toBe(true);
    expect(out.indexOf('<trap>')).toBeLessThan(out.indexOf('<build>'));
    expect(out.indexOf('<build>')).toBeLessThan(out.indexOf('build me a game'));
    expect(out.indexOf('</task_context>')).toBeLessThan(out.indexOf('build me a game'));
  });

  it('includes the approved-plan fragment when present', () => {
    const out = composeUserTurn('proceed', { plan: '## Execution plan\n1. Do' });
    expect(out).toContain('## Execution plan\n1. Do');
    expect(out.endsWith('proceed')).toBe(true);
  });

  it('includes clarifying answers as hard constraints before the request', () => {
    const out = composeUserTurn('build it', { clarifications: '<user_clarifications>平台：Web</user_clarifications>' });
    expect(out.startsWith('<task_context>')).toBe(true);
    expect(out).toContain('<user_clarifications>平台：Web</user_clarifications>');
    expect(out.endsWith('build it')).toBe(true);
  });

  it('includes the delivery contract beside the approved task context', () => {
    const out = composeUserTurn('build it', { contract: '<delivery_contract>tests are required</delivery_contract>' });
    expect(out).toContain('<delivery_contract>tests are required</delivery_contract>');
    expect(out.endsWith('build it')).toBe(true);
  });

  it('includes the proactive intent assessment beside the request', () => {
    const out = composeUserTurn('delete it', { assessment: '<intent_assessment>high risk</intent_assessment>' });
    expect(out).toContain('<intent_assessment>high risk</intent_assessment>');
    expect(out.endsWith('delete it')).toBe(true);
  });

  it('ignores empty fragments', () => {
    expect(composeUserTurn('x', { traps: '', buildProtocol: undefined, plan: '' })).toBe('x');
  });
});

describe('stripUserTurnContext (replay round-trip)', () => {
  it('strips the <task_context> block leaving the user text', () => {
    const composed = composeUserTurn('build me a game', { traps: '<trap>x</trap>' });
    expect(stripUserTurnContext(composed)).toBe('build me a game');
  });

  it('returns plain text unchanged', () => {
    expect(stripUserTurnContext('just a normal question')).toBe('just a normal question');
    expect(stripUserTurnContext('')).toBe('');
  });

  it('round-trips a multi-fragment turn exactly', () => {
    const text = '  带空格的请求  ';
    const composed = composeUserTurn(text, {
      traps: 'a',
      buildProtocol: 'b',
      plan: '## Execution plan',
    });
    expect(stripUserTurnContext(composed)).toBe(text);
  });

  it('does not strip when the closing tag is missing (malformed)', () => {
    expect(stripUserTurnContext('<task_context>broken')).toBe('<task_context>broken');
  });
});

describe('FILE_TOOLS_CORE (L1 shared tool list)', () => {
  it('lists the full file + shell/git tool set', () => {
    expect(FILE_TOOLS_CORE).toContain('read_file(path, startLine?, endLine?)');
    expect(FILE_TOOLS_CORE).toContain('replace_files(files[], oldString, newString, allowMultiple?)');
    expect(FILE_TOOLS_CORE).toContain('execute_command(command) — run a shell command');
    expect(FILE_TOOLS_CORE).toContain('git_status — working tree status');
  });
});

describe('INCREMENTAL_BUILD_PROMPT (humanized build reporting)', () => {
  it('uses natural step headings and plain-language reports, not labeled What/How sections', () => {
    expect(INCREMENTAL_BUILD_PROMPT).toContain('## 第 n 步');
    // The old internal four-label report (做了什么/怎么做/结果/验证) is banned
    // — the model must write flowing sentences instead.
    expect(INCREMENTAL_BUILD_PROMPT).toContain('做了什么 / 怎么做 / 结果 / 验证');
    expect(INCREMENTAL_BUILD_PROMPT).toContain('flowing sentences');
    expect(INCREMENTAL_BUILD_PROMPT).not.toContain('**做了什么 / What**');
    expect(INCREMENTAL_BUILD_PROMPT).not.toContain('**怎么做 / How**');
    expect(INCREMENTAL_BUILD_PROMPT).toContain('live plan card can reflect optional progress markers');
    expect(INCREMENTAL_BUILD_PROMPT).toContain('overall plan context separate from any optional progress list');
    expect(INCREMENTAL_BUILD_PROMPT).toContain('For other complex work');
    expect(INCREMENTAL_BUILD_PROMPT).toContain('meaningful protection');
    expect(INCREMENTAL_BUILD_PROMPT).not.toContain('dedicated test step');
    expect(INCREMENTAL_BUILD_PROMPT).not.toContain('at least three rounds');
    expect(INCREMENTAL_BUILD_PROMPT).toContain('concrete failing checks and evidence');
  });
});
