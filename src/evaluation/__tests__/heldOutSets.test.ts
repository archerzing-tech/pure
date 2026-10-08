// src/evaluation/__tests__/heldOutSets.test.ts
// P1-3 — held-out 装载测试。核心契约只有一条：**缺席不是错误**。
//
// 这条契约是 CI 安全性的全部依据——held-out 目录是用户本地的，仓库里没有、
// 也不该有。所以任何"目录不存在就抛错/退出非零"的写法都会把 CI 门禁
// （bun test + eval:sanity）打红，而 CI 根本不需要 held-out。

import { afterEach, describe, expect, it } from 'bun:test';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  describeHeldOut,
  expandHome,
  heldOutRoot,
  isCodingTaskFixture,
  loadHeldOutCodingTasks,
  loadHeldOutRoleCases,
} from '../heldOutSets';
import { isRoleCaseFixture } from '../roleRegression';
import { CODING_TASK_FIXTURES } from '../codingTaskBaseline';
import { MIN_ROLE_CASES } from '../roleRegression';

const roots: string[] = [];
async function tempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'pure-heldout-test-'));
  roots.push(root);
  return root;
}

const VALID_CODING = {
  id: 'held-fix-dup-merge',
  category: 'bugfix',
  difficulty: 'easy',
  prompt: 'Merge two sorted lists without using extra space beyond the output buffer.',
  files: { 'src/merge.ts': 'export function merge(a: number[], b: number[]): number[] { return []; }\n' },
  verification: [{ name: 'tests', command: 'bun', args: ['test'] }],
};

const VALID_ROLE_CASE = {
  id: 'held-01',
  description: 'held-out 题目',
  args: { topic: 'a topic never used while drafting the overlay', sources: 'both', scope: '2026 facts' },
  must: ['来源'],
};

afterEach(async () => {
  while (roots.length > 0) await rm(roots.pop()!, { recursive: true, force: true });
});

describe('held-out 缺席语义（CI 不受影响的全部依据）', () => {
  it('目录不存在 → 空集，不是错误', async () => {
    const coding = await loadHeldOutCodingTasks(join(await tempRoot(), 'never-created'));
    expect(coding.fixtures).toEqual([]);
    expect(coding.issues).toEqual([]);
  });

  it('目录存在但没有 json → 空集', async () => {
    const root = await tempRoot();
    await mkdir(join(root, 'coding'), { recursive: true });
    await writeFile(join(root, 'coding', 'README.md'), 'not a fixture', 'utf8');
    const coding = await loadHeldOutCodingTasks(root);
    expect(coding.fixtures).toEqual([]);
    expect(coding.issues).toEqual([]);
  });

  it('角色目录不存在 → 空集（每个角色各判一次，不假设目录形状）', async () => {
    const role = await loadHeldOutRoleCases('researcher', await tempRoot());
    expect(role.fixtures).toEqual([]);
  });

  it('空 role 名不碰文件系统直接返回空集', async () => {
    expect((await loadHeldOutRoleCases('  ')).fixtures).toEqual([]);
  });

  it('--heldout-dir 指向一个普通文件时也是「没有题目」，不是崩溃', async () => {
    // ENOTDIR used to escape the loader and take the whole process down AFTER
    // the gate had already printed its verdict — turning an ALLOW into exit 1
    // with no report on disk. A mistyped path must read as "nothing to hold out".
    const root = await tempRoot();
    const notADir = join(root, 'i-am-a-file');
    await writeFile(notADir, 'not a directory', 'utf8');
    expect((await loadHeldOutCodingTasks(notADir)).fixtures).toEqual([]);
    expect((await loadHeldOutRoleCases('researcher', notADir)).fixtures).toEqual([]);
  });

  it('expandHome 展开 ~ 前缀，非 ~ 开头原样 resolve', () => {
    // 期望值只能用跨平台原语表达：HOME 环境变量在 Windows runner 上未必存在
    // （那边是 USERPROFILE），'/abs/x' 会被 win32 resolve 成 'C:\abs\x'——
    // 写死 POSIX 字面量就是给发布门埋雷（v3.1.1-beta 首打实测）。
    expect(expandHome('~/x')).toBe(join(homedir(), 'x'));
    expect(expandHome('~')).toBe(homedir());
    const absolute = join(resolve('/'), 'abs', 'x');
    expect(expandHome(absolute)).toBe(absolute);
  });

  it('heldOutRoot 认 PURE_EVAL_HELDOUT_DIR，且展开 ~ 前缀', () => {
    const previous = process.env.PURE_EVAL_HELDOUT_DIR;
    try {
      process.env.PURE_EVAL_HELDOUT_DIR = '~/somewhere';
      expect(heldOutRoot()).toBe(join(homedir(), 'somewhere'));
      const absolute = join(resolve('/'), 'absolute', 'path');
      process.env.PURE_EVAL_HELDOUT_DIR = absolute;
      expect(heldOutRoot()).toBe(absolute);
      delete process.env.PURE_EVAL_HELDOUT_DIR;
      expect(heldOutRoot()).toBe(join(homedir(), '.pure', 'evals-heldout'));
    } finally {
      if (previous === undefined) delete process.env.PURE_EVAL_HELDOUT_DIR;
      else process.env.PURE_EVAL_HELDOUT_DIR = previous;
    }
  });
});

