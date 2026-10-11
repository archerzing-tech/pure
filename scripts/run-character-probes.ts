// scripts/run-character-probes.ts
// 人格轨道 刀 4（2026-10-12）— 性格内核行为判例集 runner。
//
// 蓝图 §3 刀 4：固定探针集（拿不准的任务 / 失败的交付 / 模糊指令 / 中途打断 /
// 用户情绪化催促），pass/fail 走**固定断言 + 人工抽查**，禁止 LLM-as-judge
// 单裁；任何内核 / 投影文本变更必须跑本集（人格变更 = 行为变更）。
//
// 两个模式：
//   replay（默认，免 key）——CI 门。判例从 evals/character/*.json 装载，每条
//     在 samples/ 里有配对的预录样本：good-* 必须过，bad-* 必须挂在文件名
//     标注的那一条断言上（挂了别的 / 没挂，都算语料与 grader 漂移，红）。
//     它证明的是「判例集完整、判定可控」，不碰模型——模型侧结论只来自 live。
//   live（--agent <provider>）——人工抽查层。每条判例用**真实装配**的 system
//     prompt（含 character_core / character_expression 两个 fragment，正是本
//     集要守的注入面）问一次真 provider，grader 判分、--report 落盘供人按
//     各条失败原因抽查。禁 LLM-as-judge：判卷的只有固定行为断言。
//
// 用法：
//   bun run eval:character                                   # replay（CI）
//   bun run eval:character -- --agent deepseek-openai        # live
//       [--model deepseek-chat] [--only <caseId>] [--report path]
//       [--cases evals/character] [--samples evals/character/samples]
//
// 退出码：0 = 全过，1 = 有失败，2 = 用法 / 环境错误（与 run-evals 对齐）。

import { readdir, readFile, mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import {
  CHARACTER_PROBE_EXPECTATIONS,
  characterProbeScore,
  gradeCharacterProbe,
  isCharacterProbeCase,
  type CharacterProbeCase,
} from '../src/evaluation/characterProbe';
import { createAdapter } from '../src/evaluation/codingAgentExecutor';
import { promptAssembler } from '../src/shared/PromptAssembler';
import { defaultModelFor } from '../src/shared/providers';

const argv = process.argv.slice(2);
const flag = (name: string): string | undefined => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : undefined;
};

const agentFlag = flag('--agent');
const modelFlag = flag('--model');
const onlyFlag = flag('--only');
const reportFlag = flag('--report');
const casesDir = resolve(flag('--cases') ?? 'evals/character');
const samplesDir = resolve(flag('--samples') ?? 'evals/character/samples');

function apiKeyForProvider(provider: string): string | undefined {
  if (process.env.PURE_EVAL_API_KEY) return process.env.PURE_EVAL_API_KEY;
  switch (provider) {
    case 'deepseek-openai':
    case 'deepseek-anthropic':
      return process.env.DEEPSEEK_API_KEY;
    case 'qwen':
      return process.env.DASHSCOPE_API_KEY;
    case 'glm':
      return process.env.ZHIPU_API_KEY;
    default:
      return undefined;
  }
}

// ── 装载判例 ──

const cases: CharacterProbeCase[] = [];
for (const entry of (await readdir(casesDir)).sort()) {
  if (!entry.endsWith('.json')) continue;
  const parsed: unknown = JSON.parse(await readFile(resolve(casesDir, entry), 'utf8'));
  if (!isCharacterProbeCase(parsed)) {
    console.error(`${entry}: not a character probe case (need id / scenario / summary / userTurns[] / expectations[])`);
    process.exit(2);
  }
  cases.push(parsed);
}
if (cases.length === 0) {
  console.error(`no probe cases in ${casesDir} — see evals/character/README.md for the format`);
  process.exit(2);
}
const selected = onlyFlag ? cases.filter((c) => c.id === onlyFlag) : cases;
if (selected.length === 0) {
  console.error(`no case with id "${onlyFlag}" — known: ${cases.map((c) => c.id).join(', ')}`);
  process.exit(2);
}
// id 重复会导致 --only 与报告张冠李戴——装载时就拦，不等到判卷。
const ids = new Set(selected.map((c) => c.id));
if (ids.size !== selected.length) {
  console.error(`duplicate case ids in ${casesDir} — every case needs a unique id`);
  process.exit(2);
}

interface CaseResult {
  id: string;
  scenario: string;
  expectations: string[];
  passed: boolean;
  failures: string[];
}

const results: CaseResult[] = [];
let failures = 0;

// live 模式：真实 system prompt 装配（本集要守的正是这条注入链）。
const PROBE_SURFACE = 'gui' as const;
function assembledSystemPrompt(): string {
  return promptAssembler.buildSystemPrompt({
    surface: PROBE_SURFACE,
    capabilities: 'general assistant capabilities',
  });
}

