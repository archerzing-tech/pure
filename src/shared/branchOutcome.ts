// src/shared/branchOutcome.ts
// 分支中断标识（对话智能升格第 2 期）：委派结果里的 outcome 标记这次「成功」
// 其实是用户点名暂停 / 停掉了一支——不是可复用的成功。
//
// 两个消费点共享同一口径，所以放在 shared：
//  - 引擎去重（同参重派即断点续跑：带 outcome 的「成功」绝不能被去重复用，
//    否则「把 X 那支接着跑完」会永远回放暂停快照）；
//  - 接力流水线（被中断的上游支不能把中断结算体当产出灌给下游，下游必须立即
//    以明确错误落定，而不是拿一份空产出继续跑）。

export type BranchOutcome = 'paused' | 'stopped';

/** 从工具结果里读出「这是用户中断」的标记；普通结果返回 undefined。 */
export function branchOutcomeOf(tr: { result?: { result?: unknown } } | undefined): BranchOutcome | undefined {
  const value = tr?.result?.result;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const outcome = (value as { outcome?: unknown }).outcome;
  return outcome === 'paused' || outcome === 'stopped' ? outcome : undefined;
}
