// src/shared/insertionMessaging.ts
// 插话话术的单一事实来源（2026-09-28）：取消这件事在系统里有三处教导/呈现
// ——① L1 协议（教模型口径）；② steer 框架文本（宿主投递时给的口径）；③
// 宿主收执（用户当场看到的口径）。三处各自改文案就会漂移（收执说「暂停了」
// 而协议说「别停」就是用户可见的自相矛盾），所以搬进一个共享模块，让回归
// 测试一次锁住三处的一致性。
//
// 纪律：这里只放「同一规则的多处措辞」，不放判定逻辑。判定（谁停、停哪支、
// 何时停）归 DynamicInsertionCoordinator / chat.ts / steerTargeting.ts。
//
// 核心口径（与 INSERTION_PROTOCOL_PROMPT 2026-09-28 改稿一致）：
//   停/暂停一支是**宿主的动作**，模型永不亲自动手停；模型负责叙述、排除
//   产出（不进最终汇总）、合并幸存者。收执必须与这个口径同一方向——宿主
//   说「我先暂停了」，是「已完成的动作」的汇报，不是模型去停。
//
// 收执纪律（2026-09-28 用户定调「固定话术全部删除，基于事实来回答」）：
//   收执只说**这个场景里真实发生/真实存在**的事。机制承诺（没派的不会派、
//   不进最终汇总、只合并幸存者）一律不住在收执里——它们住在协议与框架里，
//   那些文本面向模型、说机制才对。收执面向用户：单任务场景说「派/汇总」
//   就是驴头不对马嘴（2026-09-28 事故：「不用测试了」被回「还没派的不会
//   派出去，也不会进最终汇总」——那个场景没有多支、没有汇总）。所以
//   cancelBeforeDispatchReceipt 只说砍了什么、剩下照旧；涉及支/汇总的收执
//   （停支、折入）只在那些机制真实在场的路径上被调用，才允许说那些词。

/** ② steer 框架文本（chat.ts steerRunningTurn 的投递正文）。cancel=true 用
 *  取消口径——通用口径的「选最小动作，手头的活继续」会把取消引导成「计划
 *  照旧」（2026-09-26 事故：收执说不会派、计划书里三支全名），所以取消必须
 *  走自己的框架：计划当场缩，被收掉的不派工不进汇总。叙述规则按场景给：
 *  有分路数剩下的分路，没分路就不提分路——框架不预设场景里有几路（2026-09-28
 *  事故：单任务游戏被教着「复述原规划几路」，模型只好对着一路编排「几路」）。 */
export function steerFrameText(text: string, cancel: boolean): string {
  return cancel
    ? `【用户插话·顺路带上】${text}\n（这是任务进行中的取消，不是新任务：用户收掉了一个方向/话题。把它从计划和后续动作里去掉，不要再为它派工，它的产出不进最终汇总；其余工作照常。复述计划时只说实际保留的部分——计划里有分路就数剩下的分路，没有分路就不要提分路。）`
    : `【用户插话·顺路带上】${text}\n（这是任务进行中的插话，不是新任务：按 <insertion_protocol> 判断它影响什么，选最小动作，手头的活继续。）`;
}

/** ③-a 停支收执（宿主按模型指认的 callId 真停成功后，此时委派确实在飞）。宿主
 *  已完成的动作的汇报——pause（收活「先停下」，活口大）与 abort（祈使
 *  「停掉那支」）两种。「产出」不预设这支在干调研还是写码。 */
export function branchStopReceipt(label: string, mode: 'pause' | 'abort'): string {
  return mode === 'pause'
    ? `明白——「${label}」那路我先暂停了，它的产出不进最终汇总；其余照常跑，想续上随时说。`
    : `已停掉「${label}」那支——进度留了断点，随时可以让它接着跑，其余照常。`;
}

/** ③-a2 拿不准暂停的收执（2026-10-21 真机三连，用户定调「方向性问题大
 *  bug」）：去重复核没给结论（超时/解析失败）时宿主的兜底不再是「不重复
 *  派」照旧跑——用户说了「不需要」却被任其继续，是当着用户的面背叛，且
 *  不可逆；误停一支是可逆的（说一声就续上）。拿不准选可逆的一边：暂停
 *  covered 那支，收执诚实交代没拿准+给出恢复口——绝不装「明白」（那会儿
 *  恰恰是没听懂）。 */
