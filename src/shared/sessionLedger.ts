// src/shared/sessionLedger.ts
// 会话账本（蓝图第 4 期「不重复问、不重复做、不重复规划」）：宿主持有的三本账
// —— asked（澄清指纹 → 回答）、done（动作指纹 → 结果摘要）、plans（计划指纹
// 与状态链）。宿主在记账点写入，注入层把账排成给模型看的素材；模型在协议层
// 被教会在提问/动手前先翻账（命中只「提示 + 确认」，不静默跳过）。
//
// 形态对齐 TaskScript：version 显式、append-only、状态现推；指纹同
// SubagentOrchestrator.stableHash 的 FNV-1a 64-bit 同式。纯模块无 IO——
// 持久化由宿主快照（SessionUiState 可选字段）负责。

/** FNV-1a 64-bit over UTF-8 bytes — 与 SubagentOrchestrator.stableHash 同式：
 *  稳定、无 Date/random，跨重启可复算（同一动作/问题在两次会话里必须映射到
 *  同一指纹，去重才成立）。 */
function fnv1a64(parts: string[]): string {
  let h = 0xcbf29ce484222325n;
  for (const p of parts) {
    for (const b of new TextEncoder().encode(p)) {
      h ^= BigInt(b);
      h = (h * 0x100000001b3n) & 0xffffffffffffffffn;
    }
  }
  return h.toString(16);
}

/** 参数规范化：keys 递归排序后序列化——`{"a":1,"b":2}` 与 `{"b":2,"a":1}` 是
 *  同一个动作。parse 失败（模型给的 arguments 偶尔不是合法 JSON）回退 trim
 *  原文，指纹仍然稳定，只是规范化弱一档。 */
export function normalizeArgs(args: string): string {
  const trimmed = args.trim();
  if (!trimmed) return '';
  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (parsed === null || typeof parsed !== 'object') return JSON.stringify(parsed);
    const sorted = sortKeys(parsed as Record<string, unknown>);
    return JSON.stringify(sorted);
  } catch {
    return trimmed;
  }
}

function sortKeys(value: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(value).sort()) {
    const v = value[key];
    out[key] = v !== null && typeof v === 'object' && !Array.isArray(v)
      ? sortKeys(v as Record<string, unknown>)
      : v;
  }
  return out;
}

/** 动作指纹：意图（工具/委派名）+ 规范化参数。同意图不同参数是不同的动作。 */
export function actionFingerprint(toolName: string, args: string): string {
  return fnv1a64([toolName, normalizeArgs(args)]);
}

/** 问句指纹：trim、空白折叠、去尾标点后 hash——「端口用哪个 ？」与「端口用哪个」
 *  是同一件事（录入差异），不被问第二遍；差实词的问句仍不同指纹。 */
export function questionFingerprint(question: string): string {
  return fnv1a64([question.trim().replace(/\s+/gu, '').replace(/[?？.!。！]+$/u, '')]);
}

// ── 三本账 ──

/** asked：澄清账。提问前先翻——同一件事不问第二遍，用已有答案并说明「按你
 *  刚才说的」。answer 由答案回收点回填（插话重分类 / 旁答回收）。 */
export interface AskedEntry {
  ts: number;
  fingerprint: string;
  question: string;
  source: 'clarification' | 'sideAnswer';
  /** 用户的回答；未回收（settled=false）时缺省。 */
  answer?: string;
  answeredAt?: number;
  /** 回答已回收。未回收的条目不进注入素材（没有答案的问题没有复用价值）。 */
  settled: boolean;
}

/** done：动作账。动手前先翻——已做过就复用并告知，不重跑。summary 是宿主
 *  记的结果摘要（素材），不是给模型的结论句。 */
export interface DoneEntry {
  ts: number;
  fingerprint: string;
  /** 意图：工具名 / 委派 role 名。 */
  intent: string;
  ok: boolean;
  summary: string;
}

/** plans：计划账。配合既有 planSeq/planReplaced 语义——细化沿用编号不重开
 *  （replaced 标记），重开需在 reason 里明说之前的计划为何作废。 */
export interface PlanEntry {
  ts: number;
  fingerprint: string;
  planSeq: number;
  /** 触发输入（用户的原话或重开原因）。 */
  reason: string;
  /** 被同链细化取代（planReplaced）。 */
  replaced: boolean;
}

export interface SessionLedger {
  /** 账本格式版本。字段演进时升版，不靠猜。 */
  version: 1;
  asked: AskedEntry[];
  done: DoneEntry[];
  plans: PlanEntry[];
}

export function createSessionLedger(): SessionLedger {
  return { version: 1, asked: [], done: [], plans: [] };
}

/** 归一化任意输入为账本（旧快照缺字段 / 损坏输入的兜底——读侧永不让宿主崩）。 */
export function normalizeSessionLedger(input: unknown): SessionLedger {
  if (!input || typeof input !== 'object') return createSessionLedger();
  const raw = input as Partial<SessionLedger>;
  return {
    version: 1,
    asked: Array.isArray(raw.asked) ? raw.asked : [],
    done: Array.isArray(raw.done) ? raw.done : [],
    plans: Array.isArray(raw.plans) ? raw.plans : [],
  };
}

// ── 记账（全部返回新账本，不改写入参——快照管线拿旧引用做 diff 前提） ──

