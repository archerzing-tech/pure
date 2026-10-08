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
/** A fake `~/.pure/subagents/` — the write assertions below are only meaningful
 *  if the manifest EXISTS, otherwise every promote case returns early at the
 *  existence check and the red-line assertion becomes tautological. */
const files: Record<string, string> = {};
const writes: Array<{ path: string; content: string }> = [];
let sources: Array<{ file: string; text: string; trialMarker?: string | null }> = [];
let evolution = true;

function resetFiles(): void {
  for (const key of Object.keys(files)) delete files[key];
  writes.length = 0;
}

mock.module('@tauri-apps/api/path', () => ({
  homeDir: () => Promise.resolve('/tmp/pure-q14-fake-home'),
  join: (...parts: string[]) => parts.join('/').replace(/\/\/+/g, '/'),
}));
mock.module('../../shared/tauri', () => ({
  isTauriRuntime: () => true,
  tauriInvoke: async (cmd: string) => {
    calls.push(cmd);
    if (cmd !== 'list_external_subagents') return undefined;
    // Mirror the real scan: it reads each role's sidecar off disk, so a case
    // that just wrote a marker must see it on the next scan. Returning `sources`
    // verbatim would make every write invisible to the reader.
    return sources.map((source) => ({
      ...source,
      // `subagents/` prefix matches the fake disk's keying (args.path is relative
      // to workspace); the real scan resolves the sidecar inside its own dir.
      trialMarker: files[`subagents/${source.file.replace(/\.json$/, '.trial.json')}`] ?? null,
    }));
  },
  loadTauriCore: () => Promise.resolve({
    invoke: async (cmd: string, args?: Record<string, unknown>) => {
      calls.push(cmd);
      if (cmd === 'read_file') {
        const path = String(args?.path ?? '');
        const onDisk = files[path];
        if (onDisk === undefined) throw new Error('ENOENT');
        return onDisk;
      }
      if (cmd === 'write_file') {
        writes.push({ path: String(args?.path ?? ''), content: String(args?.content ?? '') });
        files[String(args?.path ?? '')] = String(args?.content ?? '');
      }
      if (cmd === 'remove_path') {
        // 真命令（lib.rs remove_path）对不存在的路径返回 Ok，不是报错：删除侧
        // 因此不需要先探一次存在，旁挂账可缺也照删。
        const path = String(args?.path ?? '');
        if (files[path] === undefined) return 'Path already absent';
        delete files[path];
        return 'Removed';
      }
      return undefined;
    },
  }),
}));

const NOW = 1_700_000_000_000;
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

// ONE module instance, with the per-run scan cache dropped between cases. An
// earlier version re-imported the module with a `?fresh=` query per case, which
// silently gave `../config` a SECOND instance whose cache `invalidateConfigCache`
// never cleared — every case then read a stale master switch, and the write-path
// assertions were all vacuous. Using the real invalidation is both simpler and a
// test of the thing that actually ships.
import * as delegableRoles from '../delegableRoles';

function withModule(): typeof import('../delegableRoles') {
  calls.length = 0;
  resetFiles();
  delegableRoles.invalidateExternalSubagents();
  return delegableRoles;
}

async function withFreshModule(run: (mod: typeof import('../delegableRoles')) => Promise<void>): Promise<void> {
  await run(withModule());
}