export function branchUncertainPauseReceipt(label: string): string {
  return `这句我没拿准您的意思——保险起见先把「${label}」那路暂停了，它的产出暂时不进汇总；该继续的话说一声，我马上让它接着跑。`;
}

/** ③-b 出生前取消的收执（委派还没起飞，也可能压根没有委派——单任务场景）。
 *  只说砍了什么，其余的交给模型下个叙述去讲：这个收执可能在没有任何
 *  委派/汇总的场景里发出，所以一个机制词汇都不带（2026-09-28 事故原文
 *  「还没派的不会派出去，也不会进最终汇总」——单任务里两头都是空话）。 */
export function cancelBeforeDispatchReceipt(topic: string | null): string {
  return topic ? `好——“${topic}”这项不做了。` : '好——这项不做了。';
}

/** ③-c 折入收执（取消型 vs 追加型）。取消口径绝不能沿用追加口径——把
 *  「收掉一项」回成「先补这项」就是反向执行（2026-09-24 事故原话）。 */
// hasDelegation 无默认值——调用方必须显式声明场景（忘传 = 编译错误而不是
// 单任务里静默说多路黑话）。
export function foldInReceipt(cancels: boolean, hasDelegation: boolean): string {
  if (cancels) {
    // 有委派在飞：机制词汇真实在场，可以说。
    if (hasDelegation) {
      return '收到——这项不做了；其余照常。';
    }
    // 没有委派在飞（单任务场景）：一个机制词都不带——「汇总」「合并」
    // 「收齐」这些词只属于多路调研的世界，单任务里说了就是编造
    // （2026-10-01 用户事故：做飞机大战，插话「不用测试了」，收执却回
    // 「不进最终汇总；收齐后只合并剩下的」——驴头不对马嘴）。
    return '好——这步不做了。';
  }
  if (hasDelegation) {
    return '已收到——收齐后先补这项。';
  }
  return '收到——做完手头的就带上这句。';
}

/** ③-c 早派收执（刀 2.2 早派版，2026-10-10）：追加在挂号时已经真的派出
 *  去了——沿用「收齐后先补这项」就是失实收执（它不等收齐，现在就在跑）。
 *  诚实口径说清三件事：已在跑、与其余几路并行、产出仍并入最终汇总。
 *  只在宿主真的当场派出时才用；回落汇合路由时仍用 foldInReceipt。 */
export function foldInEarlyReceipt(): string {
  return '已收到——这项不用等收齐，我已经直接派出去补跑了，与其余几路并行，产出照样并入最终汇总。';
}

/** ④ 取消型折入的引擎侧框架（chat.ts cancelFoldInstruction）。与追加框架
 *  反着说死：不许派新委派、部分产出不算结论不进汇总、幸存分支照常合并。 */
export function cancelFoldInstruction(text: string): string {
  return `【中途取消，不是追加】用户中途收掉了这项工作：${text}\n执行要求：不要再为它派任何委派；已经跑出的相关部分不算结论、不写入最终汇总（用户没说要保留）。委派收齐后，最终汇总只覆盖剩下的对象，并用一句话交代这项已按要求取消。`;
}

/** 已结算支的产出剔除墓碑（缺口②机械排除，2026-10-15）：委派已收工、产出
 *  已写进父上下文后用户点名取消这一路——把上下文里那路的结果整体换成本
 *  文。与在飞停支「结算体不带产出」（SubagentOrchestrator）同一语义：父上下
 *  文从此没有这路产出可写进汇总，不依赖 cancelFoldInstruction 劝阻；fold
 *  照折（宣布「已取消」的职责仍在框架文本里）。 */
export function settledBranchCancelNote(): string {
  return '【已按用户要求取消】用户中途收掉了这一路的工作，其全部产出已从汇总素材中剔除。不要引用或复述本条的任何内容；最终汇总不包含这一路，只用一句话交代它已按用户要求取消。';
}

/** 取消折入但「点名停支」没停成时的收执（2026-10-10 修「取消后子 agent 不
 *  停」的收执半边）。此时只有取消挂号（拦新委派）与折入守门（产出不进汇
 *  总）在生效，在飞支一个没停——「这项不做了；其余照常」在这个场景是失实
 *  收执（什么都没停却说得像已停）。如实说「没停」，并把唯一能真停的说法
 *  （点名）交给用户——收执纪律：只说真实发生的事。 */
export function cancelFoldUnmatchedReceipt(): string {
  return '收到——这项不做了，产出不会进最终结果。不过正在跑的相关支我没点出是哪一支，先没停：要立刻停下的话，说「停掉 XX 那支」我就停。';
}

