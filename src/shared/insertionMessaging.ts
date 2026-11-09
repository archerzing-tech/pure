// src/shared/insertionMessaging.ts
// 插话文本的单一事实来源。框架改革一期刀 A2（docs/framework-reform-2026-11.md）
// 收口：本模块只剩**框架文本**——面向模型的机制指令，只描述机制事实，不示范
// 措辞，更不冒充模型的口吻对用户说话。
//   收执 = 承接插话的模型现场写的 receipt，唯一来源；引擎在模型缺席时沉默
//   （宁可无话，不出机械腔——机制状态由 UI 呈现）。回应性固定话术（branchStop
//   / cancelBeforeDispatch / foldIn / foldInEarly / queued / queuedUrgent /
//   steerFallback / holdRelease / truePause / selfCheckClear 一族，2026-10-28
//   刀 2）与判例播报（branchUncertainPause / cancelFoldUnmatched /
//   branchResume / treeResume 及 covered「不重复派」字面量，本刀）已全部退役：
//   暂停、续跑、去重这些宿主动作由活动面板与生命周期卡呈现，模型的下一动作
//   被框架告知机制事实后自然带出叙述。
// 纪律：这里只放文本，不放判定逻辑。判定（谁停、停哪支、何时停）归
// DynamicInsertionCoordinator / chat.ts / DelegationControlPlane。
// 核心口径不变：停/暂停一支是**宿主的动作**，模型永不亲自动手停；模型
// 负责叙述、排除产出（不进最终汇总）、合并幸存者。

/** steer 框架文本（chat.ts steerRunningTurn 的投递正文）。cancel=true 用
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

/** 取消型折入的引擎侧框架（chat.ts cancelFoldInstruction）。与追加框架
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

/** 追加型折入的引擎侧框架（chat.ts foldInInstruction）。与取消框架互补：
 *  把「别光汇总」说死——追加项像其他委派一样派出去做完，再合并输出。
 *  【下一刀标注】P2 fold 退役（设计 docs/interjection-inline-sideline.md §四
 *  删除清单 3/4）随折入链整体退役；本刀只标注，chat.ts/收尾派发仍在消费。 */
export function foldInInstruction(text: string): string {
  return `【中途追加的任务，不是闲聊】用户要求在本次任务里追加：${text}\n执行要求：把这项追加的工作像其他委派一样派出去做完；拿到结果后，把它与本次任务已产出的全部内容合并，输出一份覆盖所有对象的最终汇总。在此之前不要输出最终汇总。`;
}

/** 折入没被照办时转排队的兜底口径（chat.ts foldInFollowUpText）。
 *  【下一刀标注】随 P2 fold 退役，本刀只标注（roundClose 收尾核验在消费）。 */
export function foldInFollowUpText(text: string): string {
  return `（中途追加）${text}\n把这项追加的工作做完，然后把结果与此前任务的产出合并，输出一份覆盖全部对象的完整汇总（此前的产出在会话历史里）。`;
}

/** 队列重入的交接框架（2026-10-21 对话主导架构刀 C）：排队插话在回合收尾
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

/** 取消口径的一致性锚（一致性测试读它，不读各处散文）——每条都是「取消」
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
   *  停支/折入收执不受此锁（那些路径机制真实在场）。
   *  （引擎侧兜底话术已全族退役；锚保留——后续任何引擎侧兜底话术回潮时
   *  仍用此锁。） */
  absentMechanismWords: /派|汇总|支/,
} as const;

/** 续跑口径的一致性锚（第 2 期第三刀）：命中必须说断点（最好带轮数）、
 *  未命中必须认账「没找到存档」——漂移到任何一头，都是框架在替机制许愿
 *  或把模型蒙在鼓里。用户侧续跑收执（branchResume/treeResume）已随刀 A2
 *  退役；锚继续锁 DelegationControlPlane 的兜底指令（给模型的机制事实：
 *  命中从断点续、没命中重新跑）。 */
export const RESUME_INVARIANTS = {
  // 全角括号是字面量不是分组：锚必须真咬住轮数（\d+ 缺席即锚失效）。
  hitSaysFromCheckpoint: /从存档断点（第 \d+ 轮）/,
  missAdmitsNoArchive: /没找到存档/,
} as const;
