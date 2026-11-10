# LLM 可访问性门禁：模型选择列表只显示可访问的模型（2026-11 蓝图 v2）

定位：对话框下方的模型选择列表只显示**可访问**的 LLM。设置页继续承担 provider 与模型的全量配置职责；可访问性是感知层事实，配置层不因它隐藏任何东西。

> v2 注记：经独立对抗评审收敛。阻塞项一处（探测鉴权协议分道）+ 实锤缺陷三处已并入；两处分歧（砍快照、砍周期）未全收，理由见 §10。

## 1. 职责边界（三层分离）

| 层 | 载体 | 职责 | 不做什么 |
| --- | --- | --- | --- |
| 配置层 | 设置页 → config.json | provider、baseURL、key、模型清单；全量显示 | 不因不可访问隐藏条目 |
| 感知层 | 可用性台账（llmModelAvailability） | 对每个已配置端点维护最近探测结论 | 不改配置、不静默切换模型 |
| 呈现层 | 模型选择列表（下拉 + /model） | 过闸子集 = 已配置 ∧ 可访问 | 不显示未知/不可访问项 |

## 2. 「可访问」判据（口径）

探测 = 复用 Rust `test_llm_connection`：`GET {models URL}`，与 `chat_stream` **全同款**：同客户端构建（超时 + 代理）、同 key 解析（含 per-provider override secret）、同代理 bypass、同一次对向路线 fallback。**探测不发 completion，不花钱**。

**协议分流（v2 阻塞项修正）**：鉴权头必须走 `apply_auth_headers`（lib.rs:13022）按协议分流——anthropic 协议发 `x-api-key` + `anthropic-version`，openai 协议发 `Bearer`。现 `probe_llm_endpoint` 只发 Bearer（lib.rs:366-368），对 anthropic/minimax（均 `protocol:'anthropic'`）恒 401。models URL 按协议构造：URL 以 `/v1` 结尾追加 `/models`，否则（anthropic 路径）追加 `/v1/models`。capabilityProbe 有同一前科（已修），本次必须引用。

| 探测结果 | 裁决 |
| --- | --- |
| 2xx | 可访问 |
| 401 / 403 | 不可访问（key 被拒） |
| 连接层失败（DNS/TLS/拒绝/超时/5xx） | 不可访问 |
| 429 | 记「限流」计数，**暂不下架**；**连续 3 次 429 → 降级为不可访问**（配额耗尽不该永久占列表），任一次非 429 结果即复位 |

**已知上限（明示，不装作判据能保证推理可用）**：
- 不鉴权就返回 2xx 的中转站，key 死了探不出来（假阳性）；
- 配额只有真发请求才知道。
推理可用性由回合失败触发兜底（§4.5）。用户中转站生态占比需真机摸底（§10 挂账）。

模型级判据（P2）：`/models` 返回体解析模型 id 集合；集合非空 ∧ 与配置清单交集非空 → 只显示交集；集合为空 / 解析失败 / 交集为空 → 「清单不可核对」，显示全部配置模型 + 低置信标记（返回体需 cap，防 OpenRouter 式 MB 级清单）。

## 3. 可用性台账

- 键：`provider::baseURL`（端点级）。
- 值：`{ ok, checkedAt, latencyMs?, error?, status?, limitedStreak? }`（`models?: string[]` P2）。
- 内存 Map（窗口内即时读）+ localStorage 快照 `pure.llmAvailability.v1`：
  - **只持久化 ok:true 条目**（v2：断网期的错误结论不进盘，不毒化下次启动）；
  - **失效判据 = 配置身份失配**（provider/baseURL 变了才废），不做 24h 墙钟过期（v2：治隔天全灭窗；过期-positive 由启动探测潮秒级纠偏）；
  - 读写 try/catch，不可用降级纯内存。
- 多窗口：快照整份覆盖（last-writer-wins）可接受，各窗口内存副本独立，探测幂等。

## 4. 探测时机

1. **启动**：恢复快照（列表立即有内容）→ 后台探测潮，**当前 provider 最先**，其余并发跟上（用户最可能马上用的最先纠偏）。
2. **设置保存**：**按 LLM 相关字段 diff 触发**（provider、model、customProviders、providerOverrides、key 类、proxy——代理影响可达性；改主题/字号不触发）。台账原位更新，**不先 invalidate 后探测**。
3. **设置页「测试连接」**：无论成败都过账。
4. **周期 30min 全量**（v2 从 10min 降频）：「变可用」恢复方向**唯一的探测者，不可砍**；失败端点退避补探 60s → 5min。
5. **回合失败（v2 提进 P1）**：回合对当前 provider **连接层失败**（DNS/TLS/拒绝/超时/401/403）→ 失效 + 即时重探；429/业务错误不触发。接线点在 adapter 错误分类路径（现有 netOutcome 管道仅代理模式生效，直连失败走 adapter error 路径）。
6. **llmWarm 连败信号（v2 提进 P1）**：llmWarm 每 30s 已在探当前端点（零费用 GET），连续 3 次失败 → 触发正式重探。零新增请求，当前端点死亡发现从 10min 级提到 ~90s。

节流：每端点同时只允许一个在飞探测；periodic 同端点最小间隔 60s。

## 5. 显示门禁（接线点）

