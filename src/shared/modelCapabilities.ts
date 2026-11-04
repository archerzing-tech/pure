// src/shared/modelCapabilities.ts
// 能力清单（capability manifest）——模型代际知识的单一起源。
//
// 为什么要有这一层（2026-11 双腿定位 W1）：原来「窗口 / 输出上限」住在
// providers.ts 的 promptBudgetDefaults if 链里，「是否吃 reasoning_effort」
// 住在另一份正则里，「能不能看图」根本没有任何判定。同一个模型的知识被切
// 成三处、各写各的，加一个新模型要同时改三处代码——模型是连续迭代的，这个
// 形状追不上。本模块把它们收成一张有序规则表 + 一个查询函数：
//
//   · 规则是数据（有序 first-match），加模型 = 加一条规则（或一条用户覆盖）
//   · 每条规则带 id，诊断能说出「命中了哪条」，不再是黑箱
//   · 未知模型返回 known:false，而不是伪造一个天花板
//
// 边界（诚实声明）：这里的「探测」是**命名规则匹配**，不是运行时语义探测。
// 真正的探测需要发请求，属于调用面的活（首次连接时由 adapter 做，结果作为
// 覆盖传进来）；本模块只负责「声明 + 查询 + 保守回落」。
//
// 本模块是叶子：不 import providers.ts（后者 import 它），避免环。

export interface ModelBudget {
  contextWindowTokens: number;
  outputReserveTokens: number;
}

interface BudgetTier {
  /** 命中该档的模型名条件；最后一档省略 when（兜底档）。 */
  when?: RegExp;
  contextWindowTokens: number;
  outputReserveTokens: number;
}

/**
 * 一条预算规则。匹配语义是 OR：providerIn / providerIncludes / modelIncludes
 * / eitherIncludes 任一命中即算命中。规则按数组顺序 first-match ——
 * 顺序即语义（gpt-5 必须先于 gpt-4o）。
 *
 * provider 侧字段的证据强度是这套表的边界（2026-11-04 复审收窄）：model id
 * 由厂商策展，子串命中就是族信号；provider id 里的自定义段是用户自由文本
 * （my-glm-proxy / kimi-relay），子串只说明命名习惯，不构成端点事实——拿它
 * 推断天花板就是伪造。所以 provider 侧只认「内置精确 id」（providerIn）或
 * 显式厂商词根（providerIncludes，现役仅 anthropic），匹配不上宁可无档
 * 回落保守，也不给一个自信的错误值：预算错配的代价是每个请求都超限失败，
 * 比「没默认值」贵得多。未覆盖的空档由 P1 的端点自探测填，不靠猜名字。
 */
export interface ModelBudgetRule {
  id: string;
  /** provider id 精确等于（内置 provider 的口径）。 */
  providerIn?: readonly string[];
  /** provider id 包含该子串；只给显式厂商词根用，不做族猜测。 */
  providerIncludes?: readonly string[];
  /** model id 包含该子串（厂商策展名，子串命中即族信号）。 */
  modelIncludes?: readonly string[];
  /** provider 与 model 用同一个子串匹配（两侧都是子串的族，现役仅 deepseek）。 */
  eitherIncludes?: readonly string[];
  tiers: readonly BudgetTier[];
}

const M = 1_000_000;

/**
 * 内置预算表。数值口径见 providers.ts 原注释（2026-08 vendor docs 核对）；
 * 迁移时逐条等价搬迁，providers.test.ts 的既有断言就是等价性护栏。
 */
