import { describe, expect, it } from 'bun:test';
import { detectVerificationEntry, formatVerificationEntry } from '../verificationEntry';
import { clearVerificationEntryCache, collectVerificationEntry } from '../verificationEntrySource';
import type { ToolAdapter, ToolCall, ToolResult } from '../types';

const pkg = (scripts: Record<string, string>) => JSON.stringify({ name: 'x', scripts });

describe('detectVerificationEntry', () => {
  it('reads package.json scripts in verification order with the lockfile package manager', () => {
    const entry = detectVerificationEntry({
      packageJson: pkg({ test: 'bun test', typecheck: 'tsc --noEmit', lint: 'eslint .' }),
      rootEntries: ['package.json', 'bun.lock', 'src'],
    });
    expect(entry).toEqual({
      source: 'package.json',
      commands: ['bun run typecheck', 'bun run test', 'bun run lint'],
    });
  });

  it('falls back to npm when no lockfile is present', () => {
    expect(detectVerificationEntry({ packageJson: pkg({ test: 'jest' }), rootEntries: ['package.json'] }))
      .toEqual({ source: 'package.json', commands: ['npm run test'] });
  });

  it('returns null for a package.json without verification scripts or broken JSON', () => {
    expect(detectVerificationEntry({ packageJson: pkg({ start: 'node .' }), rootEntries: [] })).toBeNull();
    expect(detectVerificationEntry({ packageJson: '{oops', rootEntries: [] })).toBeNull();
  });

  it('reads pyproject tool sections with the uv prefix when uv.lock exists', () => {
    const pyproject = '[tool.mypy]\nstrict = true\n[tool.pytest.ini_options]\naddopts = "-q"\n';
    expect(detectVerificationEntry({ pyproject, rootEntries: ['pyproject.toml', 'uv.lock'] }))
      .toEqual({ source: 'pyproject.toml', commands: ['uv run mypy .', 'uv run pytest'] });
  });

  it('reads Cargo, go.mod and Makefile entries', () => {
    expect(detectVerificationEntry({ cargoToml: '[package]\nname = "x"\n' }))
      .toEqual({ source: 'Cargo.toml', commands: ['cargo test', 'cargo check'] });
    expect(detectVerificationEntry({ goMod: 'module example.com/x\n\ngo 1.22\n' }))
      .toEqual({ source: 'go.mod', commands: ['go test ./...', 'go vet ./...'] });
    expect(detectVerificationEntry({ makefile: 'test:\n\tpytest\nlint:\n\truff .\n' }))
      .toEqual({ source: 'Makefile', commands: ['make test', 'make lint'] });
  });

  it('prefers package.json when several manifests are present', () => {
    const entry = detectVerificationEntry({
      packageJson: pkg({ test: 'jest' }),
      goMod: 'module x\n',
      rootEntries: ['package.json'],
    });
    expect(entry?.source).toBe('package.json');
  });
});

describe('formatVerificationEntry', () => {
  it('names the source and the exact commands', () => {
    const text = formatVerificationEntry({
      source: 'package.json',
      commands: ['bun run typecheck', 'bun run test'],
    });
    expect(text).toContain('<project_verification>');
    expect(text).toContain('Detected from package.json');
    expect(text).toContain('`bun run typecheck`, `bun run test`');
    expect(text).toContain('whole-project test run exits 0');
  });

  it('omits the green sentence when no test command was detected', () => {
    const text = formatVerificationEntry({ source: 'Makefile', commands: ['make lint'] });
    expect(text).not.toContain('whole-project test run');
  });
});

describe('collectVerificationEntry', () => {
  function fakeAdapter(root: string, files: Record<string, string>) {
    const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
    const adapter = {
      getTools: () => [],
      getMetadata: () => undefined,
      execute: async (call: ToolCall): Promise<ToolResult> => {
        const name = call.function.name;
        const args = JSON.parse(call.function.arguments || '{}') as Record<string, unknown>;
        calls.push({ name, args });
        if (name === 'list_files') return { id: 'l', toolName: name, result: root, success: true, duration: 0 };
        if (name === 'read_file') {
          const content = files[String(args.path)];
          if (content === undefined) return { id: 'r', toolName: name, error: 'missing', success: false, duration: 0 };
          return { id: 'r', toolName: name, result: content, success: true, duration: 0 };
        }
        return { id: 'x', toolName: name, error: `unexpected ${name}`, success: false, duration: 0 };
      },
    } as unknown as ToolAdapter;
    return { adapter, calls };
  }

  it('reads the manifest once and caches the fact per adapter', async () => {
    const { adapter, calls } = fakeAdapter('package.json\nbun.lock\nsrc\n', {
      'package.json': pkg({ typecheck: 'tsc --noEmit', test: 'bun test' }),
    });
    clearVerificationEntryCache(adapter);
    const first = await collectVerificationEntry(adapter);
    expect(first).toContain('bun run typecheck');
    // 清单解析必须拿原文：带行号的显示层会破坏 JSON.parse。
    const read = calls.find((call) => call.name === 'read_file');
    expect(read?.args.lineNumbers).toBe(false);

    const before = calls.length;
    const second = await collectVerificationEntry(adapter);
    expect(second).toBe(first);
    expect(calls.length).toBe(before);
  });

  it('returns an empty fact when the project declares nothing recognisable', async () => {
    const { adapter } = fakeAdapter('src\nREADME.md\n', {});
    clearVerificationEntryCache(adapter);
    expect(await collectVerificationEntry(adapter)).toBe('');
  });
});
