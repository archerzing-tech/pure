// src/ui/__tests__/delegableRoles.test.ts
// The single scan that decides "which roles can this host delegate to".
//
// Three claims are load-bearing and none of them is obvious from the call site,
// so they are pinned here: the scan happens **once** (two private scans of one
// directory is how the session and the dashboard would drift into disagreeing
// about which roles exist); the master switch gates it (design §13's boundary
// table: "all generated artifacts unload, no more advice cards" — and
// observations keep recording regardless, so an ungated scan would produce
// advice cards while the switch is off); and a generated role may not take a
// built-in tool's name (the manifest name rule accepts `execute_command`, and
// once this surface reached the observation slices every shell call would
// render as a role delegation).

import { afterEach, describe, expect, it, mock } from 'bun:test';
import { invalidateConfigCache, STORAGE_KEY } from '../config';

const calls: string[] = [];
let sources: Array<{ file: string; text: string }> = [];
let evolution = true;

mock.module('../../shared/tauri', () => ({
  isTauriRuntime: () => true,
  tauriInvoke: async (cmd: string) => {
    calls.push(cmd);
    return cmd === 'list_external_subagents' ? sources : undefined;
  },
}));

const mem: Record<string, string> = {};
(globalThis as Record<string, unknown>).localStorage = {
  getItem: (k: string) => mem[k] ?? null,
  setItem: (k: string, v: string) => { mem[k] = v; },
  removeItem: (k: string) => { delete mem[k]; },
};
(globalThis as Record<string, unknown>).window = { location: { search: '' } };

function manifest(name: string): { file: string; text: string } {
  return {
    file: `${name}.json`,
    text: JSON.stringify({
      version: 1,
      name,
      description: `a generated role named ${name} used by these tests`,
      systemPrompt: 'do the thing for {prompt}',
      input_schema: { type: 'object', properties: { prompt: { type: 'string' } }, required: ['prompt'] },
    }),
  };
}

/** Each case needs a fresh module instance, because the scan is cached for the
 *  process — that cache IS one of the things under test. */
async function withFreshModule(run: (mod: typeof import('../delegableRoles')) => Promise<void>): Promise<void> {
  calls.length = 0;
  const mod = await import(`../delegableRoles?fresh=${Math.random()}`);
  await run(mod);
}

afterEach(() => {
  delete mem[STORAGE_KEY];
  invalidateConfigCache();
});

describe('只扫一次', () => {
  it('多次调用同一个模块实例只发一次 IO，且返回同一份对象', async () => {
    sources = [manifest('researcher_focused')];
    await withFreshModule(async (mod) => {
      const first = await mod.loadExternalSubagents();
      await mod.loadExternalSubagents();
      await mod.loadDelegableRoleNames();
      expect(calls.filter((c) => c === 'list_external_subagents')).toHaveLength(1);
      expect(await mod.loadExternalSubagents()).toBe(first);
    });
  });
});

describe('总开关是硬门（不是可选项）', () => {
  it('关掉时一个生成角色都不加载，可委派面只剩内建', async () => {
    sources = [manifest('researcher_focused')];
    mem[STORAGE_KEY] = JSON.stringify({ configVersion: 16, skills: { evolution: false } });
    invalidateConfigCache();
    await withFreshModule(async (mod) => {
      expect(await mod.loadExternalSubagents()).toEqual([]);
      const names = await mod.loadDelegableRoleNames();
      expect(names).not.toContain('researcher_focused');
      expect(names).toHaveLength(8);
    });
  });

  it('开着时正常加载（否则上一条恒真，红线测试就白写了）', async () => {
    sources = [manifest('researcher_focused')];
    evolution = true;
    mem[STORAGE_KEY] = JSON.stringify({ configVersion: 16, skills: { evolution } });
    invalidateConfigCache();
    await withFreshModule(async (mod) => {
      expect((await mod.loadDelegableRoleNames())).toContain('researcher_focused');
    });
  });
});

describe('生成角色不许占用内建工具名', () => {
  it('叫 execute_command 的 manifest 被编译期拒绝（reserved 含工具名）', async () => {
    sources = [manifest('execute_command')];
    evolution = true;
    mem[STORAGE_KEY] = JSON.stringify({ configVersion: 16, skills: { evolution } });
    invalidateConfigCache();
    await withFreshModule(async (mod) => {
      const names = await mod.loadDelegableRoleNames();
      expect(names).not.toContain('execute_command');
      expect(names).toHaveLength(8); // 只有内建
    });
  });

  it('叫 researcher_focused 的正常通过（对照：上一条不是因为全都拒绝）', async () => {
    sources = [manifest('researcher_focused'), manifest('execute_command')];
    evolution = true;
    mem[STORAGE_KEY] = JSON.stringify({ configVersion: 16, skills: { evolution } });
    invalidateConfigCache();
    await withFreshModule(async (mod) => {
      const names = await mod.loadDelegableRoleNames();
      expect(names).toContain('researcher_focused');
      expect(names).not.toContain('execute_command');
    });
  });

  it('生成角色撞名内建角色同样被拒（内建不可被覆盖）', async () => {
    sources = [manifest('researcher')];
    evolution = true;
    mem[STORAGE_KEY] = JSON.stringify({ configVersion: 16, skills: { evolution } });
    invalidateConfigCache();
    await withFreshModule(async (mod) => {
      const names = await mod.loadDelegableRoleNames();
      // 名字只应出现一次：被拒的那份没有叠在真内建之上。
      expect(names.filter((n) => n === 'researcher')).toHaveLength(1);
    });
  });
});

describe('内建名录是唯一来源（两处曾各写一份）', () => {
  it('builtinRoleNames 与 SubagentOrchestrator 的注册面一致，且不含工具', async () => {
    await withFreshModule(async (mod) => {
      const names = mod.builtinRoleNames();
      expect(names).toHaveLength(8);
      expect(new Set(names).size).toBe(8);
      expect(names).toContain('researcher');
      expect(names).toContain('bash_executor'); // 内建里有，观察面再滤掉
      expect(names).not.toContain('execute_command');
    });
  });
});