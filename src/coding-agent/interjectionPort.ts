// src/coding-agent/interjectionPort.ts
// 插话端口契约（2026-10-28 用户定调）：「当前一期实现的插话处理逻辑不对，
// 整体架构先不变，要把插话的对接点、插入点留出来，后续再改。」
//
// 插话机制与主架构的交界物理上早已集中（S2 第六刀：入口/序列化链/裁决序收进
// InterjectOrchestrator，宿主只剩转发与投影缝）——本文件把「事实集中」升格为
// 「契约声明」：后续替换插话处理逻辑（现裁决序九类分发 → 目标态：队列+注入式
// mid-turn injection，业界通行形状）时，只换边界内的实现，端口与宿主零改动。
//
// ── 端口全图 ────────────────────────────────────────────────────────────
//
// 对接点（插话怎么进来，全系统唯一入口）：
//   InterjectOrchestrator.interject(text, images, displayText)   → InterjectionIngress
//   · GUI 主输入（main.ts Enter-while-generating）与多会话面板都汇到
//     chat.interject 转发缝，再进编排器序列化链——到达即入链，绝不丢话。
//   · CLI / 新通道接入时只写新的转发，不复制任何处理逻辑。
//
// 插入点（插话内容出现在模型对话流哪里，三个，引擎在固定时机取件）：
//   P1 轮中消息边界  takeSteerMessages(recipient)      → EngineContext（宿主实现）
//   P2 委派收齐派发  takeSyntheticToolCalls()          → EngineContext（宿主实现）
//   P3 思考窗补充    takePreflightSupplements()        → InterjectOrchestrator（宿主在重想轮取件并账）
//   P1/P2 是宿主闭包交给引擎回合循环的回调；P3 是编排器持有的暂存器。
//
// 宿主动作面（裁决后让宿主执行的机械动作）与读数面（宿主状态投影）：
//   InterjectOrchestratorDeps（编排器文件头）——决策核不猜宿主状态，
//   DOM/LLM 产出/铺排/引擎把手全经依赖缝留给宿主，双向不越界。
//
// ── 边界内（可整体替换，后续再改，端口不动）────────────────────────────
//   · classifyAndApply 裁决序（软暂停 → 裁决 → 时机语义 → 置信门 → 思考窗
//     吸收 → 九类处置表分发）
//   · DynamicInsertionCoordinator 裁决器（含 passthrough 原话直投）
//   · 收执纪律（receipt 裁决器现场措辞 / 引擎沉默兜底）
//   · SteerBus / FoldInLedger / DelegationControlPlane / RoundClosePlane /
//     HoldGate 等编排机制件
//   换逻辑时：保持 interject 签名与三个插入点形状，内部推倒重写不惊动宿主。
//
// ── 接入纪律 ────────────────────────────────────────────────────────────
//   1. 宿主（chat.ts / 任何通道）不得绕过对接点直接调裁决器或裁决序。
//   2. 不得自开第四插入点——插入点形状要扩，先改这份契约再动实现。
//   3. 队列/注入逻辑的改版发生在边界内；对接点与插入点的签名是稳定面。

import type { EngineContext } from '../shared/types';

/** 对接点：插话唯一入口。GUI/多会话面板/CLI/未来通道都汇到这；实现方
 *  （一期=裁决序九类分发，后续=队列+注入）自由，端口签名不变。 */
export interface InterjectionIngress {
  interject(text: string, images?: MessageImageList, displayText?: string): Promise<void>;
}

type MessageImageList = import('../shared/types').MessageImage[];

/** 插入点契约：三个取件口的形状。P1/P2 直接引用 EngineContext 现有签名
 *  （类型真相源不搬），P3 是编排器方法。宿主只依赖这些形状，不依赖实现。 */
export interface InterjectionInjectionPoints {
  /** P1 轮中消息边界：引擎每个 THINK 边界取件（消息协议唯一干净点）；
   *  1a 定向投递按 recipient 身份过滤。折入/转向经此口进对话流。 */
  takeSteerMessages: EngineContext['takeSteerMessages'];
  /** P2 委派收齐派发：返回合成工具调用，引擎走原生 ACT 管线执行——
   *  scope 追加折入、点名续跑的机械执行件经此口出生。 */
  takeSyntheticToolCalls: NonNullable<EngineContext['takeSyntheticToolCalls']>;
  /** P3 思考窗补充：计划思考窗内到达的追加/约束暂存于编排器，宿主在
   *  重想轮取件并账进请求正文。 */
  takePreflightSupplements: () => Array<{ text: string; images: MessageImageList }>;
}
