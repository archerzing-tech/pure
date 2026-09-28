// 插话语料资产（2026-09-28）：真实插话原句 + 每句的正确处置 + 契约字段期望。
//
// 两个消费者共用这一份，避免"回放看到的语料"和"回归断言的语料"分家：
//   - `src/coding-agent/__tests__/insertionCorpus.test.ts`：离线回归（无需 key），
//     断言机械路径的截胡面与语料自洽
//   - `scripts/replay-insertion-decisor.ts`：离线对照 + 真跑裁决器（--llm）
//
// 每句都标 `source`（出处：测试、事故记录或已定稿口径），保证句子不是编的。
// `cancels` / `addsAlong` 是契约字段期望：该报没报 = 漏报，不该报报了 = 误报，
// 两者代价不对称，所以分开计数。
//
// 机械路径的事实来源是协调器导出的那些正则常量——这里绝不复制一份，否则
// "哪些话会被机械路径抢答"这个报告就只是在描述这份语料自己。
//
// 语料有两段来源（2026-09-28）：上面 `CASES` 是人工核对过的（每句的 kind 与
// 契约期望都可断言）；`HARVESTED_CASES` 是**诊断区审计自动收割**的疑点句——
// 那句期望只由「它当初为什么被标疑点」推出来（取消味没报 cancels_part ⇒
// 该报 cancels_part），未经人工复核，所以标 `expectation: 'suspected'`，
// 统计时与断言段分开计。收割脚本：`scripts/harvest-insertion-corpus.ts`。

import {
  BRANCH_STOP_RE,
  CANCEL_PART_RE,
  GOAL_CHANGE_RE,
  RESUME_BRANCH_RE,
  SCOPE_ADD_RE,
  STOP_RE,
} from './DynamicInsertionCoordinator';
import type { InsertionKind } from './Planner';
import { HARVESTED_CASES } from './insertionCorpusHarvested';

/** 机械路径会给出的处置（与裁决器应判的 kind 是两套词，分开标注，离线对照
 *  才不会把「停一支」和「整树停」混成一件事）。 */
export type Handled = 'stop' | 'branch-stop' | 'branch-resume' | 'goal-change' | 'steer-cancel' | 'task';

export type ExpectKind = InsertionKind | 'scheduled';

export interface Case {
  text: string;
  /** 裁决器应当判成的 kind；scheduled = 话里自带时刻，由时间语义排期。 */
  kind: ExpectKind;
  /** 正确处置（机械路径用同一套词描述它给的处置，用于离线对照）。 */
  detail?: Handled;
  /** 出处：文件或已记档的口径，用来核对这句不是凭空的。 */
  source: string;
  /** 期望裁决器报出的契约信号：该报没报 = 漏报，不该报报了 = 误报。
   *  两者代价不对称（漏报 cancels_part = 反向执行；误报 = 少排一个队），
   *  所以分开计数。undefined 即"不该报"。 */
  cancels?: boolean;
  addsAlong?: boolean;
  /** 期望的可靠程度（默认 asserted = 人工核对过）。`suspected` 表示这句话
   *  是从诊断区审计里自动收割的：期望由「它被标疑点的原因」推出，还没经过
   *  人复核。统计时分开算，免得把审计网的假阳性当成裁决器判错。 */
  expectation?: 'asserted' | 'suspected';
}

