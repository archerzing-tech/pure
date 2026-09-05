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
  PLAUSIBILITY_REVIEW_PROMPT,
  SVG_OUTPUT_PROMPT,
  IMAGE_GEN_OUTPUT_PROMPT,
  MAP_DSL_PROMPT,
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
    // The reasoning phase plans the work — it is not a scratch draft of the
    // deliverable (drafting code in thinking doubled tokens and latency).
    expect(SYSTEM_CORE_PROMPT).toContain('Reason to plan, not to draft');
    expect(SYSTEM_CORE_PROMPT).toContain('never to write out the deliverable');
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
    expect(COMPLETION_PROMPT).toContain('依据');
    expect(COMPLETION_PROMPT).toContain('改动');
    expect(COMPLETION_PROMPT).toContain('验证');
    expect(COMPLETION_PROMPT).toContain('通过');
    expect(COMPLETION_PROMPT).toContain('不通过');
    expect(COMPLETION_PROMPT).toContain('实际运行的命令');
    // No fixed completion template: the report must read like a colleague,
    // not a labeled checklist. (The prompt may MENTION the banned heading in
    // its prohibition clause, but must not mandate the old heading+bullets
    // structure.)
    expect(COMPLETION_PROMPT).not.toContain('## 完成总结\n- ');
    expect(COMPLETION_PROMPT).not.toContain('**交付依据');
  });

  it('shares typo tolerance and logical-traps defense', () => {
    expect(TYPO_TOLERANCE_PROMPT).toContain('Smart typo tolerance');
    expect(LOGICAL_TRAPS_PROMPT).toContain('Logical traps & approach switching');
  });

  it('reviews answers against real-world geography/physics/chemistry/math/history', () => {
    expect(PLAUSIBILITY_REVIEW_PROMPT).toContain('Plausibility & real-world consistency review');
    expect(PLAUSIBILITY_REVIEW_PROMPT).toContain('Geography');
    expect(PLAUSIBILITY_REVIEW_PROMPT).toContain('Physics');
    expect(PLAUSIBILITY_REVIEW_PROMPT).toContain('Chemistry');
    expect(PLAUSIBILITY_REVIEW_PROMPT).toContain('Math');
    expect(PLAUSIBILITY_REVIEW_PROMPT).toContain('History');
    // Route direction is a concrete case: waypoints must advance toward the goal.
    expect(PLAUSIBILITY_REVIEW_PROMPT).toContain('西安→上海');
    expect(PLAUSIBILITY_REVIEW_PROMPT).toContain('宝鸡/甘南');
    // Fiction / alternate-history requests opt out of the review.
    expect(PLAUSIBILITY_REVIEW_PROMPT).toContain('skip this review');
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

  it('keeps maps on the Leaflet JSON contract and never falls back to SVG', () => {
    // Root cause of the "map not rendering → model re-emits it as SVG" bug:
    // the SVG picture contract is prominent, so the model conflated maps with
    // SVG and "fixed" a broken map by switching formats. The map DSL must state
    // Leaflet explicitly and forbid SVG so the recovery path is a valid map block.
    expect(MAP_DSL_PROMPT).toContain('interactive Leaflet map');
    expect(MAP_DSL_PROMPT).toContain('A MAP IS NEVER SVG');
    expect(MAP_DSL_PROMPT).toContain('renders it with Leaflet, not SVG');
    expect(MAP_DSL_PROMPT).toContain('NEVER switch to SVG');
    expect(MAP_DSL_PROMPT).toContain('re-emitting a valid');
  });

  it('asks for a human, conversational tone without canned boilerplate', () => {
    expect(HUMAN_TONE_PROMPT).toContain('Communication tone');
    expect(HUMAN_TONE_PROMPT).toContain('senior engineer');
    expect(HUMAN_TONE_PROMPT).toContain('canned');
    expect(HUMAN_TONE_PROMPT).toContain('control lines');
  });

  it('reports finished work like a colleague, not a changelog', () => {
    expect(HUMAN_TONE_PROMPT).toContain('flowing sentences');
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

  it('includes the plausibility-review override beside the request', () => {
    const out = composeUserTurn('写一个架空的故事', { plausibilityOverride: '<plausibility_review_override>skip</plausibility_review_override>' });
    expect(out.startsWith('<task_context>')).toBe(true);
    expect(out).toContain('<plausibility_review_override>skip</plausibility_review_override>');
    expect(out.endsWith('写一个架空的故事')).toBe(true);
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
    expect(FILE_TOOLS_CORE).toContain('execute_command(command, background?) — run a shell command');
    expect(FILE_TOOLS_CORE).toContain('git_status — working tree status');
  });

  it('teaches the serve-and-preview decision: static file vs web server', () => {
    // The "启动服务打开页面" protocol: the model must pick the right vehicle
    // instead of faking a preview or letting a server time out.
    expect(FILE_TOOLS_CORE).toContain('Single self-contained .html file');
    expect(FILE_TOOLS_CORE).toContain('MUST go through http://localhost');
    expect(FILE_TOOLS_CORE).toContain('background:true');
    expect(FILE_TOOLS_CORE).toContain('never fake a preview by opening file:// for something that needs a server');
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
    expect(INCREMENTAL_BUILD_PROMPT).toContain('choose and state a test strategy before implementation');
    // NEW TASK RULE: a fresh user request after a finished plan restarts
    // numbering instead of appending "计划6" to the old plan's stages.
    expect(INCREMENTAL_BUILD_PROMPT).toContain('NEW TASK RULE');
    expect(INCREMENTAL_BUILD_PROMPT).toContain('restart heading numbers');
    expect(INCREMENTAL_BUILD_PROMPT).toContain('create the project test entry');
    expect(INCREMENTAL_BUILD_PROMPT).toContain('at least one focused smoke/unit/integration test');
    expect(INCREMENTAL_BUILD_PROMPT).toContain('happy-dom');
    expect(INCREMENTAL_BUILD_PROMPT).toContain('manual click-through is not an automated test');
    expect(INCREMENTAL_BUILD_PROMPT).not.toContain('meaningful protection');
    expect(INCREMENTAL_BUILD_PROMPT).not.toContain('dedicated test step');
    expect(INCREMENTAL_BUILD_PROMPT).not.toContain('at least three rounds');
    expect(INCREMENTAL_BUILD_PROMPT).toContain('concrete failing checks and evidence');
  });
});
