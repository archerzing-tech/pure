// src/shared/paramRejectionHeal.ts
// 参数拒绝自愈（2026-11-18 用户定案：「别因为一个参数的设置导致项目过程中断」）。
// pure 往请求体里塞的供应商旋钮（extraBody：reasoning_effort / thinking /
// tool_stream…）不是所有端点都收——DeepSeek V4.1 的 chat_template_kwargs 就
// 不收 `medium`（真机 400 判例：`reasoning_effort must be low, high, xhigh,
// max, or an integer within [1, 100]`）。旋钮是 pure 自己的手脚，不是用户的
// 配置：端点拒收哪个键，就把它从本进程的后续请求里撤掉并**原地重试一次**，
// 回合不中断；重试仍败才把原始错误交回引擎的确定性止损阶梯（证据不丢）。
// 与 providerSelfHeal（模型没了→处方给模型裁决）的分工：这是 pure 修自己的
// 请求形状，纯机械，无需模型裁决。与 schemaQuarantineHeal 的同构点：进程级
// 记账；不同点：撤参是 sticky（一次被拒就永远不再发），不是读即清。
// 亮灯取舍：撤参对模型零可感知影响（旋钮没了≠能力没了），静默机械处理；
// 词表层（providers.ts 的 REASONING_EFFORT_VOCABULARIES）挡已知端点，这一层
// 兜所有未知端点——两类合起来才是「考虑所有的模型」。
// shared 层不碰存储，也不读 i18n（providerSelfHeal 同构）。

/** 进程级撤参账本：scope（baseURL+model）→ 已被端点拒收的键。sticky——
 *  端点对某个键的态度不会在会话中途翻转，撤掉就不回加。 */
const withdrawn = new Map<string, Set<string>>();

/** 归一化 scope：同端点同模型的 http 变体（尾斜杠、大小写）落在同一格。 */
export function paramHealScope(baseURL: string | undefined | null, model: string | undefined | null): string {
  const url = (baseURL ?? '').trim().replace(/\/+$/, '').toLowerCase();
  return `${url}::${(model ?? '').trim()}`;
}

/** 记一笔撤参（进程级 sticky）。 */
export function recordParamWithdrawal(scope: string, param: string): void {
  let set = withdrawn.get(scope);
  if (!set) {
    set = new Set();
    withdrawn.set(scope, set);
  }
  set.add(param);
}

/** 读 scope 的撤参集（不消费）。 */
export function withdrawnParams(scope: string): ReadonlySet<string> {
  return withdrawn.get(scope) ?? new Set();
}

/** 按 scope 撤掉已被拒收的键。extraBody 本就不存在或键全撤光时返回
 *  undefined（调用方据此一个字段都不带，而不是带个空对象）。 */
export function withdrawExtraBody(
  extraBody: Record<string, unknown> | undefined,
  scope: string,
): Record<string, unknown> | undefined {
  if (!extraBody) return undefined;
  const bad = withdrawn.get(scope);
  if (!bad || bad.size === 0) return extraBody;
  const rest = Object.fromEntries(Object.entries(extraBody).filter(([k]) => !bad.has(k)));
  return Object.keys(rest).length > 0 ? rest : undefined;
}

// 端点拒收「参数本身」（而非某个值能修好的抱怨）的措辞族。值类抱怨
// （must be / invalid）也收进动词表：旋钮的合法值域因端点而异，pure 没有
// 通用译法——撤参落到端点默认档，比带着可能再 400 的值重试稳。
// 误召回的代价是丢一个旋钮（回合照常走），漏召回的代价是整回合 400 中断
// ——方向不对称，表放宽是对的。
const REJECTION_VERB_RE = new RegExp(
  [
    'not supported',
    'unsupported',
    'unknown parameter',
    'unrecognized',
    'unexpected',
    'extra_forbidden',
    'not allowed',
    'does not support',
    'must be',
    'is not a valid',
    'invalid value',
  ].join('|'),
  'i',
);

/**
 * 从端点错误原文里认出「拒收的是 pure 注入的哪个键」。命中返回键名；
 * 不命中（网络类错误、401 凭证、与本请求旋钮无关的 400）返回 null。
 * 锚定条件：键名在原文里字面在场 + 任一拒收动词在场——错误正文是一小段
 * JSON，同现锚定足够；不做近邻距离判断，误召回方向安全（见上）。
 */
export function planParamWithdrawal(message: string, extraKeys: readonly string[]): string | null {
  if (!message || extraKeys.length === 0) return null;
  if (!REJECTION_VERB_RE.test(message)) return null;
  for (const key of extraKeys) {
    if (key && message.includes(key)) return key;
  }
  return null;
}

/** 测试与跨面清场用（进程级模块状态，见 flaky-quartet 判例）。 */
export function resetParamHealForTests(): void {
  withdrawn.clear();
}
