# 网络层设计：单一网络端口 + 代理资源（2026-11）

> 状态：**设计稿，未开工**（2026-11-04 定稿并拍板）。本文档是实现的目标基线；文档与代码冲突时以代码为准。
> 基线取证：`v4.1.4`（`179f5c1`，2026-11-05 复核刷新；行号以该版本为准，改动落盘后可能漂移）。原取证（`27d8727`）中两条证据已被 P2-5 三刀消化——Rust 搜索扇出与后端冷却随单源化退役，问题本体迁至 TS 单源接线（见附录 A 标注）。上游：[network-intelligence-2026-10.md](network-intelligence-2026-10.md)（期 1–3 已落、期 4 余主体）、[two-legs-plan-2026-11.md](two-legs-plan-2026-11.md)（D1=A：TS 单执行器）。
> 与上游的关系：L1/L2/L3 三层划分沿用，不推翻路由脑。本文修正其中一条**未落地**的口径——"`HOST_CLASS_RULES` 的 proxy-first 改为按实测健康度与时延决定"——并把"代理"从策略层剥离到资源层。

---

## 〇、定调与口径修正

用户定调（2026-11-04，原文）：

1. 代理层是 pure 的一个工具，pure 可以根据情况操作它。
2. 代理层的目的是帮助 pure 打通网络；这个能力对人不重要，**用不用、什么时候用**都是智能决策。
3. 这一层要干净、独立、单一职责。

三处需要精确化的地方（本文一律按修正后的口径施工）：

| 原表述 | 精确口径 | 为什么 |
|---|---|---|
| 代理层是工具 | 代理是**出口资源（transport）**，只提供"能否到达 / 多快 / 是否死期"三个事实 | 工具可被调不调用；资源不替调用方做决定 |
| 用不用由代理层智能决策 | 智能属于**路由策略层**，按目标类 + 实测证据排序 | 让代理自己决定"该不该用我"，就是现在 44 条静态名单的病根 |
| 人不用关注 | **静默 + 可回放**：过程零打扰，每次请求留一条结构化决策记录 | 不关注 ≠ 不可解释；否则失败时只能踢皮球 |

一句话目标态：

> 每个出口只声明「访问谁、能不能重放」；`NetworkPort` 给出尝试计划；代理是计划里的一个 transport；所有真实结局回流到一本证据账本。

---

## 一、判定：现在的病不是"实现不好"，是职责放错了

| # | 本质问题 | 证据 |
|---|---|---|
| 1 | **策略被写进了资源层**：44 条静态 host 名单决定首选，代理健康只能"翻面"；时延证据只覆盖 LLM | `netRoute.ts:80`（名单）、`:369`（代理死→proxy-first 全局翻直连）、`:485`（快慢比较需双路样本） |
| 2 | **决策粒度错了**：`web_search` / `web_public_api` / `command` / `mcp` 按"出口面"一个 bit 决定整体路径，而它们内部国内外混排 | `netRoute.ts:212`、`TauriToolAdapter.ts:1027`（web_search 已单源化入 TS，但 `makeIpcFetchPage(proxyUrl)` 仍把同一个代理绑死喂所有后端） |
| 3 | **执行三份、证据只回一份**：Rust 回 `headers_ms`，GUI/CLI 工具从不产生时延样本 | `chat.ts:1318`、`RustLLMAdapter.ts:194` vs `TauriToolAdapter.ts:930`、`NodeToolAdapter.ts:2290`（只传 route/ok） |
| 4 | **物理路径三种、标签两种**：`direct` 可能是应用直连、env 代理或系统代理；学习表记成一种 | `lib.rs:184` `finalize_http_client`、`:223` 注释（reqwest 默认继承 env proxy）；CLI 侧 `cliFetch.ts:104` 只认 env |
| 5 | **四套状态机互不通气**：host 熔断 + 24h 劝退、路线死期、代理健康行、搜索后端冷却（Rust 冷却已退役，TS 单源冷却接位） | `netGuard.ts:497/515`、`netRoute.ts` `deadUntil`、`proxyProbe.ts:41`、`tools/impl/webSearch.ts:121` |

附带的次级问题（本期一并消掉）：

