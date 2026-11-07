// src/coding-agent/planControlTool.ts
// request_plan（决策边界刀 2，2026-11-07）：「何时规划」归模型——首回合
// 清单里给模型这个工具，它判断这轮要先对齐步骤就调用；宿主桥接既有规划
// 编排（当着用户的流式思考 + 步骤卡），产物随工具结果回填，引擎按卡继续。
// 宿主不再拿形态判据（长文/代码块/工程创作）替模型决定「这轮要规划」。
// 结构同 stop_branch：条件在场由宿主的 PlanControl.defs() 控制（清单面），
// ToolRegistry.execute 顶部按名转发 PlanControl.execute（执行面，known
// 检查之前——它天然不进公共/委派 defs，不占权限面）。CLI 不注入
// PlanControl → 工具不在场，CLI 维持现状（CLI 规划另立刀）。

import type { ToolCall, ToolDefinition, ToolResult } from '../shared/types';

export const REQUEST_PLAN_TOOL_NAME = 'request_plan';

/** 规划桥的超时上限：规划自身 180s（PLAN_THINKING_TIMEOUT_MS）+ 出卡与
 *  批准语义收尾。声明独立值，避免被通用工具闸（180s）贴线掐断。 */
export const REQUEST_PLAN_TIMEOUT_MS = 300_000;

/** 宿主注入的规划控制面：清单面每 THINK 轮重算（宿主闭包按回合状态判——
 *  首回合且无既存计划且无 forcedMode 才在场），执行面桥接宿主编排。 */
export interface PlanControl {
  defs(): ToolDefinition[];
  execute(toolCall: ToolCall, signal?: AbortSignal): Promise<ToolResult>;
}

// 手脚说明——调用后会发生什么（当着用户的流式思考 + 步骤卡 + 结果回填）
// 与结果回来后的接续契约，不写「何时该调」的触发清单（决策边界判据：
// 何时归模型）。focus 是模型想给规划的一句侧重点，可选。
export const REQUEST_PLAN_TOOL_DEF: ToolDefinition = {
  name: REQUEST_PLAN_TOOL_NAME,
  description: 'Run a visible planning pass before doing the work: the host streams a thinking narration to the user, derives a step plan from it, puts a plan card in the conversation, and returns the approved plan text as the tool result. Continue from that result by executing the plan step by step. An optional focus narrows what the plan should figure out first. If the pass produces nothing usable, the result says so and you proceed by your own judgment.',
  input_schema: {
    type: 'object',
    properties: {
      focus: { type: 'string', description: 'Optional one-line steer for the planning pass (e.g. what to figure out or decide first).' },
    },
    required: [],
  },
};
