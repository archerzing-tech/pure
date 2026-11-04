# 网络层设计：单一网络端口 + 代理资源（2026-11）

> 状态：**设计稿，未开工**（2026-11-04 定稿并拍板；2026-11-05 重审计修订后开工）。本文档是实现的目标基线；文档与代码冲突时以代码为准。
> 重审计（2026-11-05）：红队 + 落地可行性两路并行审计，22 条发现归并为本文修订——核心是 LLM 语义统一（可重放口径）、local 类型层不变量、探活分支闭环、score 规范、Rust 内部退避梯子归属、账本终态定为 WebCache 形态。评审意见见文末。
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
| 用不用由代理层智能决策 | 智能属于**路由策略层**，按目标类 + 实测证据排序 | 让代理自己决定"该不该用我"，就是现在 42 条静态名单的病根 |
| 人不用关注 | **静默 + 可回放**：过程零打扰，每次请求留一条结构化决策记录 | 不关注 ≠ 不可解释；否则失败时只能踢皮球 |

一句话目标态：

> 每个出口只声明「访问谁、能不能重放」；`NetworkPort` 给出尝试计划；代理是计划里的一个 transport；所有真实结局回流到一本证据账本。

---

## 一、判定：现在的病不是"实现不好"，是职责放错了

| # | 本质问题 | 证据 |
|---|---|---|
| 1 | **策略被写进了资源层**：42 条静态 host 名单决定首选，代理健康只能"翻面"；时延证据只覆盖 LLM | `netRoute.ts:80`（名单）、`:369`（代理死→proxy-first 全局翻直连）、`:485`（快慢比较需双路样本） |
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
  | 'local'   // 环回/私网：类型层不变量（见不变量 6），不进证据系统，plan 硬返回 direct-only
  | 'llm-api' | 'search-cn' | 'search-intl' | 'public-api-cn' | 'public-api-intl'
  | 'pkg-registry' | 'vcs' | 'asset' | 'web-page' | 'mcp-remote' | 'tile';