export const CASES: Case[] = [
  // ── 命令族：机械快路径的正规业务（人喊停不需要 deliberation）──
  { text: '停止当前任务', kind: 'stop', detail: 'stop', source: 'DynamicInsertionCoordinator.test.ts' },
  { text: '停下', kind: 'stop', detail: 'stop', source: 'STOP_RE 词族' },
  { text: '别做了', kind: 'stop', detail: 'stop', source: 'DynamicInsertionCoordinator 注释' },
  { text: '取消', kind: 'stop', detail: 'stop', source: 'STOP_RE 词族' },
  { text: '先别做这个了', kind: 'stop', detail: 'stop', source: 'STOP_RE 词族' },
  { text: '停掉竞品那支', kind: 'steer', detail: 'branch-stop', source: '第 2 期分支中断用例' },
  { text: '把调研那路掐掉', kind: 'steer', detail: 'branch-stop', source: 'BRANCH_STOP_RE 注释' },
  { text: '那路别跑了', kind: 'steer', detail: 'branch-stop', source: 'BRANCH_STOP_RE 注释' },
  { text: '把竞品那支接着跑完', kind: 'steer', detail: 'branch-resume', source: '第 2 期第三刀用例' },
  { text: '让报价那路继续', kind: 'steer', detail: 'branch-resume', source: 'RESUME_BRANCH_RE 注释' },

  // ── 推翻族：已降级为安全网（判定要看时机与上下文）──
  { text: '推翻重来', kind: 'goal-change', source: '改进进度记录 2026-09-22' },
  { text: '换个方案', kind: 'goal-change', source: 'INSERTION_CLASSIFY_PROMPT goal-change 例' },
  { text: '这个方向走不通，换个做法吧', kind: 'goal-change', source: 'DynamicInsertionCoordinator.test.ts' },
  { text: '不要了，全部重来', kind: 'goal-change', source: 'DynamicInsertionCoordinator.test.ts' },

  // ── 加活族：已降级为安全网（往在飞产出物里加还是第二件活，只有裁决器分得清）──
  { text: '再加一个 爱奇艺平台', kind: 'task', source: '改进进度记录 2026-09-22 实测' },
  { text: '顺便也查一下 芒果TV', kind: 'task', source: 'DynamicInsertionCoordinator.test.ts' },
  { text: '增加一个平台  爱奇艺', kind: 'task', source: '改进进度记录 2026-09-22 实测' },
  { text: '把爱奇艺也查一下', kind: 'task', source: 'SCOPE_ADD_RE 词族' },
  { text: '芒果TV也来一份', kind: 'task', source: 'SCOPE_ADD_RE 词族' },
  { text: 'also check Douban', kind: 'task', source: 'SCOPE_ADD_RE 词族' },

  // ── 收活族：已降级为安全网（收一支 ≠ 整树停）──
  { text: 'X 就不调研了', kind: 'steer', detail: 'steer-cancel', cancels: true, source: 'CANCEL_PART_RE 注释（2026-09-24 事故）' },
  { text: 'Y 那个不用查了', kind: 'steer', detail: 'steer-cancel', cancels: true, source: 'CANCEL_PART_RE 注释' },
  { text: '把 X 这个调研取消掉', kind: 'steer', detail: 'steer-cancel', cancels: true, source: '改进进度记录 2026-09-25 复测案例二' },
  { text: '不用再加知乎了', kind: 'steer', detail: 'steer-cancel', cancels: true, source: 'CANCEL_PART_RE 注释' },
  { text: '不要只查均价，把区间也查了', kind: 'steer', cancels: true, addsAlong: true, source: 'chat.ts 停支的闸注释（混着加活的收活）' },
  { text: 'B站那支别查了，再加一个爱奇艺', kind: 'steer', cancels: true, addsAlong: true, source: 'INSERTION_CLASSIFY_PROMPT adds_along 例' },

  // ── 软停：正则覆盖不到的停，由裁决器判 stop（2026-09-28 补档）──
  { text: '先缓一缓，这个就到这儿吧', kind: 'stop', source: 'stop 档契约例（无任何命令词）' },
  { text: '停掉整个任务', kind: 'stop', source: 'stop 档契约例（"停掉"不在 STOP_RE 词表，也无分支锚）' },
  { text: '不用继续了，够了', kind: 'stop', source: 'stop 档契约例' },
  { text: '这个就先这样吧', kind: 'stop', source: 'stop 档契约例' },
  // 反例：看上去像停但不是（信号报错 = 误报）
  { text: '别停下来，继续往下跑', kind: 'steer', source: 'stop 档反例（约束不是停）' },
  { text: '这个先别改，其他照常', kind: 'steer', source: 'stop 档反例（约束不是停）' },

  // ── 纠错族：措辞最多样、没有任何标志词，正是正则最不该碰的 ──
  { text: '我在西安', kind: 'premise-change', source: '改进进度记录 2026-09-22（21775c2）' },
  { text: '其实我在西安，不是广东', kind: 'premise-change', source: 'INSERTION_CLASSIFY_PROMPT premise-change 例' },
  { text: '预算只有三千', kind: 'premise-change', source: 'INSERTION_CLASSIFY_PROMPT premise-change 例' },
  { text: '你对jev的理解是错误的，jev是2026年9月新发布的模型', kind: 'premise-change', source: 'docs/conversational-intelligence-upgrade.md jev 案例' },

  // ── 并进当前产出物：加的是内容不是第二件事 ──
  { text: '背景上加几朵会动的云', kind: 'steer', source: 'Planner.test.ts supplements_current（画鸟补云）' },
  { text: '诗句里一定要出现「明月」', kind: 'steer', source: 'INSERTION_CLASSIFY_PROMPT steer 例' },
  { text: '这首必须是五言的', kind: 'steer', source: 'INSERTION_CLASSIFY_PROMPT steer 例' },
  { text: '标题再大一点', kind: 'steer', source: 'docs/conversational-intelligence-upgrade.md 思考窗吸收' },
  { text: '新增加两位', kind: 'steer', source: 'INSERTION_CLASSIFY_PROMPT steer 例（五位加两位）' },

  // ── 约束/指引 ──
  { text: '记得跑测试', kind: 'steer', source: 'CHANGELOG 插话重构（老逻辑推倒重来的反例）' },
  { text: '文案再口语一点', kind: 'steer', source: 'INSERTION_CLASSIFY_PROMPT steer 例' },

  // ── 提问 ──
  { text: '跑完了吗', kind: 'question', source: 'INSERTION_CLASSIFY_PROMPT question 例' },
  { text: '现在跑到哪一步了', kind: 'question', source: 'DynamicInsertionCoordinator.test.ts' },

  // ── 寒暄 ──
  { text: '哈哈', kind: 'chatter', source: 'INSERTION_CLASSIFY_PROMPT chatter 例' },
  { text: '辛苦了', kind: 'chatter', source: 'DynamicInsertionCoordinator.test.ts' },
  { text: '+1', kind: 'chatter', source: 'INSERTION_CLASSIFY_PROMPT chatter 例' },

  // ── 排期：自带时刻，时间语义先于 kind 生效 ──
  { text: '10 分钟后把标题改成 X', kind: 'scheduled', source: 'DynamicInsertionCoordinator.test.ts' },
  { text: '下午三点再跑一遍完整测试', kind: 'scheduled', source: 'DynamicInsertionCoordinator.test.ts' },

  // ── 歧义：置信门的主场（宁可问一句，不猜着推倒）──
  { text: '这节内容好像都不对了，要不要重新整理一下这一部分', kind: 'goal-change', source: 'DynamicInsertionCoordinator.test.ts 低置信用例' },
  { text: '用X。算了还是Y。不，别管刚才那句', kind: 'steer', source: 'INSERTION_CLASSIFY_PROMPT 自相矛盾例' },
];

