// src/character/register.ts
// 分量判读（人格轨道 刀 6，2026-10-12）：用意 → 档位 → 做法的那层前置判断。
//
// 病根（docs/persona-core-upgrade.md §3 刀 6 的动机）：决策面旋钮全是全局静态，
// pure 有「怎么把一件事做好」、没有「这件事该用多重的做法」——「快速出几个设计
// 稿」被全套验证伺候、「原型穿刺」被全量工程。本模块给每个任务判一个
// WorkOrderRegister，并把档位缩放成结构上限（registerScaledDecision）。
//
// 三条纪律（蓝图刀 6 节钉死）：
//   1. production = 现行为：判不出明显信号就落 production，不问不猜；档位只下调
//      不上调。误判代价不对称（往重判损失时间，往轻判损失信任），词表偏保守——
//      只收高置信措辞，产物形态推断等弱信号一律不进首版。
//   2. 判定必须可解释：verdict 带命中的信号词，回执要引用它（用户才知道为什么
//      降档，一句话可纠正）。
//   3. 档位是任务属性：判定发生在任务下发时，档位随计划/委派传播——本模块不含
//      任何可变状态（那是宿主回合上下文的事）。
//
// 与内核的关系：档位表的值住在 CharacterProfile.decision.registerTendency（每内
// 核一张、逐值标注源句），本模块只做「判定 + 读表缩放」两件事，自己不藏数值。
//
// 本模块是叶子：不 import 任何 ui / coding-agent / shared 运行时模块，避免环。

import type { CharacterProfile, RegisterScaledCaps, WorkOrderRegister } from './types';

/** 判定结果：档位 + 命中的信号词（回执引用它，让用户能纠正）。 */
export interface WorkOrderVerdict {
  register: WorkOrderRegister;
  /** 命中的显式信号（原词）。production 且无信号时为空串——那是默认落点，没有「为什么」。 */
  matched: string;
}

/**
 * draft 档信号：决策稿的措辞。首版只收高置信词——「设计稿」「看看」这类单看不
 * 必然是草稿（正式设计也交设计稿），一律不进词表，防误报降档。
 */
const DRAFT_PATTERNS: readonly RegExp[] = [
  /快速(出|来|画|给|做|搞)/,
  /草稿|草图/,
  /先来(一|几)版|先出(一|几)版|先做(一|几)版|先来一版/,
  /几个(方案|版本|版|样式|风格|备选)|多几(版|个方案)|几版/,
  /随便(画|做|弄|出|写)/,
  /不求(精细|完美|好看|精确)/,
  /\bquick (and dirty|draft|mock|version)\b/i,
  /\brough (draft|cut|version|sketch)\b/i,
  /\b(few|several|a couple of) (variants|versions|options|drafts)\b/i,
  /\bmock\s?ups?\b/i,
];

/**
 * spike 档信号：原型/穿刺的措辞。「试试」裸词不进（「试试这个 bug 能不能复现」
 * 是任务内容不是档位声明）；「示范」「demo」收高置信形态。
 */
const SPIKE_PATTERNS: readonly RegExp[] = [
  /原型|样机/,
  /穿刺|dry[ -]?run/i,
  /\bdemo\b/i,
  /示范(程序|项目|版)/,
  /验证可行|验证一下可行|可行性验证/,
  /走通(流程|主路径|主流程)|跑通(流程|主路径|主流程)/,
  /\bprototype\b/i,
  /\bproof of concept\b/i,
  /\bpoc\b/i,
  /试验(一下|品|性)/,
];

/**
 * production 的**显式**信号：只有用户明说「正式」才由它压过 draft/spike（同句
 * 混合时重者赢：「快速出几个正式可用的版本」→ production）。裸「上线」「发布」
 * 不进——「修完这个 bug 就能上线」里它们是任务内容，不是档位声明。
 */
const PRODUCTION_PATTERNS: readonly RegExp[] = [
  // 「正式做」是反问-答复断点里最自然的纠正口吻（模型问「按原型档办吗？」→
  // 用户答「正式做」），刀 7 验收判例回填。
  /正式(做|项目|版本|交付|发布|环境|功能)/,
  /生产(环境|级)/,
  /\bproduction[- ](ready|grade|code|quality)\b/i,
  /\bgo[ -]?live\b/i,
];

function firstMatch(patterns: readonly RegExp[], input: string): string | null {
  for (const pattern of patterns) {
    const hit = input.match(pattern);
    if (hit) return hit[0];
  }
  return null;
}

/**
 * 判任务分量档位。规则顺序即优先级：显式 production > spike > draft > 默认
 * production——同句混合时重者赢（「快速出个原型」= draft 词 + spike 词 → spike，
 * 原型比草稿重），显式「正式」压一切。首版纯规则、可解释、可关；判不出返回
 * production + 空信号（不问不猜，蓝图刀 6 纪律 1）。
 */