interface Destination {
  key: string;            // host（或后端组的稳定 key）
  class: DestClass;
  idempotent: boolean;    // GET/HEAD
  // 可重放 = 失败发生在不可逆副作用（计费/写入/发送）之前，换 transport 重发安全。
  // LLM 是 POST（非幂等）但 replayable=true——流还没吐给用户前失败，换路重发无副作用。
  // shell / MCP = false（副作用在子进程，失败可能已发生）。
  replayable: boolean;
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
  // LLM/流式出口 = 到响应头（Rust 在流前测，现状 headersMs 同口径）；
  // 工具出口（fetch_page 等读完整 body 才返回）= 总耗时，`msScope` 标注口径。
  ms: number;
  msScope?: 'headers' | 'total';
  failure?: 'dns' | 'tcp' | 'tls' | 'http' | 'hijack' | 'policy' | 'abort';
  status?: number;
}
// cache 不产 Attempt：命中是 plan 前置检查（亚毫秒"成功"入账会把 EWMA 拉向 0，
// argmax 永远选 cache 直到 TTL）；miss 也不消耗 budget。reader 的失败按双 key 入账
// （dest.host × reader + reader 服务本身 × direct），否则 reader 出口死了账本学不到。
```

**Evidence**（双层作用域：host 用于同站复用，class 用于冷启动与跨站迁移）：

```ts
interface Stat {
  n: number;              // 样本数 = 置信度
  ok: number;
  headersEwma?: number;   // α=0.3，只吃真实业务请求的 msScope='headers' 样本
  deadUntil?: number;     // 独立于证据 TTL
  lastOkAt?: number;
}
interface Ledger {
  host:  Record<string, Partial<Record<TransportId, Stat>>>;
  class: Record<DestClass, Partial<Record<TransportId, Stat>>>;
  // warm 双路采样（GET 根路径，与 POST 分布不同）单独入字段，只作冷启动 prior
  // 供体，不混入 headersEwma——否则 LLM 决策被一个更乐观的分布带偏。
  warmPrior?: { direct?: { ok: boolean; ms: number; at: number }; proxy?: { ok: boolean; ms: number; at: number } };
}
// 写入纪律：单写者（每进程一个写入队列 + 文件原子替换/原子写 localStorage）；
// 跨进程 last-writer-wins + 字段级合并（deadUntil 取 max，防止旧快照复活死路）。
// 存储终态 = WebCache 形态（仓库已验证）：Rust 持有单文件（~/.pure/ 下），
// GUI 走 IPC、CLI 走 fs、共盘同键——GUI localStorage 只作 P0 临时态，
// 清除即冷启动是已接受的降级路径。
```

### 2.2 代理层：只回答三个事实

```ts
interface ProxyResource {
  id: string;  // 稳定 id：'system' | `manual:${scheme}://${host}:${port}`（不含凭证）
  healthFor(destClass: DestClass): {
    score: number; headersEwma?: number; deadUntil?: number; samples: number;
  };
  // 调用者 = NetworkPort.execute（primary 成功但 class 级 n < N_MIN 时低频异步补采样）
  // 与 warm 循环复用骨架。探活目标由**策略层注入**（probeTargets: per-class 表），
  // 资源层自身不持有任何域名名单——守住下方的禁止事项。
  probe(destClass?: DestClass): Promise<Attempt>;
  // env/system 代理事实上报：GUI WebView 无 process.env，由宿主（Rust 启动时读一次，
  // 系统代理变化时刷新）注入；system 解析结果归 app-proxy 类（id 区分来源 system/manual）。
  envFacts(): { envProxy?: string; systemProxy?: string };
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
  plan(dest: Destination, preferences?: PreferenceEntry[]): EgressPlan;  // preferences 来自 net.prefer，仲裁序见 §三
  // 两种执行形状并存（重审计裁定）：TS 逐跳循环（工具类出口，port 逐 transport 调 run）
  // 与 Rust 整段执行（LLM：Rust 按内部退避梯子跑完，按每一跳回报 Attempt[]）。
  execute<T>(dest: Destination, plan: EgressPlan, run: (t: TransportId) => Promise<T>):
    Promise<{ value: T; attempts: Attempt[] }>;
  executeLlm(dest: Destination, plan: EgressPlan, run: (t: TransportId) => Promise<T>):
    Promise<{ value: T; attempts: Attempt[] }>;
  diagnose(target: string): Promise<NetProbeReport>;   // 走真实 plan，结论回写账本
  status(): NetworkStatus;                              // 只读快照（模型/设置页共用）
  prefer(destClass: DestClass, transport: TransportId, ttlMs?: number): void;
}
```

LLM 的执行口径（重审计统一，消除原文三处矛盾）：LLM 是 POST（非幂等）但 **replayable=true**——失败发生在计费前，换 transport 重发无副作用。429/5xx 的**同路退避梯子保留在 Rust 执行器内部**（`LLM_RETRY_MAX_ATTEMPTS`，这是已修过的主诉，砍掉即回归）；梯子对外折叠：一次逻辑 Attempt = 一组物理重试，`ms` 取最终成功/失败那一次，TS 预算按逻辑 Attempt 计数（否则 TS budget=2 × Rust 3 次 = 最坏 6 次真发，「默认预算 2」文面不成立）。失败后的换路重放由端口驱动（这正是 replayable 的语义），不做请求级双发（避免双倍 token）。

### 2.4 不变量（架构测试要守住）

1. 出口不得直接 `fetch` / `new Client` / 拼代理 URL —— 必须经 `NetworkPort`。
2. 代理层不得 import 任何 host 规则表。
3. 账本只写结构化 `Attempt`，不写错误文案。
4. 每个 attempt 必须带 `ms`（工具出口可用 `msScope:'total'` 降级口径）；没有 `ms` 的成功不算证据；cache 不产 attempt（见 §2.1）。
5. **非可重放**请求默认无 fallback（唯一例外：§三 的探活小循环）。`idempotent=false` 但 `replayable=true`（LLM）照常换路——失败发生在计费前。
6. **环回/私网是类型层不变量**：`class='local'`（含 127/8、::1、10/8、172.16/12、192.168/16、100.64/10）永不上代理、不进证据系统——一条错位样本也不许把 127.0.0.1 判给代理（现状 netRoute `isNeutralIpLiteral` + 拒绝学习的语义升格为架构测试）。netRoute 与 cliFetch 两份私网判定的网段口径统一（100.64/10 现只有一侧有）。

---

## 三、决策算法

```
plan(dest, ledger, proxies, preferences):
  if dest.class == 'local': return { primary: 'direct', fallback: [], budget: 1 }   // 不变量 6，硬直连

  candidates  = direct
              + (env 事实（宿主上报，见 §2.2 envFacts）有 env proxy ? env-proxy : ∅)
              + (app proxy 存在 ? app-proxy : ∅)
              + (dest.mirrorable ? mirror:* : ∅)
              + (dest.expect in {html} ? reader : ∅)
              // cache 不是候选 transport：plan 前置检查，命中直接返回且不产生 attempt

  score(t) = 合成(证据, prior)，见下方 score 规范
           = -∞  if deadUntil 未过期（唯一候选时降级为最低分而非直接淘汰）
           = preferences 置顶（net.prefer 的会话内偏好，deadUntil 与负证据仍可否决——仲裁序：不变量 6 > deadUntil > prefer > score）

  if !dest.replayable:
      // 探活不是「探一次然后照发」——是 plan 内的候选小循环（重审计裁定）：
      // 按分数序逐个候选探活（TCP/TLS，不发业务请求），首个通过者发唯一一枪；
      // 探活全灭则显式失败并附每条真因（正是证据入账的原料）。
      if n(首选) ≥ N_MIN: return { primary: 首选, fallback: [], budget: 1 }
      else: return { primary: 'probe-loop(候选序)', fallback: [], budget: 1 }

  primary  = argmax(score)
  fallback = 次优且 score 高于阈值（默认 1 个；全死则空）
  return { primary, fallback, budget: 2 }