- 代理健康是**全局一行**，探测目标写死 `gstatic.com/generate_204`、3s 超时（`lib.rs:467`）——一个域名/一次超时决定全表走向，而设置页测试用的是另一组 probe（`proxy.ts` `DEFAULT_PROXY_PROBES`）。
- 死路退避上限 4 小时，但学习表 30 分钟 TTL 会把整行（连同 `deadUntil`）丢掉（`netRoute.ts:492` 的过期分支）。
- `proxy.llmEnabled` / `toolsEnabled` 已是死字段，但仍在 live settings 简报里打印（`proxy.ts:32-33`、`TauriToolAdapter.ts:2199`）。
- `diagnose_network` 自成一套决策：GUI 强制把 `this.proxyUrl` 传给探测（`TauriToolAdapter.ts:643`），结论不回写学习表。
- CLI 的"直连兜底"是假的：`cliFetch` 用"不传 proxy 选项"表达直连（`cliFetch.ts:165`），Bun 仍读 `HTTPS_PROXY`；非幂等请求只走一次代理（`:169-172`）。
- 劫持判定两份实现（`netGuard.ts` / `lib.rs:8328`），已升级为跨语言双锁（数据锁比对 Rust 源码表 + 行为锁两侧同 fixtures），但两份实现本体仍在。

---

## 二、目标架构

```
   出口适配层（LLM / web_fetch / search / public_api / download / shell / MCP / tiles / update）
        │  只声明 Destination：访问谁、能否重放、能否改写
        ▼
   ┌──────────┐  plan(dest)   ┌───────────────┐
   │NetworkPort│ ───────────▶ │ RoutePlanner   │  纯函数，无 IO
   │ 唯一入口  │ ◀─────────── │ (策略)         │
   └────┬─────┘  Attempt[]    └──────▲────────┘
        │                            │ prior + evidence
        ▼                            │
   ┌──────────┐  outcomes     ┌──────┴────────┐
   │ Executors │ ────────────▶ │ EvidenceLedger │  host × transport / class × transport
   │ Rust / TS │               └──────▲────────┘
   └────┬─────┘                      │ healthFor(destClass)
        │ uses                       │
        ▼                     ┌──────┴────────┐
   ┌──────────────┐           │ Mirror / Reader / Cache │ 其它 transport
   │ ProxyResource │           └────────────────────────┘
   │ 配置/认证/健康 │
   └──────────────┘
```

### 2.1 三个不可再少的抽象

**Destination**（出口声明的东西，不含任何代理概念）：

```ts
// 草案，命名待实现时定稿
type DestClass =
  | 'llm-api' | 'search-cn' | 'search-intl' | 'public-api-cn' | 'public-api-intl'
  | 'pkg-registry' | 'vcs' | 'asset' | 'web-page' | 'mcp-remote' | 'tile';

interface Destination {
  key: string;            // host（或后端组的稳定 key）
  class: DestClass;
  idempotent: boolean;    // GET/HEAD
  replayable: boolean;    // 允许换 transport 重放（shell / MCP = false）
  mirrorable: boolean;    // 允许字节等价改写（GitHub / pkg / raw）
  expect: 'html' | 'json' | 'bytes' | 'stream';
}
```

**Attempt**（执行器的唯一回报形态，取代"从错误文案猜分类"）：

```ts
type TransportId = 'direct' | 'env-proxy' | 'app-proxy' | `mirror:${string}` | 'reader' | 'cache';

interface Attempt {
  transport: TransportId;
  ok: boolean;
  ms: number;  // 到响应头（不含 body）
  failure?: 'dns' | 'tcp' | 'tls' | 'http' | 'hijack' | 'policy' | 'abort';
  status?: number;
}
```

**Evidence**（双层作用域：host 用于同站复用，class 用于冷启动与跨站迁移）：

```ts
interface Stat {
  n: number;              // 样本数 = 置信度
  ok: number;
  headersEwma?: number;   // α=0.3
  deadUntil?: number;     // 独立于证据 TTL
  lastOkAt?: number;
}
interface Ledger {
  host:  Record<string, Partial<Record<TransportId, Stat>>>;
  class: Record<DestClass, Partial<Record<TransportId, Stat>>>;
}
```

### 2.2 代理层：只回答三个事实

