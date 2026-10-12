import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import {
  buildCharacterExpressionPrompt,
  CHARACTER_PROFILES,
  EXPRESSION_RED_LINES,
  listCharacterProfiles,
  type CharacterDecisionProfile,
  type CharacterScenarioId,
} from '../index';

// 人格轨道 刀 5 的公共断言集：**对名册里的每个内核**逐条跑，而不是给每个内核抄
// 一份测试。加内核的验收因此只剩「登记 + 落两个 .md + 跑本文件」。
//
// 守的六件事（前四条来自刀 2/刀 3，后两条是刀 5 多内核才成立的）：
//   ① 三方版本一致（源句表 / profile / .md 镜像头行）；
//   ② .md 人读镜像与注入面**逐字同文**——改一边不改另一边即红；
//   ③ 铁律 1：决策面每个旋钮都有出处，出处 id 真存在；
//   ④ 本刀纪律：表达面例句只进人读账，一句也不许进注入文本；
//   ⑤ 源句编号前缀不串读（老手快线 K / 工匠慢线 C）；
//   ⑥ 两个内核的决策面**必须真的不同**——否则第二个内核是个同义词。

const KERNELS_DIR = new URL('../kernels/', import.meta.url);

function kernelMirror(id: string): string {
  return readFileSync(new URL(`${id}.md`, KERNELS_DIR), 'utf8');
}

function expressionMirror(id: string): string {
  return readFileSync(new URL(`${id}-expression.md`, KERNELS_DIR), 'utf8');
}

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

