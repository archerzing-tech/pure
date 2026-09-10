// src/ui/__tests__/toolInventory.test.ts
// The settings-page tool inventory must never drift from the real gating:
// every model-visible tool appears exactly once, toggle states come from the
// same isToolEnabled the chat path uses, and the plain-chat second gate
// mirrors createToolAdapter's available().

import { describe, expect, it } from 'bun:test';
import { BUILT_IN_TOOL_DEFS, IMAGE_GEN_TOOL_DEF } from '../../shared/toolDefs';
import { DYNAMIC_CAPABILITY_TOOL_DEFS } from '../../shared/dynamicCapabilityTools';
import { defaults } from '../config';
import { listToolInventory, isToolEnabled, toolGate, FS_TOOL_NAMES } from '../toolInventory';

const cfg = () => defaults();

function entries(config = cfg(), opts?: { hasWorkspace: boolean }) {
  return listToolInventory(config, opts ?? { hasWorkspace: true }).flatMap((g) => g.tools);
}

function byName(config = cfg(), opts?: { hasWorkspace: boolean }) {
  return new Map(entries(config, opts).map((e) => [e.name, e]));
}

describe('completeness', () => {
  it('lists every model-visible tool exactly once', () => {
    const names = entries().map((e) => e.name).sort();
    const expected = [...BUILT_IN_TOOL_DEFS, IMAGE_GEN_TOOL_DEF, ...DYNAMIC_CAPABILITY_TOOL_DEFS]
      .map((d) => d.name)
      // Legacy-hidden aliases (web_search / web_fetch / search_files — the
      // research tool migration folded them into their successors) execute
      // but never show up in model tool lists — the inventory must not
      // advertise them either.
      .filter((n) => n !== 'web_search' && n !== 'web_fetch' && n !== 'search_files')
      .sort();
    expect(names).toEqual(expected);
    expect(new Set(names).size).toBe(names.length);
  });

  it('keeps all five groups non-empty in the fixed fs → cmd → git → web → other order', () => {
    const groups = listToolInventory(cfg(), { hasWorkspace: true });
    expect(groups.map((g) => g.id)).toEqual(['fs', 'cmd', 'git', 'web', 'other']);
    for (const group of groups) expect(group.tools.length).toBeGreaterThan(0);
  });
});

describe('settings-toggle gating', () => {
  it('disables the fs family when toolFS is off — but not code_searcher', () => {
    const map = byName({ ...cfg(), toolFS: false });
    for (const name of FS_TOOL_NAMES) {
      const entry = map.get(name);
      if (!entry) continue; // legacy-hidden (search_files) never shows up
      expect(entry.enabled).toBe(false);
      expect(entry.disabledReason).toBe('toggle:fs');
    }
    // code_searcher sits in the 文件 group but is NOT gated by the fs toggle.
    expect(map.get('code_searcher')?.enabled).toBe(true);
  });

  it('gates command / git / web tools with their own toggles', () => {
    const cmdOff = byName({ ...cfg(), toolCmd: false });
    expect(cmdOff.get('execute_command')?.disabledReason).toBe('toggle:cmd');
    expect(cmdOff.get('read_file')?.enabled).toBe(true);

    const gitOff = byName({ ...cfg(), toolGit: false });
    expect(gitOff.get('git_diff')?.disabledReason).toBe('toggle:git');
    expect(gitOff.get('git_log')?.disabledReason).toBe('toggle:git');
    expect(gitOff.get('git_status')?.disabledReason).toBe('toggle:git');

    const webOff = byName({ ...cfg(), toolBrowser: false });
    expect(webOff.get('web_scrape')?.disabledReason).toBe('toggle:browser');
    expect(webOff.get('researcher_docs')?.disabledReason).toBe('toggle:browser');
    // download_file is not matched by the web-tool name list — nothing gates it.
    expect(webOff.get('download_file')?.enabled).toBe(true);
  });

  it('unknown and MCP-discovered names default to enabled', () => {
    expect(isToolEnabled('some_server__search', cfg())).toBe(true);
    expect(isToolEnabled('totally_new_tool', cfg())).toBe(true);
  });

  it('toolGate mirrors the toggle mapping', () => {
    expect(toolGate('read_file')).toBe('fs');
    expect(toolGate('execute_command')).toBe('cmd');
    expect(toolGate('git_diff')).toBe('git');
    expect(toolGate('web_scrape')).toBe('browser');
    expect(toolGate('sys_info')).toBeUndefined();
  });
});

describe('plain-chat second gate (no workspace)', () => {
  it('marks fs/cmd/write tools as needing a workspace; web/sys_info/dynamic stay on', () => {
    const map = byName(cfg(), { hasWorkspace: false });
    expect(map.get('read_file')?.disabledReason).toBe('needWorkspace');
    expect(map.get('execute_command')?.disabledReason).toBe('needWorkspace');
    expect(map.get('create_document')?.disabledReason).toBe('needWorkspace');
    expect(map.get('download_file')?.disabledReason).toBe('needWorkspace');
    expect(map.get('web_scrape')?.enabled).toBe(true);
    expect(map.get('sys_info')?.enabled).toBe(true);
    expect(map.get('search_agent_skills')?.enabled).toBe(true);
    expect(map.get('connect_mcp_server')?.enabled).toBe(true);
  });
});

describe('generate_image availability', () => {
  it('reports imageGenUnsupported on the default provider', () => {
    expect(byName().get('generate_image')?.disabledReason).toBe('imageGenUnsupported');
  });

  it('lights up when the provider carries an image model (openai)', () => {
    expect(byName({ ...cfg(), provider: 'openai' }).get('generate_image')?.enabled).toBe(true);
  });
});