/** 人工核对的语料（kind 可断言）。 */
export const ASSERTED_CASES: Case[] = CASES;

/** 全量语料 = 人工核对 + 诊断区审计收割。回归与回放都读这一份。 */
export const ALL_CASES: Case[] = [...CASES, ...HARVESTED_CASES];

export interface MechanicalHit {
  name: string;
  lane: 'main' | 'net';
  gives: Handled;
}

/** 按协调器 decide() 的真实次序判定命中；"命中即返回"的语义在这里体现为
 *  「第一个 main 命中才作数」。 */
export function mechanicalHits(text: string): MechanicalHit[] {
  const hits: MechanicalHit[] = [];
  if (BRANCH_STOP_RE.test(text)) hits.push({ name: 'BRANCH_STOP_RE', lane: 'main', gives: 'branch-stop' });
  if (RESUME_BRANCH_RE.test(text)) hits.push({ name: 'RESUME_BRANCH_RE', lane: 'main', gives: 'branch-resume' });
  if (STOP_RE.test(text)) hits.push({ name: 'STOP_RE', lane: 'main', gives: 'stop' });
  if (GOAL_CHANGE_RE.test(text)) hits.push({ name: 'GOAL_CHANGE_RE', lane: 'net', gives: 'goal-change' });
  if (CANCEL_PART_RE.test(text)) hits.push({ name: 'CANCEL_PART_RE', lane: 'net', gives: 'steer-cancel' });
  if (SCOPE_ADD_RE.test(text)) hits.push({ name: 'SCOPE_ADD_RE', lane: 'net', gives: 'task' });
  return hits;
}

/** 机械路径给的处置跟期望是否同一个方向。期望里写了 detail 就严格比；只写了
 *  kind 时，steer 家族的收活（steer-cancel）也算一致——那正是 steer 的一种。 */
export function aligns(c: Case, gives: Handled): boolean {
  if (c.detail) return c.detail === gives;
  if (c.kind === 'steer') return gives === 'steer-cancel';
  return gives === c.kind;
}

/** 第一个主路命中（这才是真正会抢在裁决器前面的那一条）。 */
export function mainHit(c: Case): MechanicalHit | undefined {
  return mechanicalHits(c.text).find((h) => h.lane === 'main');
}
