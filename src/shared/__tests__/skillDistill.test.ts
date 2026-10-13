// src/shared/__tests__/skillDistill.test.ts
// E2.2 — 沉淀指令识别、来源挑选、SKILL.md 解析/净化、LLM 往返，以及 CLI
// 落盘 → parseSkillMarkdown 回读的闭环（loadAppSkills 就是这么读的，等于
// 验了「下个会话 <skills> 可见」的前半段）。

import { describe, it, expect } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import type { MemoryEntry } from '../types';
import {
  distillSkill,
  matchSkillDistillInstruction,
  parseDistilledSkill,
  pickDistillSource,
  type DistillLlm,
} from '../skillDistill';
import { parseSkillMarkdown } from '../skillFiles';
import { skillsRootDir, writeAutoSkillDir } from '../../cliSkillStore';
import { PURE_DIR } from '../../cliConfig';

function entry(overrides: Partial<MemoryEntry>): MemoryEntry {
  return {
    id: `m_${Math.random().toString(36).slice(2)}`,
    type: 'successful_pattern',
    content: 'x',
    timestamp: Date.now(),
    sessionId: 's',
    projectPath: '/p',
    ...overrides,
  };
}

describe('matchSkillDistillInstruction', () => {
  it('matches the Chinese phrasings', () => {
    expect(matchSkillDistillInstruction('把这个做法沉淀成技能')).toBe('把这个做法沉淀成技能');
    expect(matchSkillDistillInstruction('帮我把刚才的流程保存成技能')).toBeTruthy();
    expect(matchSkillDistillInstruction('这套步骤整理成一个技能')).toBeTruthy();
  });

  it('matches the English phrasings', () => {
    expect(matchSkillDistillInstruction('save this as a skill')).toBeTruthy();
    expect(matchSkillDistillInstruction('distill that into a skill please')).toBeTruthy();
    expect(matchSkillDistillInstruction('turn the approach into a reusable skill')).toBeTruthy();
  });

  it('ignores unrelated messages mentioning skills', () => {
    expect(matchSkillDistillInstruction('教我一种学习技能的方法')).toBeNull();
    expect(matchSkillDistillInstruction('list the installed skills')).toBeNull();
    expect(matchSkillDistillInstruction('帮我写一个爬虫')).toBeNull();
    expect(matchSkillDistillInstruction('')).toBeNull();
  });
});

describe('pickDistillSource', () => {
  it('prefers the newest procedure memory', () => {
    const t = Date.now();
    const source = pickDistillSource([
      entry({ type: 'procedure', content: 'old procedure', timestamp: t - 1000 }),
      entry({ type: 'procedure', content: 'new procedure', timestamp: t }),
      entry({ type: 'successful_pattern', content: 'reflect lesson', timestamp: t + 500, dedupeKey: 'reflect:s1:task' }),
    ]);
    expect(source?.content).toBe('new procedure');
  });

  it('falls back to the newest reflected lesson when no procedure exists', () => {
    const t = Date.now();
    const source = pickDistillSource([
      entry({ content: 'plain success — not a source', timestamp: t + 999 }),
      entry({ content: 'older lesson', timestamp: t, dedupeKey: 'reflect:a:x' }),
      entry({ content: 'newer lesson', timestamp: t + 1, dedupeKey: 'reflect:b:y' }),
    ]);
    expect(source?.content).toBe('newer lesson');
  });

  it('returns undefined on an empty store', () => {
    expect(pickDistillSource([])).toBeUndefined();
    expect(pickDistillSource([entry({ content: 'plain' })])).toBeUndefined();
  });
});

const GOOD_REPLY = `---\nname: recover git rebase\ndescription: Unstick a rebase that stops mid-way\n---\n\n## When to use\nA rebase stopped with conflicts.\n\n1. Run git status\n2. Resolve conflicts\n3. Verify with git log`;

describe('parseDistilledSkill', () => {
  it('parses a plain reply and forces the auto- prefix', () => {
    const skill = parseDistilledSkill(GOOD_REPLY);
    expect(skill).not.toBeNull();
    expect(skill!.name).toBe('auto-recover-git-rebase');
    expect(skill!.description).toBe('Unstick a rebase that stops mid-way');
    expect(skill!.body).toContain('git status');
    expect(skill!.markdown).toMatch(/^---\nname: auto-recover-git-rebase\n/);
  });

  it('tolerates code fences and surrounding prose', () => {
    const skill = parseDistilledSkill(`Sure, here is the skill:\n\`\`\`markdown\n${GOOD_REPLY}\n\`\`\`\nHope that helps!`);
    expect(skill?.name).toBe('auto-recover-git-rebase');
  });

  it('keeps an existing auto- prefix and strips illegal characters', () => {
    const skill = parseDistilledSkill('---\nname: Auto_Fetch Retry!!\ndescription: d\n---\nbody here');
    expect(skill?.name).toBe('auto-auto_fetch-retry');
  });

  it('falls back to a dated name when nothing usable remains', () => {
    const skill = parseDistilledSkill('---\nname: !!\ndescription: d\n---\nbody here');
    expect(skill?.name).toMatch(/^auto-skill-\d{8}$/);
  });

  it('rejects replies without a usable skill', () => {
    expect(parseDistilledSkill('just prose, no frontmatter')).toBeNull();
    expect(parseDistilledSkill('---\nname: x\ndescription: d\n---\n   \n')).toBeNull();
  });
});

