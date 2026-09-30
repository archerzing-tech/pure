// scripts/lib/scriptedChannelAgent.ts
// 通道验收脚本共用的「脚本化 agent 工厂」：真实 Harness + 真实 NodeToolAdapter +
// 真实权限门控 + 通道档 LLM 复核验证器，只把 LLM 换成脚本化适配器（免 key、确定性）。
import { Harness } from '../../src/harness/Harness';
import { createDefaultHarnessConfig } from '../../src/coding-agent/defaultHarnessConfig';
import { NodeToolAdapter } from '../../src/adapter/node/NodeToolAdapter';
import { ToolRegistry } from '../../src/coding-agent/ToolRegistry';
import { PermissionManager } from '../../src/coding-agent/PermissionManager';
import { FSStore } from '../../src/adapter/storage/FSStore';
import { promptAssembler } from '../../src/shared/PromptAssembler';
import { createChannelVerifier } from '../../src/channels/verifierProfile';
import { DEFAULT_BUDGET } from '../../src/cliConfig';
import type { HarnessBundle, BuildSessionSpec } from '../../src/channels/agentSession';
import type { LLMAdapter, LLMChunk, Message, ToolDefinition, LLMResponse, ToolCall } from '../../src/shared/types';

export const scriptedStats = { verifierCalls: 0, turns: 0 };

function content(text: string): LLMChunk {
  return { type: 'content', content: text };
}

/** 验收用的最小 SVG：走真实 resvg 光栅化，断言「PNG 附件真发出去」而非 mock 桩。 */
export const VERIFY_SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="240" height="80"><rect width="240" height="80" fill="#3b82f6"/><text x="16" y="48" font-size="28" fill="#ffffff">pure</text></svg>';

/** mermaid / puml 验收图表：在 headless Chrome 里跑真引擎，而不是 mock 渲染。 */
export const VERIFY_MERMAID = 'graph TD; A[通道]-->B[gateway]; B-->C[适配器];';
export const VERIFY_PUML = '@startuml\nA -> B: hi\n@enduml';

/** 通道投影验收：一条回答里同时有正文、代码块、表格与图表。 */
export const VERIFY_MIXED_ANSWER = [
  '这是结论。',
  '',
  '```ts',
  'export const answer = 42;',
  '```',
  '',
  '| 项 | 值 |',
  '| --- | --- |',
  '| 通道 | 飞书 |',
  '',
  '```mermaid',
  VERIFY_MERMAID,
  '```',
].join('\n');

function decide(messages: Message[]): LLMChunk[] {
  const last = messages[messages.length - 1];
  const pendingToolResult = !!last && (last.role === 'tool' || last.toolCallId !== undefined);
  const lastUser = [...messages].reverse().find((m) => m.role === 'user' && m.toolCallId === undefined);
  const userText = lastUser?.content ?? '';
  const priorUserTexts = messages.filter((m) => m.role === 'user' && m !== lastUser).map((m) => m.content);

  if (pendingToolResult) return [content('已创建工作区文件 ==hello.txt==。')];
  if (userText.includes('带代码')) {
    return [content(VERIFY_MIXED_ANSWER), { type: 'done', content: '', toolCalls: [] }];
  }
  if (userText.includes('流程图')) {
    return [content(`这是流程图：\n\n\`\`\`mermaid\n${VERIFY_MERMAID}\n\`\`\``), { type: 'done', content: '', toolCalls: [] }];
  }
  if (userText.includes('时序图')) {
    return [content(`这是时序图：\n\n\`\`\`puml\n${VERIFY_PUML}\n\`\`\``), { type: 'done', content: '', toolCalls: [] }];
  }
  if (userText.includes('画')) {
    return [content(`这是图表：\n\n\`\`\`svg\n${VERIFY_SVG}\n\`\`\``), { type: 'done', content: '', toolCalls: [] }];
  }
  if (userText.includes('创建')) {
    const args = JSON.stringify({ path: 'hello.txt', content: 'hello from channel gateway\n' });
    const call: ToolCall = { id: 'call_write_1', index: 0, function: { name: 'write_file', arguments: args } };
    return [
      content('好的，'),
      content('我来创建工作区文件。'),
      { type: 'tool_call', index: 0, id: call.id, name: 'write_file', arguments: args },
      { type: 'done', content: '', toolCalls: [call] },
    ];
  }
  const remembered = priorUserTexts.find((t) => t.includes('创建 hello.txt'));
  if (remembered) return [content(`你刚刚让我：${remembered}`), { type: 'done', content: '', toolCalls: [] }];
  return [content('（脚本化适配器：没有可回答的历史）'), { type: 'done', content: '', toolCalls: [] }];
}

class ScriptedLLMAdapter implements LLMAdapter {
  async *stream(messages: Message[], _tools: ToolDefinition[], _signal?: AbortSignal): AsyncGenerator<LLMChunk, void, void> {
    scriptedStats.turns += 1;
    for (const chunk of decide(messages)) yield chunk;
  }

  async complete(messages: Message[], tools: ToolDefinition[], signal?: AbortSignal): Promise<LLMResponse> {
    if (messages.length === 1 && messages[0].content.includes('verification agent')) {
      scriptedStats.verifierCalls += 1;
      return { content: '{"passed": true, "feedback": "addresses the request"}' };
    }
    let text = '';
    for await (const chunk of this.stream(messages, tools, signal)) {
      if (chunk.type === 'content') text += chunk.content;
    }
    return { content: text };
  }
}

export interface ScriptedFactoryOptions {
  sessionsDir: string;
  budget?: unknown;
}

export function createScriptedChannelFactory(options: ScriptedFactoryOptions) {
  return async (spec: BuildSessionSpec): Promise<HarnessBundle> => {
    const llm = new ScriptedLLMAdapter();
    const adapter = new NodeToolAdapter({ workspace: spec.workspace ?? process.cwd(), sessionId: spec.sessionId });
    const registry = new ToolRegistry(adapter);
    registry.setPermissionManager(new PermissionManager(spec.permissionMode === 'PLAN' ? 'PLAN' : 'NORMAL', spec.approvalHandler));
    const budget = { provider: 'mock', model: 'mock', maxInputTokens: 32000 };
    const plumbing = createDefaultHarnessConfig({ llm, promptBudget: budget, toolsProvider: () => registry.getTools() });
    const harness = new Harness({
      sessionId: spec.sessionId,
      llm,
      tools: registry,
      toolsDefs: registry.getTools(),
      budget: DEFAULT_BUDGET,
      stateStore: new FSStore(options.sessionsDir),
      promptAssembler,
      promptBudget: budget,
      contextEngine: plumbing.contextEngine,
      verifier: createChannelVerifier(llm),
      hooks: plumbing.hooks,
      failurePolicy: plumbing.failurePolicy,
      projectPath: spec.workspace ?? process.cwd(),
      workspaceAvailable: true,
      evolutionEnabled: false,
    });
    return {
      harness,
      systemPrompt: 'You are a scripted channel agent for verification. Be concise.',
      sessionId: spec.sessionId,
      projectPath: spec.workspace ?? process.cwd(),
    };
  };
}
