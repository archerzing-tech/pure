// scripts/tmp-replay-agent-testset.ts
// 通用 Agent 能力与稳定性测试集回放器（44 条 → ~100 会话，含红线×3、
// 权重3×3、B5-01×10 的重复展开）。被测对象 = pure 当前源码的 CLI 全量真装配：
// CodingAgent + PromptAssembler + buildCliCapabilities + NodeToolAdapter（真
// 工具、真权限 YOLO、真 provider），与 s1-real-session / 编码测试集回放器同一
// 套装配——测的就是会跑在用户机器上的那条链路，不是简化代理。
//
// 职责边界：本脚本**只收集不判分**——每会话留最终回答、工具轨迹、时延、字数、
// fatal，评分（0/1/2 对照期望行为与失败判定）由评测者另行做。红线取最差。
//
// 用法：
//   bun scripts/tmp-replay-agent-testset.ts --only A1-01,B4-01   # 指定用例
//   bun scripts/tmp-replay-agent-testset.ts --sanity             # B4-01/02/03 快速冒烟
//   bun scripts/tmp-replay-agent-testset.ts --out tmp/agent-testset/results.json
//
// 搜索工具：NodeToolAdapter 的 web_search 走 SERPER_API_KEY env + 免 key 公共
// API 快路径；key 从 ~/.pure/config.json 的 serperApiKey 注入，绝不回显。

import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

import { CodingAgent } from '../src/coding-agent/CodingAgent';
import { createAdapter } from '../src/evaluation/codingAgentExecutor';
import { NodeToolAdapter } from '../src/adapter/node/NodeToolAdapter';
import { PromptAssembler, buildCliCapabilities } from '../src/shared/PromptAssembler';
import { promptBudgetForProvider } from '../src/shared/providers';
import type { BudgetConfig, EngineEvent, Message } from '../src/shared/types';
import { AGENT_TEST_CASES, type AgentTestCase } from './tmp-agent-testset-cases';

// ── 参数 ─────────────────────────────────────────────────────────────────────

const argv = process.argv.slice(2);
const flagValue = (name: string): string | undefined => {
  const index = argv.indexOf(name);
  const value = index >= 0 ? argv[index + 1] : undefined;
  return value && !value.startsWith('--') ? value : undefined;
};
const only = flagValue('--only')?.split(',').map((v) => v.trim().toUpperCase());
const outPath = flagValue('--out') ?? join(process.cwd(), 'tmp', 'agent-testset', 'results.json');
const sanity = argv.includes('--sanity');
const keepWorkspaces = argv.includes('--keep-workspaces');

// ── provider/key（与 s1-real-session 同一套解析；显式 glm，绝不回显 key）──
const cfg = JSON.parse(readFileSync(join(homedir(), '.pure', 'config.json'), 'utf8')) as {
  provider?: string; model?: string; apiKey?: string; serperApiKey?: string;
};
const provider = 'glm';
const model = flagValue('--model') ?? 'glm-5.3-flash';
const secrets = JSON.parse(readFileSync(join(homedir(), '.pure', 'secrets.json'), 'utf8')) as Record<string, unknown>;
const apiKey = String(secrets[`llm.apiKey.${provider}`] ?? '').trim();
if (!apiKey) {
  console.error('no GLM API key found (secrets.json llm.apiKey.glm)');
  process.exit(2);
}
// web_search 的后端 key 从 config 注入 env（工具内读 SERPER_API_KEY / 免 key 快路径）。
if (cfg.serperApiKey?.trim()) process.env.SERPER_API_KEY = cfg.serperApiKey.trim();

// ── 会话级装配 ────────────────────────────────────────────────────────────────

const adapter = createAdapter({ provider, model, apiKey });
const assembler = new PromptAssembler();
const SESSION_BUDGET: BudgetConfig = {
  maxTurns: 15,
  maxTotalTokens: 120_000,
  maxExecutionTime: 6 * 60 * 1000,
  warningThreshold: 0.8,
  graceTurns: 1,
};

interface SessionRecord {
  caseId: string;
  run: number;
  turnIndex: number;
  text: string;
  toolCalls: Array<{ toolName: string; success?: boolean }>;
  elapsedMs: number;
  charCount: number;
  turns: number;
  fatal?: string;
  workspace?: string;
}

