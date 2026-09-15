import { describe, expect, it } from 'bun:test';
import { mergeWizardConfig } from '../cliConfig';
import type { PureConfig } from '../cliConfig';

// A config that looks like one written by the GUI: MCP servers, hidden tool
// prefixes, hub skills and provider overrides all live in the same file.
const guiWritten: PureConfig = {
  provider: 'openai',
  apiKey: 'sk-gui',
  model: 'gpt-x',
  workspace: '/tmp/gui-workspace',
  mcpServers: [{ name: 'fs', command: 'npx', args: ['-y', '@modelcontextprotocol/server-fs'] } as never],
  mcpExcludedPrefixes: ['internal_'],
  hubSkills: [{ name: 'ocr', description: 'd', source: 'hub', body: 'b', enabled: true }],
  providerOverrides: { openai: { name: 'OpenAI (proxy)', baseURL: 'https://proxy.internal/v1', apiKey: 'sk-ovr' } },
};

const wizardAnswers = {
  provider: 'custom-1',
  apiKey: 'sk-new',
  model: 'qwen2.5-coder:7b',
  workspace: '.',
  customProviders: [{ id: 'custom-1', name: 'Ollama', baseURL: 'http://localhost:11434/v1', models: ['qwen2.5-coder:7b'], defaultModel: 'qwen2.5-coder:7b', apiKey: '', hasApiKey: false }],
};

describe('mergeWizardConfig', () => {
  it('preserves GUI-owned sections (mcpServers / mcpExcludedPrefixes / hubSkills / providerOverrides) through a wizard re-run', () => {
    const merged = mergeWizardConfig(guiWritten, wizardAnswers);
    expect(merged.mcpServers).toEqual(guiWritten.mcpServers);
    expect(merged.mcpExcludedPrefixes).toEqual(['internal_']);
    expect(merged.hubSkills).toEqual(guiWritten.hubSkills);
    expect(merged.providerOverrides).toEqual(guiWritten.providerOverrides);
  });

  it('overwrites exactly the fields the wizard asks about', () => {
    const merged = mergeWizardConfig(guiWritten, wizardAnswers);
    expect(merged.provider).toBe('custom-1');
    expect(merged.apiKey).toBe('sk-new');
    expect(merged.model).toBe('qwen2.5-coder:7b');
    expect(merged.workspace).toBe('.');
    expect(merged.customProviders).toEqual(wizardAnswers.customProviders);
  });

  it('does not leak the previous provider’s top-level key when the wizard picked a keyless local endpoint', () => {
    // finalKey for a keyless custom provider is '' — the spread must not
    // resurrect the old provider’s secret on top of it.
    const merged = mergeWizardConfig(guiWritten, { ...wizardAnswers, apiKey: '' });
    expect(merged.apiKey).toBe('');
  });

  it('builds a clean config from nothing on first run', () => {
    const merged = mergeWizardConfig(null, wizardAnswers);
    expect(merged).toEqual(wizardAnswers);
  });

  it('carries fields added to PureConfig in the future without needing wizard changes', () => {
    const future = { ...guiWritten, someFutureFlag: true } as PureConfig & { someFutureFlag: boolean };
    const merged = mergeWizardConfig(future, wizardAnswers) as PureConfig & { someFutureFlag: boolean };
    expect(merged.someFutureFlag).toBe(true);
  });
});
