// 插话语料回归（2026-09-28）：把回放脚本用的那批真实插话原文接进常规回归。
//
// 这里锁的是**语料本身的行为边界**，不是模型判定质量——所以不需要 API key，
// 每次 `bun test` 都能跑。
//
// 2026-10-28 框架改革刀 1：七条机械快路径正则整族删除（STOP_RE/
// BRANCH_STOP_RE/RESUME_BRANCH_RE/GOAL_CHANGE_RE/CANCEL_PART_RE/URGENT_RE/
// SCOPE_ADD_RE 及 netVerdict 字面网），主路只剩裁决器 judge 与原话直投
// passthrough 两条。语料的旧职能「锁机械路径判错面」随之消失——停/续/改的
// 判定全归裁决器（真机判例与回放对照兜），语料继续锁的：
//   1. 语料自洽（出处、去重、契约期望成对）
//   2. 收割段与人工段的边界（suspected 不冒充断言）
//   3. 场景跟句走（回放按句取场景，不回到全场一个上下文）
//   4. 机械路径不回潮（导出面锁死）
//
// 语料本体在 ../insertionCorpus.ts，与 scripts/replay-insertion-decisor.ts 共用。
//
// 语料分两段（2026-09-28）：人工核对的 CASES（可断言 kind），与诊断区审计自动
// 收割的 HARVESTED_CASES（期望由疑点原因反推，标 suspected）。

import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import * as corpus from '../insertionCorpus';
import { ALL_CASES, CASES, DEFAULT_SCENARIO, HARVESTED_SCENARIO_ID, SCENARIOS, scenarioFor } from '../insertionCorpus';

describe('插话语料：行为边界', () => {
  it('语料自洽：每句都有出处、不重复、契约期望成对', () => {
    const seen = new Set<string>();
    for (const c of ALL_CASES) {
      expect(c.source.trim().length).toBeGreaterThan(0);
      expect(seen.has(c.text)).toBe(false);
      seen.add(c.text);
      // adds_along 只在 cancels_part 为真时有意义（契约本身就这么写的）。
      if (c.addsAlong === true) expect(c.cancels).toBe(true);
    }
  });

  it('收割段是审计来的，一律标 suspected 而不是断言', () => {
    // 审计网的假阳性是可接受的（见 insertionAudit 注），所以它收割出来的期望
    // 不能冒充人工核对过的断言——准确率统计必须能把两段分开算。
    const harvested = ALL_CASES.filter((c) => !CASES.includes(c));
    for (const c of harvested) {
      expect(c.expectation).toBe('suspected');
      expect(c.kind).toBe('steer');
      expect(c.source.startsWith('诊断区审计')).toBe(true);
    }
    // 人工段里带 suspected 的必须是**有意降级的已知双读句**（快照式：谁想把断言
    // 语料降级都得先在这里显式改一次，不会静默发生）。
    expect(CASES.filter((c) => c.expectation === 'suspected').map((c) => c.text))
      .toEqual(['不要只查均价，把区间也查了']);
  });

  it('场景自带：每句指到的场景都存在，且场景不泄露答案', () => {
    // 回放曾经给所有句子同一个上下文，于是「我在西安」「这首必须是五言的」在
    // 与它们无关的语境里被判错——判错的是上下文。场景跟着句子走就是这么定的。
    for (const c of ALL_CASES) {
      const { id, text } = scenarioFor(c);
      // 收割来的用例带的是**当初判它时的现场原文**（见 Case.scenarioText）：
      // 它不来自场景库，也不该被收编成场景库的一条——自动收割不编辑现场。
      if (c.scenarioText) {
        expect(id).toBe(HARVESTED_SCENARIO_ID);
        expect(text).toBe(c.scenarioText);
        continue;
      }
      expect(SCENARIOS[id]).toBeDefined();
      expect(text).toBe(SCENARIOS[id]);
    }
    // 至少五个场景在用：否则"全场一个上下文"会静静地溜回来。
    const used = new Set(ALL_CASES.map((c) => scenarioFor(c).id));
    expect(used.size).toBeGreaterThanOrEqual(5);
    expect(used.has(DEFAULT_SCENARIO)).toBe(true);
    // 场景只描述当前任务与阶段，不含任何 kind 词——否则语料变成"把答案抄进
    // 上下文"，断言就不再是断言。
    for (const text of Object.values(SCENARIOS)) {
      expect(text).not.toContain('排队');
    }
    for (const leaked of ['steer', 'premise-change', 'goal-change', 'chatter']) {
      for (const text of Object.values(SCENARIOS)) {
        expect(text).not.toContain(leaked);
      }
    }
  });

  it('回放按句取场景，不回到「全场一个上下文」', () => {
    const script = readFileSync(new URL('../../../scripts/replay-insertion-decisor.ts', import.meta.url), 'utf8');
    expect(script).toContain('contextsFor(row.c, withTiming)');
    expect(script).toContain('scenarioFor(c)');
  });

  it('机械快路径不回潮：mainHit/mechanicalHits 已随刀 1 整族删除', () => {
    // 快路径删除是刀 1 的核心动作：判定全归裁决器，宿主零字面匹配。函数名
    // 一旦重新出现（哪怕只是换壳的正则网），裁决器就会被重新截胡——导出面
    // 锁死，回潮即红。
    const names = Object.keys(corpus);
    expect(names).not.toContain('mainHit');
    expect(names).not.toContain('mechanicalHits');
    // CASES 数据全保留（回放对照的 baseline 不许丢）：命令句仍在语料里，
    // 只是它们的判定改由裁决器做。
    const texts = CASES.map((c) => c.text);
    expect(texts).toContain('停止当前任务');
    expect(texts).toContain('停掉竞品那支');
    expect(texts).toContain('把竞品那支接着跑完');
  });
});
