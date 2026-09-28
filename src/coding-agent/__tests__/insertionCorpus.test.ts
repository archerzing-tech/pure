// 插话语料回归（2026-09-28）：把回放脚本用的那批真实插话原文接进常规回归。
//
// 这里锁的是**机械路径的行为边界**，不是模型判定质量——所以不需要 API key，
// 每次 `bun test` 都能跑。三件事必须一直成立：
//   1. 主路的机械快路径一句都不许判错（这是它继续抢在裁决器前面的唯一理由）
//   2. 软停语料一句都不许被机械路径命中（否则裁决器新补的 stop 档永远到不了）
//   3. 降级路径的方向偏差就是已知那两句（改契约前必须重新评估，不能悄悄变多）
//
// 语料本体在 ../insertionCorpus.ts，与 scripts/replay-insertion-decisor.ts 共用。
//
// 语料分两段（2026-09-28）：人工核对的 CASES（可断言 kind），与诊断区审计自动
// 收割的 HARVESTED_CASES（期望由疑点原因反推，标 suspected）。机械路径的断言
// 跑全量——那些正则与模型无关；快照只锁人工段，免得自动收割把快照刷花。

import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { ALL_CASES, CASES, DEFAULT_SCENARIO, SCENARIOS, aligns, mainHit, mechanicalHits, scenarioFor } from '../insertionCorpus';

describe('插话语料：机械路径的行为边界', () => {
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
      expect(text.length).toBeGreaterThan(40);
      for (const leaked of ['steer', 'premise-change', 'goal-change', 'chatter', '排队']) {
        expect(text).not.toContain(leaked);
      }
    }
  });

  it('回放按句取场景，不回到「全场一个上下文」', () => {
    const script = readFileSync(new URL('../../../scripts/replay-insertion-decisor.ts', import.meta.url), 'utf8');
    expect(script).toContain('contextsFor(row.c, withTiming)');
    expect(script).toContain('scenarioFor(c)');
  });

  it('主路的机械快路径一句都不许判错', () => {
    // 判错 = 反向执行（该停的继续跑、该收的当成加活）。只要这里出现一条，
    // 那条话就必须从快路径拿走交给裁决器。跑全量：审计收割来的句子同样会
    // 落到宿主手里，正则变宽把它截错也是一样的事故。
    const wrong = ALL_CASES
      .map((c) => ({ c, hit: mainHit(c) }))
      .filter(({ c, hit }) => hit !== undefined && !aligns(c, hit.gives));
    expect(wrong.map((w) => w.c.text)).toEqual([]);
  });

  it('主路命中集合就是那 10 句命令——增删都要有人重新审视', () => {
    // 快照式断言：语料变了、或某个正则变宽/变窄，都必须在这里显式改一次，
    // 而不是让"截胡面"悄悄漂移。
    const main = CASES
      .filter((c) => mainHit(c) !== undefined)
      .map((c) => `${c.text} [${mainHit(c)!.name}]`);
    expect(main).toEqual([
      '停止当前任务 [STOP_RE]',
      '停下 [STOP_RE]',
      '别做了 [STOP_RE]',
      '取消 [STOP_RE]',
      '先别做这个了 [STOP_RE]',
      '停掉竞品那支 [BRANCH_STOP_RE]',
      '把调研那路掐掉 [BRANCH_STOP_RE]',
      '那路别跑了 [BRANCH_STOP_RE]',
      '把竞品那支接着跑完 [RESUME_BRANCH_RE]',
      '让报价那路继续 [RESUME_BRANCH_RE]',
    ]);
  });

  it('软停语料不被任何机械路径命中——否则裁决器的 stop 档永远到不了', () => {
    // detail 为空表示它不是命令（命令走快路径，本来就轮不到裁决器）。
    const soft = ALL_CASES.filter((c) => c.kind === 'stop' && c.detail === undefined);
    expect(soft.length).toBeGreaterThanOrEqual(4);
    for (const c of soft) {
      expect(mechanicalHits(c.text)).toEqual([]);
    }
  });

  it('降级路径的方向偏差就是已知那两句', () => {
    // 这两句在裁决器倒下时会被推去排队（期望是 steer）：SCOPE_ADD_RE 认不出
    // "往当前结果里加"与"第二件活"的区别。数字变多说明加活族的边界松了。
    const drifted = CASES
      .filter((c) => mainHit(c) === undefined)
      .map((c) => ({ c, hit: mechanicalHits(c.text).find((h) => h.lane === 'net') }))
      .filter(({ c, hit }) => hit !== undefined && !aligns(c, hit.gives))
      .map(({ c }) => c.text);
    expect(drifted).toEqual(['不要只查均价，把区间也查了', '新增加两位']);
  });
});
