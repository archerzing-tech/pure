// 插话决策回放：用一批真实插话原文验证「决策不看关键词」这条定调，并在
// --llm 时真跑裁决器量**契约遵守率**（折算表判对率 + stop 档 + chatter
// 保守放行）。
//
// 语料与机械路径判定住在 `src/coding-agent/insertionCorpus.ts`，与离线回归
// 测试（`insertionCorpus.test.ts`）共用同一份——回放看到的和回归断言的必须是
// 同一批句子。
//
// 三条通道的代价完全不同，所以分开报：
//   main：机械快路径（整停 / 点名停支 / 点名续支）——已随 2026-10-28 框架
//         改革刀 1 整体退役（见下方离线通道注释）
//   net ：字段族安全网（推翻 / 收活 / 加活）——字段族已随裁决器 v3 三值契约
//         退役，安全网收窄为 fallbackUsed 原话直投
//
// 现在唯一的活通道是 --llm：真跑裁决器，量折算表判对率与兜底率。
//
// 用法：
//   bun scripts/replay-insertion-decisor.ts            离线：机械路径截胡面
//   bun scripts/replay-insertion-decisor.ts --llm      追加真跑裁决器（GLM key
//                                                      同应用解析顺序）
//   ... --llm --limit 8                                只跑前 8 句（调试用）
//   ... --llm --from 15 --limit 15                     分片跑（限流退避容易超时）
//   ... --llm --pause 1500                             句间节流（限流严重时用）
//   ... --llm --timing                                 两个阶段各跑一遍
//   ... --llm --thinking-on                            不关暗推理（复现生产的延迟兜底）
//
// 暗推理（2026-09-28 查清）：bigmodel 的 anthropic 端点默认开着 thinking，而适配器
// 只透传可见文字——于是量到的「首字节」实际是「思考结束」。同一批句子实测：关掉
// 1.1–6.5s，开着 8–28s，最长那几句 90s 都出不来一个字。生产裁决预算是 8s，所以
// 开着思考时大部分插话根本轮不到判断（走字面安全网）。回放默认关掉：这里要量的是
// **裁决器的判断质量**，不是 provider 的思考延迟；`--thinking-on` 用来复现延迟兜底率。

import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { ALL_CASES, DEFAULT_SCENARIO, SCENARIOS, scenarioFor, type Case } from '../src/coding-agent/insertionCorpus';
import { classifyInsertion, type InsertionClassification } from '../src/coding-agent/Planner';
import { DeepSeekAnthropicAdapter } from '../src/adapter/deepseek/DeepSeekAnthropicAdapter';
import type { LLMAdapter } from '../src/shared/types';

// 离线通道（机械路径截胡面）已随 2026-10-28 框架改革刀 1 退役：机械快路径
// 正则族整体删除、判定全归裁决器，「哪句会被正则抢答」的对象不存在了
// （insertionCorpus 撤掉 mechanicalHits/mainHit 时本脚本没跟上，import 已删
// 导出直到本次修复前一直是坏的）。裁决器契约遵守率的量测全在 --llm 通道。

// ── 真跑裁决器（--llm）────────────────────────────────────────────────────

/** 关掉暗推理：bigmodel 认 `thinking: {type:'disabled'}`（adapter 不接 extraBody，
 *  所以直接在请求体上打补丁；shared/providers.ts 的 planThinkingOffExtraBody 是
 *  同一条实测结论的生产版）。 */
function withThinkingOff(adapter: LLMAdapter): LLMAdapter {
  const client = (adapter as unknown as { client?: { messages?: { stream?: (p: unknown, o?: unknown) => unknown } } }).client;
  const stream = client?.messages?.stream;
  if (!client?.messages || typeof stream !== 'function') return adapter;
  const bound = stream.bind(client.messages);
  client.messages.stream = (params: unknown, opts?: unknown) =>
    bound({ ...(params as Record<string, unknown>), thinking: { type: 'disabled' } }, opts);
  return adapter;
}

