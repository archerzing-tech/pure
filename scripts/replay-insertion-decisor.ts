// 插话决策回放：用一批真实插话原文验证「决策不看关键词」这条定调，量化残留
// 机械路径的截胡面，并在 --llm 时真跑裁决器量**契约遵守率**（stop 档 /
// cancels_part / adds_along）。
//
// 语料与机械路径判定住在 `src/coding-agent/insertionCorpus.ts`，与离线回归
// 测试（`insertionCorpus.test.ts`）共用同一份——回放看到的和回归断言的必须是
// 同一批句子。
//
// 三条通道的代价完全不同，所以分开报：
//   main：仍在主路上的机械快路径（整停 / 点名停支 / 点名续支）——会真正抢在
//         裁决器前面，代价是「判错就反向执行」
//   net ：已降级为安全网的字段族（推翻 / 收活 / 加活）——只在裁决器不可用时
//         生效，日常不参与
//
// （宿主粗筛 CANCELISH_RE 与停支闸 SCOPE_ADD_RE 已于 2026-09-28 移除，改由
//   裁决器的 cancels_part / adds_along 驱动，所以这里不再有 host 通道。）
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
import { ALL_CASES, DEFAULT_SCENARIO, SCENARIOS, aligns, mainHit, mechanicalHits, scenarioFor, type Case, type MechanicalHit } from '../src/coding-agent/insertionCorpus';
import { classifyInsertion, type InsertionKind } from '../src/coding-agent/Planner';
import { DeepSeekAnthropicAdapter } from '../src/adapter/deepseek/DeepSeekAnthropicAdapter';
import type { LLMAdapter } from '../src/shared/types';

function offlineReport(): void {
  const mainRight: string[] = [];
  const mainWrong: string[] = [];
  const netRight: string[] = [];
  const netWrong: string[] = [];

  console.log('\n═══ 离线：机械路径会不会抢答，抢答的方向对不对 ═══\n');
  for (const c of ALL_CASES) {
    const hits = mechanicalHits(c.text);
    const main = hits.find((h) => h.lane === 'main');
    const nets = hits.filter((h) => h.lane === 'net');
    const tag = (h: MechanicalHit) => `${h.name}→${h.gives}`;
    const want = c.detail ?? c.kind;

    if (main) {
      (aligns(c, main.gives) ? mainRight : mainWrong)
        .push(`「${c.text}」  ${tag(main)}  期望 ${want}\n      出处：${c.source}`);
      continue;
    }
    if (nets.length > 0) {
      (aligns(c, nets[0].gives) ? netRight : netWrong)
        .push(`「${c.text}」  ${nets.map(tag).join(' + ')}  期望 ${want}\n      出处：${c.source}`);
    }
  }

  const section = (title: string, rows: string[], note: string) => {
    console.log(`${title}（${rows.length}）${note}`);
    if (rows.length === 0) console.log('  （无）');
    else rows.forEach((r) => console.log(`  ${r}\n`));
  };

  section('【仍在主路】机械快路径命中且方向正确', mainRight,
    '\n —— 整停 / 点名停支 / 点名续支：人喊停不需要 deliberation，正则留着是对的\n');
  section('【仍在主路】机械快路径命中但方向错', mainWrong,
    '\n —— 每一句都是一个反向执行事故，必须留给裁决器\n');
  section('【已降级】裁决器倒下时会被网接住，方向一致', netRight,
    '\n —— 日常不参与；代价只落在裁决器超时/失败那一轮\n');
  section('【已降级】裁决器倒下时会被网接住，方向会判偏', netWrong,
    '\n —— 裁决器挂掉的那一轮，这些句子会被推到错的目的地\n');

  console.log(`语料 ${ALL_CASES.length} 句（含诊断区审计收割 ${ALL_CASES.filter((c) => c.expectation === 'suspected').length} 句）。`);
  console.log(`主路：命中 ${mainRight.length + mainWrong.length} 句，判错 ${mainWrong.length} 句`
    + `（这就是把 main 也交给裁决器能拿到的全部收益）；`);
  console.log(`降级：命中 ${netRight.length + netWrong.length} 句，方向偏差 ${netWrong.length} 句（只在裁决器倒下时兑现）。`);
  console.log('取消类不再有宿主粗筛的兜底（已于 2026-09-28 移除），全部押在 cancels_part 上。\n');
}

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

interface Verdict {
  kind: InsertionKind | null;
  label: string;
  cancelsPart: boolean;
  addsAlong: boolean;
}