```

**score 规范**（重审计补——原文量纲/N_MIN/阈值全留白，是设计的心脏地带）：

- **合成规则**：字典序——先可用性后时延。`score(t) = (okRate(t), -headersEwma(t))`，`okRate = ok/n`；同可用性比时延。fallback 阈值复用现成参照物：`fasterRouteOf` 的「快 1 倍且省 ≥500ms」（`netRoute.ts:485`，warm 翻转已复用），通用 score 同款，不自造第四套阈值。
- **prior 数值表**：名单的 proxy-first/direct-first 分类映射为 okRate 先验——direct-first：`(0.85, n=10)`；proxy-first：direct `(0.5, n=10)` / proxy `(0.85, n=10)`；neutral 类不进表（不变量 6）。证据 `n ≥ N_MIN` 后按字典序自然覆盖。
- **N_MIN = 5**（class 级），host 级 `N_MIN = 3`。依据：样本 <3 的 okRate 波动 ±40% 以上，5 起可用性排序在双通场景稳定。
- **探索通道**（防纯 exploitation 死锁）：execute 在 primary 成功但 class 级 `n < N_MIN` 时低频异步补采样次优候选（复用 warm 循环骨架）；ProxyResource.probe 的探活目标由策略层注入（§2.2 probeTargets），资源层自身无名单。

与现状的差异（每一条都要有回归用例）：

| 现状 | 目标 | 理由 |
|---|---|---|
| 首选由静态名单决定 | 名单降级为 prior，`n` 上来后被证据覆盖 | 保留领域经验，但不让名单永久压过实测 |
| `首选 → 反向 → 首选重试` 三步 | 默认 2 步（按逻辑 Attempt 计）；429/5xx 同路退避保留在 Rust 执行器内部（每跳对外折叠为一次 Attempt） | 第三步对同一路径原样重发，成本高收益低；LLM 的退避梯子是已修过的主诉，不能砍 |
| 失败是否换路由错误文案正则判断 | 执行器返回 `failure` 枚举接管网关/网络/超时的**路由判据**；语义分类（auth/rate-limit 给模型的出路文案）保留在 classifyFailure | 文案是隐式契约，改一个词就静默失效；但 provider 响应体语义枚举盖不住，两者分工不混 |
| 代理健康是一个布尔（全局） | `healthFor(destClass)` 矩阵 | 同一个代理对国内/境外目标的可达性不同 |
| 死期与 30 分钟 TTL 共用 | 证据与死期分离 | 现在 4 小时退避在 30 分钟处被整行丢弃 |
| 工具侧无时延 | 每个 `Attempt` 带 `ms` 入库 | "谁快用谁"在工具侧才有可能发生 |
| 非幂等请求配了代理就只走代理 | 证据最强路 + 连接层探活兜底 | "只走代理"把代理变成了单点故障 |

**LLM 的额外优化**：`warm_llm_routes` 已经每 30s 同时打两条路（`lib.rs:534`），只缺把耗时留下。改为双路采样入库——但**只入 `warmPrior` 独立字段**（§2.1），不混入 `headersEwma`：warm 测的是对 base_url 根路径的 GET（任意应答即算通），与真实 POST /chat/completions 是两种分布，混账会让 LLM 决策被更乐观的分布带偏。warmPrior 只作冷启动 prior 供体；若两条都通且差距超过阈值（快 1 倍以上且省 ≥500ms），按证据翻转。不做业务请求双发。**此刀前移进 P0**（廉价、不依赖 Attempt 契约全量落地，给账本供第一批样本）。

---

## 四、出口接入矩阵

| 出口 | 现状 | 目标 | 期 |
|---|---|---|---|
| LLM 主对话 | TS 算 pair，Rust 内部 failover + 独立退避梯子（`LLM_RETRY_MAX_ATTEMPTS`=3）+ 连接池驱逐 + 独立流式 client 构建链，只回服务跳 `headers_ms` | TS 出 plan；Rust 按每一跳回报 `Attempt[]`（内部重试折叠：一次逻辑 Attempt=一组物理重试，ms 取最终那次）；「删 route_of 之外的判断」推 P2——退避梯子保留 | P0a 契约先行 / P2 收敛 |
| web_fetch / web_scrape | 已走 `runRouted`，无时延样本 | 接 `NetworkPort`，`Attempt.ms` 入库 | P0 |
| web_search | TS 单源已就位，`makeIpcFetchPage` 单代理绑死所有后端；自带 per-backend 30s 冷却（第五套状态机） | P0 只加 ms 不改选路（接线反正要动）；P1 按后端拆 `search-cn` / `search-intl` + per-backend 粘性（防 cookie jar 风控信号与出口 IP 错位放大验证码）+ BackendQuota 归宿写明（并入账本或只管配额不管路由）；编排级重试改仅重试失败后端 | P0 加 ms / P1 拆 class |
| web_public_api | 同上（TS 单源已就位） | 按数据提供方分 class | P1 |
| download | CLI 侧已是四步枚举+镜像兜底+逐尝试落账（最接近目标）；GitHub 加速智能 auto 自带证据层（第三个独立状态机，文档此前漏列） | 镜像作为 transport 参与 plan；删独立优先级链时**一并收编** GitHub 加速死标状态进账本 mirror 统计 | P1 |
| shell | 配了代理就无条件注入 env，`NO_PROXY` 只有 loopback（`lib.rs:3598`、`:3942`）；**GUI 下载降级链生成的 curl/aria2c/wget 脚本不带 `-x`，代理全靠 env 注入——默认不注入会静默炸掉它** | **默认不注入**；P0 只有显式 egress 意图（execute_command 加 egress 参数——与八分叉⑤撞同一段代码，合刀），证据条件 P1 账本有来源后生效；注入时 `NO_PROXY` = 用户值 + 国内域表（域表注明来源与衰减策略，防成为下一个 42 条名单）；下载脚本显式补 `-x` 或降级链单独保留注入 | P0 过渡 / P2 评估 sidecar |
| MCP | 同 shell，且无兜底（`mcp.rs:63`）；spawn 配置驱动、无模型决策点，Rust 在 spawn 时查不到账本（账本 P0 在 TS 侧） | **P0 只做 config.json per-server `egress` 字段（manual 声明）**；「证据要求」P2 跨端账本通道后生效；远端 HTTP 走 `NetworkPort`，stdio 走环境声明 | P0 过渡 / P2 |
| 瓦片 / skill hub | 已接 `netRouteProxyPair`（离目标很近，小改） | 接 `NetworkPort` | P1 |
| 更新（updater） | tauri-plugin-updater 插件自持传输（endpoint update-relay），TS plan 够不着——**「接 NetworkPort」不可达** | 二选一：插件级静态 proxy 配置（P1 可接受）或自写检查命令替换插件 | P1 |
| CLI 自安装（install_cli） | 裸 `Client::builder` 直连 GitHub Releases 下载，无代理参数、不走 finalize——国内最易失败的出口反而在路由外（矩阵此前漏行） | 接 `NetworkPort`，mirrorable=true；探活类裸 builder（gateway_http_ok / probe_reachability）列入**探活豁免清单**防架构测试误伤 | P1 |
| diagnose_network | 独立决策路径，强制当前代理，不回写 | 变成端口的只读视图：探测真实 plan 的每条 transport，结论入库 | P1 |

### 4.1 shell / MCP 的两步走（已拍板）

- **第一步（P0）**：默认不注入。需要网络能力的命令由调用方/模型声明 `egress` 意图（execute_command 加参数——与执行器八分叉⑤撞同一段代码，两件事合刀施工）；**「证据表明该目标类必须代理」半个条件在 P0 是死字**（command/mcp class 在 P0 没有任何证据来源），标注 P1 生效。GUI 下载降级链的脚本显式补代理旗标。注入时 `NO_PROXY` 合并用户配置与国内域表，避免 `npm install` / `pip` / `git clone`（国内源）被代理绕路；域表须注明来源与衰减/复审机制——它是一张新的静态名单，与全文对名单的定性（不可维护、病根）存在张力，承认张力并给退出机制，否则它就是下一个 42 条名单。
- **第二步（P2 评估）**：localhost egress sidecar（`127.0.0.1` + 随机 token + 仅 CONNECT）。所有无法改造的出口（git/npm/pip/MCP server/用户脚本）只需一个固定地址，路由集中在 pure 内部。**先不实现**，用 P1 的真实判例决定是否值得。

---

## 五、智能体控制面

默认零调用、全自动。只给四类低压接口，均不涉及改配置：

| 接口 | 语义 | 备注 |
|---|---|---|
| `net.status` | 只读：代理健康、各 class 偏好、最近失败原因 | 也可并入 `sys_info` |
| `net.diagnose(target)` | 已有 `diagnose_network`，改走真实 plan | 报告带"探测的是哪条路" |
| `net.prefer(destClass, transport, ttl)` | 会话内偏好，可过期、可撤销；**进 plan() 的 preferences 输入位**（原文只给接口不给消费口=装饰）；仲裁序：不变量 6 > deadUntil > prefer > score——prefer 置顶但负证据仍可否决 | 让模型"操作工具"的最小表达；`net.status` 读的"各 class 偏好"即 preferences 当前态 |
| 请求级 `egress: 'auto' \| 'direct' \| 'proxy'` | 单次意图，只出现在工具参数 | `download_file` 已有 `proxy` 参数的雏形 |

**禁止**：模型选择代理节点、端口、认证；这些属于资源层，错了就是安全事故。

结果侧：工具返回值附一行紧凑的 `egress`（`servedBy` / `attempts` / `ms`），不打断对话；失败时才给"试过什么 + 每条真因"。

---

## 六、分期

| 期 | 交付物 | 删除项 | 判据 |
|---|---|---|---|
| **P0 收口**（按矩阵逐行对齐，重审计拆刀防失控） | **P0a 契约与账本先行**：`shared/network/`（port + plan + ledger 接口）+ Attempt 契约（含 `msScope`）+ 每跳回报契约（Rust 内部重试折叠定义）+ warm 双路采样入库（前移，`warmPrior` 独立字段）+ ledger 存储 = **WebCache 形态**（Rust 单文件 + GUI IPC + CLI fs 共盘同键，GUI localStorage 只作临时态）+ 单写者纪律；**P0b 接入与行为**：web_fetch 接入；LLM 每跳回报；`Attempt.ms` **已接入出口**（原文「全出口」与矩阵 P1 行自相矛盾）；CLI 读同一份 ProxyConfig（manual 读 config+secrets；**system 模式明写「CLI 下退化为 env」**）；`system://` 改结构化 mode；shell 默认不注入（egress 参数 + 下载脚本补旗标）；MCP per-server egress 字段 | `llmEnabled`/`toolsEnabled`；CLI 假直连分支；`direct` 标签二义性**单独立项**（~18 个 build_http_client 生产调用点 + LLM 独立流式 builder，一刀一契约测试，不与端口层混刀） | 未配代理时代理尝试次数 = 0；Rust 命令可被显式要求强制直连（可测中间态）；CLI 与 GUI 同配置同行为（manual 模式内） |
| **P1 证据化** | 名单降级 prior；`healthFor(destClass)` 矩阵；死期/TTL 解耦；预算 3→2（硬依赖 P0 failure 枚举，顺序不动）；search/api 按后端拆 class（成本已低——TS 单源就位，机械阻力只在 makeIpcFetchPage 闭包）+ per-backend 粘性；诊断回写；shell「证据要求」条件生效；install_cli 接入；updater 二选一；download 链收编 GitHub 加速证据层 | `SURFACE_CLASS` 一刀切；`proxyFallbackFor` 全局翻面；`netGuard` 的 24h"别尝试"文案 | 双通场景 20 次后快路命中 ≥80%；平均尝试 ≤1.2 |
| **P2 结构收敛** | 一个决策器（TS）+ 一个执行器契约（Rust 执行/回报；LLM 退避梯子归属 Rust 定稿）；Rust 删 route_of 之外判断；MCP「证据要求」跨端生效；评估 sidecar | `netGuard` / `netRoute.deadUntil` 重叠状态收编——**「删 netGuard」边界：只删 24h 劝退面与劫持本体，classifyFailure 的语义分类保留**（Attempt 枚举只接管网关/网络/超时的路由判据，auth/rate-limit 的出路文案永久留在文案层）；两份劫持实现之一（执行器内共享 fixtures） | 任何出口不再持有自己的路由状态 |
| **P3 可选** | sidecar 接管 shell/MCP/第三方工具；连接层竞速 | `execute_command` / `mcp.rs` 的 env 注入分支 | 第三方工具零改造获得智能路由 |