/** ④ 追加型折入的引擎侧框架（chat.ts foldInInstruction）。与取消框架互补：
 *  把「别光汇总」说死——追加项像其他委派一样派出去做完，再合并输出。 */
export function foldInInstruction(text: string): string {
  return `【中途追加的任务，不是闲聊】用户要求在本次任务里追加：${text}\n执行要求：把这项追加的工作像其他委派一样派出去做完；拿到结果后，把它与本次任务已产出的全部内容合并，输出一份覆盖所有对象的最终汇总。在此之前不要输出最终汇总。`;
}

/** 折入没被照办时转排队的兜底口径（chat.ts foldInFollowUpText）。 */
export function foldInFollowUpText(text: string): string {
  return `（中途追加）${text}\n把这项追加的工作做完，然后把结果与此前任务的产出合并，输出一份覆盖全部对象的完整汇总（此前的产出在会话历史里）。`;
}

/** ⑥ 队列重入的交接框架（2026-10-21 对话主导架构刀 C）：排队插话在回合收尾
 *  后经 reenter 重入——原话裸发的问题是模型把它当成凭空而来的新请求，不知
 *  道这是「我忙时用户说的、排到了现在」，答出来的东西和刚做完的活、当时的
 *  对话对不上（用户报的「说出来的话和语境不搭」的直接机制）。框架交给模型
 *  三个事实：话是用户在你工作时说的；当时在忙排到了现在；现在接上——结合
 *  刚做的事消化，它可能延续、补充或修正刚完成的成果。屏幕显示的仍是原话
 *  （displayText），框架只走引擎。 */
export function queuedHandoffText(text: string): string {
  if (!text.trim() || text.startsWith('【排队中的用户消息')) return text;
  return `【排队中的用户消息·现在轮到它】${text}\n（这是你忙于前一件事时用户发来的话，当时排进了队列；现在前一件事已收尾，轮到接这句话。结合刚做完的事和对话的来龙去脉消化它——它可能延续、补充或修正刚完成的成果，不要当成凭空而来的新请求从零开始。）`;
}

/** 排期收执（第 5 期「调度」）：插话产生的 task 进待办队列时，宿主当场说
 *  一句「排上了」——队列卡是逐条可见的账，这句话是排队这个动作的**事实陈
 *  述**，不含机制承诺、不预告顺序之外的东西。口吻与详略归第 6 期，这里只
 *  说事实（排上了）。用户口头说「这个急」被提级时走 queuedUrgentReceipt，
 *  如实说「插队了」。 */
export function queuedReceipt(): string {
  return '这句排上了，办完手头就轮到。';
}

/** 提级排期收执（第 5 期）：用户说了「这个急」，宿主照做把它插到队头——
 *  收执如实交代「插队了、办完手头就轮到」，与 queuedReceipt 同款只陈述事实。 */
export function queuedUrgentReceipt(): string {
  return '这句急，我插到队头——办完手头就轮到。';
}

/** ⑤ 分支级继续的收执（第 2 期第三刀）：排队（interjectOrchestrator）与派工
 *  （chat.ts takeSyntheticToolCalls）两处共用一个出处。二分口径（蓝图判例
 *  14「回执说清从哪轮接的」+「找不到断点不许悄悄从头跑」）：命中 checkpoint
 *  说从断点第几轮接上；没命中明说没找到存档、会重新跑——绝不预支「从断点
 *  继续」的承诺（GUI 的 checkpoint 在进程内存里，重启/旧会话后 miss 是常态，
 *  收执替机制许愿就是说谎）。pending=true = 还有委派在飞（这支等收齐再接），
 *  补一句时序交代；派工收执（本批就是它）不带走时不带。 */
export function branchResumeReceipt(
  label: string,
  checkpoint: { hit: boolean; turns: number },
  pending: boolean,
): string {
  const tail = pending ? '等手头这批收齐接上。' : '';
  return checkpoint.hit
    ? `续跑：「${label}」从存档断点（第 ${checkpoint.turns} 轮）接上。${tail}`
    : `续跑：「${label}」——没找到存档，会重新跑一遍。${tail}`;
}