describe('held-out 装载与形状校验', () => {
  it('合法的 coding fixture 原样读入', async () => {
    const root = await tempRoot();
    await mkdir(join(root, 'coding'), { recursive: true });
    await writeFile(join(root, 'coding', 'a.json'), JSON.stringify(VALID_CODING), 'utf8');
    const loaded = await loadHeldOutCodingTasks(root);
    expect(loaded.fixtures.map((f) => f.id)).toEqual(['held-fix-dup-merge']);
    expect(loaded.issues).toEqual([]);
  });

  it('坏文件被丢弃并记账——静默少算一半题目正是这个机制要防的', async () => {
    const root = await tempRoot();
    await mkdir(join(root, 'coding'), { recursive: true });
    await writeFile(join(root, 'coding', 'good.json'), JSON.stringify(VALID_CODING), 'utf8');
    await writeFile(join(root, 'coding', 'broken.json'), '{ not json', 'utf8');
    await writeFile(join(root, 'coding', 'wrong-shape.json'), JSON.stringify({ id: 'x' }), 'utf8');
    const loaded = await loadHeldOutCodingTasks(root);
    expect(loaded.fixtures).toHaveLength(1);
    expect(loaded.issues).toHaveLength(2);
    expect(loaded.issues.map((i) => i.file).join(' ')).toContain('broken.json');
    expect(loaded.issues.map((i) => i.file).join(' ')).toContain('wrong-shape.json');
  });

  it('缺 verification / 坏 category / 非字符串 files 内容逐条拒绝', () => {
    expect(isCodingTaskFixture({ ...VALID_CODING, verification: [] })).toBe(false);
    expect(isCodingTaskFixture({ ...VALID_CODING, verification: [{ name: 't' }] })).toBe(false);
    expect(isCodingTaskFixture({ ...VALID_CODING, category: 'nope' })).toBe(false);
    expect(isCodingTaskFixture({ ...VALID_CODING, difficulty: 'impossible' })).toBe(false);
    expect(isCodingTaskFixture({ ...VALID_CODING, files: { 'a.ts': 42 } })).toBe(false);
    expect(isCodingTaskFixture({ ...VALID_CODING, id: '  ' })).toBe(false);
    expect(isCodingTaskFixture({ ...VALID_CODING, prompt: '' })).toBe(false);
    expect(isCodingTaskFixture(VALID_CODING)).toBe(true);
  });

  it('合法的 role case 原样读入；args 必须是对象而非数组', async () => {
    const root = await tempRoot();
    await mkdir(join(root, 'roles', 'researcher'), { recursive: true });
    await writeFile(join(root, 'roles', 'researcher', 'h1.json'), JSON.stringify(VALID_ROLE_CASE), 'utf8');
    const loaded = await loadHeldOutRoleCases('researcher', root);
    expect(loaded.fixtures.map((f) => f.id)).toEqual(['held-01']);
    expect(isRoleCaseFixture({ ...VALID_ROLE_CASE, args: [] })).toBe(false);
    expect(isRoleCaseFixture({ ...VALID_ROLE_CASE, must: [1] })).toBe(false);
    expect(isRoleCaseFixture({ ...VALID_ROLE_CASE, must: '来源' })).toBe(false);
  });

  it('畸形的 mustNot 在装载期就被拒，不留到判卷时抛', async () => {
    // A malformed mustNot throws inside gradeRoleCase's loop — i.e. after real
    // LLM calls have been spent on that case.
    const root = await tempRoot();
    await mkdir(join(root, 'roles', 'researcher'), { recursive: true });
    await writeFile(join(root, 'roles', 'researcher', 'good.json'), JSON.stringify(VALID_ROLE_CASE), 'utf8');
    await writeFile(join(root, 'roles', 'researcher', 'bad.json'), JSON.stringify({ ...VALID_ROLE_CASE, id: 'held-02', mustNot: [42] }), 'utf8');
    const loaded = await loadHeldOutRoleCases('researcher', root);
    expect(loaded.fixtures.map((f) => f.id)).toEqual(['held-01']);
    expect(loaded.issues.map((i) => i.file).join(' ')).toContain('bad.json');
    expect(isRoleCaseFixture({ ...VALID_ROLE_CASE, mustNot: 'x' })).toBe(false);
    expect(isRoleCaseFixture({ ...VALID_ROLE_CASE, mustNot: ['ok'] })).toBe(true);
    expect(isRoleCaseFixture({ ...VALID_ROLE_CASE, mustNot: undefined })).toBe(true);
  });

  it('文件名排序 → 装载顺序稳定（报告可逐字节复现）', async () => {
    const root = await tempRoot();
    await mkdir(join(root, 'coding'), { recursive: true });
    for (const id of ['c', 'a', 'b']) {
      await writeFile(join(root, 'coding', `${id}.json`), JSON.stringify({ ...VALID_CODING, id: `held-${id}` }), 'utf8');
    }
    const loaded = await loadHeldOutCodingTasks(root);
    expect(loaded.fixtures.map((f) => f.id)).toEqual(['held-a', 'held-b', 'held-c']);
  });
});

