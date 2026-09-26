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

/** 起飞闸的一条拦截记录：说给协调器发合成结果用。kind 决定收据口径——
 * 出生前被取消 vs 用户已点名停掉那一支后父又重派了一次。 */
export interface TakeoffBlock {
  callId: string;
  reason: string;
  kind: 'cancelled-before-dispatch' | 'stopped-branch';
}

/**
 * 委派起飞闸：给一批**尚未起飞**的委派候选过闸，返回该在出生点拦下的那
 * 几支。两群挂号共用同一套区分词匹配器、同一份纪律（只认区分性命中，打平/
 * 认不出=放行——宁可漏拦交给父边界消化，绝不误杀）：
 * - cancelTexts：用户赶在这支出生之前收掉它的话（'cancelled-before-dispatch'）。
 * - stoppedTexts：用户已点名停掉某一支的话——同一回合里父若又派了一次同一
 *   目标，那一支就是「排队未起飞」的同名支（'stopped-branch'）。真停的效力
 *   因此不依赖父听不听话。
 * 命中即消费（一次性）：返回的 consumed 是本次兑现掉的用户原话，调用方据此
 * 从挂号簿里剪掉。跨回合的挂号由调用方负责清空（新一轮的「继续/再跑」是
 * 用户最新的指令，旧挂号无权否决它）。
 */
export function planTakeoffGate(
  candidates: InFlightBranch[],
  cancelTexts: string[],
  stoppedTexts: string[],
): { blocked: TakeoffBlock[]; consumed: string[] } {
  const blocked: TakeoffBlock[] = [];
  const consumed: string[] = [];
  if (candidates.length === 0) return { blocked, consumed };
  const stillOpen = (): InFlightBranch[] => candidates.filter((c) => !blocked.some((b) => b.callId === c.callId));
  const tryOne = (text: string, kind: TakeoffBlock['kind']): void => {
    const matched = matchInFlightBranch(text, stillOpen());
    if (!matched) return;
    blocked.push({ callId: matched.callId, reason: text, kind });
    consumed.push(text);
  };
  for (const text of cancelTexts) tryOne(text, 'cancelled-before-dispatch');
  for (const text of stoppedTexts) tryOne(text, 'stopped-branch');
  return { blocked, consumed };
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

/**
 * 出生前取消的收执要点名被收掉的话题（用户实测反馈：固定话术里「这项」
 * 是空的，真人同事会说「“未来三年的爆发点”这项不做了」）。纯字符串零
 * 延迟——收执必须抢在委派卡之前，等不得模型。判据同样保守：
 * - 引号里的大概率就是话题本身（用户自己就这么说），最先认；
 * - 没引号就剥祈使框架（「X 这个不要调研了」「不要调研 X 了」）取主干；
 * - 提不出（全是指代词、太短、太长、混着加活）返回 null——收执退回
 *   「这项」的说法，绝不装懂点名。
 */
export function cancelReceiptTopic(text: string): string | null {
  const s = text.trim();
  if (!s) return null;
  // 1) 引号话题：中英引号都认，取第一段 2–30 字的。
  for (const m of s.matchAll(/[“"「『]([^”"」』]{2,30})[”"」』]/g)) {
    const t = m[1].trim();
    if (t && !STEER_STOP_TOKENS.has(t)) return t;
  }
  // 2) 话题在前、祈使收尾：「未来三年的爆发点这个不要调研了」「jev 就不查了」。
  const topicFirst = s.match(/^(.{2,30}?)\s*[，,]?\s*(?:这|那)?(?:个|项)?[，,]?\s*(?:就|先|也)?(?:不要|别|不用|不需|先不|不)再?(?:调研|查|研究|分析|讨论|做|弄|写|聊|管|跑|看)了?[。！!～\s]*$/);
  if (topicFirst) {
    const t = topicFirst[1].trim().replace(/[，,。！!～\s]+$/, '');
    if (t.length >= 2 && t.length <= 30 && !STEER_STOP_TOKENS.has(t)) return t;
  }
  // 3) 祈使开头、话题收尾：「不要调研未来三年的爆发点了」。
  const verbFirst = s.match(/^(?:不要|别|不用|先不|不)再?(?:调研|查|研究|分析|讨论|做|弄|写|聊|管|跑|看)\s*(.{2,30}?)(?:这|那)?(?:个|项)?(?:了|啦)?[。！!～\s]*$/);
  if (verbFirst) {
    const t = verbFirst[1].trim().replace(/^[，,。！!～\s]+/, '').replace(/[，,。！!～\s]+$/, '');
    if (t.length >= 2 && t.length <= 30 && !STEER_STOP_TOKENS.has(t)) return t;
  }
  return null;
}