/** 整树续跑的对话流回执判定（第 3 期刀 3）：send('继续') 引导的恢复回合里，
 *  每个重派支起飞时宿主问一次本函数。命中存档说从第几轮接；停着的旧支存档
 *  没跟上就明说重跑；本轮新委派不出声——回执替机制许愿就是说谎，噪音回执
 *  稀释真信号同理。话术与分支级继续同源（branchResumeReceipt），两处不许
 *  漂移。防重（段内续 slice 的二次 onStart 不再出声）是宿主按 callId 记的
 *  账，纯函数只管单次判定。 */
export function treeResumeReceipt(
  activity: { resumed?: boolean; resumedTurns?: number; agentName: string },
  ctx: { resumingPausedTurn: boolean; pausedBranches: ReadonlySet<string> },
): string | null {
  if (activity.resumed) return branchResumeReceipt(activity.agentName, { hit: true, turns: activity.resumedTurns ?? 0 }, false);
  if (ctx.resumingPausedTurn && ctx.pausedBranches.has(activity.agentName)) {
    return branchResumeReceipt(activity.agentName, { hit: false, turns: 0 }, false);
  }
  return null;
}

/** 三处口径的一致性锚（一致性测试读它，不读各处散文）——每条都是「取消」
 *  这个动作在系统里必须同时成立的三个面：宿主动手、产出出清、幸存者合并。 */
export const CANCELLATION_INVARIANTS = {
  /** 宿主停支，模型永不停支（协议措辞锚）。 */
  hostStops: 'host stops or pauses that branch',
  /** 模型侧框架/收执必须传达：被收掉的部分不进最终结果。各站措辞有自然
   *  变体（不进/不会进/不写入 最终汇总），锚用正则锁语义方向而不是锁死
   *  某一种写法——同族措辞才算同向，写了「进最终汇总」才是漂移。 */
  staysOutOfResult: /不(?:会)?(?:写入|进)最终汇总/,
  /** 幸存分支照跑、合并只覆盖幸存者（协议措辞锚）。 */
  survivorsMerge: 'the merge covers the survivors only',
  /** 收执安全线（2026-09-28）：出生前取消收执可能在没有任何委派/汇总的
   *  单任务场景发出，一个机制词汇都不能带——测试断言它**不匹配**这个正则。
   *  停支/折入收执不受此锁（那些路径机制真实在场）。 */
  absentMechanismWords: /派|汇总|支/,
} as const;

/** 续跑口径的一致性锚（第 2 期第三刀）：命中必须说断点（最好带轮数）、
 *  未命中必须认账「没找到存档」——漂移到任何一头，都是收执在替机制许愿
 *  或把用户蒙在鼓里。 */
export const RESUME_INVARIANTS = {
  // 全角括号是字面量不是分组：锚必须真咬住轮数（\d+ 缺席即锚失效）。
  hitSaysFromCheckpoint: /从存档断点（第 \d+ 轮）/,
  missAdmitsNoArchive: /没找到存档/,
} as const;

// ── 插话架构 v2 收执（2026-10-27 软暂停/九类/真暂停链）─────────────────────
// v2 里插话到达即被宿主软暂停押着（hold on），判定放行才到模型；这里新增的
// 收执是放行/转向/真暂停/冻结几个宿主动作的当场口径。收执纪律不变（§十.6
// 保留）：只说这个场景里真实发生/真实在场的事——放行/转向/真暂停都可能发生
// 在单任务（无委派无汇总）场景，机制词汇照旧一个不带；机制语义（九类处置、
// 清理链、幸存者合并）住在协议与框架文本里，那里才面向模型。

/** 软暂停一致性锚（与 CANCELLATION_INVARIANTS 同型的契约锚）：放行必须传
 *  达「手头照跑」；转向必须同时说「受影响的停/清」与「其余照常」；真暂停
 *  必须「推倒」与「重新想」同句在场（只清不重想是把用户晾着，只重想不清
 *  是把错误当底）；冻结必须带「冻」并开口问用户；自查交代必须明说「没跑
 *  偏」的结论——不许装改正（没有错可改），也不许闷头当没听见。 */
export const HOLD_INVARIANTS = {
  releaseKeepsRunning: /接着跑/,
  turnNamesAffected: /受影响/,
  turnSparesRest: /照常/,
  truePauseTearsDown: /推倒/,
  truePauseRethinks: /重新想/,
  frozenNamesFreeze: /冻/,
  frozenAsksUser: /你说一声|要不要|还是/,
  selfCheckStatesVerdict: /没跑偏/,
} as const;