function resolveLlm(): LLMAdapter | null {
  let apiKey: string | undefined;
  try {
    const raw = JSON.parse(readFileSync(join(homedir(), '.pure', 'config.json'), 'utf8')) as {
      apiKey?: string;
      providerOverrides?: Record<string, { apiKey?: string }>;
    };
    apiKey = raw.providerOverrides?.glm?.apiKey ?? raw.apiKey;
  } catch {
    // 没有 config 文件就看 secrets。
  }
  if (!apiKey) {
    try {
      const secrets = JSON.parse(readFileSync(join(homedir(), '.pure', 'secrets.json'), 'utf8')) as Record<string, string>;
      apiKey = secrets['llm.apiKey.glm'] ?? secrets['llm.apiKey'];
    } catch {
      // 两条都没有就没法跑真实裁决。
    }
  }
  if (!apiKey) return null;
  // maxTokens 不能小：glm-5.3 的 thinking 先吃掉预算，可见输出就空了（适配器
  // 自己的注释也踩过同一个坑）。而生产的插话裁决超时是 8s——回放时放宽到
  // 15s，因为这里要分清「判错」和「没来得及判」，不能把超时混进误判率。
  const adapter = new DeepSeekAnthropicAdapter({
    apiKey,
    model: 'glm-5.3-flash',
    baseURL: 'https://open.bigmodel.cn/api/anthropic',
    maxTokens: 8192,
  }) as unknown as LLMAdapter;
  return process.argv.includes('--thinking-on') ? adapter : withThinkingOff(adapter);
}

/**
 * 每句用它自己的场景（`insertionCorpus.ts` 的 SCENARIOS）。
 *
 * 2026-09-28 之前这里是**两个固定上下文**套给所有句子，于是「我在西安」「这首
 * 必须是五言的」被放在「并行调研三个平台」的语境里判——判错的是上下文，不是
 * 模型。现在场景跟着句子走；`--timing` 再加跑一遍默认场景，看同一句的判定会不
 * 会随场景变（场景不匹配会判错，正是这条教训的度量）。
 */
function contextsFor(c: Case, withTiming: boolean): Array<{ id: string; text: string }> {
  const own = scenarioFor(c);
  if (!withTiming) return [own];
  const fallback = { id: DEFAULT_SCENARIO, text: SCENARIOS[DEFAULT_SCENARIO] };
  return own.id === fallback.id ? [own] : [own, fallback];
}

/** 比生产的 8s 宽松（生产预算见 classifyInsertion 的 timeoutMs 默认值）。关掉
 *  暗推理后实测 1–7s 足够，留 15s 是为了不把“限流/网络慢”混成“判错”。
 *  PURE_REPLAY_TIMEOUT 可覆盖。 */
const LLM_TIMEOUT_MS = Number(process.env.PURE_REPLAY_TIMEOUT ?? '') || 15_000;

/** 判定形状（三值契约 + 机械停动作 + 点名 id；插话架构 v2/v3 后的权威输出）：
 *  stop=整树停（"action":"stop"）；stop_branch/resumes_branch=点名支带确切
 *  id；其余就是 verdict 本身。旧九类 kind 已随裁决器 v3 退役——回放的
 *  「判对」走下面的折算表，不再直接比 kind。 */
type VerdictShape = 'stop' | 'stop_branch' | 'resumes_branch' | 'inline' | 'sideline' | 'new_task';

/** 折算表：语料期望（人工核对的旧词表，语料本体按原样留档）在新契约下的
 *  合法判定集合。inline 是宽桶+兜底位（「宁可打扰，不丢话」契约）——主线
 *  类（steer/goal-change/premise-change/question/task）判成 inline 一律算对；
 *  点名停/续支（花名册场景下）也是 steer 的合法子形。chatter 判 inline 不算
 *  错但单独记「保守放行」（sideline 高门槛漏判率要可见）。语料场景不带
 *  <live_branches> 花名册，点名支点不出 id 判 inline 正是契约要求的行为。 */
const ACCEPTED_SHAPES: Record<Exclude<Case['kind'], 'scheduled'>, VerdictShape[]> = {
  stop: ['stop'],
  steer: ['inline', 'stop_branch', 'resumes_branch'],
  'goal-change': ['inline'],
  'premise-change': ['inline'],
  question: ['inline'],
  task: ['inline'],
  chatter: ['sideline'],
};

interface Verdict {
  shape: VerdictShape | null;
  label: string;
}

interface LlmRow {
  c: Case;
  verdicts: string[];
  shapes: Array<VerdictShape | null>;
}

/** 一次裁决 + 限流退避。bigmodel 对连续请求限得很紧，而回放是压测（生产里
 *  插话不会这么密）——把 429 当成「判错」会得到一堆假发现，所以要重试。 */
