import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadUserHooks, mergeUserHooks, parseUserHooks } from '../userHooks';

describe('parseUserHooks', () => {
  it('parses a valid config across all three events', () => {
    const config = parseUserHooks(JSON.stringify({
      on_pre_tool: [{ command: 'bun lint', matcher: 'write_file' }],
      on_post_tool: [{ command: 'bun test', timeoutMs: 5000 }],
      on_turn_complete: [{ command: 'notify.sh' }],
    }));
    expect(config.on_pre_tool).toEqual([{ command: 'bun lint', matcher: 'write_file' }]);
    expect(config.on_post_tool).toEqual([{ command: 'bun test', timeoutMs: 5000 }]);
    expect(config.on_turn_complete).toEqual([{ command: 'notify.sh' }]);
  });

  it('tolerates broken documents without throwing', () => {
    expect(parseUserHooks(null)).toEqual({});
    expect(parseUserHooks('')).toEqual({});
    expect(parseUserHooks('not json')).toEqual({});
    expect(parseUserHooks('["array"]')).toEqual({});
    expect(parseUserHooks('42')).toEqual({});
  });

  it('drops invalid entries and unknown event keys', () => {
    const config = parseUserHooks(JSON.stringify({
      on_pre_tool: [
        { command: '  ' },
        { matcher: 'no-command' },
        null,
        'string',
        { command: 'keep.sh', timeoutMs: -1, matcher: 42 },
        { command: 'also-keep.sh', timeoutMs: 1500 },
      ],
      on_unknown_event: [{ command: 'ignored' }],
    }));
    expect(config.on_pre_tool).toEqual([
      { command: 'keep.sh' },
      { command: 'also-keep.sh', timeoutMs: 1500 },
    ]);
    expect((config as Record<string, unknown>).on_unknown_event).toBeUndefined();
  });

  it('caps hooks per event', () => {
    const many = Array.from({ length: 100 }, (_, i) => ({ command: `cmd-${i}.sh` }));
    const config = parseUserHooks(JSON.stringify({ on_turn_complete: many }));
    expect(config.on_turn_complete?.length).toBe(64);
  });
});

describe('mergeUserHooks', () => {
  it('concatenates layers in run order and dedupes identical hooks', () => {
    const app = { on_post_tool: [{ command: 'shared.sh' }, { command: 'app-only.sh' }] };
    const global = { on_post_tool: [{ command: 'shared.sh' }], on_turn_complete: [{ command: 'turn.sh' }] };
    const workspace = { on_post_tool: [{ command: 'workspace.sh' }] };
    const merged = mergeUserHooks(app, global, workspace);
    expect(merged.on_post_tool?.map((h) => h.command)).toEqual(['shared.sh', 'app-only.sh', 'workspace.sh']);
    expect(merged.on_turn_complete).toEqual([{ command: 'turn.sh' }]);
  });

  it('treats same command with different matcher as distinct', () => {
    const merged = mergeUserHooks(
      { on_pre_tool: [{ command: 'lint.sh', matcher: 'write_file' }] },
      { on_pre_tool: [{ command: 'lint.sh', matcher: 'execute_command' }] },
    );
    expect(merged.on_pre_tool?.length).toBe(2);
  });

  it('tolerates null and empty layers', () => {
    expect(mergeUserHooks(null, {}, undefined)).toEqual({});
  });
});

describe('loadUserHooks', () => {
  let root: string;
  let appRoot: string;
  let globalRoot: string;
  let workspaceRoot: string;

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), 'pure-user-hooks-'));
    appRoot = join(root, 'app');
    globalRoot = join(root, 'global');
    workspaceRoot = join(root, 'workspace');
    mkdirSync(appRoot, { recursive: true });
    mkdirSync(globalRoot, { recursive: true });
    mkdirSync(workspaceRoot, { recursive: true });
    // The app layer ships broken JSON: the loader must tolerate it.
    writeFileSync(join(appRoot, 'hooks.json'), '{broken', 'utf8');
    writeFileSync(join(globalRoot, 'hooks.json'), JSON.stringify({
      on_post_tool: [{ command: 'global-test.sh' }],
    }), 'utf8');
    writeFileSync(join(workspaceRoot, 'hooks.json'), JSON.stringify({
      on_post_tool: [{ command: 'workspace-test.sh' }],
      on_pre_tool: [{ command: 'guard.sh', matcher: 'execute_command' }],
    }), 'utf8');
  });

  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('merges present layers in run order and tolerates missing/broken ones', async () => {
    const hooks = await loadUserHooks({
      appSpaceRoot: appRoot,
      globalUserRoot: globalRoot,
      userSpaceRoot: workspaceRoot,
    });
    expect(hooks.on_post_tool?.map((h) => h.command)).toEqual(['global-test.sh', 'workspace-test.sh']);
    expect(hooks.on_pre_tool).toEqual([{ command: 'guard.sh', matcher: 'execute_command' }]);
    expect(hooks.on_turn_complete).toBeUndefined();
  });

  it('returns an empty config when no layer exists', async () => {
    const hooks = await loadUserHooks({ appSpaceRoot: join(root, 'missing') });
    expect(hooks).toEqual({});
  });
});