if (!agentFlag) {
  // ── replay 模式（CI 门，免 key） ──
  const known = new Set<string>(CHARACTER_PROBE_EXPECTATIONS as readonly string[]);
  const sampleEntries = (await readdir(samplesDir).catch(() => [] as string[])).filter((f) => f.endsWith('.txt'));
  let sampleCount = 0;
  for (const probe of selected) {
    // good-<caseId>.txt 必须过；bad-<caseId>-<expectation>.txt 必须精确挂在
    // 标的断言上。文件名里的 expectation 用已知集合做后缀解析——判例 id 本身
    // 也带连字符，从左往右猜会把 good- 也吃进来。
    const good = sampleEntries.find((f) => f === `good-${probe.id}.txt`);
    const bads = sampleEntries.filter((f) => f.startsWith(`bad-${probe.id}-`));

    const probeFailures: string[] = [];
    if (good) {
      sampleCount += 1;
      const grade = gradeCharacterProbe(await readFile(resolve(samplesDir, good), 'utf8'), probe);
      if (!grade.passed) probeFailures.push(`good 样本未过(${good}): ${grade.failures.join('; ')}`);
    } else {
      probeFailures.push(`缺少 good 样本: ${samplesDir}/good-${probe.id}.txt`);
    }
    for (const bad of bads) {
      sampleCount += 1;
      const suffix = bad.slice(`bad-${probe.id}-`.length, -'.txt'.length);
      if (!known.has(suffix)) {
        probeFailures.push(`坏样本标注了未知断言: ${bad}`);
        continue;
      }
      const grade = gradeCharacterProbe(await readFile(resolve(samplesDir, bad), 'utf8'), probe);
      if (grade.passed) probeFailures.push(`坏样本未挂(${bad}): grader 判过了`);
      else if (!grade.failures.some((x) => x.startsWith(`[${suffix}]`))) probeFailures.push(`坏样本挂错断言(${bad}): 挂在别处，不是 ${suffix}`);
    }
    const passed = probeFailures.length === 0;
    if (!passed) failures += 1;
    results.push({ id: probe.id, scenario: probe.scenario, expectations: probe.expectations, passed, failures: probeFailures });
    console.log(`${passed ? '✓' : '✗'} ${probe.id} (${probe.scenario})${passed ? '' : ` — ${probeFailures.join('; ')}`}`);
    if (!good && bads.length === 0) console.log(`    （该判例在 samples/ 无任何配对样本：${samplesDir}）`);
  }
  console.log(`\nreplay: ${selected.length - failures}/${selected.length} 判例的语料与判定一致（${sampleCount} 个样本）`);
  console.log('边界：本模式不碰模型——它证明判例集完整、行为判定可控；模型侧人格结论请用 --agent 跑 live。');
} else {
  // ── live 模式（人工抽查层） ──
  const requestedAgent = agentFlag;
  if (requestedAgent !== 'mock' && !apiKeyForProvider(requestedAgent)) {
    console.error('A provider API key is required for --agent (set PURE_EVAL_API_KEY or the provider-specific key).');
    process.exit(2);
  }
  const model = modelFlag ?? process.env.PURE_EVAL_MODEL ?? defaultModelFor(requestedAgent);
  const adapter = createAdapter({ provider: requestedAgent, model, apiKey: apiKeyForProvider(requestedAgent) });
  const systemPrompt = assembledSystemPrompt();

  console.log(`character probes: ${selected.length} cases · agent=${requestedAgent} · model=${model}`);
  console.log(`cases: ${casesDir} · system prompt: ${systemPrompt.length} chars（含 character_core / character_expression）`);
  if (!systemPrompt.includes('<character_core>') || !systemPrompt.includes('<character_expression>')) {
    // 探针还没开跑，注入面就丢了——这种情况跑出来的 pass 毫无意义。
    console.error('装配出的 system prompt 缺 character_core / character_expression 之一——先查 PromptAssembler，别跑。');
    process.exit(2);
  }

  for (const probe of selected) {
    // 单轮：把 userTurns 拼成一次提问（多轮探针的早轮作为上文带进同一条消息）。
    // 人格探针测的是文本姿态，不驱动工具环——这个边界写进 README。
    const userMessage = probe.userTurns.join('\n\n');
    const started = Date.now();
    let output = '';
    try {
      const response = await adapter.complete(
        [{ role: 'system', content: systemPrompt }, { role: 'user', content: userMessage }],
        [],
      );
      output = response.content;
    } catch (error) {
      output = `[RUN_FAILED] ${error instanceof Error ? error.message : String(error)}`;
    }
    const grade = gradeCharacterProbe(output, probe);
    if (!grade.passed) failures += 1;
    results.push({ id: probe.id, scenario: probe.scenario, expectations: probe.expectations, passed: grade.passed, failures: grade.failures });
    const mark = grade.passed ? '✓' : '✗';
    console.log(`${mark} ${probe.id} (${probe.scenario}) (${Math.round((Date.now() - started) / 1000)}s)${grade.passed ? '' : `\n    ${grade.failures.join('\n    ')}`}`);
  }
  const score = characterProbeScore(results);
  console.log(`\nlive: ${score.passed}/${score.total} 通过 — 未过项请按各条 [assertion] 原因人工抽查`);
  console.log('（判定只有固定行为断言；LLM-as-judge 按蓝图禁止）');
}

if (reportFlag) {
  await mkdir(resolve(reportFlag, '..'), { recursive: true });
  await writeFile(
    resolve(reportFlag),
    `${JSON.stringify({ suiteVersion: 'character-probes-v1', mode: agentFlag ? 'live' : 'replay', agent: agentFlag ?? null, model: modelFlag ?? null, caseCount: selected.length, results, ranAt: new Date().toISOString() }, null, 2)}\n`,
  );
  console.log(`report: ${resolve(reportFlag)}`);
}
process.exit(failures === 0 ? 0 : 1);
