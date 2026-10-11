import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import {
  activeCharacterExpression,
  DEFAULT_CHARACTER_PROFILE,
  EXPRESSION_RED_LINES,
  VETERAN_FAST_EXPRESSION_PROMPT,
  VETERAN_FAST_EXPRESSION_VERSION,
  VETERAN_FAST_LINES,
  VETERAN_FAST_SCENARIOS,
  VETERAN_FAST_SCENARIO_IDS,
  type CharacterScenarioId,
} from '../index';

// 人格轨道 刀 3 的机制面（docs/persona-core-upgrade.md §3 刀 3、铁律 1）：
//   ① 人读账与注入面**逐字同文**——label / 义务 / 禁止 / 源句 / 红线改一边不改另一边即红；
//   ② 铁律 1：每个场景的源句 id 都真存在（内核源句表 + 内核 .md 双重确认）；
//   ③ 本刀的核心纪律：**例句只进人读账，绝不进注入文本**（逐字复用会变成机器腔）；
//   ④ 每场景 3–5 条例句（人读账是刀 4 判例集的素材面，不能是空壳）；
//   ⑤ 红线负向锁：注入文本里不许出现谄媚 / 陪伴话术；
//   ⑥ 体积上限：表达投影每回合都付 token。
const LEDGER = readFileSync(new URL('../kernels/veteran-fast-expression.md', import.meta.url), 'utf8');
const KERNEL_MIRROR = readFileSync(new URL('../kernels/veteran-fast.md', import.meta.url), 'utf8');
const PROMPT = VETERAN_FAST_EXPRESSION_PROMPT;

/** 人读账里的例句块：`<!-- examples:<id> -->` … `<!-- /examples:<id> -->`。 */
function extractExampleBlocks(markdown: string): Map<string, string[]> {
  const blocks = new Map<string, string[]>();
  for (const match of markdown.matchAll(/<!-- examples:([\w-]+) -->\n([\s\S]*?)<!-- \/examples:\1 -->/g)) {
    const lines = match[2]
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.startsWith('- '))
      .map((line) => line.slice(2).trim());
    blocks.set(match[1], lines);
  }
  return blocks;
}

describe('性格内核「老手快线」表达投影 v0（刀 3）', () => {
  it('场景账完整：五个场景，每个都有标签 / 义务 / 禁止 / 源句', () => {
    expect(VETERAN_FAST_SCENARIO_IDS.length).toBe(5);
    expect([...VETERAN_FAST_SCENARIO_IDS].sort()).toEqual(
      (Object.keys(VETERAN_FAST_SCENARIOS) as CharacterScenarioId[]).sort(),
    );
    for (const id of VETERAN_FAST_SCENARIO_IDS) {
      const scenario = VETERAN_FAST_SCENARIOS[id];
      expect(scenario.label.trim().length).toBeGreaterThan(5);
      expect(scenario.obligation.trim().length).toBeGreaterThan(40);
      expect(scenario.forbidden.length).toBeGreaterThan(0);
      expect(scenario.derivedFrom.length).toBeGreaterThan(0);
      for (const text of scenario.forbidden) expect(text.trim().length).toBeGreaterThan(5);
    }
  });

  it('三方版本一致：常量 / 人读账头行', () => {
    expect(VETERAN_FAST_EXPRESSION_VERSION).toBe('v0');
    expect(LEDGER).toContain('veteran-fast');
    expect(LEDGER).toContain('v0');
  });

  it('人读账与注入面逐字同文（标签 / 义务 / 禁止 / 源句）', () => {
    for (const id of VETERAN_FAST_SCENARIO_IDS) {
      const scenario = VETERAN_FAST_SCENARIOS[id];
      expect(LEDGER).toContain(`\`${id}\``);
      expect(LEDGER).toContain(scenario.label);
      expect(LEDGER).toContain(scenario.obligation);
      for (const text of scenario.forbidden) expect(LEDGER).toContain(text);
      for (const lineId of scenario.derivedFrom) expect(LEDGER).toContain(`\`${lineId}\``);
    }
  });

  it('铁律 1：每个场景的源句 id 在内核源句表与内核 .md 里都真存在', () => {
    for (const id of VETERAN_FAST_SCENARIO_IDS) {
      for (const lineId of VETERAN_FAST_SCENARIOS[id].derivedFrom) {
        expect(VETERAN_FAST_LINES[lineId]).toBeDefined();
        expect(KERNEL_MIRROR).toContain(`\`${lineId}\``);
      }
    }
  });

  it('人读账的例句账覆盖每个场景，且每场景 3–5 条', () => {
    const blocks = extractExampleBlocks(LEDGER);
    expect([...blocks.keys()].sort()).toEqual([...VETERAN_FAST_SCENARIO_IDS].sort());
    for (const id of VETERAN_FAST_SCENARIO_IDS) {
      const examples = blocks.get(id)!;
      expect(examples.length).toBeGreaterThanOrEqual(3);
      expect(examples.length).toBeLessThanOrEqual(5);
      for (const example of examples) expect(example.length).toBeGreaterThan(10);
    }
  });

  it('本刀的核心纪律：例句只进人读账，一句也不许进注入文本', () => {
    const examples = [...extractExampleBlocks(LEDGER).values()].flat();
    expect(examples.length).toBeGreaterThanOrEqual(15);
    for (const example of examples) {
      expect(PROMPT).not.toContain(example);
    }
    // 注入面自己也把这条纪律说出来：场景行是义务，不是可以照抄的句子。
    expect(PROMPT).toContain('not a line to reuse');
  });

  it('注入文本带 <character_expression> 框架与全部场景义务，且不臃肿', () => {
    expect(PROMPT.startsWith('<character_expression>')).toBe(true);
    expect(PROMPT.endsWith('</character_expression>')).toBe(true);
    for (const id of VETERAN_FAST_SCENARIO_IDS) {
      expect(PROMPT).toContain(VETERAN_FAST_SCENARIOS[id].label);
      expect(PROMPT).toContain(VETERAN_FAST_SCENARIOS[id].obligation);
    }
    // 每回合都要付这份 token：上限与内核同一量级（< 2000），防场景账无节制长大。
    expect(PROMPT.length).toBeLessThan(2_000);
  });

  it('红线清单双向落地：装配面 / 人读账 / 注入文本三处同文', () => {
    expect(EXPRESSION_RED_LINES.length).toBe(4);
    for (const line of EXPRESSION_RED_LINES) {
      expect(LEDGER).toContain(line);
      expect(PROMPT).toContain(line);
    }
  });

  it('红线 1/2 负向锁：注入文本不含谄媚 / 陪伴话术', () => {
    const banned = [
      'always be here',
      'always here for you',
      "I'm always",
      '陪着你',
      '我一直',
      'hope this helps',
      'Hope this helps',
      'Great question',
      'Certainly!',
    ];
    for (const phrase of banned) {
      expect(PROMPT).not.toContain(phrase);
    }
  });

  it('profile 与装配函数同源（不是手抄第二份）', () => {
    expect(DEFAULT_CHARACTER_PROFILE.expression.scenarios).toBe(VETERAN_FAST_SCENARIOS);
    expect(activeCharacterExpression()).toBe(PROMPT);
  });
});
