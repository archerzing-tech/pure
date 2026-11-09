// src/character/soulOverride.ts
// SOUL.md 运行时覆盖层（2026-11-06）：人格用户可编辑。
// 内置人格是编译期 TS 源句表（L0 契约，发布物零依赖盘上文件）；本模块让用户
// 可以用一份 SOUL.md 覆盖它：块标记 `<!-- soul:kernel:<id> -->` /
// `<!-- soul:expression:<id> -->` 与仓库版同构，id 必须已在名册（veteran-fast /
// craftsman-slow）。读取时机 = 宿主启动一次（CLI 直读盘、GUI 经 Tauri invoke），
// 会话中途不重读——与「会话内 system prompt 冻结」的既有惯例一致，改人格下一
// 次启动生效。
// 覆盖语义（机械、可测）：
//   - 两层：globalUserRoot（~/.pure/SOUL.md）先铺，workspaceRoot/SOUL.md 同块
//     覆盖——与 AGENTS.md 的 conventions 同优先级。但**不拼接**：人格按块整份
//     替换，两份人格拼起来是精神分裂。
//   - 块级容忍：文件里缺哪个块就不覆盖哪个面——用户只想改老手快线时不必抄全
//     工匠慢线。
//   - **内核级生效**：一个内核的任一面校验失败 → 该内核整体回退内置（rejected
//     里写明原因）。内核与表达面同源（蓝图铁律），半个内核覆盖 = 精神分裂。
//   - 只覆盖叙事层：core / kernelLines / expression.scenarios。决策面旋钮
//     （decision / decisionDerivation）与 name / description / version 是产品
//     机制与 GUI 资产，覆盖层不得改写。
//   - 派生完整性：覆盖后的源句表必须仍覆盖 decisionDerivation 与各场景
//     derivedFrom 引用的全部 id——引用断裂即拒绝，绝不静默半覆盖。
//   - 红线负向锁：覆盖文本过一遍 CHARACTER_BANNED_PHRASES（谄媚 / 陪伴话术）。
//     红线是产品物理定律（蓝图 §4），用户覆盖不得越过。
//   - 生效注入文本与内置同上限（< 2000 字符）：每回合都要付 token。
// 生效点只有一个：active.ts 的 activeCharacterProfile() 读 soulOverrideOf()。
// PromptAssembler（character_core / character_expression）与子代理继承
// （SubagentOrchestrator → activeCharacterCore）都从它派生，一处生效三路全通。
// 本模块是叶子：不 import ui / coding-agent；evolution/trace 自身是动态 import
// 的 bundle 安全模块，静态引它不成环。

import type { CharacterProfile } from './types';
import { buildCharacterCorePrompt, type CharacterKernelLines } from './core';
import {
  buildCharacterExpressionPrompt,
  type CharacterScenarioId,
  type CharacterScenarioLedger,
  type CharacterScenarioProjection,
} from './expression';
import { CHARACTER_PROFILES } from './registry';
import { appendTrace } from '../evolution/trace';

/** 红线 1/2 的负向短语：覆盖文本与注入文本里一律不许出现（三个守卫测试与
 *  覆盖校验共用一份清单——三处各抄一份迟早分叉）。 */
