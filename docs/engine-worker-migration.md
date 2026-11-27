# 引擎 WebWorker 化迁移设计（方案 2 立项稿）

> 状态：立项（2026-11-27，用户拍板）。commit 锚：待 Phase 1 首提交回填。
> 上游判例：前端单点事故三案（呈现冻结吞 persist、双窗口主线程饱和、mac 僵尸态）。
> 关联：[[remote-office-bridge-design]] S3 daemon 化是本方案的远期收口（方案 3）；
> [[decision-boundary-2026-11]] 的四分归属在本方案中的含义：引擎搬 Worker 改变的是
> 「系统手脚」的宿主位置，模型决策与判据体系不动。

## 一、背景：前端单点（三案汇聚）

GUI 是 pure 全家族里唯一「引擎住 UI 进程」的宿主（CLI/通道网关的引擎都在独立进程）。
代价在三案中全部兑现：

| 案 | 现象 | 耦合点 |
|---|---|---|
| 呈现冻结吞 persist（2026-11-26 任务 B） | UI 冻结 → save_session 断 → 交付物丢失 | persist 住前端 |
| Windows 双窗口双卡死（2026-11-27） | 双窗并发流式 → 宿主主线程饱和 → 全窗冻结 | 主线程=所有窗口 ExecuteScript 的串行瓶颈 |
| mac 僵尸态（历史多案） | 快速甩动后按钮全死、页面空白 | JS 事件循环=引擎+UI 共用 |

只要引擎与 UI 同居一个 JS 事件循环，「会话死=UI 死」结构性成立。战术层（折叠/
泊车/闸门/喂食降频/nudge 自愈，v4.10.6–4.10.19）已把已知形态压到可用水位，但
「前端冻结=全停」的结构性风险仍在。

## 二、目标形态

```
┌─ 主线程（UI 进程）──────────────┐   ┌─ Worker（每会话一个）─────────┐
│ transcript 渲染（投影）          │   │ AgentLoopEngine（回合循环）    │
│ 输入框/工具卡/计划卡 UI          │◄──┤ 会话状态机（transcript 权威）  │
│ 用户输入 → postMessage → Worker  │──►│ persist（快照权威）            │
│ 工具执行桥（invoke 转发，低频）   │   │ LLM SSE 消费                   │
└──────────────────────────────┘   └──────────────────────────────┘
```

- **Worker 有独立事件循环**：主线程的布局/绘制/合成冻结不影响引擎执行与落盘
  ——「UI 卡死」降级为「画面暂冻、会话照跑、恢复无损」。
- **persist 权威移入 Worker**：前端冻结不再断数据链（直接消除任务 B 形态事故）。
- **UI 退化为投影**：transcript 快照是唯一权威，主线程只画不存；WebView 重开=
  重新投影，零丢失。

## 三、关键技术决策

### 3.1 LLM SSE 通道
现状：Rust `chat_stream` 拉 SSE → Channel → 主线程 → 引擎。Worker 化后 Channel
绑定 WebView 的机制不通（Worker 不是 WebView），**保持 Rust 拉流不变**，转发链
改为：Rust（50ms 自适应合批，v4.10.19 机制保留）→ 主线程 → `postMessage` →
Worker。转发过主线程是 WebView2 平台物理约束（PostWebMessage 必须主线程），
但主线程只做「转发已合批文本」这一件轻事；引擎的解析/状态机/工具编排全部移出
主线程，主线程负载量级下降。

### 3.2 工具执行桥
引擎的工具调用（execute_command/read_file/write_file…）现走 tauri invoke。
Worker 内 `window.__TAURI_INTERNALS__` 不可用 → **桥接**：Worker postMessage
工具请求 → 主线程 invoke → 结果 postMessage 回 Worker。工具执行是低频事件
（每回合数次），桥接成本可接受。安全约束不变：审批流（permission mode）在
主线程桥上执行——权限面收口位置不动。

### 3.3 persist 移入 Worker
快照/transcript/stats 的落盘 invoke 全部移到 Worker（经 3.2 同一桥）。前端
冻结时 Worker 侧 persist 照跑。save_session 的 10s 超时语义重新评估：Worker
persist 不受主线程拥堵影响后，超时窗可收紧。

### 3.4 每会话一 Worker
多窗口模型隔离判例（2026-11-06）已定「会话跟着窗口走」。Worker 生命周期 =
会话生命周期：会话开 → Worker 起；会话关/空闲超时 → Worker 释放（状态已在
落盘快照里）。多窗口打开同一会话 → 投影订阅同一 Worker（单写多读）。

### 3.5 bundling
Vite 原生 worker module 入口：
`new Worker(new URL('./sessionWorker.ts', import.meta.url), { type: 'module' })`。
engine/harness 代码零改动打包进 worker chunk。

## 四、迁移步骤（渐进可回退）

| 阶段 | 内容 | 回退 |
|---|---|---|
| P0 | 协议冻结：引擎 `yield` 事件类型已是消息协议（复用）；审计 engine/harness 的 DOM 触碰点清零 | — |
| P1 | Worker 骨架 + 桥接层（invokeProxy）+ **特性开关**：新会话走 Worker 路径，既有会话维持主线程路径（双轨） | 开关回退 |
| P2 | 工具执行桥 + persist 迁 Worker（快照权威换址） | 开关回退 |
| P3 | 全量切换，移除主线程引擎路径；audit 主线程剩余职责（渲染+输入+权限桥） | — |

## 五、风险清单

1. **Worker 无 window/document**：engine/harness 若有 DOM 触碰需清（P0 审计，
   预期极少——引擎是纯状态机设计）。
2. **invoke 桥的消息协议**：Worker↔主线程的 postMessage 序列化（结构化克隆）
   与现有 invoke 参数形态的映射；错误传播（tool error 的 error 字段语义）。
3. **SSE 转发的时序语义**：合批/背压/取消（stop 的 AbortSignal 在 Worker 内
   无法直接 abort 主线程 fetch → 取消指令走桥反向传递）。
4. **调试面**：Worker 的 console 在 devtools 的 Worker context；诊断打点
   （gui_perf/gui_errors）走桥转发，格式不变。
5. **双窗口主线程转发饱和是物理约束**：Worker 化后主线程只剩「已合批文本转发
   + 权限桥」——负载量级下降但不归零；4.10.19 自适应合批继续独立演进。

## 六、验收判据

1. 呈现冻结注入测试（人为冻结主线程渲染）下：Worker 内引擎照常推进回合、
   persist 照常落盘，恢复后 transcript 零丢失。
2. 双窗口并发对话：两窗均可在对方流式期间正常打字/滚动/收结果。
3. 既有测试面（engine/harness 全量）在 Worker 环境等价通过。
4. 主线程长任务占比测量：引擎相关任务从主线程消失（Performance 面板取证）。
