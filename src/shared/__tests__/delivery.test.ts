import { describe, expect, it } from 'bun:test';
import { buildTaskContract, buildVerificationPlan, classifyDeliveryFailure, discoverWorkspace, formatTaskContract, isBareWorkspace } from '../delivery';
import type { ToolAdapter, ToolCall, ToolResult } from '../types';

function adapter(listing: string, packageJson = ''): ToolAdapter {
  return {
    getTools: () => [],
    getMetadata: () => undefined,
    execute: async (call: ToolCall): Promise<ToolResult> => {
      const name = call.function.name;
      const args = JSON.parse(call.function.arguments) as { path?: string };
      if (name === 'list_files') return { id: call.id, toolName: name, result: listing, success: true, duration: 1 };
      if (name === 'read_file' && args.path === 'package.json') return { id: call.id, toolName: name, result: packageJson, success: true, duration: 1 };
      return { id: call.id, toolName: name, result: '', success: false, error: 'not found', duration: 1 };
    },
  };
}

describe('delivery workspace discovery', () => {
  it('discovers Bun scripts and creates a profile-driven verification plan', async () => {
    const profile = await discoverWorkspace(adapter(
      '.git\npackage.json\nbun.lock\nsrc/index.ts\nsrc/index.test.ts',
      JSON.stringify({ scripts: { typecheck: 'tsc --noEmit', test: 'bun test', build: 'vite build' } }),
    ));
    expect(profile.projectType).toBe('bun');
    expect(profile.packageManager).toBe('bun');
    expect(profile.testFilesFound).toBe(true);
    expect(profile.verification.map((spec) => spec.id)).toEqual(['typecheck', 'test', 'build']);
    expect(profile.verification.map((spec) => spec.command)).toEqual(['bun run typecheck', 'bun run test', 'bun run build']);
    expect(profile.gitRepository).toBe(true);
    expect(profile.explorationComplete).toBe(true);
  });

  it('ignores dependency and generated tests during discovery', async () => {
    const profile = await discoverWorkspace(adapter(
      'package.json\nnode_modules/vendor/vendor.test.ts\ndist/generated.spec.ts',
      JSON.stringify({ scripts: { test: 'vitest' } }),
    ));
    expect(profile.testFilesFound).toBe(false);
  });

  it('marks projects without discoverable tests so delivery cannot silently pass', async () => {
    const profile = await discoverWorkspace(adapter(
      'package.json\npackage-lock.json\nsrc/index.ts',
      JSON.stringify({ scripts: { test: 'vitest', build: 'npm run compile' } }),
    ));
    expect(profile.testFilesFound).toBe(false);
    expect(profile.verification.find((spec) => spec.id === 'test')).toMatchObject({ required: false, command: 'npm run test' });
    const contract = buildTaskContract('implement the feature', profile);
    expect(contract.acceptanceCriteria.some((criterion) => criterion.id === 'test' && criterion.required === false)).toBe(true);
    expect(contract.acceptanceCriteria.some((criterion) => criterion.id === 'test-infrastructure' && criterion.required === true)).toBe(true);
    expect(formatTaskContract(contract)).toContain('选择合适的测试 runner');
    expect(formatTaskContract(contract)).toContain('smoke/focused');
    expect(formatTaskContract(contract)).toContain('实际运行测试');
    expect(formatTaskContract(contract)).toContain('<delivery_contract>');
    expect(formatTaskContract(contract)).toContain('npm run test');
  });

  it('builds stack-specific plans without mutating the workspace', () => {
    const specs = buildVerificationPlan({
      projectType: 'rust',
      packageManager: 'cargo',
      manifests: ['Cargo.toml', 'Cargo.lock'],
      scripts: {},
      testFilesFound: true,
      gitRepository: true,
      relevantFiles: ['Cargo.toml'],
    });
    expect(specs.map((spec) => spec.command)).toEqual(['cargo check', 'cargo test', 'cargo build']);
  });

  it('stops waiting when workspace discovery is aborted', async () => {
    const controller = new AbortController();
    const hanging: ToolAdapter = {
      getTools: () => [],
      getMetadata: () => undefined,
      execute: async () => new Promise<ToolResult>(() => {}),
    };
    const pending = discoverWorkspace(hanging, controller.signal);
    setTimeout(() => controller.abort(), 5);
    const profile = await pending;
    expect(profile.projectType).toBe('unknown');
    expect(profile.explorationComplete).toBe(false);
  });

  it('flags an empty workspace as bare so from-scratch builds get honest copy', async () => {
    const bare = await discoverWorkspace(adapter(''));
    expect(isBareWorkspace(bare)).toBe(true);
    expect(bare.projectType).toBe('unknown');
    expect(bare.verification).toEqual([]);
    // A workspace with a manifest is NOT bare, even if verification is empty.
    const node = await discoverWorkspace(adapter('package.json\nREADME.md', '{"name":"x"}'));
    expect(isBareWorkspace(node)).toBe(false);
  });
});

describe('delivery failure classification', () => {
  it('separates environment blocks from code failures', () => {
    expect(classifyDeliveryFailure('command not found: pytest')).toBe('tool_unavailable');
    expect(classifyDeliveryFailure('permission denied')).toBe('permission_blocked');
    expect(classifyDeliveryFailure('expected 2 received 1')).toBe('test_failure');
    expect(classifyDeliveryFailure('TS2345: type error')).toBe('typecheck_failure');
    expect(classifyDeliveryFailure('vite build failed')).toBe('build_failure');
  });
});
