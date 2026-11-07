// src/shared/network/ledger.ts
// P0a 账本：Attempt 样本的入账与读侧。存储=P0 临时态（localStorage + CLI fs
// 同 schema 双落点，蓝图 §2.1 明写「GUI localStorage 只作 P0 临时态」）；
// 终态=WebCache 形态共盘单文件，P0b 接线时随 Rust 回传通道一并落。
//
// 写入纪律（蓝图 §2.1）：单写者——本模块是进程内唯一写入点，写即整表原子
// 替换；跨进程 last-writer-walls + 字段级合并（deadUntil 取 max，防旧快照
// 复活死路）在共盘终态落地时由存储层承担，本层先把合并语义做成纯函数钉住。
//
// cache 不产 Attempt（不变量 2）：recordAttempt 不做运行时拦截（调用方是
// P0b 的出口代码，接线评审把 cache 命中挡在 plan 层），但读侧的 argmax 消费
// 永远不会看到 'cache' 的 Stat——本模块对 cache transport 的样本直接拒绝，
// 把不变量做成机械约束而不是注释。

import type { Attempt, AttemptFailure, DestClass, Destination, LedgerData, Stat, TransportId } from './types';
import { nextEwma } from './types';

export const NET_LEDGER_STORE_KEY = 'pure.netLedger.v1';

/** 证据保质期：与 netRoute 学习表同量级（30 分钟）。样本过期的行在读侧
 *  丢弃；deadUntil 不受它管（独立字段）。 */
export const LEDGER_ENTRY_TTL_MS = 30 * 60_000;

const CLASS_KEYS: readonly DestClass[] = [
  'llm-api', 'search-cn', 'search-intl', 'public-api-cn', 'public-api-intl',
  'pkg-registry', 'vcs', 'asset', 'web-page', 'mcp-remote', 'tile',
];

function emptyLedger(): LedgerData {
  return { host: {}, class: {} };
}

function isTransportId(v: string): v is TransportId {
  return v === 'direct' || v === 'env-proxy' || v === 'app-proxy' || v === 'reader' || v.startsWith('mirror:');
}

function sanitizeStat(raw: unknown): Stat | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.n !== 'number' || r.n <= 0 || typeof r.ok !== 'number') return null;
  return {
    n: r.n,
    ok: r.ok,
    ...(typeof r.headersEwma === 'number' && r.headersEwma >= 0 ? { headersEwma: r.headersEwma } : {}),
    ...(typeof r.deadUntil === 'number' ? { deadUntil: r.deadUntil } : {}),
    ...(typeof r.lastOkAt === 'number' ? { lastOkAt: r.lastOkAt } : {}),
  };
}

function sanitizeLedger(raw: unknown): LedgerData {
  const out = emptyLedger();
  if (typeof raw !== 'object' || raw === null) return out;
  const r = raw as Record<string, unknown>;
  if (typeof r.host === 'object' && r.host !== null) {
    for (const [host, transports] of Object.entries(r.host as Record<string, unknown>)) {
      if (typeof transports !== 'object' || transports === null) continue;
      for (const [t, stat] of Object.entries(transports as Record<string, unknown>)) {
        if (!isTransportId(t)) continue;
        const s = sanitizeStat(stat);
        if (s) (out.host[host] ??= {})[t] = s;
      }
    }
  }
  if (typeof r.class === 'object' && r.class !== null) {
    for (const [cls, transports] of Object.entries(r.class as Record<string, unknown>)) {
      if (!CLASS_KEYS.includes(cls as DestClass)) continue;
      if (typeof transports !== 'object' || transports === null) continue;
      for (const [t, stat] of Object.entries(transports as Record<string, unknown>)) {
        if (!isTransportId(t)) continue;
        const s = sanitizeStat(stat);
        if (s) (out.class[cls as DestClass] ??= {})[t] = s;
      }
    }
  }
  return out;
}

// ── 单写者：进程内唯一的内存表 + 原子替换落盘 ────────────────────────────

let ledger: LedgerData | null = null;
// 测试清场标志：resetNetLedgerForTests 之后关死 localStorage 重灌通道。
// flaky-quartet 同款判例（netRoute 学习表先踩过）：removeItem 的可靠性不
// 敢赌——bun test 单进程跨文件共享 localStorage，更早文件的残留账本会在
// 下一用例 ensureLedger 时整表灌回（CI 实证：class 层收到 15，host 层
// 是干净的 1——灌回只富集 class 桶，host 键是全新的）。reset 改置空账
// + 关闸，重灌只剩一条路：显式 reload 入口。
let skipStorageReload = false;

function ensureLedger(): LedgerData {
  if (ledger) return ledger;
  ledger = emptyLedger();
  if (!skipStorageReload) {
    try {
      if (typeof localStorage !== 'undefined') {
        const raw = localStorage.getItem(NET_LEDGER_STORE_KEY);
        if (raw) ledger = sanitizeLedger(JSON.parse(raw));
      }
    } catch {
      ledger = emptyLedger(); // 存档损坏——从空账本开始
    }
  }
  return ledger!;
}

function persistLedger(data: LedgerData): void {
  try {
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem(NET_LEDGER_STORE_KEY, JSON.stringify(data));
    }
  } catch {
    // 存储不可用——内存账本照常工作
  }
}

