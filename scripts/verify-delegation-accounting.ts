// scripts/verify-delegation-accounting.ts
// 「委派真的记上账」这一刀的验收夹具（2026-10-07 审计取证 → 167479f 修复）。
//
// 为什么需要它：审计点名的活 bug 是 `config.observability?.` 那个 `?.`。GUI 构造
// CodingAgent 的 config 里没有 `observability` 键，于是
// `setDelegationRolePredicate(...)` 整体静默 no-op，`delegations[]` 的写入闸永远
// 关着——真机 32 条 agent_run 里 delegations 出现 0 次，成本视图（T4）恒空。
// **丢这个键的代价是零报错**：没有守卫，下次重构配置字面量时会再丢一次，而下一次
// 同样要等真机数据才发现（那已经是很久以后）。代码注释留不住这种约定，断言可以。
//
// 这个脚本量的是**机制层**四件事，用的全是生产代码本身：
//   1. GUI 接线：chat.ts 的 CodingAgent config 真的带着那个全局单例，且只带一次
//      （传一个新实例会让记账离开 JSONL，磁盘上照样一条没有）。
//   2. 写入闸：predicate 装着时角色 ToolResult 落进 `delegations[]`，非角色不落。
//   3. 落盘：经真 FilePromptObservationStore 写盘、再用同一个解析器读回来——
//      等价于人工那句 `Select-String '"delegations"\s*:\s*\[\s*\{'`，但给 pass/fail。
//   4. 消费：summarizeTeamCosts 读到这些记录时 T4 不再是空态。
// 外加一条**负控**：不装 predicate 时同一条 ToolResult 一条 delegation 都不写。
// 负控是这里最要紧的一环——没有它，第 2 条断言可能是空转（predicate 判定写错了也
// 一样「没写 delegations」，看起来像通过）。负控把「不写」钉成预期行为，于是
// 「写了」才携带信息。
//
// 诚实边界（与 verify-plan-card-lag.ts 同款交代）：这个夹具**不驱动 chat.ts 的
// 事件循环**，也不发真实 LLM 请求——那需要 Tauri 窗口与真 provider。所以它量的是
// 「闸门装了、写了、落盘了、消费端读得到」，**不是**「某个真机会话肉眼看到什么」。
// 真机那一轮仍需人工：GUI 里派一次带 token 拆分的活，看设置页 T4 的
// 「还没有带 token 拆分的委派记录」这句话消失。
//
// 用法：bun run scripts/verify-delegation-accounting.ts

import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FilePromptObservationStore } from '../src/shared/FilePromptObservationStore';
import { PromptObservability } from '../src/shared/promptObservability';
import type { AgentRunObservation, PromptObservation } from '../src/shared/promptObservability';
import { summarizeTeamCosts } from '../src/shared/teamObservability';
import { renderTeamCostSection } from '../src/ui/evolutionDashboard';
import type { EngineEvent } from '../src/shared/types';

// ─────────────────────────────────────────────────────────────────────────────
// 迷你断言器：verify-* 脚本的既有做法是跑完打印结论（见 verify-plan-card-lag.ts），
// 但这个脚本要当回归门用，所以失败必须带非零退出码——否则 CI 里它只是一段日志。
// ─────────────────────────────────────────────────────────────────────────────

const failures: string[] = [];
let checks = 0;

