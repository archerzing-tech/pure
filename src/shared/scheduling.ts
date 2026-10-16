// src/shared/scheduling.ts
// 第 5 期「调度」的单一事实来源：把插话的五分类 kind 显式化成「处理级」，
// 再折成待办队列的**数值优先级**——轻重缓急、能并则并、当分则分。
//
// 此前这条策略活在分发序里（DynamicInsertionCoordinator.decideInner 的 switch
// 顺序），读得出来、写不下来：队列纯 FIFO，插话产生的 task 一律排到队尾，用
// 户口头说「这个急」也无处安放。本模块只做**纯映射**，不碰任何宿主状态——
// 判定（谁打断、谁排队）仍归 DynamicInsertionCoordinator / interjectOrchestrator，
// 这里只回答「这个 kind 该按多急处理」。
//
// 与第 6 期（播报粒度/口吻）的分界：这里只产出**事实性**的级别与数，口吻
// 与详略不在这里。

/**
 * 处理级——调度策略词汇（kind 是插话裁决的词汇，两者一一映射）：
 *  - interrupt        中断级：现在处理（stop / premise-change / goal-change）
 *  - boundary         边界级：下个边界带上（steer）
 *  - immediate-answer 即答级：旁答即刻，不打扰主线（question）
 *  - queued           队列级：办完手头就轮到（task）
 *  - companion        陪伴级：收下即可（chatter）
 */
export type ProcessingLevel = 'interrupt' | 'boundary' | 'immediate-answer' | 'queued' | 'companion';

/** kind → 处理级。kind 是 DynamicInsertionKind 的字符串面（宽松进参，便于回放）。 */
const LEVEL_BY_KIND: Record<string, ProcessingLevel> = {
  stop: 'interrupt',
  'premise-change': 'interrupt',
  'goal-change': 'interrupt',
  steer: 'boundary',
  question: 'immediate-answer',
  task: 'queued',
  chatter: 'companion',
};

/** 未知 kind 兜底队列级——与 netVerdict 的默认目的地同向（唯一保证跑完的投递）。 */
export function levelForKind(kind: string): ProcessingLevel {
  return LEVEL_BY_KIND[kind] ?? 'queued';
}

/** 处理级的基准优先级：数值越大越急。级间留空档，给提级（URGENT_BOOST）落脚。 */
export const PROCESSING_LEVEL_PRIORITY: Record<ProcessingLevel, number> = {
  interrupt: 40,
  boundary: 30,
  'immediate-answer': 20,
  queued: 10,
  companion: 0,
};

/** 普通队列级优先级——QueuedTask.priority 的缺省值 / 旧快照兜底值。 */
export const QUEUED_PRIORITY = PROCESSING_LEVEL_PRIORITY.queued;

/**
 * 「这个急」的提级量：抬到本档之上、仍低于下一档——用户说这句急的意思是
 * 「排到同侪前面、先办」，不是把一件 task 冒充成中断级（那会抢在 steer 的
 * 边界级前面，语义错了）。同值同级仍是到达序（RoundClosePlane 稳定插入）。
 */
export const URGENT_BOOST = 5;

export function priorityForLevel(level: ProcessingLevel, urgent = false): number {
  const base = PROCESSING_LEVEL_PRIORITY[level];
  return urgent ? base + URGENT_BOOST : base;
}

/** 折成队列优先级：普通 task=10，提级 task=15；steer=30，提级 steer=35…… */
export function priorityForKind(kind: string, urgent = false): number {
  return priorityForLevel(levelForKind(kind), urgent);
}