/** cache 永不入账（不变量 2 的机械形态）：命中是 plan 前置检查，不是证据。 */
export function recordAttempt(dest: Destination, attempt: Attempt, now = Date.now()): void {
  if (attempt.transport === 'cache') return;
  if (typeof attempt.ms !== 'number' || attempt.ms < 0 || Number.isNaN(attempt.ms)) return;
  const data = ensureLedger();
  const bucket = dest.class === 'local' ? undefined : dest.key ? data.host[dest.key] ??= {} : undefined;
  const classBucket = dest.class === 'local' ? undefined : data.class[dest.class] ??= {};
  const apply = (m: Partial<Record<TransportId, Stat>> | undefined): void => {
    if (!m) return;
    const prev = m[attempt.transport];
    const headersLike = attempt.msScope !== 'total';
    m[attempt.transport] = {
      n: (prev?.n ?? 0) + 1,
      ok: (prev?.ok ?? 0) + (attempt.ok ? 1 : 0),
      // ewma 只吃成功样本（失败的 ms 不代表路的快慢）且只吃 headers 口径
      // （total 口径含 body 传输，混入会把 headers EWMA 拉高）。
      ...(attempt.ok && headersLike
        ? { headersEwma: nextEwma(prev?.headersEwma, attempt.ms) }
        : prev?.headersEwma !== undefined ? { headersEwma: prev.headersEwma } : {}),
      ...(prev?.deadUntil !== undefined ? { deadUntil: prev.deadUntil } : {}),
      ...(attempt.ok ? { lastOkAt: now } : prev?.lastOkAt !== undefined ? { lastOkAt: prev.lastOkAt } : {}),
      // 失败样本随行留痕（诊断观测面，不参与选路）。Attempt 契约里一直有
      // status/failure 字段，但 apply 构造 Stat 时从来没写过——「404 入账
      // 带 status」在账本层落空（GUI 真机三案例实证）。
      ...(attempt.ok ? {} : attempt.status !== undefined ? { lastStatus: attempt.status } : {}),
      ...(attempt.ok ? {} : attempt.failure ? { lastFailure: attempt.failure } : {}),
    };
  };
  apply(bucket);
  apply(classBucket);
  persistLedger(data);
}

/** 读侧：该 host × transport 的活样本（TTL 内）。class 层冷启动读。 */
export function hostStat(data: LedgerData, key: string, transport: TransportId, now = Date.now()): Stat | undefined {
  const s = data.host[key]?.[transport];
  if (!s) return undefined;
  if (s.lastOkAt !== undefined ? now - s.lastOkAt > LEDGER_ENTRY_TTL_MS : true) {
    // 只有成功样本能续命；从未成功的行（纯失败样本）当场视为无效。
    return undefined;
  }
  return s;
}

/** 类层读侧：冷启动（host 无样本）时该类的统计。 */
export function classStat(data: LedgerData, cls: DestClass, transport: TransportId, now = Date.now()): Stat | undefined {
  if (cls === 'local') return undefined;
  const s = data.class[cls]?.[transport];
  if (!s) return undefined;
  if (s.lastOkAt !== undefined ? now - s.lastOkAt > LEDGER_ENTRY_TTL_MS : true) return undefined;
  return s;
}

/** 跨进程字段级合并（共盘终态的合并语义，先做成纯函数钉住）：
 *  last-writer-wins 逐字段，唯独 deadUntil 取 max——旧快照里较晚的死期
 *  必须压过新快照里已过期的死期，否则旧快照复活死路（flaky-quartet 同族
 *  判例：旧账灌回把决策翻面）。 */
export function mergeStat(local: Stat | undefined, remote: Stat | undefined): Stat | undefined {
  if (!local) return remote;
  if (!remote) return local;
  return {
    n: Math.max(local.n, remote.n),
    ok: Math.max(local.ok, remote.ok),
    headersEwma: remote.headersEwma ?? local.headersEwma,
    deadUntil: (() => {
      const a = local.deadUntil ?? 0;
      const b = remote.deadUntil ?? 0;
      return Math.max(a, b) > 0 ? Math.max(a, b) : undefined;
    })(),
    lastOkAt: Math.max(local.lastOkAt ?? 0, remote.lastOkAt ?? 0) || undefined,
    // last-writer-wins 同族：远程快照带失败痕迹就用远程的，否则保留本地。
    lastStatus: remote.lastStatus ?? local.lastStatus,
    lastFailure: remote.lastFailure ?? local.lastFailure,
  };
}

/** 失败族从 netGuard 文案分类到 Attempt.failure 的映射表（P0b 接入时的
 *  唯一翻译点；现在只钉映射本身，文案分类留在 netRoute）。 */
export function failureFromNetGuardClass(cls: string): AttemptFailure | undefined {
  switch (cls) {
    case 'dns': return 'dns';
    case 'timeout': return 'tcp';
    case 'tls': return 'tls';
    case 'hijack': return 'hijack';
    case 'auth': return 'policy';
    case 'schema': return 'policy';
    case 'context': return undefined; // 对话超窗不是路的错
    default: return 'http';
  }
}

/** 测试与跨面清场用（进程级单例，flaky-quartet 判例）。置空账 + 关死
 *  localStorage 重灌通道——removeItem 不可靠（CI 二平台实证），残留账本
 *  曾在下一用例 ensureLedger 时整表灌回。 */
export function resetNetLedgerForTests(): void {
  ledger = emptyLedger();
  skipStorageReload = true;
  try {
    if (typeof localStorage !== 'undefined') localStorage.removeItem(NET_LEDGER_STORE_KEY);
  } catch {
    // 内存清空 + 关闸即已足够
  }
}

/** 读侧取整账本快照（诊断/消费面用）。 */
export function ledgerSnapshot(): LedgerData {
  return ensureLedger();
}

export type { Attempt, AttemptFailure, DestClass, Destination, LedgerData, Stat, TransportId };
