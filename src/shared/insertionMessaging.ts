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

/** ② steer 框架文本（chat.ts steerRunningTurn 的投递正文）。cancel=true 用
 *  取消口径——通用口径的「选最小动作，手头的活继续」会把取消引导成「计划
 *  照旧」（2026-09-26 事故：收执说不会派、计划书里三支全名），所以取消必须
 *  走自己的框架：计划当场缩，叙述只数会派的支。 */
export function steerFrameText(text: string, cancel: boolean): string {
  return cancel
    ? `【用户插话·顺路带上】${text}\n（这是任务进行中的取消，不是新任务：用户收掉了一个方向/话题。它不进计划、不派工、不进最终汇总——你现在规划或复述计划时，只数实际会派的支，明说：原规划几路、用户收掉了哪路、现在实际派出哪几路；别再把被收掉的方向当作仍在计划里的一路，也不要再为它派工。其余工作照常。）`
    : `【用户插话·顺路带上】${text}\n（这是任务进行中的插话，不是新任务：按 <insertion_protocol> 判断它影响什么，选最小动作，手头的活继续。）`;
}

/** ③-a 停支收执（chat.ts stopNamedBranch 命中后）。宿主已完成的动作的汇报
 *  ——pause（收活「先停下」，活口大）与 abort（祈使「停掉那支」）两种。 */
export function branchStopReceipt(label: string, mode: 'pause' | 'abort'): string {
  return mode === 'pause'
    ? `明白——「${label}」那路我先暂停了，它已经查到的部分不进最终汇总；其余照常跑，想续上随时说。`
    : `已停掉「${label}」那支——进度留了断点，随时可以让它接着跑，其余照常。`;
}

/** ③-b 出生前取消的收执（委派还没起飞）：点得出话题就点名，点不出退回
 *  「这项」。核心承诺：没派的不会派、不进最终汇总。 */
export function cancelBeforeDispatchReceipt(topic: string | null): string {
  return topic
    ? `好——“${topic}”这项不做了：还没派的不会派出去，也不会进最终汇总。`
    : '好——这项不做了：还没派的不会派出去，也不会进最终汇总。';
}

/** ③-c 折入收执（取消型 vs 追加型）。取消口径绝不能沿用追加口径——把
 *  「收掉一项」回成「先补这项」就是反向执行（2026-09-24 事故原话）。 */
export function foldInReceipt(cancels: boolean): string {
  return cancels
    ? '收到——这项收掉了，不进最终汇总；其余照跑，收齐后只合并剩下的。'
    : '已收到——正在跑的活收齐后先补这项，再合并出一份覆盖全部的汇总。';
}

/** ④ 取消型折入的引擎侧框架（chat.ts cancelFoldInstruction）。与追加框架
 *  反着说死：不许派新委派、部分产出不算结论不进汇总、幸存分支照常合并。 */
export function cancelFoldInstruction(text: string): string {
  return `【中途取消，不是追加】用户中途收掉了这项工作：${text}\n执行要求：不要再为它派任何委派；已经跑出的相关部分不算结论、不写入最终汇总（用户没说要保留）。委派收齐后，最终汇总只覆盖剩下的对象，并用一句话交代这项已按要求取消。`;
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
} as const;