/** 红线 1/2 的负向短语：注入文本里一律不许出现（两个内核共用一份清单）。 */
const BANNED_PHRASES = [
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

describe('性格内核名册的公共断言（刀 5：对每个内核逐条跑）', () => {
  const profiles = listCharacterProfiles();

  it('名册非空且 id / 人读名 / 摘要齐备，默认内核排第一', () => {
    expect(profiles.length).toBeGreaterThanOrEqual(2);
    expect(profiles[0].id).toBe('veteran-fast');
    for (const profile of profiles) {
      expect(profile.id.trim().length).toBeGreaterThan(0);
      expect(profile.name.trim().length).toBeGreaterThan(0);
      expect(profile.description.trim().length).toBeGreaterThan(0);
      expect(profile.version.trim().length).toBeGreaterThan(0);
      expect(CHARACTER_PROFILES[profile.id]).toBe(profile);
    }
    // 名册键与 profile.id 一致（写错键会让 resolveCharacterProfile 静默查不到）。
    expect(Object.keys(CHARACTER_PROFILES).sort()).toEqual(profiles.map((p) => p.id).sort());
  });

  for (const profile of profiles) {
    describe(`${profile.name}（${profile.id} · ${profile.version}）`, () => {
      const core = profile.core;
      const mirror = kernelMirror(profile.id);
      const ledger = expressionMirror(profile.id);
      const expression = profile.expression.scenarios;
      const scenarioIds = Object.keys(expression) as CharacterScenarioId[];

      it('三方版本一致：源句表 / profile / .md 镜像头行', () => {
        expect(profile.version).toBe(profile.version.trim());
        expect(mirror).toContain(profile.id);
        expect(mirror).toContain(profile.version);
      });

      it('源句表非空、id 唯一、每条都是行为断言（>20 字符）', () => {
        const ids = Object.keys(profile.kernelLines);
        expect(ids.length).toBeGreaterThanOrEqual(8);
        expect(new Set(ids).size).toBe(ids.length);
        for (const text of Object.values(profile.kernelLines)) {
          expect(text.trim().length).toBeGreaterThan(20);
        }
      });

      it('.md 人读镜像与源句表逐字同文（含 id）', () => {
        for (const [id, text] of Object.entries(profile.kernelLines)) {
          expect(mirror).toContain(`\`${id}\``);
          expect(mirror).toContain(text);
        }
      });

      it('注入文本带 <character_core> 框架与全部源句，且不臃肿（<2000 字符）', () => {
        expect(core.startsWith('<character_core>')).toBe(true);
        expect(core.endsWith('</character_core>')).toBe(true);
        for (const text of Object.values(profile.kernelLines)) {
          expect(core).toContain(text);
        }
        expect(core.length).toBeLessThan(2_000);
      });

      it('铁律 1：决策面每个旋钮都标注了推导源句，且 id 真存在', () => {
        const knobs = Object.keys(profile.decision) as Array<keyof CharacterDecisionProfile>;
        expect(Object.keys(profile.decisionDerivation).sort()).toEqual([...knobs].sort());
        for (const knob of knobs) {
          const sources = profile.decisionDerivation[knob];
          expect(sources.length).toBeGreaterThan(0);
          for (const id of sources) {
            expect(profile.kernelLines[id]).toBeDefined();
            expect(mirror).toContain(`\`${id}\``);
          }
        }
      });

      it('表达面账完整：五个场景，label / 义务 / 禁止 / 源句齐备', () => {
        expect(scenarioIds.length).toBe(5);
        for (const id of scenarioIds) {
          const scenario = expression[id];
          expect(scenario.label.trim().length).toBeGreaterThan(5);
          expect(scenario.obligation.trim().length).toBeGreaterThan(40);
          expect(scenario.forbidden.length).toBeGreaterThan(0);
          for (const text of scenario.forbidden) expect(text.trim().length).toBeGreaterThan(5);
          expect(scenario.derivedFrom.length).toBeGreaterThan(0);
          for (const lineId of scenario.derivedFrom) {
            expect(profile.kernelLines[lineId]).toBeDefined();
            expect(mirror).toContain(`\`${lineId}\``);
          }
        }
      });

      it('人读账与注入面逐字同文（标签 / 义务 / 禁止 / 源句 / 红线）', () => {
        for (const id of scenarioIds) {
          const scenario = expression[id];
          expect(ledger).toContain(`\`${id}\``);
          expect(ledger).toContain(scenario.label);
          expect(ledger).toContain(scenario.obligation);
          for (const text of scenario.forbidden) expect(ledger).toContain(text);
          for (const lineId of scenario.derivedFrom) expect(ledger).toContain(`\`${lineId}\``);
        }
        for (const line of EXPRESSION_RED_LINES) expect(ledger).toContain(line);
      });

      it('人读账的例句账覆盖每个场景、每场景 3–5 条，且一句也不进注入文本', () => {
        const blocks = extractExampleBlocks(ledger);
        expect([...blocks.keys()].sort()).toEqual([...scenarioIds].sort());
        // 注入文本按**本内核**的场景账重算（不读 activeCharacterExpression：
        // 那是全局状态，会让本文件与其他测试文件互相影响）。
        const prompt = buildCharacterExpressionPrompt(expression);
        const examples: string[] = [];
        for (const id of scenarioIds) {
          const block = blocks.get(id)!;
          expect(block.length).toBeGreaterThanOrEqual(3);
          expect(block.length).toBeLessThanOrEqual(5);
          examples.push(...block);
        }
        expect(examples.length).toBeGreaterThanOrEqual(15);
        for (const example of examples) expect(prompt).not.toContain(example);
        // 场景义务 / 标签则**必须**在注入文本里（原则进 prompt、例句不进）。
        for (const id of scenarioIds) {
          expect(prompt).toContain(expression[id].label);
          expect(prompt).toContain(expression[id].obligation);
        }
        expect(prompt.startsWith('<character_expression>')).toBe(true);
        expect(prompt.endsWith('</character_expression>')).toBe(true);
        expect(prompt.length).toBeLessThan(2_000);
      });

      it('红线 1/2 负向锁：两张注入文本都不含谄媚 / 陪伴话术', () => {
        const prompt = buildCharacterExpressionPrompt(expression);
        for (const phrase of BANNED_PHRASES) {
          expect(core).not.toContain(phrase);
          expect(prompt).not.toContain(phrase);
        }
      });
    });
  }

  it('⑤ 源句编号前缀不串读：老手快线 K*、工匠慢线 C*', () => {
    for (const id of Object.keys(CHARACTER_PROFILES['veteran-fast'].kernelLines)) {
      expect(id.startsWith('K')).toBe(true);
    }
    for (const id of Object.keys(CHARACTER_PROFILES['craftsman-slow'].kernelLines)) {
      expect(id.startsWith('C')).toBe(true);
    }
  });

  it('⑥ 两个内核的决策面必须真的不同（否则第二个内核是同义词）', () => {
    const veteran = CHARACTER_PROFILES['veteran-fast'].decision;
    const craftsman = CHARACTER_PROFILES['craftsman-slow'].decision;
    expect(craftsman).not.toEqual(veteran);
    // 慢线在七个旋钮上都得与快线不同向：规划更早、验得更密、步子更小、确认更多、
    // 汇报更密、并行更少、插话门更高。逐条写死，防止「只改一个值就算第二内核」。
    expect(craftsman.modeThreshold.planAtComplexity).toBe('simple');
    expect(craftsman.modeThreshold.complexFileThreshold).toBeLessThan(veteran.modeThreshold.complexFileThreshold);
    expect(craftsman.verifyDensity.maxVerificationItems).toBeGreaterThan(veteran.verifyDensity.maxVerificationItems);
    expect(craftsman.stepSize.maxPlanSteps).toBeLessThan(veteran.stepSize.maxPlanSteps);
    expect(craftsman.confirmTendency.permissionMode).not.toBe(veteran.confirmTendency.permissionMode);
    expect(craftsman.reportRhythm).not.toBe(veteran.reportRhythm);
    expect(craftsman.parallelTendency.maxSubagentRoles).toBeLessThan(veteran.parallelTendency.maxSubagentRoles);
    expect(craftsman.insertionThreshold.confidenceGate).toBeGreaterThan(veteran.insertionThreshold.confidenceGate);
  });

  it('红线 4：高危内核不改变默认内核的确认取向（默认仍是 auto / 全自动批准）', () => {
    expect(CHARACTER_PROFILES['veteran-fast'].decision.confirmTendency).toEqual({
      permissionMode: 'auto',
      autoApprove: { read: true, write: true, cmd: true, git: true },
    });
  });
});