```ts
interface ProxyResource {
  id: string;  // 稳定 id：'system' | `manual:${scheme}://${host}:${port}`（不含凭证）
  healthFor(destClass: DestClass): {
    score: number; headersEwma?: number; deadUntil?: number; samples: number;
  };
  probe(destClass?: DestClass): Promise<Attempt>;  // 证据不足或死期临近才调用
}
```

**禁止事项（写进类型与评审清单）**：

- 不判断"某个 host 该不该走代理"；
- 不维护域名名单；
- 不做镜像改写、不决定重试次数；
- 不感知具体工具（不知道 web_search 还是 LLM 在用它）。

凭证只在 Rust：TS 只产出 `ProxyConfig`（结构化，不再是 `system://` 哨兵），Rust 解析为可执行 URL 并注入密码；执行器回报的 `transport` 用 `id` 表示，账本不落凭证。

### 2.3 网络端口

```ts
interface NetworkPort {
  plan(dest: Destination): EgressPlan;
  execute<T>(dest: Destination, plan: EgressPlan, run: (t: TransportId) => Promise<T>):
    Promise<{ value: T; attempts: Attempt[] }>;
  diagnose(target: string): Promise<NetProbeReport>;   // 走真实 plan，结论回写账本
  status(): NetworkStatus;                              // 只读快照（模型/设置页共用）
  prefer(destClass: DestClass, transport: TransportId, ttlMs?: number): void;
}
```

`execute` 对 LLM 特化为"单发 + 失败换路"（不做请求级双发，避免双倍 token），其余出口按 `budget` 循环。

### 2.4 不变量（架构测试要守住）

1. 出口不得直接 `fetch` / `new Client` / 拼代理 URL —— 必须经 `NetworkPort`。
2. 代理层不得 import 任何 host 规则表。
3. 账本只写结构化 `Attempt`，不写错误文案。
4. 每个 attempt 必须带 `ms`；没有 `ms` 的成功不算证据。
5. 非幂等请求默认无 fallback（唯一例外：先做连接层探活再发唯一一次）。

---

## 三、决策算法

```
plan(dest, ledger, proxies):
  candidates  = direct
              + (env proxy 存在 ? env-proxy : ∅)
              + (app proxy 存在 ? app-proxy : ∅)
              + (dest.mirrorable ? mirror:* : ∅)
              + (dest.expect in {html} ? reader : ∅)
              + (dest.expect in {bytes, html} ? cache : ∅)

  score(t) = evidence[dst.class][t] ?? prior[dst.class][t]        // 名单只作 prior，n=0
           = -∞  if deadUntil 未过期                                   // 唯一候选时降级为最低分而非直接淘汰

  if !dest.replayable:
      t = argmax(score) 且 n ≥ N_MIN
      if n < N_MIN: 先对目标 host 做连接层探活（TCP/TLS，不发业务请求），再发唯一一次
      return { primary: t, fallback: [], budget: 1 }

  primary  = argmax(score)
  fallback = 次优且 score 高于阈值（默认 1 个；全死则空）
  return { primary, fallback, budget: 2 }
```

与现状的差异（每一条都要有回归用例）：

| 现状 | 目标 | 理由 |
|---|---|---|
| 首选由静态名单决定 | 名单降级为 prior，`n` 上来后被证据覆盖 | 保留领域经验，但不让名单永久压过实测 |
| `首选 → 反向 → 首选重试` 三步 | 默认 2 步；退避重试只给"幂等 + 5xx/429" | 第三步对同一路径原样重发，成本高收益低 |
| 失败是否换路由错误文案正则判断 | 执行器返回 `failure` 枚举 | 文案是隐式契约，改一个词就静默失效 |
| 代理健康是一个布尔（全局） | `healthFor(destClass)` 矩阵 | 同一个代理对国内/境外目标的可达性不同 |
| 死期与 30 分钟 TTL 共用 | 证据与死期分离 | 现在 4 小时退避在 30 分钟处被整行丢弃 |
| 工具侧无时延 | 每个 `Attempt` 带 `ms` 入库 | "谁快用谁"在工具侧才有可能发生 |
| 非幂等请求配了代理就只走代理 | 证据最强路 + 连接层探活兜底 | "只走代理"把代理变成了单点故障 |

**LLM 的额外优化**：`warm_llm_routes` 已经每 30s 同时打两条路（`lib.rs:534`），只缺把耗时留下。改为双路采样入库，作为冷启动先验；若两条都通且差距超过阈值（快 1 倍以上且省 ≥500ms），按证据翻转。不做业务请求双发。

---

## 四、出口接入矩阵