interface LlmRow {
  c: Case;
  verdicts: string[];
  kinds: Array<InsertionKind | null>;
  cancels: boolean[];
  addsAlong: boolean[];
}

/** 一次裁决 + 限流退避。bigmodel 对连续请求限得很紧，而回放是压测（生产里
 *  插话不会这么密）——把 429 当成「判错」会得到一堆假发现，所以要重试。 */
async function judgeOnce(llm: LLMAdapter, ctx: string, text: string): Promise<Verdict> {
  for (let attempt = 0; attempt <= 1; attempt++) {
    try {
      const v = await classifyInsertion(llm, ctx, text, undefined, undefined, LLM_TIMEOUT_MS);
      if (!v.fallbackUsed) {
        return {
          kind: v.kind,
          label: `${v.kind}(${v.confidence.toFixed(2)})${v.cancelsPart ? ' +cancels_part' : ''}${v.addsAlong ? ' +adds_along' : ''}${v.when ? ` when=${v.when}` : ''}`,
          cancelsPart: v.cancelsPart === true,
          addsAlong: v.addsAlong === true,
        };
      }
    } catch {
      // 抛错也退避重试。
    }
    if (attempt < 1) await new Promise((r) => setTimeout(r, 1500));
  }
  return { kind: null, label: '兜底（裁决超时/限流/解析失败）', cancelsPart: false, addsAlong: false };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function llmReport(llm: LLMAdapter, limit: number | null, withTiming: boolean, from: number, pauseMs: number): Promise<void> {
  // 分片跑是必要的：回放会连续打 provider，限流退避叠起来很容易撞过工具超时，
  // 而一次超时会把整段结果全丢掉（stdout 随进程没）。
  const pool = ALL_CASES.slice(from, limit ? from + limit : undefined);
  const thinkingOff = !process.argv.includes('--thinking-on');
  console.log(`═══ 真跑裁决器（GLM${thinkingOff ? '，暗推理已关' : '，暗推理开着'}，第 ${from + 1}–${from + pool.length} 句 · `
    + `每句自带场景${withTiming ? ' + 默认场景对照' : ''} · 句间 ${pauseMs}ms）═══\n`);
  const rows: LlmRow[] = pool.map((c) => ({ c, verdicts: [], kinds: [], cancels: [], addsAlong: [] }));
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    for (const ctx of contextsFor(row.c, withTiming)) {
      const v = await judgeOnce(llm, ctx.text, row.c.text);
      row.verdicts.push(`${ctx.id}: ${v.label}`);
      row.kinds.push(v.kind);
      row.cancels.push(v.cancelsPart);
      row.addsAlong.push(v.addsAlong);
    }
    // 即时打印：分片跑的目的就是「超时也只丢最后一句」——把结果缓到最后
    // 统一输出，一次限流退避超时就把已经拿到的判定全赔进去（踩过）。
    const gradable = row.c.kind !== 'scheduled';
    const first = row.kinds[0];
    const mark = !gradable ? '·' : first === null ? '⚠' : first === row.c.kind ? '✓' : '✗';
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
  const judged = asserted.filter((r) => r.kinds[0] !== null);
  const fell = asserted.length - judged.length;
  const graded = judged.filter((r) => r.c.kind !== 'scheduled');
  const misses: string[] = [];
  const timingSensitive: string[] = [];

  for (const row of asserted) {
    const gradable = row.c.kind !== 'scheduled';
    const first = row.kinds[0];
    if (gradable && first !== null && first !== row.c.kind) {
      misses.push(`「${row.c.text}」 期望 ${row.c.kind} → ${row.verdicts.join(' | ')}\n      出处：${row.c.source}`);
    }
    // 同一句在「思考中」与「执行中」判出不同 kind：时机真的进了判定，而这
    // 正是正则结构上做不到的事。
    const [a, b] = row.kinds;
    if (a && b && a !== b) timingSensitive.push(`「${row.c.text}」  ${a} ↔ ${b}`);
  }

  // ── 契约遵守率：漏报与误报分开算（漏报 = 反向执行，误报 = 少排一个队）──
  // 契约统计只算「裁决器主战场」的句子：命令族（detail 已定）本来就由快路径
  // 接走，把裁决器单独问它们，它只能用 cancels_part 表达「停掉那一路」——那
  // 不是误报，是同一个意思的另一种说法。
  const judicable = judged.filter((r) => mainHit(r.c) === undefined);
  // 收割段单独看契约字段：这正是它们被收进来的原因（当初就是这里漏报）。
  const harvested = rows.filter((r) => r.c.expectation === 'suspected');
  const harvestedJudged = harvested.filter((r) => r.kinds[0] !== null);
  const rate = (expect: (c: Case) => boolean, got: (r: LlmRow) => boolean) => {
    const targeted = judicable.filter((r) => expect(r.c));
    const missed = targeted.filter((r) => !got(r));
    const spurious = judicable.filter((r) => !expect(r.c) && got(r));
    return { targeted, missed, spurious };
  };
  const cancels = rate((c) => c.cancels === true, (r) => r.cancels[0]);
  const adds = rate((c) => c.addsAlong === true, (r) => r.addsAlong[0]);
  const soft = judged.filter((r) => r.c.kind === 'stop');
  const softHit = soft.filter((r) => r.kinds[0] === 'stop');
  const stopSpurious = graded.filter((r) => r.c.kind !== 'stop' && r.kinds[0] === 'stop');

  const contractLine = (label: string, t: ReturnType<typeof rate>) =>
    `${label}  该报 ${t.targeted.length} 句，报出 ${t.targeted.length - t.missed.length}，漏报 ${t.missed.length}；误报 ${t.spurious.length} 句`;

  console.log('\n─── 契约遵守率（只算有有效裁决的 %d 句）───'.replace('%d', String(judged.length)));
  console.log(`  ${contractLine('cancels_part  ', cancels)}`);
  console.log(`  ${contractLine('adds_along    ', adds)}`);
  console.log(`  stop 档        软停 ${soft.length} 句判对 ${softHit.length}；非软停句误判成 stop ${stopSpurious.length} 句`);
  const detail = (title: string, rows2: LlmRow[], render: (r: LlmRow) => string) => {
    if (rows2.length === 0) return;
    console.log(`\n  ${title}：`);
    rows2.forEach((r) => console.log(`    ${render(r)}`));
  };
  detail('cancels_part 漏报（这句会反向执行）', cancels.missed, (r) => `「${r.c.text}」 → ${r.verdicts[0]}`);
  detail('cancels_part 误报（少排一个队）', cancels.spurious, (r) => `「${r.c.text}」 期望 ${r.c.kind}`);
  detail('adds_along 漏报（会把要加的活停掉）', adds.missed, (r) => `「${r.c.text}」 → ${r.verdicts[0]}`);
  detail('adds_along 误报', adds.spurious, (r) => `「${r.c.text}」 期望 ${r.c.kind}`);
  detail('stop 档漏判', soft.filter((r) => r.kinds[0] !== 'stop'), (r) => `「${r.c.text}」 → ${r.verdicts[0]}`);
  detail('stop 档误报', stopSpurious, (r) => `「${r.c.text}」 期望 ${r.c.kind}`);

  console.log(`\nkind 准确率：可比对 ${graded.length} 句，判对 ${graded.length - misses.length}`
    + `（${graded.length > 0 ? Math.round(((graded.length - misses.length) / graded.length) * 100) : 0}%）`);
  if (fell > 0)  if (fell > 0) console.log(`⚠ ${fell} 句走了兜底（裁决超时/解析失败/限流）——不是判错，是没判出来。`);
  if (harvested.length > 0) {
    const held = harvestedJudged.filter((r) => (r.c.cancels ? r.cancels[0] : true) && (r.c.addsAlong ? r.addsAlong[0] : true));
    console.log(`\n非断言段（审计收割 + 复核降级的双读句，期望待复核）${harvested.length} 句，有效裁决 ${harvestedJudged.length}，契约字段现在报对 ${held.length}：`);
    harvested.forEach((r) => console.log(`  「${r.c.text}」  ${r.verdicts[0]}`));
  }
  if (timingSensitive.length > 0) {
    console.log(`\n同一句在两个阶段判出不同 kind（${timingSensitive.length} 句，时机进了判定）：`);
    timingSensitive.forEach((m) => console.log(`  ${m}`));
  }
  if (misses.length > 0) {
    console.log('\nkind 误判清单：');
    misses.forEach((m) => console.log(`  ${m}\n`));
  } else {
    console.log('\nkind 无误判。');
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
offlineReport();
if (wantLlm) {
  const llm = resolveLlm();
  if (!llm) {
    console.error('没找到 GLM key（~/.pure/config.json 或 secrets.json），跳过 --llm。');
    process.exit(1);
  }
  await llmReport(llm, limit, withTiming, from, pauseMs);
}
