// scripts/run-work-order-probes.ts
// 分量判读（人格轨道 刀 6，2026-10-12）— 判例集 runner。
//
// 判定器是词表，词表会一直调——判例文件化（evals/work-order/*.json）让扩判例
// 不用改代码：新措辞判错了，加一个 JSON 就是回归防线。两轨与 eval:character
// 同款纪律（固定断言 + 人工抽查，禁 LLM-as-judge）：
//
//   replay（默认，免 key）——CI 门。每条判例断言 detectWorkOrderRegister 的
//     档位与命中面：轻档必须命中信号词（判定可解释，回执气泡引用它），
//     production-default 必须空命中（默认档不靠词，靠「判不出=正式」）。
//     外加机制链冒烟：档位表锁值、解析缩放（步数/验证真被收窄）、交付标记
//     解析——判例措辞之外，机制面坏了同样红。
//   live（--agent <provider>）——人工抽查层。用判例措辞配**真实档位段**装配
//     （buildPlanThinkingPrompt，正是刀 6 要守的注入面）问真 provider，断言：
//     a) 模型**自发**承诺的步数 ≤ 档位表上限——解析用 production 档（不经
//        缩放器收窄），量的是模型对档位段的服从度，不是裁剪器的服从度；
//     b) 轻档回复带跳过声明（诚实义务：轻做≠装完）。
//     失败细节 --report 落盘供人抽查。现 provider 不通/未配 key 时退出码 2。
//
// 用法：
//   bun run eval:work-order                                # replay（CI）
//   bun run eval:work-order -- --agent deepseek-openai     # live
//       [--model <id>] [--cases evals/work-order] [--report path]
//
// 退出码：0 = 全过，1 = 有失败，2 = 用法 / 环境错误（与 eval:character 对齐）。

import { readdir, readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import {
  CHARACTER_PROFILES,
  detectWorkOrderRegister,
  registerScaledDecision,
  resetActiveCharacterProfile,
  setActiveCharacterProfile,
  type WorkOrderRegister,
} from '../src/character';
import { parsePlanJsonWithMeta } from '../src/coding-agent/Planner';
import { buildPlanThinkingPrompt } from '../src/ui/planNarration';
import { parseDeliveryMarkers } from '../src/shared/delivery';
import { createAdapter } from '../src/evaluation/codingAgentExecutor';
import { defaultModelFor } from '../src/shared/providers';

interface WorkOrderCase {
  id: string;
  register: WorkOrderRegister;
  /** 轻档判例必须命中信号词；production-default 必须空命中。 */
  expectMatched: boolean;
  summary: string;
  userTurns: string[];
}

function isWorkOrderCase(value: unknown): value is WorkOrderCase {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return typeof v.id === 'string'
    && (v.register === 'draft' || v.register === 'spike' || v.register === 'production')
    && typeof v.expectMatched === 'boolean'
    && typeof v.summary === 'string'
    && Array.isArray(v.userTurns)
    && v.userTurns.every((t) => typeof t === 'string');
}

const argv = process.argv.slice(2);
const flag = (name: string): string | undefined => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : undefined;
};
const agentFlag = flag('--agent');
const modelFlag = flag('--model');
const casesDir = resolve(import.meta.dir, '..', flag('--cases') ?? 'evals/work-order');
const reportPath = flag('--report');

const failures: string[] = [];
const check = (ok: boolean, label: string): boolean => {
  if (ok) {
    console.log(`  ✅ ${label}`);
  } else {
    console.log(`  ❌ ${label}`);
    failures.push(label);
  }
  return ok;
};

// ── replay：判定面 + 机制链冒烟 ──

function runReplay(cases: WorkOrderCase[]): void {
  console.log(`\nreplay：${cases.length} 条判例 × 判定面`);
  for (const c of cases) {
    const verdict = detectWorkOrderRegister(c.userTurns[0]!);
    check(verdict.register === c.register, `${c.id}: 措辞 → ${c.register}（实得 ${verdict.register}）`);
    check(
      c.expectMatched ? verdict.matched.length > 0 : verdict.matched === '',
      `${c.id}: 命中面${c.expectMatched ? '非空（可解释）' : '为空（默认档不靠词）'}（实得「${verdict.matched}」）`,
    );
  }

  console.log('\nreplay：机制链冒烟（档位表 → 解析缩放 → 交付标记）');
  const fatPlan = JSON.stringify({
    reasoning: 'probe',
    steps: Array.from({ length: 8 }, (_, i) => ({ action: `step ${i + 1}` })),
    verification: [
      { command: 'a', reason: 'x' },
      { command: 'b', reason: 'y' },
      { command: 'c', reason: 'z' },
    ],
  });
  for (const id of ['veteran-fast', 'craftsman-slow'] as const) {
    for (const register of ['draft', 'spike'] as const) {
      // parsePlanJsonWithMeta 读的是活跃内核（全局状态）：冒烟哪个内核就把谁
      // 注上台——否则 caps 是 craftsman 的、解析是 veteran 的，断言形同虚设。
      setActiveCharacterProfile(id);
      try {
        const caps = registerScaledDecision(CHARACTER_PROFILES[id], register);
        const { plan } = parsePlanJsonWithMeta(fatPlan, register);
        check(
          (plan?.steps.length ?? 99) <= caps.maxPlanSteps
          && (plan?.verification?.length ?? 99) <= caps.maxVerificationItems,
          `${id}×${register}: 解析步数 ${plan?.steps.length}≤${caps.maxPlanSteps}、验证 ${plan?.verification?.length}≤${caps.maxVerificationItems}`,
        );
      } finally {
        resetActiveCharacterProfile();
      }
    }
  }
  check(
    JSON.stringify(parseDeliveryMarkers('## 产物已就绪：a.html\n## 产物已就绪：b.html\n## 产物已就绪：a.html'))
      === JSON.stringify(['a.html', 'b.html']),
    '交付标记：多份全收、去重、按序',
  );
}