| 出口 | 现状 | 目标 | 期 |
|---|---|---|---|
| LLM 主对话 | TS 算 pair，Rust 内部 failover，只回一跳 `headers_ms` | TS 出 plan；Rust 按**每一跳**回报 `Attempt[]`；Rust 不再有 `route_of` 之外的判断 | P0 |
| web_fetch / web_scrape | 已走 `runRouted`，无时延样本 | 接 `NetworkPort`，`Attempt.ms` 入库 | P0 |
| web_search | 一个代理喂所有后端 | 按后端拆 `search-cn` / `search-intl`，同一次搜索可"国内直连 + 海外代理" | P1 |
| web_public_api | 同上 | 按数据提供方分 class | P1 |
| download | 镜像链与路由脑各排各的序 | 镜像作为 transport 参与 plan；删独立优先级链 | P1 |
| shell | 配了代理就无条件注入 env，`NO_PROXY` 只有 loopback（`lib.rs:3598`） | **默认不注入**；只有显式 egress 意图或证据要求才注入；注入时 `NO_PROXY` = 用户值 + 国内域表 | P0 过渡 / P2 评估 sidecar |
| MCP | 同 shell，且无兜底（`mcp.rs:63`） | 同上；远端 HTTP 走 `NetworkPort`，stdio 走环境声明 | P0 过渡 / P2 |
| 瓦片 / 更新 / skill hub | 各自直传 proxyUrl | 接 `NetworkPort` | P1 |
| diagnose_network | 独立决策路径，强制当前代理，不回写 | 变成端口的只读视图：探测真实 plan 的每条 transport，结论入库 | P1 |

### 4.1 shell / MCP 的两步走（已拍板）

- **第一步（P0）**：默认不注入。需要网络能力的命令由调用方/模型声明 `egress` 意图（或证据表明该目标类必须代理）；注入时 `NO_PROXY` 合并用户配置与国内域表，避免 `npm install` / `pip` / `git clone`（国内源）被代理绕路。
- **第二步（P2 评估）**：localhost egress sidecar（`127.0.0.1` + 随机 token + 仅 CONNECT）。所有无法改造的出口（git/npm/pip/MCP server/用户脚本）只需一个固定地址，路由集中在 pure 内部。**先不实现**，用 P1 的真实判例决定是否值得。

---

## 五、智能体控制面

默认零调用、全自动。只给四类低压接口，均不涉及改配置：

| 接口 | 语义 | 备注 |
|---|---|---|
| `net.status` | 只读：代理健康、各 class 偏好、最近失败原因 | 也可并入 `sys_info` |
| `net.diagnose(target)` | 已有 `diagnose_network`，改走真实 plan | 报告带"探测的是哪条路" |
| `net.prefer(destClass, transport, ttl)` | 会话内偏好，可过期、可撤销 | 让模型"操作工具"的最小表达 |
| 请求级 `egress: 'auto' \| 'direct' \| 'proxy'` | 单次意图，只出现在工具参数 | `download_file` 已有 `proxy` 参数的雏形 |

**禁止**：模型选择代理节点、端口、认证；这些属于资源层，错了就是安全事故。

结果侧：工具返回值附一行紧凑的 `egress`（`servedBy` / `attempts` / `ms`），不打断对话；失败时才给"试过什么 + 每条真因"。

---

## 六、分期

| 期 | 交付物 | 删除项 | 判据 |
|---|---|---|---|
| **P0 收口** | `shared/network/`（port + plan + ledger 接口）；LLM / web_fetch / download / CLI 四处接入；`Attempt.ms` 全出口；CLI 读同一份 `ProxyConfig`；`system://` 改结构化 mode；shell 默认不注入 | `llmEnabled`/`toolsEnabled`；`direct` 标签二义性（Rust `.no_proxy()` 才算 direct）；CLI 假直连分支 | 未配代理时代理尝试次数 = 0；CLI 与 GUI 同配置同行为 |
| **P1 证据化** | 名单降级 prior；`healthFor(destClass)` 矩阵；warm 双路采样入库；死期/TTL 解耦；预算 3→2；search/api 按后端拆 class；诊断回写 | `SURFACE_CLASS` 一刀切；`proxyFallbackFor` 全局翻面；`netGuard` 的 24h"别尝试"文案 | 双通场景 20 次后快路命中 ≥80%；平均尝试 ≤1.2 |
| **P2 结构收敛** | 一个决策器（TS）+ 一个执行器契约（Rust 执行/回报）；`LedgerStore` 统一（GUI localStorage / CLI `~/.pure/net-ledger.json` 同 schema）；评估 sidecar | `netGuard` / `netRoute.deadUntil` / `backend_blocked` 三套重叠状态中的两套；两份劫持实现之一（执行器内共享 fixtures） | 任何出口不再持有自己的路由状态 |
| **P3 可选** | sidecar 接管 shell/MCP/第三方工具；连接层竞速 | `execute_command` / `mcp.rs` 的 env 注入分支 | 第三方工具零改造获得智能路由 |

