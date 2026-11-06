import { beforeEach, describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import {
  applySoulOverrideTexts,
  CHARACTER_BANNED_PHRASES,
  parseKernelLines,
  parseScenarios,
  resetSoulOverridesForTests,
  sliceSoulSection,
  soulOverrideOf,
} from '../soulOverride';
import { activeCharacterProfile, resetActiveCharacterProfile, setActiveCharacterProfile } from '../active';
import { CHARACTER_PROFILES } from '../registry';

// SOUL.md 运行时覆盖层的机制面（2026-11-06）。夹具不手抄：直接从项目根
// SOUL.md 切出四个块拼成「覆盖文本」——它与内置同源，天然合法；拒绝分支全靠
// 对它做机械变异（删一行 / 换一句 / 截断），测的是解析器与校验链，不是文采。
//
// 守的五件事：
//   ① 切块器 / 两个解析器与内置源句表、场景账**逐字同文**（解析器照真块零损耗）；
//   ② 两层优先级（workspace 覆盖 global）与块级容忍（缺块=不覆盖该面）；
//   ③ **内核级生效**：任一面失败（形状或 fatal）→ 整内核回退内置，绝不半覆盖；
//   ④ 三重 fatal：派生断裂 / 红线负向锁 / 注入文本超长；
//   ⑤ 生效点唯一：activeCharacterProfile() 读 soulOverrideOf()，reset 后回内置。

const SOUL = readFileSync(new URL('../../../SOUL.md', import.meta.url), 'utf8');
const IDS = Object.keys(CHARACTER_PROFILES);

/** 把切块器吐的正文包回完整块文本（覆盖文件的夹具形态）。 */
function fullBlock(kind: 'kernel' | 'expression', id: string): string {
  const body = sliceSoulSection(SOUL, kind, id);
  if (body === null) throw new Error(`SOUL.md 缺 soul:${kind}:${id} 块`);
  return `<!-- soul:${kind}:${id} -->\n${body}<!-- /soul:${kind}:${id} -->\n`;
}

const fullText = (): string => IDS.map((id) => fullBlock('kernel', id) + fullBlock('expression', id)).join('\n');

/** 删掉 kernel 块里 `- \`<id>\` …` 源句行（变异夹具用）。 */
function stripLine(text: string, id: string): string {
  return text.replace(new RegExp(`^- \\\`${id}\\\` .*(?:\\r?\\n)?`, 'm'), '');
}

/** 截掉 expression 块第三个场景起的所有内容（制造「五场景不齐」）。 */
function cutThirdScenario(section: string): string {
  const heads = [...section.matchAll(/^#{2,6}\s+(?:\d+\.\s+)?`[\w-]+`/gm)];
  return heads.length >= 3 ? section.slice(0, heads[2].index ?? section.length) : section;
}

const rebuiltBlock = (kind: 'kernel' | 'expression', id: string, body: string): string =>
  `<!-- soul:${kind}:${id} -->\n${body}<!-- /soul:${kind}:${id} -->\n`;

beforeEach(() => {
  resetSoulOverridesForTests();
  resetActiveCharacterProfile();
});

describe('切块与解析（覆盖文本与内置逐字同文）', () => {
  it('sliceSoulSection：命中切块、缺块 null、未闭合 null', () => {
    const body = sliceSoulSection(SOUL, 'kernel', 'veteran-fast');
    expect(body).not.toBeNull();
    expect(body).toContain('老手快线');
    expect(sliceSoulSection('毫无块标记的文本', 'kernel', 'veteran-fast')).toBeNull();
    expect(sliceSoulSection('<!-- soul:kernel:veteran-fast -->\n没闭合', 'kernel', 'veteran-fast')).toBeNull();
  });

  it('parseKernelLines：真块解析结果深等内置源句表', () => {
    for (const id of IDS) {
      const section = sliceSoulSection(SOUL, 'kernel', id)!;
      expect(parseKernelLines(section)).toEqual(CHARACTER_PROFILES[id].kernelLines);
    }
  });

  it('parseKernelLines：空文本 / <8 条 / id 重复 / 短句 → null', () => {
    expect(parseKernelLines('')).toBeNull();
    const full = sliceSoulSection(SOUL, 'kernel', 'veteran-fast')!;
    const ids = Object.keys(CHARACTER_PROFILES['veteran-fast'].kernelLines);
    const lineOf = (id: string): string => full.match(new RegExp(`^- \\\`${id}\\\` .*$`, 'm'))?.[0] ?? '';
    // 只保留 3 条合法行：从真块里逐条挑行重组（不足 8 条底线）。
    const threeLines = ids.slice(0, 3).map(lineOf).filter(Boolean).join('\n');
    expect(threeLines.split('\n')).toHaveLength(3); // 夹具自身健全
    expect(parseKernelLines(threeLines)).toBeNull();
    const duped = threeLines + '\n' + lineOf(ids[0]!);
    expect(parseKernelLines(duped)).toBeNull();
    const shorted = full.replace(new RegExp(`^- \\\`${ids[0]}\\\` .*$`, 'm'), `- \`${ids[0]}\` 太短`);
    expect(parseKernelLines(shorted)).toBeNull();
  });

  it('parseScenarios：真块解析结果深等内置场景账', () => {
    for (const id of IDS) {
      const section = sliceSoulSection(SOUL, 'expression', id)!;
      expect(parseScenarios(section)).toEqual(CHARACTER_PROFILES[id].expression.scenarios);
    }
  });

  it('parseScenarios：场景不足 / 义务缺失 / 源句行缺失 → null', () => {
    const full = sliceSoulSection(SOUL, 'expression', 'veteran-fast')!;
    expect(parseScenarios(cutThirdScenario(full))).toBeNull();
    // 义务行损坏：`>` 引文被换掉后该场景 obligation 缺失。
    expect(parseScenarios(full.replace(/^>\s+.*$/m, '普通段落行'))).toBeNull();
    // **源句** 行被删后该场景 derivedFrom 为空。
    expect(parseScenarios(full.replace(/^\*\*源句.*$/m, ''))).toBeNull();
  });
});

describe('覆盖层生效（两层 + 块级容忍 + 生效点）', () => {
  it('同文覆盖：applied 全名册，解析产物与内置同文', () => {
    const report = applySoulOverrideTexts({ global: fullText() });
    expect(report.applied).toEqual(IDS);
    expect(report.rejected).toEqual([]);
    for (const id of IDS) {
      expect(soulOverrideOf(id)?.kernelLines).toEqual(CHARACTER_PROFILES[id].kernelLines);
      expect(soulOverrideOf(id)?.core).toBe(CHARACTER_PROFILES[id].core);
    }
  });

  it('缺省无害：两层全空 → 不动账、零拒绝', () => {
    const report = applySoulOverrideTexts({ global: null, workspace: undefined });
    expect(report.applied).toEqual([]);
    expect(report.rejected).toEqual([]);
    for (const id of IDS) expect(soulOverrideOf(id)).toBeUndefined();
  });

  it('块级容忍：只喂一个 kernel 块 → 只覆盖该内核该面', () => {
    const report = applySoulOverrideTexts({ global: fullBlock('kernel', 'veteran-fast') });
    expect(report.applied).toEqual(['veteran-fast']);
    expect(soulOverrideOf('veteran-fast')?.kernelLines).toEqual(CHARACTER_PROFILES['veteran-fast'].kernelLines);
    expect(soulOverrideOf('veteran-fast')?.expression.scenarios).toBe(CHARACTER_PROFILES['veteran-fast'].expression.scenarios);
    expect(soulOverrideOf('craftsman-slow')).toBeUndefined();
  });

  it('两层优先级：workspace 同块覆盖 global', () => {
    const id = IDS[0]!;
    const lineId = Object.keys(CHARACTER_PROFILES[id].kernelLines)[0]!;
    const mutated = stripLine(fullBlock('kernel', id), lineId).replace(
      `<!-- soul:kernel:${id} -->`,
      `<!-- soul:kernel:${id} -->\n- \`${lineId}\` ${'global 层的这句话和内置不同，用来辨识生效的是哪一层。'}\n`,
    );
    const report = applySoulOverrideTexts({ global: mutated, workspace: fullBlock('kernel', id) });
    expect(report.applied).toContain(id);
    // workspace 层是内置同文，生效的必须是它（global 变异句被整块覆盖掉）。
    expect(soulOverrideOf(id)?.kernelLines).toEqual(CHARACTER_PROFILES[id].kernelLines);
  });

  it('生效点：activeCharacterProfile() 读覆盖账，reset 后回内置', () => {
    const id = IDS[0]!;
    applySoulOverrideTexts({ global: fullBlock('kernel', id) });
    setActiveCharacterProfile(id);
    expect(activeCharacterProfile().kernelLines).toEqual(soulOverrideOf(id)!.kernelLines);
    resetSoulOverridesForTests();
    expect(activeCharacterProfile()).toBe(CHARACTER_PROFILES[id]);
  });
});

describe('内核级生效（任一面失败 → 整内核回退）', () => {
  it('面级形状失败联动回退：kernel 合法 + expression 解析坏 → 整内核不覆盖', () => {
    const id = IDS[0]!;
    const badExpression = rebuiltBlock('expression', id, cutThirdScenario(sliceSoulSection(SOUL, 'expression', id)!));
    const report = applySoulOverrideTexts({ global: fullBlock('kernel', id) + '\n' + badExpression });
    expect(report.rejected.some((r) => r.id === id && r.face === 'expression')).toBe(true);
    expect(soulOverrideOf(id)).toBeUndefined();
    expect(report.applied).not.toContain(id);
  });

  it('决策面推导断裂：覆盖源句表删掉被 decisionDerivation 引用的 id → 整内核拒绝', () => {
    const id = IDS[0]!;
    const base = CHARACTER_PROFILES[id];
    const referenced = Object.values(base.decisionDerivation).flat()[0]!;
    const report = applySoulOverrideTexts({ global: rebuiltBlock('kernel', id, stripLine(fullBlock('kernel', id), referenced)) });
    expect(report.applied).toEqual([]);
    const rejection = report.rejected.find((r) => r.id === id);
    expect(rejection?.reason).toContain(referenced);
    expect(soulOverrideOf(id)).toBeUndefined();
  });

  it('场景 derivedFrom 断裂：源句行引用不存在的 id → expression 面拒绝', () => {
    const id = IDS[0]!;
    const body = sliceSoulSection(SOUL, 'expression', id)!.replace(/(\*\*源句[^\n]*`)([A-Za-z][\w]*)(`)/, `$1$2\` \`K999K$3`);
    const report = applySoulOverrideTexts({ global: rebuiltBlock('expression', id, body) });
    expect(report.rejected.some((r) => r.id === id && r.face === 'expression' && r.reason.includes('K999K'))).toBe(true);
    expect(soulOverrideOf(id)).toBeUndefined();
  });

  it('红线负向锁：源句注入谄媚话术 → 整内核拒绝', () => {
    const id = IDS[0]!;
    const banned = CHARACTER_BANNED_PHRASES.find((p) => !p.includes('陪') && !p.includes('我'))!; // 取英文短语，长度达标
    const lineId = Object.keys(CHARACTER_PROFILES[id].kernelLines)[0]!;
    const poisoned = stripLine(fullBlock('kernel', id), lineId).replace(
      `<!-- soul:kernel:${id} -->`,
      `<!-- soul:kernel:${id} -->\n- \`${lineId}\` ${banned}, and I will stay attentive through the whole session without exception.\n`,
    );
    const report = applySoulOverrideTexts({ global: poisoned });
    expect(report.applied).toEqual([]);
    expect(report.rejected.some((r) => r.id === id && r.reason.includes('红线负向锁'))).toBe(true);
    expect(soulOverrideOf(id)).toBeUndefined();
  });

  it('注入文本超长：源句拉到 2500 字符 → core 超上限拒绝', () => {
    const id = IDS[0]!;
    const lineId = Object.keys(CHARACTER_PROFILES[id].kernelLines)[0]!;
    const bloated = stripLine(fullBlock('kernel', id), lineId).replace(
      `<!-- soul:kernel:${id} -->`,
      `<!-- soul:kernel:${id} -->\n- \`${lineId}\` ${'x'.repeat(2500)}\n`,
    );
    const report = applySoulOverrideTexts({ global: bloated });
    expect(report.applied).toEqual([]);
    expect(report.rejected.some((r) => r.id === id && r.reason.includes('2000'))).toBe(true);
    expect(soulOverrideOf(id)).toBeUndefined();
  });
});