export function detectWorkOrderRegister(input: string): WorkOrderVerdict {
  const text = input ?? '';
  const production = firstMatch(PRODUCTION_PATTERNS, text);
  if (production) return { register: 'production', matched: production };
  const spike = firstMatch(SPIKE_PATTERNS, text);
  if (spike) return { register: 'spike', matched: spike };
  const draft = firstMatch(DRAFT_PATTERNS, text);
  if (draft) return { register: 'draft', matched: draft };
  return { register: 'production', matched: '' };
}

// ── 刀 7：反问-答复断点的会话级档位携带 ──
//
// 真机判例（2026-10-12 GUI 验收，draft/spike 两案各自然复现一次）：轻档任务
// 模型先反问澄清 → 用户的答复没有档位信号 → 每回合重判回落 production——
// spike 案实际按全量分量跑（headless 真浏览器 9 项验证，档位表只允许 1–2 项）。
// activePlanRegister 的既有接续通道（continuingPlan/planPauseRequested）盖不住
// 这个断点：反问回合没产计划，答复回合不构成 plan 接续。
//
// 修法不加新状态：档位仍住 activePlanRegister（生命周期沿用五处清理点——
// 新会话/切会话/恢复快照/计划交付都收回 production，继承自动失效），只把
// 「答复回合该继承」的形状判出来——上一条 assistant 终稿以问句收尾 = 球在
// 用户手里，下一句无信号时按答复读，继承会话档位。链条自限：模型哪轮不以
// 问句收尾，继承就断，不会无限携带。

/** 继承判定结果：档位 + 信号 + 是否走了继承（诊断面，进 turnTimings）。 */
export interface WorkOrderResolution extends WorkOrderVerdict {
  /** true = 本回合没判新档，档位来自接续通道或反问-答复继承。 */
  carried: boolean;
}

export interface WorkOrderResolutionInput {
  userText: string;
  /** 会话当前档位（宿主的 activePlanRegister）。 */
  activeRegister: WorkOrderRegister;
  /** 上一条 assistant 终稿全文（无历史时 null）。 */
  lastAssistantText: string | null;
  continuingPlan: boolean;
  planPauseRequested: boolean;
}

/** 问句收尾：中英文问号，容忍收尾引号/括号。「吗。」「呢！」不算——球不在
 * 用户手里（陈述+反问混排时只有问号收尾才算数，防误携带）。 */
const PENDING_QUESTION_RE = /[？?][」』\)）"']*$/;

export function hasPendingQuestion(text: string | null | undefined): boolean {
  if (!text) return false;
  return PENDING_QUESTION_RE.test(text.trimEnd());
}

/**
 * 回合档位裁决。优先级：显式信号 > 接续通道 > 反问-答复继承 > 默认 production。
 * 显式信号永远赢（「正式做」纠正通道不受继承污染）；继承只在轻档上生效——
 * production 是现行为，无需携带（且防「production 反问 → 答复」把机制面搅进
 * 无收益的地方）。
 */
export function resolveWorkOrderRegister(input: WorkOrderResolutionInput): WorkOrderResolution {
  const verdict = detectWorkOrderRegister(input.userText);
  if (verdict.matched) return { ...verdict, carried: false };
  if (input.continuingPlan || input.planPauseRequested) {
    return { register: input.activeRegister, matched: '', carried: true };
  }
  const light = input.activeRegister === 'draft' || input.activeRegister === 'spike';
  if (light && hasPendingQuestion(input.lastAssistantText)) {
    return { register: input.activeRegister, matched: '', carried: true };
  }
  return { register: 'production', matched: '', carried: false };
}

/**
 * 按档位读决策面的结构上限。production 恒等现值（逐字段复制，调用方拿到的是
 * 独立对象，改它不会碰内核）；draft/spike 取档位表，并用 min() 对内核现值再锁
 * 一层——表配错（比现值还重）时也不会把档位放大成加码，档位只可能比现行为轻。
 * 确认倾向不在缩放面里（types.ts registerTendency 注释：误判降档时连确认一起
 * 丢会双重放大误判代价）。
 */
export function registerScaledDecision(
  profile: CharacterProfile,
  register: WorkOrderRegister,
): RegisterScaledCaps {
  const { verifyDensity, stepSize } = profile.decision;
  if (register === 'production') {
    return {
      maxVerificationItems: verifyDensity.maxVerificationItems,
      maxPlanSteps: stepSize.maxPlanSteps,
      maxPlanSubsteps: stepSize.maxPlanSubsteps,
    };
  }
  const caps = profile.decision.registerTendency[register];
  return {
    maxVerificationItems: Math.min(caps.maxVerificationItems, verifyDensity.maxVerificationItems),
    maxPlanSteps: Math.min(caps.maxPlanSteps, stepSize.maxPlanSteps),
    maxPlanSubsteps: Math.min(caps.maxPlanSubsteps, stepSize.maxPlanSubsteps),
  };
}