顺序理由：**先统一证据 → 再统一执行 → 最后动结构**。反过来会变成大规模重写。

---

## 七、验收

### 7.1 指标

| 指标 | 目标 |
|---|---|
| 未配置代理时，代理尝试次数 | 0 |
| 代理已判死时，除恢复探测外的代理尝试 | 0 |
| 双通场景稳定命中快路 | ≥ 80%（同类目标 20 次请求后） |
| 平均每请求 transport 尝试数 | ≤ 1.2 |
| 代理误判率（判死但真实可用） | < 1%（真实请求回放校验） |
| 非幂等请求选错路率 | < 5%（不允许重放，只能一次选对） |
| 用户可见过程文案 | 0 条（除全路失败的一句真话） |
| 纯直连网络上的首字节 P50 | 相对现状劣化 ≤ 5% |

### 7.2 必测场景

| 场景 | 期望 |
|---|---|
| 家宽：墙站直连必超时、代理正常 | 第一次可慢；之后不撞直连；代理不被单一探测目标误判 |
| 公司：代理端口无监听、直连正常 | 所有出口零延迟跳过代理；设置页标"不可达"；对话无换路线文案 |
| 双通：同一目标直连 200ms / 代理 1.5s | 稳定走直连；反向同理 |
| 网关拦截：403 + 网关页 | 归 `policy`（不换路重试），一句真话 + 出路 |
| CLI 与 GUI 同一份配置 | 行为一致；env 有代理时 CLI 的直连兜底真的直连 |

---

## 八、已拍板决策（2026-11-04）

| # | 决策 | 理由 | 影响 |
|---|---|---|---|
| D1 | **决策器在 TS**（`shared/network/`，GUI/CLI 共用）；Rust 只执行 + 回报每跳 `Attempt` | 贴合 D1=A「TS 单执行器」；决策是纯函数，无需跨进程；账本需要持久化，TS 侧已有 localStorage，CLI 补文件 | Rust 侧删掉除 `route_of` 外的路由判断；LLM 仍是 Rust 流式，但不再自己决定"谁是首选" |
| D2 | **shell/MCP 先走"默认不注入 + NO_PROXY 域表"**，sidecar 留 P2 评估 | 小、稳、可回滚；sidecar 一旦出问题影响所有子进程 | P0 只改注入条件与 NO_PROXY，不改子进程执行方式 |
| D3 | **默认预算 2**，非幂等 1（+ 连接层探活） | 现有第三步是同路重发，成本高收益低 | `unblockAttemptsBeforeMirror` 的 4 步枚举退役 |
| D4 | **名单降级为 prior**，不删除 | 保留国内网络领域经验，同时允许证据覆盖 | `HOST_CLASS_RULES` 改名/改语义为 `PRIORS`，不再被当作硬规则 |
| D5 | **证据双层**：host × transport + class × transport | host 复用精度，class 解决冷启动与样本稀疏 | 账本 schema 需两层；迁移时从现有 host 条目推导 class 先验 |
| D6 | **账本存储**：GUI localStorage / CLI 文件，schema 同源，P2 再统一 | 不新增 Rust 写盘命令即可先落地 | CLI 首次拥有跨会话记忆 |
| D7 | **不做请求级双发**；只做连接层竞速 | LLM 双发 = 双倍 token | warm 双路只做连接层 |

---

## 九、明确不做 / 风险

不做：

1. 请求级双发（token 成本）。
2. 更大的域名名单（不可维护，且让"为什么走代理"更难解释）。
3. 让每个工具自己实现路由（现状病根）。
4. 让模型改代理配置（安全事故面）。
5. 在 P0/P1 实现 sidecar。

风险与对策：