顺序理由：**先统一证据 → 再统一执行 → 最后动结构**。反过来会变成大规模重写。P0→P1 是硬依赖（P1 的名单降 prior、healthFor 矩阵全靠 P0 账本+Attempt.ms），不可倒置；可并行拆的刀=warm 采样入库（已前移）、search 拆 class（不依赖账本）、direct 二义性根治（机械独立）。P0 内部最长的两根杆=LLM 每跳 Attempt 契约（双语言）与 shell/MCP 行为面。

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
| D1 | **决策器在 TS**（`shared/network/`，GUI/CLI 共用）；Rust 只执行 + 回报每跳 `Attempt` | 贴合 D1=A「TS 单执行器」；决策是纯函数，无需跨进程；账本需要持久化，终态=WebCache 形态（Rust 单文件共盘），GUI localStorage 只作 P0 临时态 | Rust 侧保留退避梯子（对内）但删掉除 `route_of` 外的路由判断（P2 兑现）；LLM 仍是 Rust 流式，但不再自己决定"谁是首选"；Rust 每轮内部退避折叠为一次逻辑 Attempt 回报 |
| D2 | **shell/MCP 先走"默认不注入 + NO_PROXY 域表"**，sidecar 留 P2 评估 | 小、稳、可回滚；sidecar 一旦出问题影响所有子进程 | P0 只改注入条件与 NO_PROXY，不改子进程执行方式 |
| D3 | **默认预算 2**，非可重放 1（+ §三 探活小循环） | 现有第三步是同路重发，成本高收益低 | `unblockAttemptsBeforeMirror` 的 4 步枚举退役；预算按逻辑 Attempt 计（Rust 内部物理重试不占 TS 预算，否则 2×3=6 次真发文面不成立） |
| D4 | **名单降级为 prior**，不删除 | 保留国内网络领域经验，同时允许证据覆盖 | `HOST_CLASS_RULES` 改名/改语义为 `PRIORS`，不再被当作硬规则 |
| D5 | **证据双层**：host × transport + class × transport | host 复用精度，class 解决冷启动与样本稀疏 | 账本 schema 需两层；迁移时从现有 host 条目推导 class 先验 |
| D6 | **账本存储终态 = WebCache 形态**：Rust 持有单文件（~/.pure/ 下），GUI 走 IPC、CLI 走 fs、共盘同键（仓库已验证的共享通道）；P0 允许 GUI localStorage 临时态但写明是临时 | 原方案「localStorage / CLI 文件同 schema」在 P2 也合不拢——同 schema ≠ 同数据，两端证据永不互通，class 级冷启动在 CLI 永远空 | 单写者纪律（进程内写入队列 + 原子替换；跨进程 last-writer-wins + 字段级合并，deadUntil 取 max 防旧快照复活死路）；localStorage 被清=冷启动，是已接受的降级路径 |
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
| 连接层探活对非幂等请求增加一次 RTT | 只在 `n < N_MIN` 时做；对已知稳定的目标直接发；**探活全灭=显式失败附每条真因**（原稿探活失败后无分支，唯一一枪照发原路——重审计已改 plan 内候选小循环） |
| 迁移期新旧双轨 | 端口默认走旧实现，按出口 feature flag 切换；对照日志比对两套决策 |
| sidecar 安全边界 | 仅 loopback + 随机 token + 仅 CONNECT + 进程生命周期绑定；P2 单独设计评审 |
| 账本隐私 | 只存 host/class/transport/耗时；不存 path/query/header/凭证 |