/** 跑一个独立会话：工作区沙箱 + 预置文件 + 多轮顺序发送。返回每轮一条记录。 */
async function runSession(test: AgentTestCase, run: number, turns: string[]): Promise<SessionRecord[]> {
  const sessionId = `at_${test.id.replace(/[^A-Za-z0-9]/g, '-')}_r${run}_${Date.now().toString(36)}`;
  const workspace = mkdtempSync(join(tmpdir(), `pure-at-${test.id.replace(/[^A-Za-z0-9]/g, '-')}-`));
  for (const [path, content] of Object.entries(test.prepare ?? {})) {
    const target = join(workspace, path);
    mkdirSync(join(target, '..'), { recursive: true });
    writeFileSync(target, content);
    if (path === 'get_order') chmodSync(target, 0o755);
  }

  const tools = new NodeToolAdapter({ workspace, sessionId });
  const budget = promptBudgetForProvider(undefined, provider, model);
  const agent = new CodingAgent({
    sessionId,
    llm: adapter,
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
    turns[0],
  );

  const records: SessionRecord[] = [];
  const started = Date.now();
  let messages: Message[] = [];
  let turnCount = 0;

  const collect = async (userPrompt: string, turnIndex: number): Promise<void> => {
    const turnStarted = Date.now();
    const toolCalls: SessionRecord['toolCalls'] = [];
    let text = '';
    let fatal: string | undefined;
    let turnMessages: Message[] = [];
    let turnsUsed = 0;
    try {
      const stream = turnIndex === 0
        ? agent.run(assembly.systemPrompt, userPrompt)
        : agent.continueTurn(assembly.systemPrompt, messages, userPrompt);
      for await (const event of stream as AsyncIterable<EngineEvent>) {
        if (event.type === 'ToolResult') {
          const payload = event.payload as { toolName?: string; success?: boolean };
          toolCalls.push({ toolName: payload.toolName ?? '?', success: payload.success });
        }
        if (event.type === 'Completed') {
          const payload = event.payload as { messages?: Message[]; turnCount?: number; finalOutput?: string };
          turnMessages = payload.messages ?? [];
          turnsUsed = payload.turnCount ?? 0;
          text = payload.finalOutput ?? '';
        }
      }
    } catch (error) {
      fatal = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
    }
    if (turnMessages.length > 0) messages = turnMessages;
    turnCount += turnsUsed;
    records.push({
      caseId: test.id,
      run,
      turnIndex,
      text,
      toolCalls,
      elapsedMs: Date.now() - turnStarted,
      charCount: text.length,
      turns: turnsUsed,
      ...(fatal ? { fatal } : {}),
      ...(keepWorkspaces ? { workspace } : {}),
    });
  };

  try {
    for (let i = 0; i < turns.length; i++) {
      await collect(turns[i], i);
    }
  } finally {
    if (!keepWorkspaces) rmSync(workspace, { recursive: true, force: true });
  }
  void started;
  return records;
}

// ── 展开：重复策略（红线/权重3 → 3 次取最差）+ B5-01 特殊展开 + variants ────

interface PlannedRun {
  caseId: string;
  run: number;
  turns: string[];
  test: AgentTestCase;
  repeatTotal: number;
}

function expand(cases: AgentTestCase[]): PlannedRun[] {
  const runs: PlannedRun[] = [];
  for (const test of cases) {
    if (test.id === 'B5-01') {
      // B5-01 语义：对 A1-01、A1-05、A3-03 各重复 10 次。展开成挂在本用例名下的
      // 30 次会话，评分时按源题统计一致率。
      for (const sourceId of ['A1-01', 'A1-05', 'A3-03']) {
        // 源题从全量表找：--only 筛掉 A 块时 B5-01 的展开仍要拿得到源题 turns。
        const source = AGENT_TEST_CASES.find((c) => c.id === sourceId)!;
        for (let i = 1; i <= 10; i++) {
          runs.push({ caseId: `${test.id}#${sourceId}`, run: i, turns: source.turns, test, repeatTotal: 10 });
        }
      }
      continue;
    }
    if (test.variants) {
      test.variants.forEach((turn, index) => {
        runs.push({ caseId: test.id, run: index + 1, turns: [turn], test, repeatTotal: test.variants!.length });
      });
      continue;
    }
    const repeatTotal = test.repeat ?? ((test.redline || test.weight === 3) ? 3 : 1);
    for (let i = 1; i <= repeatTotal; i++) {
      runs.push({ caseId: test.id, run: i, turns: test.turns, test, repeatTotal });
    }
  }
  return runs;
}

// ── 主流程 ───────────────────────────────────────────────────────────────────

let cases = AGENT_TEST_CASES;
if (sanity) cases = cases.filter((c) => ['B4-01', 'B4-02', 'B4-03'].includes(c.id));
if (only) cases = cases.filter((c) => only.includes(c.id));
if (cases.length === 0) {
  console.error('no cases selected');
  process.exit(2);
}

const runs = expand(cases);
const totalRuns = runs.length;
mkdirSync(join(outPath, '..'), { recursive: true });
const allRecords: SessionRecord[] = [];

console.log(`pure agent testset replay — ${cases.length} case(s) → ${totalRuns} session(s), model=${model}`);
const globalStarted = Date.now();

for (let i = 0; i < runs.length; i++) {
  const plan = runs[i];
  const label = plan.run > 1 || plan.repeatTotal > 1 ? `${plan.caseId}#${plan.run}/${plan.repeatTotal}` : plan.caseId;
  const records = await runSession(plan.test, plan.run, plan.turns);
  allRecords.push(...records);
  const last = records[records.length - 1];
  const tools = records.reduce((n, r) => n + r.toolCalls.length, 0);
  const chars = records.reduce((n, r) => n + r.charCount, 0);
  const flag = last?.fatal ? ` FATAL(${last.fatal.slice(0, 60)})` : '';
  console.log(`[${i + 1}/${totalRuns}] ${label} — ${((last?.elapsedMs ?? 0) / 1000).toFixed(1)}s, tools=${tools}, chars=${chars}${flag}`);
  // 增量落盘：中途被掐也保留已跑结果。
  writeFileSync(outPath, JSON.stringify({ model, provider, startedAt: globalStarted, records: allRecords }, null, 2));
}

console.log(`\ndone — ${allRecords.length} session record(s) → ${outPath}`);
