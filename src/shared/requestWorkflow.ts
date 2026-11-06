import {
  formatArtifactPrompt,
  Planner,
} from '../coding-agent/Planner';
import type { AnalysisResult, TaskMode } from '../coding-agent/types';
import { detectUiDesignRequest } from './delivery';
import { INCREMENTAL_BUILD_PROMPT } from './agentBehavior';
import { turnShape } from '../coding-agent/turnRoute';
import { type UserTurnContext } from './promptLayers';

export type RequestWorkflowStage = 'direct' | 'probe' | 'plan' | 'confirm';

export interface RequestWorkflowOptions {
  forcedMode?: TaskMode;
  hasTools?: boolean;
  continuingPlan?: boolean;
  planPauseRequested?: boolean;
  /** Whether the active (continuing) plan was approved as a project build.
   * Only build plans keep the per-phase delivery gate on continuation — an
   * ordinary complex plan must not be forced through it just because the
   * conversation is continuing. */
  continuingProjectBuild?: boolean;
  planner?: Planner;
}

export interface CompiledRequestWorkflow {
  analysis: AnalysisResult;
  stage: RequestWorkflowStage;
  needsDeliveryGate: boolean;
  /** UI-building requests go through a design-first phase: the agent produces
   * a static design mockup and waits for user confirmation before writing any
   * implementation code. */
  needsDesignPhase: boolean;
  probeRequired: boolean;
  probeAvailable: boolean;
  needsProbe: boolean;
  requiresPlanReview: boolean;
  userContext: UserTurnContext;
}

// 预判层退役后的 workflow 编译（2026-11-06，Claude Code / opencode / Codebuff
// 三家对照定案）：没有语义路由了，本函数的全部判定源只剩两类——
//   1. 机械事实：forcedMode / continuingPlan / planPauseRequested /
//      continuingProjectBuild（用户显式或已批准流程的接续）；
//   2. 形态判据（turnShape）+ 词表安全闸（assessIntent 只在毁灭性操作上抬
//      requiresProbe/requiresConfirmation，规则只会抬高安全要求）。
// 2026-11-05 判例既定纪律在这里常态化：词表猜测只服务内部判定（stage / 探针 /
// 交付闸 / build 注入），绝不塑形主请求——assessment 不再注入 user turn。
export function compileRequestWorkflow(
  prompt: string,
  options: RequestWorkflowOptions = {},
): CompiledRequestWorkflow {
  const planner = options.planner ?? new Planner();
  const analysis: AnalysisResult = planner.analyzeTask(prompt);
  // forcedMode 是外部显式覆盖，无论词表怎么判都要生效。
  if (options.forcedMode) analysis.mode = options.forcedMode;
  const assessment = analysis.intent;
  const shape = turnShape(prompt);
  const needsDeliveryGate = options.forcedMode === 'build'
    || analysis.mode === 'build'
    // 工程创作形态（写×项目/应用/游戏…同现，排除问法与单资产创意）：没有
    // 路由分类 build 了，交付闸/探针/落盘协议由这个形态事实保持常开。
    || shape.buildShaped
    || options.continuingProjectBuild === true;
  // Design-first applies to project builds that look like UI work. A
  // continuing build keeps its original routing decision (the marker only
  // matters for the FIRST implementation turn).
  const needsDesignPhase = needsDeliveryGate && !options.continuingPlan
    && detectUiDesignRequest(prompt);
  const probeRequired = assessment.requiresProbe || needsDeliveryGate;
  const probeAvailable = options.hasTools !== false;
  const needsProbe = probeRequired && probeAvailable;
  const requiresPlanReview = Boolean(
    options.continuingPlan
    || options.planPauseRequested
    || assessment.requiresConfirmation
    || options.forcedMode === 'plan'
    || options.forcedMode === 'build'
    // 形态判据：带代码块、长文或工程创作形态 → 走规划流程。它不回答「这轮
    // 是什么」，只决定「要不要过一遍当着用户的思考」（planByThinking 想完
    // 自己决定出不出卡，「宁可不卡」契约不变），判错代价是多付一次可见思考，
    // 不是 2026-09 词表 floor 那种「判闲聊→打发」。buildShaped 在这里保持
    // 与退役前的行为等价：语义路由判 build 时会把 forcedMode 抬成 'build'
    // → 同样进规划流程。
    || shape.codeShaped
    || shape.longForm
    || shape.buildShaped
    // 词表认出的复杂任务（plan 已生成）保守走规划；寒暄猜不出 plan，自然不触发。
    || (analysis.complexity === 'complex' && analysis.plan),
  );
  // 落盘协议跟闸走：工程创作形态（buildShaped）开着交付闸，协议就必须在场
  // ——退役前由语义路由抬 forcedMode='build' 到这里，现在由形态事实直接抬。
  const buildRequested = analysis.mode === 'build'
    || options.forcedMode === 'build'
    || shape.buildShaped
    || Boolean(options.continuingPlan || options.planPauseRequested);
  const userContext: UserTurnContext = {
    buildProtocol: buildRequested ? formatArtifactPrompt() + INCREMENTAL_BUILD_PROMPT : undefined,
  };
  const stage: RequestWorkflowStage = assessment.requiresConfirmation
    ? 'confirm'
    : requiresPlanReview
      ? 'plan'
      : needsProbe
        ? 'probe'
        : 'direct';
  return {
    analysis,
    stage,
    needsDeliveryGate,
    needsDesignPhase,
    probeRequired,
    probeAvailable,
    needsProbe,
    requiresPlanReview,
    userContext,
  };
}
