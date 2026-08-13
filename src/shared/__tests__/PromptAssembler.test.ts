import { describe, expect, it } from 'bun:test';
import {
  PromptAssembler,
  buildCliCapabilities,
  buildGuiCapabilities,
} from '../PromptAssembler';
import { composeUserTurn } from '../promptLayers';
import { InMemoryPromptObservationStore, PromptObservability } from '../promptObservability';

function estimateLength(systemPrompt: string, userPrompt?: string): number {
  return Math.ceil((systemPrompt.length + (userPrompt?.length ?? 0)) / 4);
}

const assembler = new PromptAssembler();

describe('PromptAssembler', () => {
  it('uses an injected observability sink for assembly traces', () => {
    const store = new InMemoryPromptObservationStore();
    const observability = new PromptObservability({}, store);
    const isolatedAssembler = new PromptAssembler(observability);
    const assembly = isolatedAssembler.assemble({ surface: 'cli', capabilities: 'test' }, 'hello');
    expect(assembly.traceId).toBe(store.list()[0].traceId);
    expect(isolatedAssembler.getObservability()).toBe(observability);
  });

  it('uses the same ordered core for GUI and CLI while allowing capability differences', () => {
    const gui = assembler.buildSystemPrompt({
      surface: 'gui',
      capabilities: buildGuiCapabilities(true),
    });
    const cli = assembler.buildSystemPrompt({
      surface: 'cli',
      capabilities: buildCliCapabilities(),
    });

    for (const header of ['<agent_identity>', '<capabilities>', 'Output style:', 'Tool-calling rules:', 'Smart typo tolerance:', 'Logical traps & approach switching:']) {
      expect(gui.split(header).length - 1).toBe(1);
      expect(cli.split(header).length - 1).toBe(1);
    }
    expect(gui.indexOf('<agent_identity>')).toBeLessThan(gui.indexOf('<capabilities>'));
    expect(gui.indexOf('<capabilities>')).toBeLessThan(gui.indexOf('Output style:'));
    expect(gui).toContain('Path rule: pass file and directory paths relative');
    expect(cli).toContain('researcher_web(prompt');
  });

  it('injects runtime state, skills, and task mode at assembly time', () => {
    const prompt = assembler.buildSystemPrompt({
      surface: 'cli',
      capabilities: 'dynamic capability',
      environment: 'Environment: test-city',
      runtimes: 'Environment runtimes: bun 1.x',
      skills: [{ name: 'skill<>', body: 'skill body', enabled: true }],
      mode: 'build',
    });

    expect(prompt).toContain('dynamic capability');
    expect(prompt).toContain('Environment: test-city');
    expect(prompt).toContain('Environment runtimes: bun 1.x');
    expect(prompt).toContain('<skill name="skill__">');
    expect(prompt).toContain('skill body');
    expect(prompt).toContain('<task_mode>');
    expect(prompt).toContain('Operating mode: BUILD');
  });

  it('keeps user-turn composition on the same shared compiler path', () => {
    const context = { assessment: '<intent_assessment>medium</intent_assessment>' };
    expect(assembler.buildUserPrompt('ship it', context)).toBe(composeUserTurn('ship it', context));
  });

  it('preserves retrieved-memory composition for the Harness path', () => {
    const prompt = assembler.composeMemoryPrompt({
      template: 'Base',
      memory: {
        project: '/workspace/demo',
        preferences: ['Use TypeScript'],
        errorPatterns: ['TS2307 was fixed by adding the import'],
        procedures: ['Run typecheck after editing'],
      },
    });

    expect(prompt).toContain('<session_memory>');
    expect(prompt).toContain('Project: /workspace/demo');
    expect(prompt).toContain('- Use TypeScript');
    expect(prompt).toContain('- TS2307 was fixed by adding the import');
    expect(prompt).toContain('- Run typecheck after editing');
    expect(prompt).toContain('</session_memory>');
  });

  it('injects a runtime adaptive strategy even when no long-term memory is available', () => {
    const prompt = assembler.composeMemoryPrompt({
      template: 'Base',
      memory: {
        preferences: [],
        errorPatterns: [],
        adaptiveStrategy: '<adaptive_strategy>night strategy</adaptive_strategy>',
      },
    });

    expect(prompt).not.toContain('<session_memory>');
    expect(prompt).toContain('<adaptive_context>');
    expect(prompt).toContain('night strategy');
  });

  it('omits low-priority fragments before required fragments when the model budget is tight', () => {
    const assembly = assembler.assemble({
      surface: 'cli',
      capabilities: 'capabilities',
      skills: [{ name: 'large-skill', body: 'skill '.repeat(8_000), enabled: true }],
      budget: { provider: 'custom-local', model: 'tiny', contextWindowTokens: 5_000, outputReserveTokens: 0, safetyMarginTokens: 0 },
    }, 'do the task', { plan: 'plan '.repeat(8_000) });

    expect(assembly.systemPrompt).toContain('<agent_identity>');
    expect(assembly.systemPrompt).toContain('Tool-calling rules:');
    expect(assembly.budget.includedFragmentIds).toContain('system_core');
    expect(assembly.budget.includedFragmentIds).toContain('user_request');
    expect(assembly.budget.omittedFragmentIds).toContain('skills');
    expect(assembly.budget.omittedFragmentIds).toContain('plan');
    expect(assembly.userPrompt).toBe('do the task');
  });

  it('charges tool schemas against the provider window without duplicating them in system text', () => {
    const tools = [{
      name: 'large_tool',
      description: 'A tool with a sizeable schema',
      input_schema: { type: 'object', properties: { payload: { type: 'string', description: 'x'.repeat(1_200) } } },
    }];
    const assembly = assembler.assemble({
      surface: 'cli',
      capabilities: 'capabilities',
      toolDefinitions: tools,
      budget: { contextWindowTokens: 2_000, outputReserveTokens: 0, safetyMarginTokens: 0 },
    }, 'do it');

    expect(assembly.budget.estimatedToolTokens).toBeGreaterThan(0);
    expect(assembly.budget.includedFragmentIds).toContain('tool_schemas');
    expect(assembly.budget.estimatedInputTokens).toBeGreaterThan(estimateLength(assembly.systemPrompt, assembly.userPrompt));
    expect(assembly.systemPrompt).not.toContain('large_tool');
  });

  it('does not inject memory when the provider budget cannot fit it', () => {
    const template = 'base '.repeat(800);
    const result = assembler.composeMemoryPrompt({
      template,
      memory: { preferences: ['memory '.repeat(800)], errorPatterns: [] },
      budget: { provider: 'custom-local', model: 'tiny', contextWindowTokens: 1_000, outputReserveTokens: 0, safetyMarginTokens: 0 },
    });
    expect(result).toBe(template);
  });

  it('does not advertise filesystem capabilities in GUI plain-chat mode', () => {
    const prompt = assembler.buildSystemPrompt({
      surface: 'gui',
      capabilities: buildGuiCapabilities(false),
    });
    expect(prompt).toContain('Workspace: none selected');
    expect(prompt).not.toContain('write_file(path, content)');
    expect(prompt).toContain('web_search(query');
  });
});