export function recordAsked(
  ledger: SessionLedger,
  entry: { ts: number; question: string; source: AskedEntry['source'] },
): SessionLedger {
  const fingerprint = questionFingerprint(entry.question);
  // 同一指纹重复提问（用户改了两个字的同一件事）：覆盖成一条，答案回收才
  // 不会落进僵尸条目。
  const asked = ledger.asked.filter((a) => a.fingerprint !== fingerprint);
  asked.push({ ts: entry.ts, fingerprint, question: entry.question, source: entry.source, settled: false });
  return { ...ledger, asked };
}

export function recordAnswer(
  ledger: SessionLedger,
  fingerprint: string,
  answer: string,
  answeredAt: number,
): SessionLedger {
  let touched = false;
  const asked = ledger.asked.map((a) => {
    if (a.fingerprint !== fingerprint || a.settled) return a;
    touched = true;
    return { ...a, answer, answeredAt, settled: true };
  });
  return touched ? { ...ledger, asked } : ledger;
}

export function recordDone(
  ledger: SessionLedger,
  entry: { ts: number; intent: string; args: string; ok: boolean; summary: string },
): SessionLedger {
  const fingerprint = actionFingerprint(entry.intent, entry.args);
  const done = ledger.done.filter((d) => d.fingerprint !== fingerprint);
  done.push({ ts: entry.ts, fingerprint, intent: entry.intent, ok: entry.ok, summary: entry.summary });
  return { ...ledger, done };
}

export function recordPlan(
  ledger: SessionLedger,
  entry: { ts: number; planText: string; planSeq: number; reason: string },
): SessionLedger {
  const fingerprint = fnv1a64([entry.planText.trim()]);
  return {
    ...ledger,
    plans: [...ledger.plans, { ts: entry.ts, fingerprint, planSeq: entry.planSeq, reason: entry.reason, replaced: false }],
  };
}

/** 细化不重开：同 planSeq 的历史条目标记 replaced（编号沿用，状态链留痕）。 */
export function markPlanReplaced(ledger: SessionLedger, planSeq: number): SessionLedger {
  let touched = false;
  const plans = ledger.plans.map((p) => {
    if (p.planSeq !== planSeq || p.replaced) return p;
    touched = true;
    return { ...p, replaced: true };
  });
  return touched ? { ...ledger, plans } : ledger;
}

// ── 查询（命中判定在协议层只「提示 + 确认」，数据核只给事实） ──

export function lookupAsked(ledger: SessionLedger, question: string): AskedEntry | undefined {
  const fingerprint = questionFingerprint(question);
  return ledger.asked.find((a) => a.fingerprint === fingerprint && a.settled);
}

export function lookupDone(ledger: SessionLedger, intent: string, args: string): DoneEntry | undefined {
  const fingerprint = actionFingerprint(intent, args);
  return ledger.done.find((d) => d.fingerprint === fingerprint);
}

// ── 注入素材（对齐 formatTaskScriptFacts 的「素材非稿子」原则） ──

const ASKED_MAX = 8;
const DONE_MAX = 10;
const PLANS_MAX = 6;
const QUESTION_EXCERPT = 100;
const ANSWER_EXCERPT = 160;
const SUMMARY_EXCERPT = 120;

function excerpt(text: string, cap: number): string {
  const flat = text.replace(/\s+/gu, ' ').trim();
  return flat.length <= cap ? flat : `${flat.slice(0, cap - 1)}…`;
}

/**
 * 把三本账排成一段**给模型看的素材**（user-turn context，不是对话流）：问过
 * 什么、答了什么、做过什么、计划怎么演化的——只排事实清单，不是替模型写好的
 * 决定。怎么用（复用并告知 / 按你刚才说的）由 LEDGER_PROTOCOL 教，这里不替它
 * 说。空账返回空串：宁可不给素材，也不给一份空清单占提示词。
 */
export function formatSessionLedgerFacts(ledger: SessionLedger | null | undefined): string {
  if (!ledger) return '';
  const lines: string[] = [];

  const answered = ledger.asked.filter((a) => a.settled).slice(-ASKED_MAX);
  for (const a of answered) {
    lines.push(`问答｜问：${excerpt(a.question, QUESTION_EXCERPT)}｜答：${excerpt(a.answer ?? '', ANSWER_EXCERPT)}`);
  }

  const done = ledger.done.slice(-DONE_MAX);
  for (const d of done) {
    lines.push(`已做｜${d.intent}${d.ok ? '' : '（未成功）'}｜${excerpt(d.summary, SUMMARY_EXCERPT)}`);
  }

  // 只留最近几个计划版本：长会话反复重开计划时，老版本的「被取代」留痕对
  // 当下决策的边际价值趋零，不能让它缓慢吃掉注入预算。
  const plans = ledger.plans.slice(-PLANS_MAX);
  for (const p of plans) {
    lines.push(`计划｜第 ${p.planSeq} 版${p.replaced ? '（已被细化取代）' : ''}｜起因：${excerpt(p.reason, QUESTION_EXCERPT)}`);
  }

  if (lines.length === 0) return '';
  return [
    '<session_ledger_facts>',
    '以下是宿主按真实交互记下的会话账：这些问题用户真答过，这些动作真做过，这些计划真立过。它只是素材——复用前仍可与用户确认；它没记到的事按你实际知道的讲，不要因为清单里没写就当作没发生。',
    ...lines,
    '</session_ledger_facts>',
  ].join('\n');
}