describe('distillSkill', () => {
  const fakeLlm = (reply: () => string): DistillLlm => ({
    complete: async () => ({ content: reply() }),
  });

  it('round-trips a good reply into a skill', async () => {
    const skill = await distillSkill(fakeLlm(() => GOOD_REPLY), 'procedure notes', '沉淀成技能');
    expect(skill?.name).toBe('auto-recover-git-rebase');
  });

  it('resolves undefined on transport failure or garbage', async () => {
    const throwing: DistillLlm = { complete: async () => { throw new Error('boom'); } };
    expect(await distillSkill(throwing, 'notes', '')).toBeUndefined();
    expect(await distillSkill(fakeLlm(() => 'no frontmatter at all'), 'notes', '')).toBeUndefined();
  });

  it('resolves undefined when the model hangs past the timeout', async () => {
    const hanging: DistillLlm = { complete: () => new Promise(() => {}) };
    expect(await distillSkill(hanging, 'notes', '', undefined, 20)).toBeUndefined();
  });
});

describe('writeAutoSkillDir (CLI 落盘闭环)', () => {
  it('writes a SKILL.md that parseSkillMarkdown reads back identically', () => {
    const root = mkdtempSync(join(tmpdir(), 'pure-skill-write-'));
    try {
      const skill = parseDistilledSkill(GOOD_REPLY)!;
      const dir = writeAutoSkillDir(skill, root);
      expect(dir).toBe(join(root, 'auto-recover-git-rebase'));

      const parsed = parseSkillMarkdown(readFileSync(join(dir, 'SKILL.md'), 'utf8'));
      expect(parsed?.name).toBe('auto-recover-git-rebase');
      expect(parsed?.body).toBe(skill.body);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('refuses names that could escape the skills directory', () => {
    const root = mkdtempSync(join(tmpdir(), 'pure-skill-write-'));
    try {
      const skill = { ...parseDistilledSkill(GOOD_REPLY)!, name: '../escape' };
      expect(() => writeAutoSkillDir(skill, root)).toThrow(/unsafe skill name/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  // 审计批 5⑤：根目录口径必须与 cliRepl 的读取面同源（cliConfig 的
  // HOME || os.homedir()）。旧口径 HOME || '' 在无 HOME 的环境落到
  // /.pure/skills——写「成功」却永远没人读。
  //
  // 判别性说明（评审批 5 P2-2）：本进程里 HOME 恒有值，进程内断言
  // `skillsRootDir() === join(PURE_DIR, 'skills')` 对新旧代码同样成立，咬不动
  // 这条回归。基座口径在模块加载期定格，无法进程内模拟「无 HOME」——用子
  // 进程把 HOME 整个摘掉：新代码落 os.homedir() 的家目录，旧代码落 '/.pure'。
  // 这个测试在任何开发机上都判得动红绿。
  it('skillsRootDir falls back to os.homedir() when HOME is missing (subprocess)', () => {
    const probe = `
      import { skillsRootDir } from ${JSON.stringify(join(import.meta.dir, '..', '..', 'cliSkillStore.ts'))};
      console.log(skillsRootDir());
    `;
    const { HOME: _drop, ...envWithoutHome } = process.env;
    const proc = Bun.spawnSync(['bun', '-e', probe], {
      env: envWithoutHome as Record<string, string>,
      stdout: 'pipe',
      stderr: 'pipe',
    });
    expect(proc.exitCode).toBe(0);
    // 与 cliConfig 同源：无 HOME 时读 os.homedir()，而不是落 '/.pure/skills'。
    expect(proc.stdout.toString().trim()).toBe(join(homedir(), '.pure', 'skills'));
  });

  it('skillsRootDir honors PURE_SKILLS_DIR overrides at call time', () => {
    const prev = process.env.PURE_SKILLS_DIR;
    try {
      process.env.PURE_SKILLS_DIR = '   ';
      expect(skillsRootDir()).toBe(join(PURE_DIR, 'skills')); // 纯空白不算覆盖
      process.env.PURE_SKILLS_DIR = '/tmp/pure-skills-elsewhere';
      expect(skillsRootDir()).toBe(join('/tmp/pure-skills-elsewhere', 'skills'));
    } finally {
      if (prev === undefined) delete process.env.PURE_SKILLS_DIR;
      else process.env.PURE_SKILLS_DIR = prev;
    }
  });
});