/** v2 软暂停解除——放行收执：hold 判完打开、主线方向不动（supplement/
 *  emphasize 纳入、question 旁答、unrelated 回告、meta 应用后继续）。
 *  folded=true = 这句会并进手头的活（纳入执行的真实承诺）；false = 不触碰
 *  主线，只说记下了——对旁答/无关的话说「并进」就是编造。topic 传插话原话
 *  或其要点，没有可引的就显式传 null。 */
export function holdReleaseReceipt(topic: string | null, folded: boolean): string {
  const said = topic ? `“${topic}”` : '这句';
  return folded
    ? `收到——${said}并进手头的活里，接着跑。`
    : `收到——${said}记下了，手头的活不受它影响，接着跑。`;
}

/** v2 软暂停解除——转向收执：hold 判完打开、主线按插话改道（change/
 *  correction 的进行中处置）。只能在受影响的在飞活确实已被宿主停掉/清出的
 *  路径上用——「停下来清出去了」是已完成动作的汇报，没停成还说它就是失实
 *  收执（cancelFoldUnmatchedReceipt 的教训：没停要明说没停）。 */
export function holdReleaseTurnReceipt(topic: string): string {
  return `明白——照这句改：受影响的活我停下来清出去了，按「${topic}」接着干，没受影响的照常。`;
}

/** v2 真暂停收执：理解纠偏坐实（自查确认当前输出不忠实于用户上一句，或改
 *  变的目标已被旧方向实质产出）——宿主掐流、把基于错误理解的产出清出上下
 *  文，新回合带着用户上一句原话 + 纠偏输入重新开始。「推倒」与「重新想」
 *  必须同时在场（HOLD_INVARIANTS 锁）。屏幕上那段留底是给用户看的记录，
 *  不是新推理的地基——这句负责把两件事说开（蓝图 §七.3：现场清、UI 留底、
 *  账本作废）。 */
export function truePauseReceipt(): string {
  return '这里我之前理解偏了——基于这个理解跑出来的部分我推倒了，带着你上一句话和这句纠偏重新想。屏幕上先前的记录还在，是给你留的底，我不会在它上面接着盖。';
}

/** v2 真暂停重入框架（引擎侧，新回合开场投递用）：旧方向产出已清出上下文，
 *  新回合第一眼 = 用户上一句原话 + 纠偏插话。原话裸发的风险同队列重入
 *  （queuedHandoffText 的教训）：模型把纠偏当凭空而来的新请求，或把已清掉
 *  的旧产出当既成事实接着推。框架交给模型三件事：这是推倒重来；旧产出不在
 *  上下文、不许当底；从原话 + 纠偏重新理解。屏幕显示仍归 displayText，框架
 *  只走引擎。 */
export function truePauseReentryText(originalAsk: string, correction: string): string {
  if (originalAsk.startsWith('【推倒重来')) return originalAsk;
  if (!correction.trim()) return originalAsk;
  return `【推倒重来·回到你的原话】你的上一句话是：「${originalAsk}」；刚发的这句纠偏是：「${correction}」。\n（之前基于错误理解的产出已从上下文清出，不要当既成事实，也不要试图接回它；从这两句重新理解任务，重新开始。）`;
}

/** v2 已完成副作用的收执（(2)/(5)/(7) 的已完成节点，一期一律冻结+询问，
 *  蓝图 §六）：如实说三件事——那步已经做完、先冻住（下游不再依赖它）、
 *  补偿与否交用户发话。「已经做完」不许说成「还没做」，「冻住」不许说成
 *  「已经撤销」——一期没有自动补偿，收执替机制许愿就是说谎。 */
export function frozenSideEffectReceipt(done: string): string {
  return `「${done}」这步已经做完了——我先把它冻住，后面的活不再依赖它；这笔要撤还是就留着，你说一声。`;
}

/** v2 misunderstanding 自查**通过**后的如实交代：查了、没发现输出偏离用户
 *  上一句——降级轻处置（按补充收进来）继续。绝不装「已改正」（自查没坐实
 *  偏离，没有错可改），也不闷头当没听见；「没跑偏」的结论必须明说
 *  （HOLD_INVARIANTS.selfCheckStatesVerdict）。只用于降级为补充形态的放行；
 *  自查坐实偏离走 truePauseReceipt，纠正表述歧义的转向走 holdReleaseTurnReceipt。 */
export function selfCheckClearReceipt(topic: string): string {
  return `你这句我认真对了一遍——手头的活没跑偏，没有哪段要清掉；「${topic}」我按补充收进来，继续。`;
}
