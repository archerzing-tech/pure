// scripts/s1-real-session.ts
// P1-1（S1 真实样本）— CLI 侧真实多 agent 会话驱动器。
//
// 为什么需要它：session.json 存档只有 GUI 会写（Rust save_session），CLI one-shot
// 不落档 —— 而收割器（scripts/harvest-role-samples.ts）只认 ~/.pure/sessions/
// <id>/session.json。本脚本用与评测执行器完全相同的装配（CodingAgent +
// NodeToolAdapter + PromptAssembler，无 GUI 依赖）跑一轮**真实**会话（真实
// provider、真实编排器、真实工具执行），然后把引擎转录按 GUI 存档格式落盘：
// 委派是真实的，持久化只是补上 GUI 那一步。index.json 同步登记，会话出现在
// GUI 列表里可查证。
//
// 用法：
//   bun run scripts/s1-real-session.ts --workspace <dir> --title <t> --prompt <text>
//     [--model glm-5.3-flash] [--max-turns 30]
//
// provider/key 读 ~/.pure/config.json（与 CLI 同源）；permissionMode YOLO 与 CLI
// 默认一致。收完样本后跑：
//   bun run eval:harvest -- --agent glm --roles researcher,code_reviewer

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { CodingAgent } from '../src/coding-agent/CodingAgent';
import { createAdapter } from '../src/evaluation/codingAgentExecutor';
import { NodeToolAdapter } from '../src/adapter/node/NodeToolAdapter';
import { PromptAssembler, buildCliCapabilities } from '../src/shared/PromptAssembler';
import { promptBudgetForProvider } from '../src/shared/providers';
import type { BudgetConfig, EngineEvent, Message } from '../src/shared/types';

const argv = process.argv.slice(2);
const flag = (name: string): string | undefined => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : undefined;
};
const workspace = flag('--workspace');
const prompt = flag('--prompt');
const title = flag('--title') ?? 'S1 real session';
if (!workspace || !prompt) {
  console.error('--workspace and --prompt are required');
  process.exit(2);
}

interface PureConfigLite {
  provider?: string;
  model?: string;
  apiKey?: string;
}
const cfg = JSON.parse(await readFile(join(homedir(), '.pure', 'config.json'), 'utf8')) as PureConfigLite;
const provider = cfg.provider ?? 'glm';
const model = flag('--model') ?? cfg.model ?? 'glm-5.3-flash';
// 钥匙解析镜像产品：config.json 顶层 apiKey（CLI 形态）→ Rust secrets 的
// llm.apiKey.<provider>（桌面形态）。只取值用，绝不回显。
let apiKey = cfg.apiKey?.trim() || '';
if (!apiKey) {
  try {
    const secrets = JSON.parse(await readFile(join(homedir(), '.pure', 'secrets.json'), 'utf8')) as Record<string, unknown>;
    // secrets.json 是扁平的：键名本身就带点（"llm.apiKey.glm"），不是嵌套对象。
    apiKey = String(secrets[`llm.apiKey.${provider}`] ?? secrets['llm.apiKey'] ?? '').trim();
  } catch { /* fall through to the error below */ }
}
if (!apiKey) {
  console.error('no API key found (config.json apiKey / secrets.json llm.apiKey.<provider>)');
  process.exit(2);
}

const SESSION_BUDGET: BudgetConfig = {
  maxTurns: Number.parseInt(flag('--max-turns') ?? '30', 10),
  maxTotalTokens: 200_000,
  maxExecutionTime: 20 * 60 * 1000,
  warningThreshold: 0.8,
  graceTurns: 2,
};

const sessionId = `session_${Date.now()}_s1`;
const assembler = new PromptAssembler();
const budget = promptBudgetForProvider(undefined, provider, model);
const tools = new NodeToolAdapter({ workspace, sessionId });
const agent = new CodingAgent({
  sessionId,
  llm: createAdapter({ provider, model, apiKey }),
  toolAdapter: tools,
  budget: SESSION_BUDGET,
  toolsDefs: undefined,
  promptAssembler: assembler,
  promptBudget: budget,
  permissionMode: 'YOLO',
  projectPath: workspace,
});
const assembly = assembler.assemble(
  { surface: 'cli', capabilities: buildCliCapabilities(), toolDefinitions: agent.toolRegistry.getTools(), mode: 'build', budget, sessionId },
  prompt,
);

console.log(`[${new Date().toISOString()}] session ${sessionId}`);
console.log(`  provider=${provider} model=${model} workspace=${workspace}`);
console.log(`  prompt: ${prompt.slice(0, 120)}${prompt.length > 120 ? '…' : ''}`);

let messages: Message[] = [];
let turns = 0;
const toolCalls: Record<string, number> = {};
let finalText = '';
for await (const event of agent.run(assembly.systemPrompt, assembly.userPrompt ?? prompt) as AsyncIterable<EngineEvent>) {
  if (event.type === 'ToolResult') {
    const name = (event.payload as { toolName?: string }).toolName ?? '?';
    toolCalls[name] = (toolCalls[name] ?? 0) + 1;
  }
  if (event.type === 'Completed') {
    const payload = event.payload as { messages?: Message[]; turnCount?: number; isComplete?: boolean; reason?: string; output?: string };
    messages = payload.messages ?? [];
    turns = payload.turnCount ?? 0;
    finalText = payload.output ?? '';
    if (!payload.isComplete) console.warn(`  ⚠ run ended without completing (${payload.reason ?? 'unknown'})`);
  }
}

// ── Archive in the GUI's session.json shape (harvest + GUI list both read it) ──
const now = Date.now();
const sessionDir = join(homedir(), '.pure', 'sessions', sessionId);
await mkdir(sessionDir, { recursive: true });
await writeFile(join(sessionDir, 'session.json'), JSON.stringify({
  messages,
  snapshot: { version: 3, revision: 1, modelContext: { messages }, events: [], transcript: [], uiState: {} },
  updatedAt: now,
  messageCount: messages.length,
  workspace,
}));
const indexPath = join(homedir(), '.pure', 'sessions', 'index.json');
let index: unknown[] = [];
try {
  index = JSON.parse(await readFile(indexPath, 'utf8')) as unknown[];
  if (!Array.isArray(index)) index = [];
} catch { /* no index yet */ }
index.push({ id: sessionId, title, createdAt: now, updatedAt: now, messageCount: messages.length, workspace });
await writeFile(indexPath, JSON.stringify(index, null, 2));

console.log(`\n[${new Date().toISOString()}] done — turns=${turns} messages=${messages.length}`);
console.log('toolCalls:', JSON.stringify(toolCalls));
console.log(`archive: ${sessionDir}`);
console.log(`final output (first 400 chars):\n${finalText.slice(0, 400)}`);