export const MODEL_BUDGET_RULES: readonly ModelBudgetRule[] = [
  // 本地运行时排在最前：这里的上限是**主机**约束（显存/内存），不是厂商
  // 天花板；一旦让模型名族先命中，ollama 上跑 qwen2.5-coder:7b 会拿到 262k
  // 预算（原 if 链就有这个矛盾：注释写着「stay conservative」，实现却被
  // qwen 分支先截走）。provider 是主机事实，优先于模型命名。
  {
    id: 'local-runtime',
    providerIn: ['ollama', 'lmstudio'],
    modelIncludes: ['llama'],
    tiers: [{ contextWindowTokens: 32_768, outputReserveTokens: 4_096 }],
  },
  {
    id: 'deepseek',
    eitherIncludes: ['deepseek'],
    tiers: [
      { when: /v4|flash|pro/, contextWindowTokens: M, outputReserveTokens: 131_072 },
      { contextWindowTokens: 128_000, outputReserveTokens: 32_768 },
    ],
  },
  {
    id: 'glm',
    providerIn: ['glm'],
    modelIncludes: ['glm'],
    tiers: [{ contextWindowTokens: M, outputReserveTokens: 128_000 }],
  },
  {
    id: 'qwen',
    providerIn: ['qwen'],
    modelIncludes: ['qwen'],
    tiers: [
      { when: /max/, contextWindowTokens: M, outputReserveTokens: 65_536 },
      { contextWindowTokens: 262_144, outputReserveTokens: 65_536 },
    ],
  },
  {
    id: 'moonshot-kimi',
    providerIn: ['moonshot'],
    modelIncludes: ['kimi'],
    tiers: [
      { when: /k3/, contextWindowTokens: M, outputReserveTokens: 65_536 },
      { contextWindowTokens: 262_144, outputReserveTokens: 65_536 },
    ],
  },
  {
    id: 'minimax',
    providerIn: ['minimax'],
    modelIncludes: ['minimax'],
    tiers: [{ contextWindowTokens: 204_800, outputReserveTokens: 131_072 }],
  },
  {
    id: 'claude',
    providerIncludes: ['anthropic'],
    modelIncludes: ['claude'],
    tiers: [
      { when: /opus-5|sonnet-[456]-?6|sonnet-5|haiku-5/, contextWindowTokens: M, outputReserveTokens: 128_000 },
      { contextWindowTokens: 200_000, outputReserveTokens: 64_000 },
    ],
  },
  {
    id: 'gpt-5',
    modelIncludes: ['gpt-5'],
    tiers: [{ contextWindowTokens: 400_000, outputReserveTokens: 128_000 }],
  },
  {
    id: 'gpt-4o',
    modelIncludes: ['gpt-4o'],
    tiers: [{ contextWindowTokens: 128_000, outputReserveTokens: 16_384 }],
  },
  {
    id: 'openai-o-series',
    modelIncludes: ['o1', 'o3'],
    tiers: [{ contextWindowTokens: 200_000, outputReserveTokens: 100_000 }],
  },
];

/** 一条「特质」规则：模型名命中即具备该特质。 */
export interface ModelTraitRule {
  id: string;
  modelPattern: RegExp;
}

/**
 * 吃 `reasoning_effort` 的族。刻意保守：只收 2026 起的世代；未命中即
 * 「不支持」（Settings 里可以按 provider::model 强制开/关，那是覆盖层的事）。
 */
export const REASONING_TRAIT_RULES: readonly ModelTraitRule[] = [
  {
    id: 'reasoning-2026',
    modelPattern: /(?:gpt-[5-9]|glm-[5-9]|deepseek-(?:v[4-9]|r[2-9])|qwen[4-9]|qwen[3-9]\.[5-9]|qwen[3-9]-max|qwq|qmax|claude-[5-9]|claude-(?:opus|sonnet|haiku)-[5-9]|claude-(?:opus|sonnet|haiku)-4[-.]?[6-9]|fable|gemini-[3-9]|kimi-k[3-9]|moonshot-v[2-9]|minimax-m[2-9])/i,
  },
];

/**
 * 能接受图像输入的族。只收「确定支持」的命名族；未命中返回 unknown 而不是
 * false —— 猜错成「不支持」会让模型对一条它其实能看的图回答「我看不了」，
 * 那比不判定更糟。
 */