// ── live：真 provider 的档位服从度 ──

interface LiveGrade {
  id: string;
  register: WorkOrderRegister;
  steps: number | null;
  stepCap: number;
  honest: boolean;
  pass: boolean;
  notes: string;
}

const HONEST_HINTS = [/跳过/, /没(有)?(跑|做|验|测)/, /未(做|验|跑|测)/, /skip(ped)?/i, /not (been )?(verified|tested|run)/i, /light(er)? (pass|version)/i];

async function runLive(cases: WorkOrderCase[]): Promise<void> {
  const model = modelFlag ?? defaultModelFor(agentFlag!);
  const llm = createAdapter(agentFlag!, model);
  console.log(`\nlive：${agentFlag} / ${model} — ${cases.length} 条判例（只跑轻档：production 恒等现行为，没有可测的新行为）`);
  const grades: LiveGrade[] = [];
  for (const c of cases.filter((x) => x.register !== 'production')) {
    const caps = registerScaledDecision(CHARACTER_PROFILES['veteran-fast'], c.register);
    const { system, user } = buildPlanThinkingPrompt(c.userTurns[0]!, { register: c.register });
    let output = '';
    try {
      const res = await llm.chat([
        { role: 'system', content: system },
        { role: 'user', content: user },
      ], {});
      const last = res.messages[res.messages.length - 1];
      output = typeof last?.content === 'string' ? last.content : '';
    } catch (err) {
      check(false, `${c.id}: provider 调用失败（${err instanceof Error ? err.message.slice(0, 80) : 'unknown'}）`);
      continue;
    }
    // a) 自发布数：production 档解析（不经缩放器收窄）。
    const parsed = parsePlanJsonWithMeta(output, 'production');
    const steps = parsed.plan?.steps.length ?? null;
    // b) 诚实义务：跳过声明。
    const honest = HONEST_HINTS.some((re) => re.test(output));
    const pass = steps !== null && steps <= caps.maxPlanSteps && honest;
    const grade: LiveGrade = { id: c.id, register: c.register, steps, stepCap: caps.maxPlanSteps, honest, pass, notes: '' };
    grades.push(grade);
    check(pass, `${c.id}: 自发步数 ${steps ?? '无计划'}/${caps.maxPlanSteps}、跳过声明 ${honest ? '有' : '无'}`);
  }
  if (reportPath) {
    await mkdir(resolve(reportPath, '..'), { recursive: true });
    await writeFile(reportPath, JSON.stringify({ agent: agentFlag, model, grades, failures }, null, 2));
    console.log(`报告已落盘：${reportPath}`);
  }
}

// ── 装载与入口 ──

async function loadCases(): Promise<WorkOrderCase[]> {
  const files = (await readdir(casesDir)).filter((f) => f.endsWith('.json')).sort();
  const cases: WorkOrderCase[] = [];
  for (const f of files) {
    const raw: unknown = JSON.parse(await readFile(resolve(casesDir, f), 'utf8'));
    if (!isWorkOrderCase(raw)) throw new Error(`判例文件不合规（缺 id/register/expectMatched/userTurns）：${f}`);
    cases.push(raw);
  }
  if (cases.length === 0) throw new Error(`判例目录为空：${casesDir}`);
  return cases;
}

try {
  const cases = await loadCases();
  console.log(`eval:work-order — 分量判读判例集（${cases.length} 条，目录 ${flag('--cases') ?? 'evals/work-order'}）`);
  runReplay(cases);
  if (agentFlag) await runLive(cases);
  else console.log('\n（replay 面：免 key，CI 门。live 抽查加 --agent <provider>）');

  console.log(`\n${failures.length === 0 ? '全部通过' : `${failures.length} 条失败`}（共 ${cases.length} 条判例${agentFlag ? ' + live 抽查' : ''}）`);
  process.exit(failures.length === 0 ? 0 : 1);
} catch (err) {
  console.error(`用法/环境错误：${err instanceof Error ? err.message : err}`);
  process.exit(2);
}
