// src/shared/network/types.ts
// 网络层蓝图（docs/network-layer-design-2026-11.md §2.1）的契约定稿——P0a
// 第一刀：类型即合同。三个抽象（Destination / Attempt / Ledger）+ 决策口的
// 最小形状。本文件只定形状与不变量，零行为面：现役选路（netRoute.ts）在
// P1 证据化之前保持原样，ledger 由 P0b 的接入刀逐出口喂样本。
// 不变量（蓝图 §2.4，架构测试守）：
// 1. Destination 不含任何代理概念——出口声明选路，目标只声明自己。
// 2. cache 不产 Attempt：命中是 plan 前置检查，亚毫秒"成功"入账会把
//    EWMA 拉向 0，argmax 永远选 cache 直到 TTL。
// 3. 每个 Attempt 必须带 ms；没有 ms 的成功不算证据。
// 4. warm 采样与真实业务请求是两种分布——warmPrior 独立字段（现住
//    netRoute 存档的 warm: 行，P0b 接线时迁入 ledger），绝不混入 ewma。

/** 目标类。class 是冷启动与跨站迁移的证据作用域（P1 名单降 prior 的地基）。 */
export type DestClass =
  | 'local' // 环回/私网：类型层不变量，不进证据系统，plan 硬返回 direct-only
  | 'llm-api'
  | 'search-cn'
  | 'search-intl'
  | 'public-api-cn'
  | 'public-api-intl'
  | 'pkg-registry'
  | 'vcs'
  | 'asset'
  | 'web-page'
  | 'mcp-remote'
  | 'tile';

/** 出口声明的东西：目标不含代理概念。 */
export interface Destination {
  /** host（或后端组的稳定 key）。 */
  key: string;
  class: DestClass;
  /** GET/HEAD。非幂等请求的出口预算单发（cliFetch 现役语义）。 */
  idempotent: boolean;
  /**
   * 可重放 = 失败发生在不可逆副作用（计费/写入/发送）之前，换 transport
   * 重发安全。LLM 是 POST（非幂等）但 replayable=true——流还没吐给用户前
   * 失败，换路重发无副作用。shell / MCP = false（副作用在子进程，失败可能
   * 已发生）。
   */
  replayable: boolean;
  /** 允许字节等价改写（GitHub / pkg / raw 的镜像面）。 */
  mirrorable: boolean;
  expect: 'html' | 'json' | 'bytes' | 'stream';
}

export type TransportId = 'direct' | 'env-proxy' | 'app-proxy' | `mirror:${string}` | 'reader' | 'cache';

/** 失败族。与 netGuard.classifyFailure 的文案分类是两个面：Attempt 带的是
 *  执行器亲见的失败族（P0b 接入后逐渐取代「从错误文案猜分类」）。 */
export type AttemptFailure = 'dns' | 'tcp' | 'tls' | 'http' | 'hijack' | 'policy' | 'abort';

/** 执行器的唯一回报形态。 */
export interface Attempt {
  transport: TransportId;
  ok: boolean;
  /**
   * LLM/流式出口 = 到响应头（Rust 在流前测，headersMs 同口径）；
   * 工具出口（fetch_page 等读完整 body 才返回）= 总耗时，msScope 标注口径。
   */
  ms: number;
  msScope?: 'headers' | 'total';
  failure?: AttemptFailure;
  status?: number;
}

/** 单路统计：n 是置信度，ewma 只吃真实业务请求样本（α=0.3）。 */
export interface Stat {
  n: number;
  ok: number;
  headersEwma?: number;
  /** 独立于证据 TTL（蓝图 §2.1：deadUntil 解耦在 P1 兑现，字段先立）。 */
  deadUntil?: number;
  lastOkAt?: number;
  /** 最近一次失败的 HTTP 状态码与失败族——纯诊断观测面（「404 入账带
   *  status」），不参与选路：读侧仍只认成功样本续命，失败行照旧无效。 */
  lastStatus?: number;
  lastFailure?: AttemptFailure;
}

/** 双层作用域账本：host 用于同站复用，class 用于冷启动与跨站迁移。 */
export interface LedgerData {
  host: Record<string, Partial<Record<TransportId, Stat>>>;
  class: Partial<Record<DestClass, Partial<Record<TransportId, Stat>>>>;
  /**
   * warm 双路采样单独入字段，只作冷启动 prior 供体，绝不混入 headersEwma
   * （warm 测的是 base_url 根路径 GET，与真实 POST 是两种分布）。现役
   * warm: 行住 netRoute 存档（P0 前移刀已上真机），P0b 接线时迁入本字段。
   */
  warmPrior?: {
    direct?: { ok: boolean; ms: number; at: number };
    proxy?: { ok: boolean; ms: number; at: number };
  };
}

/** EWMA 更新（α=0.3，蓝图定值）。首样本直接定值。 */
export function nextEwma(prev: number | undefined, ms: number, alpha = 0.3): number {
  return prev === undefined ? ms : prev * (1 - alpha) + ms * alpha;
}