| 风险 | 对策 |
|---|---|
| class 粒度太粗 → 退回 surface 一刀切；太细 → 样本稀疏 | 先按"地域 × 用途"给 8–10 个 class；用真实请求样本量监控，`n < N_MIN` 时回落到 host prior |
| 证据覆盖 prior 过快 → 换网络初期抖动 | `n` 阈值 + 30 分钟证据窗；换网检测（出口 IP/系统代理变化）时衰减证据 |
| 连接层探活对非幂等请求增加一次 RTT | 只在 `n < N_MIN` 时做；对已知稳定的目标直接发 |
| 迁移期新旧双轨 | 端口默认走旧实现，按出口 feature flag 切换；对照日志比对两套决策 |
| sidecar 安全边界 | 仅 loopback + 随机 token + 仅 CONNECT + 进程生命周期绑定；P2 单独设计评审 |
| 账本隐私 | 只存 host/class/transport/耗时；不存 path/query/header/凭证 |

---

## 附录 A：现状证据索引

| 事实 | 位置 |
|---|---|
| 44 条静态 host 名单 | `src/shared/netRoute.ts:80` |
| 出口面一刀切 | `src/shared/netRoute.ts:212` |
| 代理死 → proxy-first 全局翻直连 | `src/shared/netRoute.ts:369` |
| 快慢比较需双路样本 | `src/shared/netRoute.ts:485` |
| 选路与死期/TTL 共用 | `src/shared/netRoute.ts:492` |
| 首选 + 反向契约 | `src/shared/netRoute.ts:681` |
| 四步打通枚举（75% 预算） | `src/shared/netRoute.ts:716` |
| 代理健康探测（gstatic/3s） | `src-tauri/src/lib.rs:467` |
| 预热双路但只回布尔 | `src-tauri/src/lib.rs:534` |
| 劫持判定 Rust 侧（双锁已立，两份本体仍在） | `src-tauri/src/lib.rs:8328` |
| shell 注入 + NO_PROXY 仅 loopback | `src-tauri/src/lib.rs:3598`、`:3942` |
| MCP 注入 | `src-tauri/src/mcp.rs:63` |
| 搜索扇出共用一个代理（Rust 扇出已退役，单代理绑定迁至 TS 接线） | `src/ui/TauriToolAdapter.ts:1027` |
| 搜索后端冷却（Rust 冷却已退役，TS 单源 per-backend 冷却接位） | `src/tools/impl/webSearch.ts:121` |
| LLM 每跳 route/headers | `src-tauri/src/lib.rs:12207-12247`、`:12618` |
| 工具侧学习不传时延 | `src/ui/TauriToolAdapter.ts:930`、`src/adapter/node/NodeToolAdapter.ts:2290` |
| LLM 学习带时延 | `src/ui/chat.ts:1318` |
| 24h 熔断历史进 planner brief | `src/shared/netGuard.ts:515`、`src/ui/chat.ts:693` |
| CLI 只认 env | `src/shared/cliFetch.ts:104`、`:165` |
| CLI 非幂等只走代理 | `src/shared/cliFetch.ts:169-172` |
| 死字段 | `src/shared/proxy.ts:32-33`、`src/ui/TauriToolAdapter.ts:2199` |
| env 代理被当作 direct | `src-tauri/src/lib.rs:184`（注释 `:223`） |
| 诊断强制当前代理 | `src/ui/TauriToolAdapter.ts:643` |
| 三份执行器基线 | `docs/two-legs-plan-2026-11.md`（Rust 101 commands） |

## 附录 B：术语

| 术语 | 含义 |
|---|---|
| transport | 一条物理出口（direct / env-proxy / app-proxy / mirror / reader / cache） |
| destination | 出口声明的访问意图（host + class + 重放/改写能力） |
| plan | 一次请求的尝试计划（primary + fallback + budget） |
| attempt | 一次实际发出的尝试及其结构化结局 |
| prior | 冷启动先验（原静态名单，样本量为 0） |
| evidence | 真实请求积累的统计（成功率、headers EWMA、死期、样本量） |

---

## 评审意见（2026-11-04）

**方向正确，建议渐进落地。**

- **职责划分精准**：将代理从策略剥离为资源是最关键的修正，能打破静态名单对路由的强制约束。
- **证据驱动务实**：用 `Attempt(ms, failure)` 替代错误文案判断切实可行，双层账本（host × transport + class × transport）既能复用又能冷启动。
- **最大风险**：Rust LLM 流式路径改造面大，且工具侧普遍缺少 `headersMs`。建议先用 LLM + web_fetch 试点、feature flag 双轨，待账本积累足够样本再推广。
- **关键约束**：必须严格遵守“非幂等请求只能一次选对”、区分 `direct/env-proxy/app-proxy` 三种物理路径、优先消除四套状态机重叠。