---

## 附录 A：现状证据索引

| 事实 | 位置 |
|---|---|
| 42 条静态 host 名单 | `src/shared/netRoute.ts:80` |
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

> 以下意见已全部吸收进上文修订；2026-11-05 重审计（红队 + 落地可行性两路，22 条发现）同样已归并为修订，最重几项：LLM「非幂等但有 fallback」撞不变量 5 → 统一为「非可重放」口径；Rust 内部退避梯子（LLM_RETRY_MAX_ATTEMPTS）此前文档未提 → 已纳入 Attempt↔物理重试折叠映射；shell 默认不注入导致 GUI 下载降级链静默失效 → 矩阵补 `-x` 与探活豁免清单；账本终态定 WebCache 形态（D6 重写）。

**方向正确，建议渐进落地。**

- **职责划分精准**：将代理从策略剥离为资源是最关键的修正，能打破静态名单对路由的强制约束。
- **证据驱动务实**：用 `Attempt(ms, failure)` 替代错误文案判断切实可行，双层账本（host × transport + class × transport）既能复用又能冷启动。
- **最大风险**：Rust LLM 流式路径改造面大，且工具侧普遍缺少 `headersMs`。建议先用 LLM + web_fetch 试点、feature flag 双轨，待账本积累足够样本再推广。
- **关键约束**：必须严格遵守“非幂等请求只能一次选对”、区分 `direct/env-proxy/app-proxy` 三种物理路径、优先消除四套状态机重叠。
