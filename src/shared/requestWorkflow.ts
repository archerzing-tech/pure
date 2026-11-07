import {
  formatArtifactPrompt,
  Planner,
} from '../coding-agent/Planner';
import type { AnalysisResult, TaskMode } from '../coding-agent/types';
import { detectUiDesignRequest } from './delivery';
import { INCREMENTAL_BUILD_PROMPT } from './agentBehavior';
import { turnShape } from '../coding-agent/turnRoute';
import { detectReplyLanguage, replyLanguageDirective } from './langDetect';
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
// 决策边界刀 2（2026-11-07）：requiresPlanReview 进一步收窄为纯机械事实
// ——形态判据不再抬规划，「何时规划」归模型（request_plan 工具）；形态
// 只继续服务交付闸 / 落盘协议 / build 注入这些流程手脚。
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
  // 规划评审只由机械事实抬（决策边界刀 2，2026-11-07）：用户显式模式、
  // 已批准流程的接续、毁灭性词表安全闸。形态判据（codeShaped/longForm/
  // buildShaped/complex+plan）的抬升权退役——「何时规划」归模型（引擎首
  // 回合清单里的 request_plan 工具），宿主只保留用户显式意图与安全闸。
  const requiresPlanReview = Boolean(
    options.continuingPlan
    || options.planPauseRequested
    || assessment.requiresConfirmation
    || options.forcedMode === 'plan'
    || options.forcedMode === 'build'
  );
  // 落盘协议跟闸走：工程创作形态（buildShaped）开着交付闸，协议就必须在场
  // ——退役前由语义路由抬 forcedMode='build' 到这里，现在由形态事实直接抬。
  const buildRequested = analysis.mode === 'build'
    || options.forcedMode === 'build'
    || shape.buildShaped
    || Boolean(options.continuingPlan || options.planPauseRequested);
  const userContext: UserTurnContext = {
    buildProtocol: buildRequested ? formatArtifactPrompt() + INCREMENTAL_BUILD_PROMPT : undefined,
    // 语言对齐单源（P3 2026-11-06）：这里的 prompt 是用户原话（GUI/CLI 共用
    // 本函数），判定零污染——引擎侧曾直接判整条 user 消息，被 2000 字符
    // 注入块灌满样本。指令随 user-turn 注入件走，system 回归全静态。
    languageDirective: replyLanguageDirective(detectReplyLanguage(prompt)),
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
