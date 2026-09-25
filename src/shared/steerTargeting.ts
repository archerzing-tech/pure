// src/shared/steerTargeting.ts
// 插话定向投递（对话智能升格第 1 期 1a）：在飞委派不再是"一个不透光的大
// 池"——用户点名某一支（「jev 你方向偏了」）时，这句话要直达那一支的引擎，
// 其余照跑；不点名时广播给全体（父 + 所有在飞分支）。纯函数：宿主与测试
// 共用同一套匹配与投递口径，无 DOM、无网络。

/** 在飞分支的宿主视图（来自 agentActivities 事件流，观测单向——不另立账本）。 */
export interface InFlightBranch {
  /** 委派工具调用 id（引擎事件流的 callId，投递寻址的 durable key）。 */
  callId: string;
  /** 分支名（委派工具名，卡片上展示的那个）。 */
  name: string;
  /** 角色描述（def.description）。 */
  role?: string;
  /** 任务书开头片段（onStart 的 inputSnippet）——用户按主题点名的匹配面。 */
  snippet?: string;
}

/** 一条待投递 steer 的目的地：父引擎 / 全体 / 点名的某一支。 */
export type SteerTarget =
  | 'parent'
  | 'all'
  | { branchCallId: string; branchName: string };

/** 引擎拉取 steer 时的身份：子代理引擎由编排器包上自己的分支身份；
 * 不带参数 = 父引擎在问。 */
export interface SteerRecipient {
  branchCallId?: string;
  branchName?: string;
}

/** 代词/指示词这类高频词——出现在任务书里的概率太高，拿它们点名等于掷
 * 筛子，直接不参与匹配。 */
const STEER_STOP_TOKENS = new Set([
  '这个', '那个', '这些', '那些', '哪个', '它', '你', '我', '他', '她',
  '一下', '还是', '就是', '先不', '不要', '不用', '现在', '马上', '然后',
  '其他', '其它', '另外', '刚刚', '刚才', '继续', '不用了', '这样', '那样',
]);

/** 从用户插话里取候选词：拉丁词整取；中文滑窗 2–4 字（「jev 不聊天的模型」
 * 里的「模型」「聊天」都要能被单独摸到）。 */
function candidateTokens(text: string): Set<string> {
  const tokens = new Set<string>();
  for (const m of text.toLowerCase().matchAll(/[a-z][a-z0-9_.-]{1,}/g)) tokens.add(m[0]);
  for (const m of text.matchAll(/[一-鿿]{2,}/g)) {
    const run = m[0];
    for (let n = 2; n <= Math.min(4, run.length); n++) {
      for (let i = 0; i + n <= run.length; i++) tokens.add(run.slice(i, i + n));
    }
  }
  return tokens;
}

/**
 * 用户这句话点名了哪一支在飞分支？判据刻意保守：
 * - 只认**区分性命中**——候选词只出现在这一支的匹配面里才算数；「调研」
 *   这种家家任务书里都有的词永远指不出具体某支。
 * - 最高分打平（两支都命中同样多的区分词）= 分不清，宁可广播也不赌。
 * 返回 null = 没点名（调用方按「全体广播」处理）。
 */
export function matchInFlightBranch(text: string, branches: InFlightBranch[]): InFlightBranch | null {
  if (branches.length === 0 || !text.trim()) return null;
  const tokens = candidateTokens(text);
  if (tokens.size === 0) return null;
  const haystacks = branches.map((b) => `${b.name} ${b.role ?? ''} ${b.snippet ?? ''}`.toLowerCase());
  // 每个候选词先数覆盖面：只被一支含有的才是区分性的。
  const discriminative = new Set<string>();
  for (const token of tokens) {
    if (token.length < 2 || STEER_STOP_TOKENS.has(token)) continue;
    const covering = haystacks.filter((hay) => hay.includes(token)).length;
    if (covering === 1) discriminative.add(token);
  }
  if (discriminative.size === 0) return null;
  let best: InFlightBranch | null = null;
  let bestHits = 0;
  let tied = false;
  for (let i = 0; i < branches.length; i++) {
    let hits = 0;
    for (const token of discriminative) {
      if (haystacks[i].includes(token)) hits++;
    }
    if (hits > bestHits) {
      bestHits = hits;
      best = branches[i];
      tied = false;
    } else if (hits === bestHits && hits > 0) {
      tied = true;
    }
  }
  return bestHits > 0 && !tied ? best : null;
}

/** 这条 steer 要不要「读给」这个拉取者听（复制语义：广播条目人人有份）。 */
export function steerDeliversTo(target: SteerTarget, recipient?: SteerRecipient): boolean {
  if (target === 'all') return true;
  if (target === 'parent') return !recipient?.branchCallId;
  return recipient?.branchCallId === target.branchCallId || (recipient?.branchName !== undefined && recipient.branchName === target.branchName);
}

/** 这个拉取者要不要把这条 steer 从队列里「取走」（消费语义：点名条目只有
 * 被点名的那支能拿走；广播条目归父边界收尾——子代理只读不取，话在回合
 * 结束后的兜底里仍归父处置，绝不因为子代理读过就丢）。 */
export function steerConsumedBy(target: SteerTarget, recipient?: SteerRecipient): boolean {
  if (target === 'parent') return !recipient?.branchCallId;
  if (target === 'all') return !recipient?.branchCallId;
  return recipient?.branchCallId === target.branchCallId || (recipient?.branchName !== undefined && recipient.branchName === target.branchName);
}