/** A run whose delegations live in the NAMED array (post-T1 shape). */
function delegatingRecord(role: string, delegations: number, successes: number) {
  return {
    type: 'agent_run', sessionId: 's', startedAt: 1_700_000_000_000 - 1000, endedAt: 1_700_000_000_000,
    delegations: Array.from({ length: delegations }, (_, i) => ({ role, success: i < successes })),
    toolCalls: [],
  } as unknown as import('../../shared/promptObservability').AgentRunObservation;
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
describe('试用角标：拿父角色自己的战绩当基线', () => {
  const NOW2 = 1_700_000_000_000;
  function outcome(delegations: number) {
    return { type: 'agent_run', sessionId: 's', startedAt: NOW2 - 1000, endedAt: NOW2, delegations: [], toolCalls: [] } as unknown as import('../../shared/promptObservability').AgentRunObservation;
  }
  function delegating(role: string, delegations: number, successes: number) {
    return {
      ...outcome(delegations),
      delegations: Array.from({ length: delegations }, (_, i) => ({ role, success: i < successes })),
    };
  }
  const records = [
    // 父角色 6 次成 5 → 83%
    delegating('researcher', 6, 5),
    // 生成角色 6 次全成 → 100%，优于父角色
    delegating('researcher_focused', 6, 6),
  ] as unknown as import('../../shared/promptObservability').PromptObservation[];

  /** The fake scan reads the sidecar off the fake disk (like the real Rust), so
   *  a case seeds `files`, not the `trialMarker` field on the source row. */
  async function rolesWithTrial(marker?: Record<string, unknown>) {
    const mod = withModule();               // resets the fake disk FIRST
    sources = [manifest('researcher_focused')];
    if (marker) files['subagents/researcher_focused.trial.json'] = JSON.stringify(marker);
    return mod.loadGeneratedRoles();
  }

  it('没有旁挂账 → 未记父角色，不裁决', async () => {
    const badges = (await withModule()).buildTrialBadges(await rolesWithTrial(), records, NOW2);
    expect(badges['researcher_focused'].label).toContain('未记父角色');
  });

  it('记了父角色且优于它 → 够格转正，evidence 含两侧数字', async () => {
    const badges = (await withModule()).buildTrialBadges(
      await rolesWithTrial({ status: 'trial', parentRole: 'researcher' }), records, NOW2);
    const badge = badges['researcher_focused'];
    expect(badge.label).toBe('够格转正');
    expect(badge.evidence).toContain('100%');
    expect(badge.evidence).toContain('83%');
    // status 决定渲染层用哪个 CSS class：转正后不能还挂 draft 样式。
    expect(badge.status).toBe('trial');
  });

  it('已转正 → label 与 status 都是已转正', async () => {
    const badges = (await withModule()).buildTrialBadges(
      await rolesWithTrial({ status: 'promoted', parentRole: 'researcher' }), records, NOW2);
    expect(badges['researcher_focused'].status).toBe('promoted');
    expect(badges['researcher_focused'].label).toBe('已转正');
  });

  it('比父角色差 → 留在试用里', async () => {
    const weaker = [
      delegating('researcher', 6, 6),
      delegating('researcher_focused', 6, 4),
    ] as unknown as import('../../shared/promptObservability').PromptObservation[];
    const badges = (await withModule()).buildTrialBadges(
      await rolesWithTrial({ status: 'trial', parentRole: 'researcher' }), weaker, NOW2);
    expect(badges['researcher_focused'].label).toContain('不达标');
  });

  it('窗口外的委派不计入（半年前的样本不能给今天的角色背书）', async () => {
    const stale = records.map((r) => ({ ...r, startedAt: NOW2 - 90 * 86_400_000 }));
    const badges = (await withModule()).buildTrialBadges(
      await rolesWithTrial({ status: 'trial', parentRole: 'researcher' }), stale, NOW2);
    expect(badges['researcher_focused'].label).toBe('试用中 · 0/5 次');
  });
});

describe('转正后屏上状态必须立刻变（回归锚点）', () => {
  /** 上一轮把「写盘后缓存失效」修好了，却**没有任何测试钉住它**——五个相关
   *  mutant 全部存活。这一条把整条链走完：转正 → 重新扫描 → 重新判 → 角标变。 */
  it('promote 之后重扫拿到 promoted，按钮随之消失', async () => {
    await withFreshModule(async (mod) => {
      sources = [manifest('researcher_focused')];
      evolution = true;
      mem[STORAGE_KEY] = JSON.stringify({ configVersion: 16, skills: { evolution } });
      invalidateConfigCache();
      files['subagents/researcher_focused.json'] = '{"version":1}';
      files['subagents/researcher_focused.trial.json'] =
        JSON.stringify({ status: 'trial', parentRole: 'researcher', registeredAt: 1 });

      const records = [delegatingRecord('researcher', 6, 6), delegatingRecord('researcher_focused', 6, 6)];
      const before = mod.buildTrialBadges(await mod.loadGeneratedRoles(), records, 1_700_000_000_000);
      expect(before['researcher_focused'].label).toBe('够格转正');

      expect(await mod.promoteGeneratedRole('researcher_focused')).toBe(true);

      // No manual cache invalidation here on purpose: promote must have done it.
      const after = mod.buildTrialBadges(await mod.loadGeneratedRoles(), records, 1_700_000_000_000);
      expect(after['researcher_focused'].status).toBe('promoted');
      expect(after['researcher_focused'].label).toBe('已转正');
    });
  });

  it('总开关中途关掉 → 生成角色立刻从可委派面消失（不再吃委派）', async () => {
    await withFreshModule(async (mod) => {
      sources = [manifest('researcher_focused')];
      evolution = true;
      mem[STORAGE_KEY] = JSON.stringify({ configVersion: 16, skills: { evolution } });
      invalidateConfigCache();
      expect(await mod.loadDelegableRoleNames()).toContain('researcher_focused');

      evolution = false;
      mem[STORAGE_KEY] = JSON.stringify({ configVersion: 16, skills: { evolution } });
      invalidateConfigCache();
      expect(await mod.loadDelegableRoleNames()).not.toContain('researcher_focused');
      expect(await mod.loadGeneratedRoles()).toEqual([]);
    });
  });
});

describe('血缘：模型自取的名字不许被硬绑成父子', () => {
  it('名字派生自父角色才写试用期', async () => {
    expect(delegableRoles.derivesFrom('researcher_focused', 'researcher')).toBe(true);
    expect(delegableRoles.derivesFrom('researcher_v2', 'researcher')).toBe(true);
    expect(delegableRoles.derivesFrom('code_reviewer_v2', 'researcher')).toBe(false);
    expect(delegableRoles.derivesFrom('researcher', 'researcher')).toBe(false);
    expect(delegableRoles.derivesFrom('researcher_focused', '')).toBe(false);
  });

  it('模型给了一个无关名字 → 不写试用期，角色永远停在「未记父角色」', async () => {
    await withFreshModule(async (mod) => {
      evolution = true;
      mem[STORAGE_KEY] = JSON.stringify({ configVersion: 16, skills: { evolution } });
      invalidateConfigCache();
      expect(await mod.startRoleTrial('code_reviewer_v2', 'researcher')).toBe(false);
      expect(writes).toEqual([]);
    });
  });
});

describe('转正写入：红线、路径与内容', () => {
  /** A manifest that exists — without it every case returns at the existence
   *  check and NOTHING below (red line, path, content) is actually exercised. */
  // Keyed on `args.path`, which is RELATIVE to `workspace` — `write_file` takes
  // them separately, so the fake disk mirrors that rather than a joined path.
  function seedManifest(role = 'researcher_focused'): void {
    files[`subagents/${role}.json`] = '{"version":1}';
  }
  function promotionWrites(): typeof writes {
    return writes.filter((w) => w.path.endsWith('.trial.json'));
  }

  it('真走到写盘：只写旁挂账，manifest 逐字节不动', async () => {
    await withFreshModule(async (mod) => {
      sources = [manifest('researcher_focused')];
      evolution = true;
      mem[STORAGE_KEY] = JSON.stringify({ configVersion: 16, skills: { evolution } });
      invalidateConfigCache();
      seedManifest();
      const manifestPath = 'subagents/researcher_focused.json';
      const before = files[manifestPath];

      expect(await mod.promoteGeneratedRole('researcher_focused')).toBe(true);
      expect(promotionWrites()).toHaveLength(1);
      expect(promotionWrites()[0].path).toBe('subagents/researcher_focused.trial.json');
      expect(files[manifestPath]).toBe(before);
    });
  });

  it('总开关关着时不写任何文件（manifest 存在，所以这条不是恒真的）', async () => {
    await withFreshModule(async (mod) => {
      sources = [manifest('researcher_focused')];
      evolution = false;
      mem[STORAGE_KEY] = JSON.stringify({ configVersion: 16, skills: { evolution } });
      invalidateConfigCache();
      seedManifest();
      expect(await mod.promoteGeneratedRole('researcher_focused')).toBe(false);
      expect(writes).toEqual([]);
    });
  });

  it('开关开着且 manifest 存在时**确实**会写（否则上一条恒真）', async () => {
    await withFreshModule(async (mod) => {
      sources = [manifest('researcher_focused')];
      evolution = true;
      mem[STORAGE_KEY] = JSON.stringify({ configVersion: 16, skills: { evolution } });
      invalidateConfigCache();
      seedManifest();
      expect(await mod.promoteGeneratedRole('researcher_focused')).toBe(true);
      expect(promotionWrites().length).toBeGreaterThan(0);
    });
  });

  it('manifest 已不在时不留下孤儿标记', async () => {
    await withFreshModule(async (mod) => {
      sources = [manifest('researcher_focused')];
      evolution = true;
      mem[STORAGE_KEY] = JSON.stringify({ configVersion: 16, skills: { evolution } });
      invalidateConfigCache();
      // no seedManifest(): read_file throws → nothing to promote
      expect(await mod.promoteGeneratedRole('researcher_focused')).toBe(false);
      expect(writes).toEqual([]);
    });
  });

  it('角色名不合法时一条命令都不发（连读盘都没有）', async () => {
    await withFreshModule(async (mod) => {
      for (const bad of ['../escape', '../../etc/passwd', '', 'UPPER', 'a', './x', 'a/b', 'a-b', 'x'.repeat(80), 'execute_command']) {
        calls.length = 0;
        expect(await mod.promoteGeneratedRole(bad)).toBe(false);
        expect(calls).toEqual([]);
      }
    });
  });

  it('写出的标记含 status/decidedAt，且保留既有 parentRole 与 registeredAt', async () => {
    await withFreshModule(async (mod) => {
      sources = [manifest('researcher_focused')];
      evolution = true;
      mem[STORAGE_KEY] = JSON.stringify({ configVersion: 16, skills: { evolution } });
      invalidateConfigCache();
      seedManifest();
      // 已有旁挂账：转正必须只改状态，不能把父角色与注册时间抹掉。
      files['subagents/researcher_focused.trial.json'] =
        JSON.stringify({ status: 'trial', parentRole: 'researcher', registeredAt: 111 });

      expect(await mod.promoteGeneratedRole('researcher_focused')).toBe(true);
      const written = JSON.parse(writes.find((w) => w.path.endsWith('.trial.json'))!.content);
      expect(written.status).toBe('promoted');
      expect(written.parentRole).toBe('researcher');
      expect(written.registeredAt).toBe(111);
      expect(typeof written.decidedAt).toBe('number');
    });
  });

  it('开试用期把父角色记进去 —— 这是转正能被触发的唯一前提', async () => {
    await withFreshModule(async (mod) => {
      sources = [manifest('researcher_focused')];
      evolution = true;
      mem[STORAGE_KEY] = JSON.stringify({ configVersion: 16, skills: { evolution } });
      invalidateConfigCache();

      expect(await mod.startRoleTrial('researcher_focused', 'researcher')).toBe(true);
      const written = JSON.parse(writes[0].content);
      expect(written).toMatchObject({ status: 'trial', parentRole: 'researcher' });
      expect(typeof written.registeredAt).toBe('number');
      // 写完盘缓存即失效，角标下一次渲染就能看见（否则用户点完转正看到的是旧状态）
      const after = await mod.loadGeneratedRoles();
      expect(after.map((r) => r.def.name)).toContain('researcher_focused');
      expect(after.find((r) => r.def.name === 'researcher_focused')?.trial.parentRole).toBe('researcher');
    });
  });

  it('开试用期也守总开关与名字校验', async () => {
    await withFreshModule(async (mod) => {
      evolution = false;
      mem[STORAGE_KEY] = JSON.stringify({ configVersion: 16, skills: { evolution } });
      invalidateConfigCache();
      expect(await mod.startRoleTrial('researcher_focused', 'researcher')).toBe(false);
      expect(writes).toEqual([]);
      evolution = true;
      mem[STORAGE_KEY] = JSON.stringify({ configVersion: 16, skills: { evolution } });
      invalidateConfigCache();
      expect(await mod.startRoleTrial('../escape', 'researcher')).toBe(false);
    });
  });
});

describe('转正落盘要留下「凭什么」', () => {
  /** 上一次复验查出的：转正当时算出来的两侧数字一个都没落盘，reason 只是
   *  一句常量结论。于是下一次问「这个角色凭什么转正的」只能靠猜。 */
  it('把用户点击时看到的那组数字写进 reason', async () => {
    await withFreshModule(async (mod) => {
      sources = [manifest('researcher_focused')];
      evolution = true;
      mem[STORAGE_KEY] = JSON.stringify({ configVersion: 16, skills: { evolution } });
      invalidateConfigCache();
      files['subagents/researcher_focused.json'] = '{"version":1}';
      files['subagents/researcher_focused.trial.json'] =
        JSON.stringify({ status: 'trial', parentRole: 'researcher', registeredAt: 1 });

      const evidence = '本角色 6 次委派成功 100%（6/6），父角色 researcher 8 次成功 100%（8/8）';
      expect(await mod.promoteGeneratedRole('researcher_focused', evidence)).toBe(true);
      const written = JSON.parse(writes.find((w) => w.path.endsWith('.trial.json'))!.content);
      expect(written.reason).toContain('researcher_focused');
      expect(written.reason).toContain(evidence);
    });
  });

  it('没传证据时退回结论串，而不是丢掉 reason 字段', async () => {
    await withFreshModule(async (mod) => {
      sources = [manifest('researcher_focused')];
      evolution = true;
      mem[STORAGE_KEY] = JSON.stringify({ configVersion: 16, skills: { evolution } });
      invalidateConfigCache();
      files['subagents/researcher_focused.json'] = '{"version":1}';
      expect(await mod.promoteGeneratedRole('researcher_focused')).toBe(true);
      expect(JSON.parse(writes.find((w) => w.path.endsWith('.trial.json'))!.content).reason).toContain('父角色');
    });
  });
});

describe('13.2 归档：隔离不删，且可重新启用', () => {
  function setEvolution(on: boolean): void {
    evolution = on;
    mem[STORAGE_KEY] = JSON.stringify({ configVersion: 16, skills: { evolution: on } });
    invalidateConfigCache();
  }
  function seedRole(role = 'researcher_focused', marker?: Record<string, unknown>): void {
    files[`subagents/${role}.json`] = '{"version":1}';
    if (marker) files[`subagents/${role}.trial.json`] = JSON.stringify(marker);
  }
  function trialWrites(): typeof writes {
    return writes.filter((w) => w.path.endsWith('.trial.json'));
  }

  it('归档只改旁挂账：manifest 逐字节不动，状态变 archived 且留下理由', async () => {
    await withFreshModule(async (mod) => {
      sources = [manifest('researcher_focused')];
      setEvolution(true);
      seedRole('researcher_focused', { status: 'trial', parentRole: 'researcher', registeredAt: 111 });
      const manifestPath = 'subagents/researcher_focused.json';
      const before = files[manifestPath];

      const evidence = '本角色 6 次委派成功 17%（1/6），父角色 researcher 12 次成功 83%（10/12）';
      expect(await mod.archiveGeneratedRole('researcher_focused', evidence)).toBe(true);
      expect(trialWrites()).toHaveLength(1);
      const written = JSON.parse(trialWrites()[0].content);
      expect(written.status).toBe('archived');
      // 血缘是角色的事实，不是裁决的附属品：归档不该把它抹掉。
      expect(written.parentRole).toBe('researcher');
      expect(written.registeredAt).toBe(111);
      expect(typeof written.archivedAt).toBe('number');
      expect(written.reason).toContain(evidence);
      // 隔离而不是删除：manifest 是用户的文件，这道门不碰它。
      expect(files[manifestPath]).toBe(before);
    });
  });

  it('归档把角色从可委派面拿掉，但它仍留在仪表盘读得到的那份名单里', async () => {
    await withFreshModule(async (mod) => {
      sources = [manifest('researcher_focused')];
      setEvolution(true);
      seedRole();
      expect(await mod.loadDelegableRoleNames()).toContain('researcher_focused');

      expect(await mod.archiveGeneratedRole('researcher_focused')).toBe(true);

      // 不清缓存：归档必须自己失效缓存，否则「今天不再被委派」不成立，
      // 而这一刀的全部意义就是不成立。
      expect(await mod.loadDelegableRoleNames()).not.toContain('researcher_focused');
      const generated = await mod.loadGeneratedRoles();
      expect(generated.map((entry) => entry.def.name)).toContain('researcher_focused');
      expect(generated.find((entry) => entry.def.name === 'researcher_focused')?.trial.status).toBe('archived');
    });
  });

  it('归档也守红线与保留名：开关关着 / 名字不合法 / 撞内建，一条命令都不发', async () => {
    await withFreshModule(async (mod) => {
      setEvolution(false);
      seedRole();
      expect(await mod.archiveGeneratedRole('researcher_focused')).toBe(false);
      expect(writes).toEqual([]);

      setEvolution(true);
      for (const bad of ['../escape', '', 'UPPER', 'execute_command', 'researcher']) {
        calls.length = 0;
        expect(await mod.archiveGeneratedRole(bad)).toBe(false);
        expect(calls).toEqual([]);
      }
    });
  });

  it('manifest 已不在 → 不留下孤儿旁挂账（它得比 manifest 短命）', async () => {
    await withFreshModule(async (mod) => {
      sources = [manifest('researcher_focused')];
      setEvolution(true);
      // 不 seed manifest：读盘抛错 → 没有可归档的角色。
      expect(await mod.archiveGeneratedRole('researcher_focused')).toBe(false);
      expect(writes).toEqual([]);
    });
  });

  it('重新启用：回到试用态、血缘保留、注册时刻重置（那就是「一段新的试用期」）', async () => {
    await withFreshModule(async (mod) => {
      sources = [manifest('researcher_focused')];
      setEvolution(true);
      seedRole('researcher_focused', {
        status: 'archived', parentRole: 'researcher', registeredAt: 111, decidedAt: 222, archivedAt: 222, reason: '旧结论',
      });
      const before = Date.now();
      expect(await mod.restoreGeneratedRole('researcher_focused')).toBe(true);
      const written = JSON.parse(trialWrites()[0].content);
      expect(written.status).toBe('trial');
      expect(written.parentRole).toBe('researcher');
      // 不重置就是「恢复 → 下一次扫掠立刻再归档」的死循环。
      expect(written.registeredAt).toBeGreaterThanOrEqual(before);
      // 已经过去的裁决不该挂在一段正在进行的试用期上。
      expect(written.reason).toBeUndefined();
      expect(written.decidedAt).toBeUndefined();
      expect(await mod.loadDelegableRoleNames()).toContain('researcher_focused');
    });
  });

  it('没被归档的角色不能「重新启用」（那是在改一个不存在的状态）', async () => {
    await withFreshModule(async (mod) => {
      sources = [manifest('researcher_focused')];
      setEvolution(true);
      seedRole('researcher_focused', { status: 'trial', parentRole: 'researcher', registeredAt: 111 });
      expect(await mod.restoreGeneratedRole('researcher_focused')).toBe(false);
      expect(writes).toEqual([]);
    });
  });

  it('没有旁挂账就没有可恢复的归档态', async () => {
    await withFreshModule(async (mod) => {
      sources = [manifest('researcher_focused')];
      setEvolution(true);
      seedRole();
      expect(await mod.restoreGeneratedRole('researcher_focused')).toBe(false);
      expect(writes).toEqual([]);
    });
  });

  it('已归档的角色不再被裁决成「够格转正」', async () => {
    await withFreshModule(async (mod) => {
      sources = [manifest('researcher_focused')];
      setEvolution(true);
      seedRole('researcher_focused', { status: 'archived', parentRole: 'researcher', registeredAt: 1 });
      const records = [
        delegatingRecord('researcher', 6, 5),
        delegatingRecord('researcher_focused', 6, 6),
      ] as unknown as import('../../shared/promptObservability').PromptObservation[];
      const badges = mod.buildTrialBadges(await mod.loadGeneratedRoles(), records, NOW);
      expect(badges['researcher_focused'].label).toBe('已归档');
    });
  });

  it('试用窗口从注册时刻起算：重新启用后的新试用期不读当年那批委派', async () => {
    await withFreshModule(async (mod) => {
      sources = [manifest('researcher_focused')];
      setEvolution(true);
      const day = 24 * 60 * 60 * 1000;
      // 委派都在 10 天前，而重新启用发生在 1 天前。没有窗口下界的话，这组读数
      // （子 100% vs 父 83%）会读成「够格转正」——同一个角色被归档后又立刻回来。
      seedRole('researcher_focused', { status: 'trial', parentRole: 'researcher', registeredAt: NOW - day });
      const records = [
        { ...delegatingRecord('researcher', 6, 5), startedAt: NOW - 10 * day },
        { ...delegatingRecord('researcher_focused', 6, 6), startedAt: NOW - 10 * day },
      ] as unknown as import('../../shared/promptObservability').PromptObservation[];
      const badges = mod.buildTrialBadges(await mod.loadGeneratedRoles(), records, NOW);
      expect(badges['researcher_focused'].label).toBe('试用中 · 0/5 次');
    });
  });
});

describe('13.2 归档：彻底删除是一颗按钮，不是一句文案', () => {
  function setEvolution(on: boolean): void {
    evolution = on;
    mem[STORAGE_KEY] = JSON.stringify({ configVersion: 16, skills: { evolution: on } });
    invalidateConfigCache();
  }

  it('删掉 manifest 与旁挂账，下一次扫描就看不见它了', async () => {
    await withFreshModule(async (mod) => {
      sources = [manifest('researcher_focused')];
      setEvolution(true);
      files['subagents/researcher_focused.json'] = sources[0].text;
      files['subagents/researcher_focused.trial.json'] = JSON.stringify({ status: 'archived', archivedAt: NOW });
      // 先扫一遍：让缓存里有它，这样才能证明删除自己失效了缓存（否则"没了"
      // 可能只是碰巧没扫过）。
      expect((await mod.loadGeneratedRoles()).map((e) => e.def.name)).toContain('researcher_focused');

      expect(await mod.deleteGeneratedRole('researcher_focused')).toBe(true);
      expect(files['subagents/researcher_focused.json']).toBeUndefined();
      expect(files['subagents/researcher_focused.trial.json']).toBeUndefined();
      // 样本目录故意不动：删 manifest 不是对证据的表态。
      sources = [];
      expect((await mod.loadGeneratedRoles()).some((e) => e.def.name === 'researcher_focused')).toBe(false);
    });
  });

  it('盘上没有这个角色 → 返回 false，且一条删除命令都不发', async () => {
    await withFreshModule(async (mod) => {
      setEvolution(true);
      expect(await mod.deleteGeneratedRole('researcher_focused')).toBe(false);
      expect(calls).not.toContain('remove_path');
    });
  });

  it('守红线：开关关着 / 名字不合法 / 撞内建工具名，一条命令都不发', async () => {
    await withFreshModule(async (mod) => {
      files['subagents/researcher_focused.json'] = manifest('researcher_focused').text;
      setEvolution(false);
      expect(await mod.deleteGeneratedRole('researcher_focused')).toBe(false);
      setEvolution(true);
      for (const bad of ['../escape', '', 'UPPER', 'execute_command', 'researcher']) {
        calls.length = 0;
        expect(await mod.deleteGeneratedRole(bad)).toBe(false);
        expect(calls).not.toContain('remove_path');
      }
      // 对照：合法名字确实会发命令，所以上面那条不是因为全都拒绝。
      expect(await mod.deleteGeneratedRole('researcher_focused')).toBe(true);
      expect(calls).toContain('remove_path');
    });
  });
});

describe('生成角色解得进 overlay 入口', () => {
  it('findRoleDefinition 先认内建，再认盘上的生成角色', async () => {
    await withFreshModule(async (mod) => {
      sources = [manifest('researcher_focused')];
      expect((await mod.findRoleDefinition('researcher'))?.name).toBe('researcher');
      // 只查内建名单时这里返回 undefined，按钮于是必报「无效角色」——
      // 而渲染那颗按钮的建议卡，其角色面本来就已经含生成角色。
      expect((await mod.findRoleDefinition('researcher_focused'))?.name).toBe('researcher_focused');
      expect(await mod.findRoleDefinition('nobody_home')).toBeUndefined();
    });
  });

  it('allRoleNames 含内建与生成角色，已归档的也算（它是盘上存在的合法目标）', async () => {
    await withFreshModule(async (mod) => {
      sources = [manifest('researcher_focused')];
      files['subagents/researcher_focused.trial.json'] = JSON.stringify({ status: 'archived', archivedAt: NOW });
      const names = await mod.allRoleNames();
      expect(names).toContain('researcher');
      expect(names).toContain('researcher_focused');
      // 对照：可委派面把它排除在外，两份名单的差别就是归档的含义。
      expect(await mod.loadDelegableRoleNames()).not.toContain('researcher_focused');
    });
  });
});