- **单缝**：`modelOptionsForConfig = providerHasKey ∧ accessible`，下拉与 `/model` 命令共用。
- **枚举与 key 解析统一（v2）**：探测枚举 = `PROVIDERS/customProviders` 经 `providerHasKey` 一条缝过滤；key 解析与 chat_stream 同款（内置 provider 的 override secret 也要解析——半成品只给 custom 传 secretKey，实锤缺陷）。
- **过滤提纯**：`filterModelOptionsByAvailability(entries, isAccessible)` 纯函数注入。
- **触发器诚实显示**：当前模型不在选项中 → trigger 占位「—」；状态栏警示「当前模型不可访问 → 打开设置」；**绝不静默改配置**（自动改配置是被否的闭环形状）。刷新钩子用注入（`setRefreshHook`），去掉 `window.__populateComposerSelects` 反向 hack。
- **全灭态**：选项空 → trigger「无可用模型」；空态条目「在设置中检查 LLM」跳设置。
- **状态栏 / 上下文面板**：当前生效模型不可访问 → 警示标记。
- **重绘合批**：一轮探测潮结束统一刷新一次。

## 6. 边界裁决表

| 情形 | 裁决 |
| --- | --- |
| 冷启动无快照（首装） | 未知 = 不显示；探测潮落地前 trigger「检查中」 |
| 隔天启动（v2） | 快照按配置身份判有效性，正常显示，探测潮秒级纠偏 |
| 断网启动（v2） | 列表随探测潮退空（本就不可达）；ok:false 不进快照，网络恢复退避补探即回 |
| 当前模型被下架 | 不静默切换；trigger 占位 + 状态栏警示；回合失败走既有错误链 |
| 全部模型不可访问 | 空列表 + 引导设置；配置数据不动 |
| 429 | 计数，连续 3 次降级隐藏；非 429 结果复位 |
| 中转站假 2xx | 已知盲区，回合失败兜底；占比真机摸底 |
| localStorage 不可用 | 降级纯内存 |
| 假阴性锁死（慢端点超时误判） | 60s 退避 + 设置页测试连接把窗口压到分钟级；`/model` 强制逃生门挂账，咬人再做 |

## 7. 分期

**P1**：Rust `test_llm_connection` 协议分流 + models URL 构造；台账（含 429 计数）+ 瘦身快照；触发时机 1–6（含回合失败、warm 连败）；单缝枚举/key 解析统一；过滤提纯；触发器诚实显示 + 空态；状态栏警示；/model 继承；测试。

**P2（挂账）**：模型级 id 过滤（返回体 cap）、设置页 per-provider 可用性徽标、`/model` 强制逃生门。

## 8. 改动面

- `src-tauri/src/lib.rs`：`test_llm_connection` 加 `protocol` 参数，复用 `apply_auth_headers`；models URL 按协议构造。
- `src/ui/llmModelAvailability.ts`：收敛重写（协议参数传递、单缝枚举、key 解析同款、快照瘦身、429 计数、退避、合批刷新、注入式刷新钩子）。
- `src/ui/main.ts`：接纯过滤；`populateModelSelect` 失配/空态；`updateSidebarModel` 警示；清理未用 import。
- `src/ui/composerSelect.ts`：空态条目 + 失配占位语义。
- `src/ui/settings.ts`：保存接线改字段 diff 触发；测试连接失败也过账。
- `src/ui/chat.ts`：回合失败触发接线（adapter 错误分类路径）。
- `src/ui/llmWarm.ts`：连败信号回调接线。
- `src/shared/llmProbe.ts`：与半成品 browser fallback 二选一统一。
- `src/ui/config.ts`：已改的本地端点无 key 判已配置保留。
- i18n：新文案。

## 9. 测试判据

- **协议分流**：anthropic 协议探测请求带 `x-api-key` + `anthropic-version`、不带 Bearer（Rust mock server 已有基建）；openai 带 Bearer。
- key 解析同款：内置 override secret 场景探测 401 不再误判。
- 纯过滤：无 key / 不可访问 / 未知不显示，可访问显示。
- 快照：只写 ok:true；配置身份失配失效；写失败不抛。
- 429：连续 3 次降级、非 429 复位。
- 保存 diff：LLM 无关字段保存不触发重探。
- 诚实显示：失配 trigger 不认领第一个选项（ComposerSelect 单测）。
- 全量纪律：bun test 全量、`bun run typecheck`、build:vite、Rust 侧 `cargo test --lib`（改了 Rust 签名，check 不编译 test 模块）。

## 10. 对抗评审记录

**已收**：协议分流阻塞项、key 解析口径分裂、保存全局误触发、回合失败提 P1、warm 连败接线、429 降级、快照只记 ok:true + 身份失效、window hack 去除、llmProbe 统一。

**未全收（分歧）**：
1. 砍快照 → 收「瘦身」不收「砍」：瘦身后成本≈0，收益是启动即有列表；三态显式化（未知短暂显示）违反需求字面义，不采。
2. 砍周期探测 → 降 30min 不砍：周期是「变可用」方向唯一探测者，砍了恢复的 provider 永不回列表。

**真机摸底挂账**：MiniMax anthropic 路径 `/models` 是否 404；Anthropic 官方 `/v1/models` 200 稳定性；用户中转站 `/models` 不鉴权占比；429 降级阈值（暂定 3）。