export const VISION_TRAIT_RULES: readonly ModelTraitRule[] = [
  { id: 'vision-openai', modelPattern: /(?:gpt-[4-9]|o[3-9](?!-mini))/i },
  { id: 'vision-claude', modelPattern: /claude-(?:3|4|5|6|opus|sonnet|haiku)/i },
  { id: 'vision-gemini', modelPattern: /gemini-[1-9]/i },
  { id: 'vision-qwen-vl', modelPattern: /qwen.*(?:vl|omni)/i },
  { id: 'vision-glm', modelPattern: /glm-(?:4|5).*v(?:l)?\b|glm-4v|glm-5v/i },
  { id: 'vision-minimax', modelPattern: /minimax.*(?:vl|vision)/i },
  { id: 'vision-kimi', modelPattern: /kimi.*(?:vl|vision)/i },
  { id: 'vision-oss', modelPattern: /(?:llava|pixtral|internvl|qvq|idefics|cogvlm)/i },
];

export interface TraitResolution {
  /** 规则命中（= 确定支持）；未命中的语义由调用方解释。 */
  known: boolean;
  supported: boolean;
  ruleId?: string;
}

export interface ResolvedModelCapability {
  budget?: ModelBudget;
  /** 命中的预算规则 id；未命中为 undefined（回落保守档）。 */
  budgetRuleId?: string;
  reasoning: TraitResolution;
  /** known:false 表示「没判定出来」，不是「不支持」。 */
  vision: TraitResolution;
}

function matchesBudgetRule(rule: ModelBudgetRule, provider: string, model: string): boolean {
  if (rule.providerIn?.includes(provider)) return true;
  if (rule.providerIncludes?.some((part) => provider.includes(part))) return true;
  if (rule.modelIncludes?.some((part) => model.includes(part))) return true;
  if (rule.eitherIncludes?.some((part) => provider.includes(part) || model.includes(part))) return true;
  return false;
}

/**
 * `missedIsKnownFalse` 是两类特质的分歧点：reasoning 的清单是「白名单」——
 * 不在名单上就确定不发该参数（保守），所以未命中是 known:false 的反面；
 * vision 的清单是「已知支持」——未命中只说明没判定出来，不能断言不支持。
 */
function resolveTrait(rules: readonly ModelTraitRule[], model: string, missedIsKnownFalse: boolean): TraitResolution {
  if (!model) return { known: false, supported: false };
  for (const rule of rules) {
    if (rule.modelPattern.test(model)) return { known: true, supported: true, ruleId: rule.id };
  }
  return { known: missedIsKnownFalse, supported: false };
}

/**
 * 解析一个 model 的能力。provider 只参与预算规则的族匹配（同一个模型挂在不同
 * 网关上窗口一样），特质只看模型名。
 *
 * 预算命中规则但无 tier 命中时回落该规则兜底档（每条规则最后一项无 when）。
 */
export function resolveModelCapability(
  provider: string | undefined | null,
  model: string | undefined | null,
): ResolvedModelCapability {
  const p = (provider ?? '').trim().toLowerCase();
  const m = (model ?? '').trim().toLowerCase();

  let budget: ModelBudget | undefined;
  let budgetRuleId: string | undefined;
  // 空 model 也要解析：调用面会在只配了 provider 的回合问家族默认（原 if 链
  // 就是 `id === 'glm'` 独立成立），这类查询不能因为 model 缺失掉到保守档。
  for (const rule of MODEL_BUDGET_RULES) {
    if (!matchesBudgetRule(rule, p, m)) continue;
    const tier = rule.tiers.find((item) => !item.when || item.when.test(m));
    if (tier) {
      budget = { contextWindowTokens: tier.contextWindowTokens, outputReserveTokens: tier.outputReserveTokens };
      budgetRuleId = rule.id;
    }
    break;
  }

  return {
    budget,
    budgetRuleId,
    reasoning: resolveTrait(REASONING_TRAIT_RULES, m, true),
    vision: resolveTrait(VISION_TRAIT_RULES, m, false),
  };
}

/** ASCII 一行能力摘要，供 sys_info 的预算现状行拼接（sidecar 可 grep）。 */
export function modelCapabilitySummary(cap: ResolvedModelCapability): string {
  const reasoning = cap.reasoning.known ? (cap.reasoning.supported ? 'yes' : 'no') : 'unknown';
  const vision = cap.vision.known ? (cap.vision.supported ? 'yes' : 'no') : 'unknown';
  const rule = cap.budgetRuleId ?? 'none';
  return `capabilities: rule=${rule} reasoning=${reasoning} vision=${vision}`;
}