async function judgeOnce(llm: LLMAdapter, ctx: string, text: string): Promise<Verdict> {
  for (let attempt = 0; attempt <= 1; attempt++) {
    try {
      const v: InsertionClassification = await classifyInsertion(llm, ctx, text, undefined, undefined, LLM_TIMEOUT_MS);
      if (!v.fallbackUsed) {
        const named = v.stopBranch?.callId ?? v.resumesBranch?.callId ?? v.branchCallId;
        const shape: VerdictShape = v.action === 'stop'
          ? 'stop'
          : v.stopBranch?.callId
            ? 'stop_branch'
            : v.resumesBranch?.callId
              ? 'resumes_branch'
              : v.verdict;
        return {
          shape,
          label: `${shape}(${v.confidence.toFixed(2)})${named ? ` 点名=${named}` : ''}${v.receipt ? ` 「${v.receipt}」` : ''}`,
        };
      }
    } catch {
      // 抛错也退避重试。
    }
    if (attempt < 1) await new Promise((r) => setTimeout(r, 1500));
  }
  return { shape: null, label: '兜底（裁决超时/限流/解析失败）' };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function llmReport(llm: LLMAdapter, limit: number | null, withTiming: boolean, from: number, pauseMs: number): Promise<void> {
  // 分片跑是必要的：回放会连续打 provider，限流退避叠起来很容易撞过工具超时，
  // 而一次超时会把整段结果全丢掉（stdout 随进程没）。
  const pool = ALL_CASES.slice(from, limit ? from + limit : undefined);
  const thinkingOff = !process.argv.includes('--thinking-on');
  console.log(`═══ 真跑裁决器（GLM${thinkingOff ? '，暗推理已关' : '，暗推理开着'}，第 ${from + 1}–${from + pool.length} 句 · `
    + `每句自带场景${withTiming ? ' + 默认场景对照' : ''} · 句间 ${pauseMs}ms）═══\n`);
  const rows: LlmRow[] = pool.map((c) => ({ c, verdicts: [], shapes: [] }));
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    for (const ctx of contextsFor(row.c, withTiming)) {
      const v = await judgeOnce(llm, ctx.text, row.c.text);
      row.verdicts.push(`${ctx.id}: ${v.label}`);
      row.shapes.push(v.shape);
    }
    // 即时打印：分片跑的目的就是「超时也只丢最后一句」——把结果缓到最后
    // 统一输出，一次限流退避超时就把已经拿到的判定全赔进去（踩过）。
    const gradable = row.c.kind !== 'scheduled';
    const first = row.shapes[0];
    const accepted = first !== null && row.c.kind !== 'scheduled' && ACCEPTED_SHAPES[row.c.kind].includes(first);
    const mark = !gradable ? '·' : first === null ? '⚠' : accepted ? '✓' : '✗';
    console.log(`${mark} 「${row.c.text}」  期望 ${row.c.kind}`);
    row.verdicts.forEach((v) => console.log(`    ${v}`));
    if (pauseMs > 0 && i < rows.length - 1) await sleep(pauseMs);
  }
  console.log('');

  // 只统计「有有效裁决」的行：兜底既不是漏报也不是误报，是没判出来。把它算
  // 进去会得到一堆假发现（限流期实测能占大半）。
  //
  // 审计收割来的句子（expectation: 'suspected'）与人工核对的语料分开算：它们的
  // 期望是从疑点原因反推的，审计网的假阳性可直接算到裁决器头上——混在一起
  // 会把“审计太宽”读成“裁决器判错”。
  const asserted = rows.filter((r) => r.c.expectation !== 'suspected');
  const judged = asserted.filter((r) => r.shapes[0] !== null);
  const fell = asserted.length - judged.length;
  const graded = judged.filter((r) => r.c.kind !== 'scheduled');
  const misses: string[] = [];
  const timingSensitive: string[] = [];

  for (const row of asserted) {
    const gradable = row.c.kind !== 'scheduled';
    const first = row.shapes[0];
    if (gradable && first !== null && !ACCEPTED_SHAPES[row.c.kind].includes(first)) {
      misses.push(`「${row.c.text}」 期望 ${row.c.kind} → ${row.verdicts.join(' | ')}\n      出处：${row.c.source}`);
    }
    // 同一句在「思考中」与「执行中」判出不同形状：时机真的进了判定，而这
    // 正是正则结构上做不到的事。
    const [a, b] = row.shapes;
    if (a && b && a !== b) timingSensitive.push(`「${row.c.text}」  ${a} ↔ ${b}`);
  }

  // ── 契约遵守率：stop 档与折算表分开看。cancels_part / adds_along 字段族已
  // 随裁决器 v3 三值契约退役（收执 receipt 取代九类账面），那两段 rate 统计
  // 一并退役——判对/判错全部走上面的折算表。机械快路径退役后全部句子都是
  // 裁决器主战场，不再剔除「命令族」。
  const soft = judged.filter((r) => r.c.kind === 'stop');
  const softHit = soft.filter((r) => r.shapes[0] === 'stop');
  const stopSpurious = graded.filter((r) => r.c.kind !== 'stop' && r.shapes[0] === 'stop');
  const chatter = judged.filter((r) => r.c.kind === 'chatter');
  const chatterConservative = chatter.filter((r) => r.shapes[0] === 'inline');
  const detail = (title: string, rows2: LlmRow[], render: (r: LlmRow) => string) => {
    if (rows2.length === 0) return;
    console.log(`\n  ${title}：`);
    rows2.forEach((r) => console.log(`    ${render(r)}`));
  };

  console.log('\n─── 契约遵守率（只算有有效裁决的 %d 句）───'.replace('%d', String(judged.length)));
  console.log(`  stop 档        整停 ${soft.length} 句判对 ${softHit.length}；非整停句误判成 stop ${stopSpurious.length} 句`);
  console.log(`  chatter 档     期望 sideline ${chatter.length} 句，判 inline（保守放行，不丢话但打扰可见）${chatterConservative.length} 句`);
  detail('stop 档漏判', soft.filter((r) => r.shapes[0] !== 'stop'), (r) => `「${r.c.text}」 → ${r.verdicts[0]}`);
  detail('stop 档误报', stopSpurious, (r) => `「${r.c.text}」 期望 ${r.c.kind}`);

  console.log(`\n折算表准确率：可比对 ${graded.length} 句，判对 ${graded.length - misses.length}`
    + `（${graded.length > 0 ? Math.round(((graded.length - misses.length) / graded.length) * 100) : 0}%）`);
  if (fell > 0) console.log(`⚠ ${fell} 句走了兜底（裁决超时/解析失败/限流）——不是判错，是没判出来。`);
  // 收割段单独展示裁决：这正是它们被收进来的原因（当初的疑点句），期望待
  // 人工复核，不进折算表评分。
  const harvested = rows.filter((r) => r.c.expectation === 'suspected');
  const harvestedJudged = harvested.filter((r) => r.shapes[0] !== null);
  if (harvested.length > 0) {
    console.log(`\n非断言段（审计收割 + 复核降级的双读句，期望待复核）${harvested.length} 句，有效裁决 ${harvestedJudged.length}：`);
    harvested.forEach((r) => console.log(`  「${r.c.text}」  ${r.verdicts[0]}`));
  }
  if (timingSensitive.length > 0) {
    console.log(`\n同一句在两个阶段判出不同形状（${timingSensitive.length} 句，时机进了判定）：`);
    timingSensitive.forEach((m) => console.log(`  ${m}`));
  }
  if (misses.length > 0) {
    console.log('\n折算表误判清单：');
    misses.forEach((m) => console.log(`  ${m}\n`));
  } else {
    console.log('\n折算表无误判。');
  }
}

const wantLlm = process.argv.includes('--llm');
const withTiming = process.argv.includes('--timing');
const limitArg = process.argv.indexOf('--limit');
const limit = limitArg >= 0 ? Number(process.argv[limitArg + 1]) || null : null;
const fromArg = process.argv.indexOf('--from');
const from = fromArg >= 0 ? Number(process.argv[fromArg + 1]) || 0 : 0;
const pauseArg = process.argv.indexOf('--pause');
const pauseMs = pauseArg >= 0 ? Number(process.argv[pauseArg + 1]) || 0 : 300;
console.log(`语料 ${ALL_CASES.length} 句（含审计收割 ${ALL_CASES.filter((c) => c.expectation === 'suspected').length} 句）。机械路径截胡面的离线通道已随框架改革刀 1 退役；量裁决器请加 --llm。\n`);
if (wantLlm) {
  const llm = resolveLlm();
  if (!llm) {
    console.error('没找到 GLM key（~/.pure/config.json 或 secrets.json），跳过 --llm。');
    process.exit(1);
  }
  await llmReport(llm, limit, withTiming, from, pauseMs);
}