export const CHARACTER_BANNED_PHRASES: readonly string[] = [
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

// ── 切块 ──

/** 从 SOUL.md 全文里切出 `soul:<kind>:<id>` 块的正文；缺块返回 null（运行时
 *  容忍：缺块=不覆盖，不抛错——抛错版在 __tests__/soulMirror.ts）。 */
export function sliceSoulSection(source: string, kind: 'kernel' | 'expression', kernelId: string): string | null {
  const open = `<!-- soul:${kind}:${kernelId} -->`;
  const close = `<!-- /soul:${kind}:${kernelId} -->`;
  const start = source.indexOf(open);
  if (start < 0) return null;
  const bodyStart = start + open.length;
  const end = source.indexOf(close, bodyStart);
  if (end < 0) return null;
  return source.slice(bodyStart, end);
}

// ── 解析：内核源句表 ──

/** 解析 kernel 块：`- \`ID\` 一句话` 行。形状校验对齐名册公共断言的底线
 *  （≥8 条、id 唯一、每条 >20 字符）。格式坏 → null（原因由调用方报「形状」）。 */
export function parseKernelLines(section: string): CharacterKernelLines | null {
  const lines: Record<string, string> = {};
  for (const match of section.matchAll(/^- `([A-Za-z][A-Za-z0-9]*)`\s+(.+)$/gm)) {
    const id = match[1];
    const text = match[2].trim();
    if (lines[id] !== undefined) return null; // id 重复
    lines[id] = text;
  }
  const ids = Object.keys(lines);
  if (ids.length < 8) return null;
  if (Object.values(lines).some((t) => t.length <= 20)) return null;
  return lines;
}

// ── 解析：表达面场景账 ──

interface ParsedScenario {
  label?: string;
  obligation?: string;
  forbidden: string[];
  derivedFrom: string[];
}

const SCENARIO_HEAD = /^#{2,6}\s+(?:\d+\.\s+)?`([\w-]+)`/;

/** 解析 expression 块：逐行状态机吃五场景的 label / 义务（> 行）/ 禁止（- 行）/
 *  源句（**源句**行里的反引号 id）。例句块与红线说明不进账——它们不进 prompt。
 *  只做形状校验（五场景齐、字段齐、长度底线）；derivedFrom 的 id 有效性在组装
 *  期统一查（那时「生效中的源句表」才定）。 */
export function parseScenarios(section: string): CharacterScenarioLedger | null {
  const order: CharacterScenarioId[] = [];
  const scenes = new Map<CharacterScenarioId, ParsedScenario>();
  let current: CharacterScenarioId | null = null;
  let mode: 'idle' | 'obligation' | 'forbidden' = 'idle';
  for (const rawLine of section.split(/\r?\n/)) {
    const line = rawLine.trim();
    const head = SCENARIO_HEAD.exec(line);
    if (head) {
      current = head[1] as CharacterScenarioId;
      if (!scenes.has(current)) {
        scenes.set(current, { forbidden: [], derivedFrom: [] });
        order.push(current);
      }
      mode = 'idle';
      continue;
    }
    if (!current) continue;
    const scene = scenes.get(current)!;
    const label = /^\*\*label[^*]*\*\*[：:]\s*(.+)$/.exec(line);
    if (label) {
      scene.label = label[1].trim();
      mode = 'idle';
      continue;
    }
    if (/^\*\*义务/.test(line)) {
      mode = 'obligation';
      continue;
    }
    if (/^\*\*禁止/.test(line)) {
      mode = 'forbidden';
      continue;
    }
    if (/^\*\*源句/.test(line)) {
      for (const idMatch of line.matchAll(/`([A-Za-z][\w]*)`/g)) scene.derivedFrom.push(idMatch[1]);
      mode = 'idle';
      continue;
    }
    if (mode === 'obligation' && !scene.obligation) {
      const quote = /^>\s*(.+)$/.exec(line);
      if (quote) {
        scene.obligation = quote[1].trim();
        mode = 'idle';
      }
      continue;
    }
    if (mode === 'forbidden') {
      const item = /^-\s+(.+)$/.exec(line);
      if (item) scene.forbidden.push(item[1].trim());
      continue;
    }
  }
  if (order.length !== 5) return null;
  for (const id of order) {
    const scene = scenes.get(id)!;
    if (!scene.label || scene.label.length <= 5) return null;
    if (!scene.obligation || scene.obligation.length <= 40) return null;
    if (scene.forbidden.length === 0 || scene.forbidden.some((t) => t.length <= 5)) return null;
    if (scene.derivedFrom.length === 0) return null;
  }
  const ledger = {} as Record<CharacterScenarioId, CharacterScenarioProjection>;
  for (const id of order) {
    const scene = scenes.get(id)!;
    ledger[id] = {
      label: scene.label!,
      obligation: scene.obligation!,
      forbidden: scene.forbidden,
      derivedFrom: scene.derivedFrom,
    };
  }
  return ledger;
}

// ── 覆盖层状态与生效 ──

export interface SoulOverrideTexts {
  /** `~/.pure/SOUL.md` 的内容（global 层）。null/空 = 该层缺省。 */
  global?: string | null;
  /** `<workspace>/SOUL.md` 的内容（workspace 层，同块覆盖 global）。 */
  workspace?: string | null;
}

export interface SoulOverrideRejection {
  id: string;
  face: 'kernel' | 'expression';
  reason: string;
}

export interface SoulOverrideReport {
  /** 覆盖生效的内核 id（任一面有覆盖即算）。 */
  applied: string[];
  rejected: SoulOverrideRejection[];
}

const overrides = new Map<string, CharacterProfile>();

/** 当前 id 的覆盖 profile（active.ts 的唯一读取点）；无覆盖返回 undefined。 */
export function soulOverrideOf(id: string): CharacterProfile | undefined {
  return overrides.get(id);
}

/** 测试隔离钩子：覆盖状态是进程全局，测试必须显式清账。 */
export function resetSoulOverridesForTests(): void {
  overrides.clear();
}

/** 把两层 SOUL.md 文本解析成覆盖账（纯函数，不做任何 I/O——读盘由各宿主自己
 *  来：CLI 直读 node:fs，GUI 经 Tauri invoke，renderer 永不拉 node 内建）。
 *  每次调用整体重建覆盖账（不是增量叠加）。 */
export function applySoulOverrideTexts(texts: SoulOverrideTexts): SoulOverrideReport {
  const rejected: SoulOverrideRejection[] = [];
  // 两层逐块解析：workspace 层后处理，同块覆盖 global 层（conventions 同优先级）。
  const kernelFace = new Map<string, CharacterKernelLines>();
  const expressionFace = new Map<string, CharacterScenarioLedger>();
  const layers: Array<[string | null | undefined, string]> = [
    [texts.global, '~/.pure/SOUL.md'],
    [texts.workspace, '<workspace>/SOUL.md'],
  ];
  for (const [text, layerName] of layers) {
    if (!text || !text.trim()) continue;
    for (const id of Object.keys(CHARACTER_PROFILES)) {
      const kernelSection = sliceSoulSection(text, 'kernel', id);
      if (kernelSection !== null) {
        const lines = parseKernelLines(kernelSection);
        if (lines) kernelFace.set(id, lines);
        else rejected.push({ id, face: 'kernel', reason: `${layerName} 的 soul:kernel:${id} 块解析不出合法源句表（≥8 条、id 唯一、每条 >20 字符）` });
      }
      const expressionSection = sliceSoulSection(text, 'expression', id);
      if (expressionSection !== null) {
        const scenarios = parseScenarios(expressionSection);
        if (scenarios) expressionFace.set(id, scenarios);
        else rejected.push({ id, face: 'expression', reason: `${layerName} 的 soul:expression:${id} 块解析不出合法场景账（五场景齐、label/义务/禁止/源句齐备）` });
      }
    }
  }

  // 组装 + 内核级校验：任一面失败 → 该内核整体回退内置（面级解析失败也算——
  // 一面坏一面好拼起来还是精神分裂，这里联动，绝不半覆盖）。
  overrides.clear();
  const applied: string[] = [];
  for (const [id, base] of Object.entries(CHARACTER_PROFILES)) {
    if (rejected.some((r) => r.id === id)) continue;
    const lines = kernelFace.get(id) ?? base.kernelLines;
    const scenarios = expressionFace.get(id) ?? base.expression.scenarios;
    if (lines === base.kernelLines && scenarios === base.expression.scenarios) continue;
    const fatal = kernelOverrideFatal(id, lines, scenarios);
    if (fatal.length > 0) {
      rejected.push(...fatal);
      continue;
    }
    overrides.set(id, {
      ...base,
      kernelLines: lines,
      core: buildCharacterCorePrompt(lines),
      expression: { scenarios },
    });
    applied.push(id);
  }
  const report: SoulOverrideReport = { applied, rejected };
  if (applied.length > 0 || rejected.length > 0) {
    appendTrace({
      type: 'soul_override',
      reason: applied.length > 0
        ? `SOUL.md override applied: ${applied.join(', ')}`
        : 'SOUL.md override present but rejected',
      route: applied.length > 0 ? 'applied' : 'rejected',
      applied,
      rejected,
    });
  }
  return report;
}

/** 内核级校验：派生 id 完整性 + 红线负向锁 + 注入文本上限。返回空数组 = 通过。 */
function kernelOverrideFatal(
  id: string,
  lines: CharacterKernelLines,
  scenarios: CharacterScenarioLedger,
): SoulOverrideRejection[] {
  const fatal: SoulOverrideRejection[] = [];
  const liveIds = new Set(Object.keys(lines));
  // 决策面推导引用（产品机制不改写，但它引用的源句 id 必须还在用户的表里）。
  const base = CHARACTER_PROFILES[id];
  const missingDerivation = Object.values(base.decisionDerivation).flat().filter((d) => !liveIds.has(d));
  if (missingDerivation.length > 0) {
    fatal.push({ id, face: 'kernel', reason: `决策面推导引用的源句 id 在覆盖后缺失：${missingDerivation.join(', ')}` });
  }
  const missingDerivedFrom = new Set<string>();
  for (const scenario of Object.values(scenarios)) {
    for (const d of scenario.derivedFrom) {
      if (!liveIds.has(d)) missingDerivedFrom.add(d);
    }
  }
  if (missingDerivedFrom.size > 0) {
    fatal.push({ id, face: 'expression', reason: `场景 derivedFrom 引用的源句 id 在覆盖后缺失：${[...missingDerivedFrom].join(', ')}` });
  }
  if (fatal.length > 0) return fatal;
  const core = buildCharacterCorePrompt(lines);
  const expressionPrompt = buildCharacterExpressionPrompt(scenarios);
  const banned = CHARACTER_BANNED_PHRASES.find((p) => core.includes(p) || expressionPrompt.includes(p));
  if (banned) {
    fatal.push({ id, face: 'kernel', reason: `红线负向锁命中（"${banned}"）：人格覆盖不得越过红线 1/2（不谄媚、不陪伴话术）` });
  }
  if (core.length >= 2_000) {
    fatal.push({ id, face: 'kernel', reason: `覆盖后的 character_core 注入文本 ${core.length} 字符，超过 2000 上限` });
  }
  if (expressionPrompt.length >= 2_000) {
    fatal.push({ id, face: 'expression', reason: `覆盖后的 character_expression 注入文本 ${expressionPrompt.length} 字符，超过 2000 上限` });
  }
  return fatal;
}
