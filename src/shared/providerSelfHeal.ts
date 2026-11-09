// src/shared/providerSelfHeal.ts
// Provider 拒绝自愈（2026-11-02 判例：OpenRouter / NVIDIA 全轮「已中断」）：
// 用户把某个 provider 的模型库配好之后，其中一部分模型在服务端其实已经
// 不存在（下架、测试期结束、区域限制、账号未开通、甚至是 embedding 模型被
// 塞进 chat 清单）。pure 对这类拒绝只能停，用户看到的是「已中断」——真正
// 的原因是「这个模型调不通」，而设置本来是可以由 pure 自己修的。
// 这一层只做判断（纯函数，可测）：从 provider 自己的错误原文里认出「模型
// 本身没了」这一类，并给出可执行的修法（从模型库剔除 + 切到清单里下一个）。
// 宿主不落盘改配置——判定结果以处方事件递给模型（事件器见文件尾），由模型
// 自己改模型库或转告用户（2026-11-04 决策边界改革刀一，5856e63 反转定调）。
// shared 层不碰存储，也不读 i18n。

export interface ProviderSelfHealInput {
  /** 中断原因原文（引擎的 stop reason，内含 provider 的错误正文）。 */
  message: string;
  /** 当前 provider id。 */
  provider: string;
  /** 当前模型名（要判定是否失效的那一个）。 */
  model: string;
  /** 该 provider 当前的模型清单（含 current）。 */
  models: readonly string[];
}

export interface ProviderSelfHealPlan {
  /** 拒收的 provider id（处方行的主语）。 */
  provider: string;
  /** 已失效的模型：从模型库里剔除它。 */
  deadModel: string;
  /** 建议切换到的模型；null 表示清单里再没有别的模型可选。 */
  nextModel: string | null;
  /** provider 自己说的话（截断），作为「为什么调不通」的证据给用户看。 */
  detail: string;
}

// 模型不在服务端 / 无权访问 / 根本不能用于 chat 的措辞。刻意不收 401/403
// 的 key 类拒绝：那与模型无关，换模型只会换个致命姿势，key 槽的问题在
// providerSecretKeyFor + Rust 回落里修。
const MODEL_GONE_RE = new RegExp(
  [
    'no longer available',
    'not available in your region',
    'is an embedding model',
    'cannot be used with the chat',
    'model .{0,40}(?:not found|does not exist|not available|deprecated|retired|decommissioned)',
    '(?:not found|does not exist) for (?:this )?account',
    'unknown model',
    'invalid model',
    'unsupported model',
    'function .{0,60}not found',
    // OpenRouter 的退役文案形如「Thank you for participating in the Stealth
    // Ox Alpha testing period. This model was ZAI's GLM-5.3 Flash.」——退役词
    // 在前半句，不能锚在 'this model was' 后面。
    'testing period',
    '(?:model|endpoint) (?:has been |was )?(?:retired|decommissioned|replaced)',
  ].join('|'),
  'i',
);

/** 从一段 provider 错误里摘出可读的一段（去掉围栏、压掉换行）。 */
function excerpt(message: string, limit = 160): string {
  const cleaned = message
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return cleaned.length > limit ? `${cleaned.slice(0, limit)}…` : cleaned;
}

/**
 * 判定一次 provider 拒绝是否属于「模型本身没了」。
 *
 * 命中时返回剔除/切换方案；不命中返回 null（调用方保持原样的停止路径，
 * 把 provider 原文交给 sanitizeInterruptedReason 展示）。
 */
export function planProviderSelfHeal(input: ProviderSelfHealInput): ProviderSelfHealPlan | null {
  const model = input.model?.trim();
  if (!model) return null;
  if (!MODEL_GONE_RE.test(input.message)) return null;
  const alternatives = input.models.map((m) => m.trim()).filter((m) => m && m !== model);
  return {
    provider: input.provider,
    deadModel: model,
    nextModel: alternatives[0] ?? null,
    detail: excerpt(input.message),
  };
}

/** 把剔除后的模型清单算出来（保持顺序，去重）。 */
export function modelsWithout(models: readonly string[], dead: string): string[] {
  const out: string[] = [];
  for (const raw of models) {
    const m = raw.trim();
    if (!m || m === dead) continue;
    if (!out.includes(m)) out.push(m);
  }
  return out;
}

// ── 处方事件器（2026-11-04 决策边界改革刀一）──────────────────────────
// 5856e63 反转定调：自愈裁决权归模型，pure 只做感知手脚。命中「模型没了」
// 时宿主不再静默落盘改配置（原 persistConfig(applyModelSelfHeal(...)) 是被
// 否的自动闭环形状），改记处方事件——各面的 user-turn 装配（GUI
// buildEnvFacts / CLI buildCliEnvFacts）读走注入，模型看到处方自己改模型库
// （设置语义操作 1cf8181 已确保改了真生效）或转告用户。读即清，无事件零注入。

let providerHealPrescriptions: ProviderSelfHealPlan[] = [];

export function recordProviderHealEvent(plan: ProviderSelfHealPlan): void {
  providerHealPrescriptions.push(plan);
  if (providerHealPrescriptions.length > 8) {
    providerHealPrescriptions.splice(0, providerHealPrescriptions.length - 8);
  }
}

/** 读走全部处方（读即清）渲染成 user-turn 处方行；无事件返回空串。
 *  按 provider+dead 去重（同模型反复被拒天然归并）。 */
export function takeProviderHealFacts(): string {
  const plans = providerHealPrescriptions;
  providerHealPrescriptions = [];
  if (plans.length === 0) return '';
  const seen = new Map<string, ProviderSelfHealPlan>();
  for (const p of plans) seen.set(`${p.provider}\n${p.deadModel}`, p);
  const rows = [...seen.values()].map((p) =>
    p.nextModel
      ? `${p.provider} rejected "${p.deadModel}" as gone (${p.detail}) — prescription: remove it from the model list and switch to "${p.nextModel}" (config.json / Settings), then carry on`
      : `${p.provider} rejected "${p.deadModel}" as gone (${p.detail}) — prescription: that provider has no models left, a working one must be added (config.json / Settings) before retrying`,
  );
  return `Provider self-heal prescriptions (the host has NOT changed any config — the decision is yours): ${rows.join('; ')}.`;
}