function check(label: string, ok: boolean, detail = ''): void {
  checks += 1;
  if (ok) {
    console.log(`  ✓ ${label}${detail ? ` — ${detail}` : ''}`);
    return;
  }
  console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`);
  failures.push(label);
}

function heading(title: string): void {
  console.log(`\n【${title}】`);
}

// ─────────────────────────────────────────────────────────────────────────────
// 夹具输入：一次成功的角色委派，用量数字照真机量级填（否则 T4 的份额列全是 0.0，
// 「有数据」与「没数据」在读数上长得一样，测不出东西）。
// ─────────────────────────────────────────────────────────────────────────────

const GENERATED_ROLE = 'researcher_focused'; // 13.2 生成角色的命名形状
const USAGE = {
  promptTokens: 1_000_000,
  completionTokens: 100_000,
  cacheHitTokens: 400_000,
  cacheMissTokens: 600_000,
} as const;

function toolResultEvent(toolName: string, overrides: Record<string, unknown> = {}): EngineEvent {
  return {
    type: 'ToolResult',
    timestamp: Date.now(),
    payload: {
      toolName,
      duration: 4200,
      toolCallId: 'call-verify-1',
      result: {
        id: 'call-verify-1',
        toolName,
        success: true,
        duration: 4200,
        result: {
          id: 'call-verify-1',
          agentId: 'ag-verify01',
          agentName: toolName,
          success: true,
          output: 'x'.repeat(2048),
          tokensUsed: 1_100_000,
          usage: USAGE,
        },
        ...overrides,
      },
    },
  } as unknown as EngineEvent;
}

/** 按 CodingAgent.ts:268 的语义复刻 predicate：工具名在已注册角色表里就算委派。
 *  这里刻意**不**去 new CodingAgent——那需要真 provider 与整条引擎；语义本身只有
 *  一行，把那一行照抄过来比造一个假 agent 更诚实（改坏了这里，闸门语义就跟着错）。 */
function rolePredicate(roster: ReadonlySet<string>) {
  return (toolName: string) => roster.has(toolName);
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. GUI 接线（静态取证）
// ─────────────────────────────────────────────────────────────────────────────

function verifyGuiWiring(): void {
  heading('1. GUI 接线：CodingAgent config 带着那个全局单例');
  const src = readSource(new URL('../src/ui/chat.ts', import.meta.url));

  check(
    'chat.ts 从 shared/promptObservability 导入那个单例',
    src.includes("import { promptObservability } from '../shared/promptObservability'"),
  );

  // 边界用构造行与构造后紧邻的赋值行夹住：不数括号，也不依赖配置项的顺序。
  const start = src.indexOf('const codingAgent = new CodingAgent({');
  const end = src.indexOf('this.codingAgentRef = codingAgent;');
  check('找得到 CodingAgent 构造块', start > -1 && end > start, `start=${start} end=${end}`);

  if (start > -1 && end > start) {
    const wiring = src.slice(start, end);
    check(
      '构造块里有 `observability: promptObservability,`',
      /^\s*observability: promptObservability,$/m.test(wiring),
    );
  }

  // 传新实例 = 记账离开 JSONL = 磁盘上照样一条没有，而且不报错。
  const occurrences = src.split('observability: promptObservability').length - 1;
  check('全文只出现一次（防「顺手传了个每轮新建的实例」）', occurrences === 1, `实际 ${occurrences} 次`);
}

// ─────────────────────────────────────────────────────────────────────────────
// 2 + 3. 写入闸与落盘（动态取证，走真生产代码）
// ─────────────────────────────────────────────────────────────────────────────

interface ChainResult {
  records: PromptObservation[];
  sinkPath: string;
}

function runAccountingChain(directory: string, installPredicate: boolean): ChainResult {
  const sinkPath = join(directory, 'app.jsonl');
  // 与 main.ts:81 同款：内部 store 留默认的内存实现，只有 sink 落到磁盘。
  // （把同一个 FilePromptObservationStore 同时当内部 store 与 sink，会让每条记录
  //   被 append 两遍——生产路径不是这么接的，夹具也不该是。）
  const observability = new PromptObservability();
  observability.setSink(new FilePromptObservationStore(sinkPath));

  const roster = new Set(['researcher', GENERATED_ROLE]);
  if (installPredicate) observability.setDelegationRolePredicate(rolePredicate(roster));

  const run = observability.startRun({
    sessionId: 'verify-delegation-accounting',
    provider: 'deepseek-openai',
    model: 'deepseek-flash',
  });
  // 一条角色委派 + 一条普通工具调用：前者该进 delegations[]，后者只进 toolCalls。
  observability.recordEvent(run, toolResultEvent(GENERATED_ROLE));
  observability.recordEvent(run, toolResultEvent('read_file', { result: { id: 'call-plain', toolName: 'read_file', success: true, duration: 3 } }));
  observability.finishRun(run, { isComplete: true, interrupted: false });

  // 从磁盘读回，而不是从内存 store：落盘这一环要单独过一遍真解析器。
  return { records: new FilePromptObservationStore(sinkPath).list(), sinkPath };
}

function verifyWriteGate(directory: string): AgentRunObservation | undefined {
  heading('2. 写入闸：predicate 装着时角色委派落进 delegations[]');

  const positive = runAccountingChain(join(directory, 'predicate-on'), true);
  const run = positive.records.find((r): r is AgentRunObservation => r.type === 'agent_run');

  if (!run) {
    check('写出了一条 agent_run 记录', false, `sink: ${positive.sinkPath}`);
    return undefined;
  }
  check('写出了一条 agent_run 记录', true, positive.sinkPath);

  check('delegations[] 非空', (run.delegations?.length ?? 0) > 0, `实际 ${run.delegations?.length ?? 0} 条`);

  const delegation = run.delegations?.[0];
  check(
    '身份落在委派自己身上（agentId / role），不是匿名 toolCall',
    delegation?.agentId === 'ag-verify01' && delegation?.role === GENERATED_ROLE,
    `agentId=${delegation?.agentId} role=${delegation?.role}`,
  );
  check(
    'token 拆分带下来了（T4 的定价与份额全靠它）',
    delegation?.usage?.cacheMissTokens === USAGE.cacheMissTokens
      && delegation?.usage?.cacheHitTokens === USAGE.cacheHitTokens,
  );
  check('耗时记下了', typeof delegation?.durationMs === 'number', `${delegation?.durationMs}ms`);

  // 普通工具调用不能被误认成委派——predicate 是「在名单里」而不是「不是角色就排除」。
  const plainWrites = run.delegations?.filter((d) => d.role === 'read_file') ?? [];
  check('非角色工具调用没有混进 delegations[]', plainWrites.length === 0, `混入 ${plainWrites.length} 条`);
  check('非角色工具调用仍然在 toolCalls[] 里（匿名路径没被破坏）', run.toolCalls.length === 2, `实际 ${run.toolCalls.length} 条`);

  heading('3. 落盘：同一份记录从 JSONL 读回来还带着 delegations[]');
  const raw = positive.records.length;
  check('FilePromptObservationStore 读回了 agent_run', raw > 0, `${raw} 条记录`);
  check(
    '读回来的记录里 delegations[] 仍在（不是只在内存里有）',
    (run.delegations?.length ?? 0) > 0,
  );

  return run;
}

function verifyNegativeControl(directory: string): void {
  heading('负控：不装 predicate 时一条 delegation 都不写');
  // 这一条决定上面所有断言是否携带信息。若没有负控，「没写 delegations」既可能是
  // 闸门关着（本次要测的），也可能是 predicate 判定写错了（夹具自身的 bug），
  // 两种情况在第 2 节里读数完全一样。
  const negative = runAccountingChain(join(directory, 'predicate-off'), false);
  const run = negative.records.find((r): r is AgentRunObservation => r.type === 'agent_run');

  check('对照组也写出了 agent_run', Boolean(run), negative.sinkPath);
  check(
    '对照组 delegations[] 缺失或为空（T1 之前的行为，逐字节不变）',
    !run || run.delegations === undefined || run.delegations.length === 0,
    `实际 ${run?.delegations?.length ?? 'undefined'} 条`,
  );
  check('对照组 toolCalls[] 仍有 2 条（匿名路径照旧）', (run?.toolCalls.length ?? 0) === 2);
}

// ─────────────────────────────────────────────────────────────────────────────
// 4. 消费端：T4 读得到（设置页不再显示空态）
// ─────────────────────────────────────────────────────────────────────────────

function verifyConsumption(directory: string): void {
  heading('4. 消费端：summarizeTeamCosts 读到这些委派（T4 不再是空态）');
  const positive = runAccountingChain(join(directory, 'consumer'), true);

  // 角色面要跟 settings.ts:3535 同款传真实名单：`roleSurface()` 的**默认**是 8 个
  // 内建角色（teamObservability.ts:28 自陈「它是默认值，不是真相」），生成角色不在
  // 里面。所以下面第一段用默认口径、第二段用宿主口径，两段都必须量——
  // 只量第一段会漏掉「谁把 settings.ts 那个 roles: 弄丢了」，只量第二段则看不出
  // 默认口径会把生成角色滤掉。
  const defaulted = summarizeTeamCosts(positive.records, { now: Date.now() });
  check(
    '默认角色面（8 内建）滤掉生成角色 —— 这是已知口径，不是本次回归',
    defaulted.rows.every((row) => row.role !== GENERATED_ROLE),
    `默认口径行: ${defaulted.rows.map((row) => row.role).join(', ') || '(空)'}`,
  );

  const view = summarizeTeamCosts(positive.records, { now: Date.now(), roles: ['researcher', GENERATED_ROLE] });
  check('hasMetered 为真（有可计价的委派读数）', view.hasMetered, `hasMetered=${view.hasMetered}`);
  check('成本视图有行', view.rows.length > 0, `${view.rows.length} 行`);
  check(
    '未计量的委派数为 0（那半边 toolCalls 回退不该被触发）',
    view.unmeteredDelegations === 0,
    `unmetered=${view.unmeteredDelegations}`,
  );
  check(
    '生成角色进了成本视图（13.2 试用制的裁决终于有数据可读）',
    view.rows.some((row) => row.role === GENERATED_ROLE),
    view.rows.map((row) => row.role).join(', ') || '(空)',
  );
  const row = view.rows.find((r) => r.role === GENERATED_ROLE);
  if (row) {
    check(
      '该行带出了 token 与金额（不是 0 占位）',
      (row.totalTokens ?? 0) > 0 && row.priced === true,
      `tokens=${row.totalTokens} priced=${row.priced} usd=${row.costUsd?.toFixed(5) ?? 'n/a'}`,
    );
  }

  // 设置页那句空态文案就是靠 hasMetered 决定的（evolutionDashboard.ts:761-764），
  // 直接断言它消失——审计点名的用户可见症状。
  const html = renderTeamCostSection(positive.records, { now: Date.now(), roles: ['researcher', GENERATED_ROLE] });
  check(
    '设置页成本卡不再显示「还没有带 token 拆分的委派记录」',
    !html.includes('还没有带 token 拆分的委派记录'),
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// 已知缺口：CLI 侧 predicate 无人安装。不静默放过，也不假装是回归。
// ─────────────────────────────────────────────────────────────────────────────

function reportKnownGap(): void {
  heading('已知缺口（不在本夹具的通过/失败判定里，但要记账）');
  const harness = readSource(new URL('../src/harness/Harness.ts', import.meta.url));
  const cliHarness = readSource(new URL('../src/cliHarness.ts', import.meta.url));

  const installs = /setDelegationRolePredicate/.test(harness) || /setDelegationRolePredicate/.test(cliHarness);
  if (installs) {
    console.log('  · CLI 侧（cliHarness → Harness）已装 predicate：本条缺口关闭，可删掉这段。');
    return;
  }
  console.log('  · CLI 侧不经过 CodingAgent（cliHarness.ts 构造的是 Harness），');
  console.log('    Harness 只取值不安装 predicate ⇒ CLI 的 delegations[] 仍恒空。');
  console.log('    影响面受限：summarizeTeamCosts 唯一消费者是设置页 T4，读的是 app.jsonl；');
  console.log('    CLI 写 cli.jsonl，暂无消费者。所以暂无用户可见症状。');
  console.log('    补的时候注意：predicate 是覆盖式赋值，GUI/CLI 共用同一个单例，');
  console.log('    两个表面同时开会互相踩——这不是加一行能了事的。');
  console.log('  证据：src/harness/Harness.ts、src/cliHarness.ts 均无 setDelegationRolePredicate 调用。');
}

// ─────────────────────────────────────────────────────────────────────────────

function readSource(url: URL): string {
  return readFileSync(url, 'utf8');
}

const directory = mkdtempSync(join(tmpdir(), 'pure-verify-delegation-'));
try {
  console.log('委派记账验收：闸门 → 写入 → 落盘 → 消费（全链走生产代码）');
  verifyGuiWiring();
  verifyWriteGate(directory);
  verifyNegativeControl(directory);
  verifyConsumption(directory);
  reportKnownGap();
} finally {
  rmSync(directory, { recursive: true, force: true });
}

console.log(`\n${checks - failures.length} / ${checks} 项通过`);
if (failures.length > 0) {
  console.error(`\n失败 ${failures.length} 项：`);
  for (const label of failures) console.error(`  - ${label}`);
  console.error('\n委派记账链断了。若 GUI 接线那节失败，先查 chat.ts 的 CodingAgent config');
  console.error('有没有把 observability 这个键弄丢——丢它是零报错的，等真机数据才会发现。');
  process.exit(1);
}
console.log('委派记账链完整。');
