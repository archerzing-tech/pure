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
  /** 这句发生在哪个场景里（`SCENARIOS` 的键）。不写就走 DEFAULT_SCENARIO。
   *  回放原先给**每一句**喂同一个上下文（并行调研三个平台），于是「我在西安」
   *  「这首必须是五言的」被放进一个与它们真实场景无关的语境里判——判错的是
   *  上下文，不是模型。2026-09-28 实测后每条 Case 可以指名自己的场景。 */
  scenario?: string;
  /** 判它时**真实记下**的场景原文（`InputDecision.inputContext`）。只有自动收割
   *  的用例带它，优先于 `scenario`。
   *
   *  为什么不把它归到 `SCENARIOS` 的某个键下：`SCENARIOS` 是人工写就的场景库，
   *  而自动收割最不该做的就是编辑现场。疑点句是"在某个具体局面下判成这样的"
   *  ——换成默认场景重判，可能根本复现不出当初那个疑点，那么"判错了能看到在
   *  什么场景下判的"就只停在看得见，接不上"下一次跑得到"。 */
  scenarioText?: string;
}

/**
 * 语料自带的场景上下文（2026-09-28）。
 *
 * 放的是**场景**，不是**答案**：只有当前任务的诉求与阶段，不含任何暗示该判成
 * 什么的提示——否则语料就变成「把答案抄进上下文」，断言失去意义（有一条测试
 * 守住这一点）。上下文只描述**「顺势而为」在这里意味着什么**，判定仍归裁决器。
 */
export const SCENARIOS: Record<string, string> = {
  /** 默认：执行中、并行委派在飞。语料里最多句子的原始语境。 */
  'platform-research': [
    '用户当前诉求：帮我调研 B站/腾讯/优酷 三个平台的会员价格，最后出一份对比汇总',
    '并行委派：共 3 个，在飞 3 个',
  ].join('\n'),
  /** 规划类纠错的原场景：一条五日自驾路线，预算与落脚点都还算在手里。 */
  'travel-plan': [
    '用户当前诉求：帮我规划一条从广东到广西的五日自驾路线，包含每天的落脚点和预算',
    '（当前状态：模型正在思考这个任务的规划、还未开始执行——此刻纠正事实或补充约束会并进请求重新思考）',
    '思考最新说到：先定路线：广东出发往西，每天一个落脚点，预算按四人两天一结',
  ].join('\n'),
  /** 写一首诗：唯一产出物是那一首，体裁/字数/意象都是它的属性。 */
  'poem-writing': [
    '用户当前诉求：写一首咏月的五言绝句，末尾附一句注释',
    '（当前状态：模型正在思考这个任务的规划、还未开始执行——此刻补充约束会并进请求重新思考）',
    '思考最新说到：先定体裁与字数，再选意象：月、桂、夜',
  ].join('\n'),
  /** 画一张图：构图与文字排版都是那一张图的属性。 */
  'drawing': [
    '用户当前诉求：画一只站在枝头的小鸟，做成一张竖版图',
    '（当前状态：模型正在思考这个任务的规划、还未开始执行）',
    '思考最新说到：……先确定构图：一只小鸟站在枝头，背景留白，右下角留标题位',
  ].join('\n'),
  /** 改文档的一节：目标是改完那一节，其余章节不动。 */
  'doc-section': [
    '用户当前诉求：把这份技术文档的「性能」一节改写清楚，其余章节保持不动',
    '（当前状态：模型正在思考这个任务的规划、还未开始执行）',
    '思考最新说到：先读现有那一节，找出说不清的地方再动笔',
  ].join('\n'),
};

export const DEFAULT_SCENARIO = 'platform-research';

/** 带真实场景原文的用例用这个 id（不是 `SCENARIOS` 的键，只是回放报告里区分
 *  "人工命名的场景"与"收割来的现场"）。 */
export const HARVESTED_SCENARIO_ID = 'harvested-context';

/** 这句该在哪个场景里判（回放与测试共用这一个读法）。收割来的用例带的是它
 *  当初被判时的场景原文，优先于场景键。 */
export function scenarioFor(c: Case): { id: string; text: string } {
  const literal = c.scenarioText?.trim();
  if (literal) return { id: HARVESTED_SCENARIO_ID, text: c.scenarioText as string };
  const id = c.scenario ?? DEFAULT_SCENARIO;
  return { id, text: SCENARIOS[id] };
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
  // 双读句，**不算断言**（2026-09-28 降级为 suspected）：`不要只查均价` 字面是
  // "不要仅限于查均价"——均值仍被需要，只是不再排他，所以既不该报 cancels_part
  // 也没有 adds_along。原先把它当"混着加活的收活"是本项目自己把 `只` 读丢了，
  // 实测反复不稳正是这个原因（3 次 2 掉）。它留在语料里作待复核向量：回放每轮
  // 都会再判一遍，但不进契约遵守率的分母（分母只收可断言的句子）。
  { text: '不要只查均价，把区间也查了', kind: 'steer', expectation: 'suspected', source: 'chat.ts 停支的闸注释——原定 cancels+adds，2026-09-28 复核为双读，降级待复核' },
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
  { text: '我在西安', kind: 'premise-change', scenario: 'travel-plan', source: '改进进度记录 2026-09-22（21775c2）' },
  { text: '其实我在西安，不是广东', kind: 'premise-change', scenario: 'travel-plan', source: 'INSERTION_CLASSIFY_PROMPT premise-change 例' },
  { text: '预算只有三千', kind: 'premise-change', scenario: 'travel-plan', source: 'INSERTION_CLASSIFY_PROMPT premise-change 例' },
  { text: '你对jev的理解是错误的，jev是2026年9月新发布的模型', kind: 'premise-change', source: 'docs/conversational-intelligence-upgrade.md jev 案例' },

  // ── 并进当前产出物：加的是内容不是第二件事 ──
  { text: '背景上加几朵会动的云', kind: 'steer', scenario: 'drawing', source: 'Planner.test.ts supplements_current（画鸟补云）' },
  { text: '诗句里一定要出现「明月」', kind: 'steer', scenario: 'poem-writing', source: 'INSERTION_CLASSIFY_PROMPT steer 例' },
  { text: '这首必须是五言的', kind: 'steer', scenario: 'poem-writing', source: 'INSERTION_CLASSIFY_PROMPT steer 例' },
  { text: '标题再大一点', kind: 'steer', scenario: 'drawing', source: 'docs/conversational-intelligence-upgrade.md 思考窗吸收' },
  { text: '新增加两位', kind: 'steer', scenario: 'poem-writing', source: 'INSERTION_CLASSIFY_PROMPT steer 例（五位加两位）' },

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
  { text: '这节内容好像都不对了，要不要重新整理一下这一部分', kind: 'goal-change', scenario: 'doc-section', source: 'DynamicInsertionCoordinator.test.ts 低置信用例' },
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
