// src/channels/harnessFactory.ts
// 通道会话的 Harness 工厂：把 binding 解析出的 workspace / permissionMode /
// 审批 handler 变成 createHarness 的一次调用（设计文档 §10「MVP 阶段先复用，
// 避免改动 CLI 行为」）。通道与 CLI 共用同一份装配，零漂移。
import { createHarness } from '../cliHarness';
import { assembleChannelPrompt } from './prompting';
import { createChannelVerifier } from './verifierProfile';
import { promptBudgetForProvider } from '../shared/providers';
import { BUILT_IN_SUBAGENTS, CODING_AGENT_ROLES } from '../coding-agent/SubagentOrchestrator';
import type { CliArgs } from '../cliConfig';
import type { HarnessFactory } from './agentSession';

export interface ChannelHarnessFactoryDeps {
  /** CLI/gateway 解析出的基础参数（provider / key / model / MCP 等）。 */
  baseArgs: CliArgs;
  log?: (message: string) => void;
}

const SUBAGENT_NAMES = new Set([...BUILT_IN_SUBAGENTS, ...CODING_AGENT_ROLES].map((d) => d.name));

export function createCliChannelHarnessFactory(deps: ChannelHarnessFactoryDeps): HarnessFactory {
  return async (spec) => {
    const args: CliArgs = { ...deps.baseArgs, workspace: spec.workspace ?? '', resume: '' };
    const built = await createHarness(args, {
      sessionId: spec.sessionId,
      persistState: true,
      // toolProfile=readonly 是硬只读：即使 binding 写了 NORMAL 也不放开写。
      permissionMode: spec.toolProfile === 'readonly' ? 'PLAN' : spec.permissionMode,
      permissionHandler: spec.approvalHandler,
      evolutionEnabled: spec.evolutionEnabled,
      workspaceAvailable: !!spec.workspace,
      // 通道档：规则 + LLM 复核（同步）。CLI 仍是纯规则。
      verifierFactory: createChannelVerifier,
    });
    const budget = promptBudgetForProvider(args.customProviders, args.provider, args.model, args.providerOverrides);
    const hasSubagents = built.toolsDefs.some((t) => SUBAGENT_NAMES.has(t.name));
    const assembly = assembleChannelPrompt({
      capabilities: spec.capabilities,
      toolDefinitions: built.toolsDefs,
      budget,
      modelIdentity: args.model ? { provider: args.provider, model: args.model } : undefined,
      hasSubagents,
      sessionId: spec.sessionId,
    });
    deps.log?.(`harness ready for ${spec.sessionKey} (${built.toolsDefs.length} tools, workspace ${spec.workspace ?? '(none)'})`);
    return {
      harness: built.harness,
      systemPrompt: assembly.systemPrompt,
      sessionId: built.sessionId,
      projectPath: built.projectPath,
      dispose: async () => {
        built.mcpClient?.disconnectAll();
      },
    };
  };
}
