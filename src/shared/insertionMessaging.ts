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

/** ④ 取消型折入的引擎侧框架（chat.ts cancelFoldInstruction）。与追加框架
 *  反着说死：不许派新委派、部分产出不算结论不进汇总、幸存分支照常合并。 */
export function cancelFoldInstruction(text: string): string {
  return `【中途取消，不是追加】用户中途收掉了这项工作：${text}\n执行要求：不要再为它派任何委派；已经跑出的相关部分不算结论、不写入最终汇总（用户没说要保留）。委派收齐后，最终汇总只覆盖剩下的对象，并用一句话交代这项已按要求取消。`;
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