describe('held-out 与准入门不重叠（留出性质的定义）', () => {
  it('题目 id 不与已提交 v5 套件相撞——runner 靠这条拒绝污染的留出集', async () => {
    const root = await tempRoot();
    await mkdir(join(root, 'coding'), { recursive: true });
    // 装载器本身不拦（它只管形状），但 runner 会；这里锁住"准入门那 15 个
    // id 是已知的"，让 runner 侧的比对有确定基准。
    const committed = new Set(CODING_TASK_FIXTURES.map((f) => f.id));
    expect(committed.has('fix-take-top-off-by-one')).toBe(true);
    expect(committed.size).toBeGreaterThanOrEqual(15);
    await writeFile(join(root, 'coding', 'leak.json'), JSON.stringify({ ...VALID_CODING, id: 'fix-take-top-off-by-one' }), 'utf8');
    const loaded = await loadHeldOutCodingTasks(root);
    // 装载器放过它（形状合法），因此 runner 的碰撞检查不是多余的。
    expect(loaded.fixtures.map((f) => f.id)).toContain('fix-take-top-off-by-one');
  });

  it('准入门阈值仍是 5——held-out 不改门槛语义', () => {
    expect(MIN_ROLE_CASES).toBe(5);
  });
});

describe('describeHeldOut：读者能区分"没人写"与"写了但坏了"', () => {
  it('三种状态给出三种可区分的话术', () => {
    expect(describeHeldOut('x', { fixtures: [], issues: [] })).toContain('无');
    expect(describeHeldOut('x', { fixtures: [1, 2], issues: [] })).toContain('2 份');
    expect(describeHeldOut('x', { fixtures: [1], issues: [{ file: 'f', reason: 'r' }] })).toContain('被丢弃');
  });
});

