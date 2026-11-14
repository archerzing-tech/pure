# Windows 4.8.0 自测问题清单（2026-11-14）

> 状态：现役问题清单（未修项待排期）；代码锚 `5d433623`（v4.8.0）
> 环境：Windows 11 + 已安装版 `D:\applications\pure\pure-app.exe`（FileVersion/ProductVersion 4.8.0）+ WebView2 + Bun 1.3.14 (x64)，单屏 3440×1440、dpr 1，系统输入法搜狗。
> 范围：只验证「Windows 上 GUI 卡死 / 无反馈假死」，不做功能正确性验收。
> 方法：真实启动已安装的 4.8.0，粘贴长文本让模型自跑；用 CDP 驱动 WebView2，同时用 Win32 探测（`SendMessageTimeout(WM_NULL)`、`IsHungAppWindow`、`GetGUIThreadInfo`）与页面内探针（rAF 帧间隔 / timer 抖动 / longtask）量化。
> 结论：**本轮未复现卡死或假死**，但有 5 个自测暴露的问题，见下。
> 修复轮（2026-11-14 同日）：问题 1/4/5 已修（见各节修复记录），问题 3 复核为疑似误报，问题 2 维持待排期。

## 一、问题总表

| # | 问题 | 严重度 | 状态 | 影响面 |
|---|---|---|---|---|
| 1 | Bun 里「只剩 unref 定时器」的 `await` 永不返回，通道审批超时失效、`bun test` 卡死 | 高 | **已修**（去 unref + 回归哨兵测试） | 通道网关进程、测试链路 |
| 2 | 进程退出有两种成因：有审计的正常 Quit（来源未定）与无审计的硬杀，不可从外部区分 | 中 | 已定性，来源待查（取证 instrumentation 可排期，本轮未动） | GUI 进程生命周期 |
| 3 | 超宽屏下聊天阅读列无最大宽度，行长失控 | 低 | **复核疑似误报**（`#chat` 自 2026-09-20 起 `max-width: 948px` + `margin: 0 auto` 居中；构建产物与多会话宿主链路均已核实） | GUI 可读性 |
| 4 | `read_file` 把 UTF-16 文本判为二进制；`execute_command` 的 stderr 混入 CLIXML 进度对象 | 低 | **已修**（BOM 前置解码；进度流源头抑制 + 尾部 blob 剥离） | 工具可用性 / 排障可读性 |
| 5 | 正常流程（`[ctx-shape] 交付门禁`）以 `kind:"error"` 写进 `gui_errors.log` | 低 | **已修**（台账新增 `kind:"info"` 诊断通道） | 错误台账信噪比 |

## 二、问题 1：`unref` 定时器的 `await` 在 Bun 下永不返回

### 现象

`bun test` 全量跑在 `src/channels/__tests__/approvals.test.ts` 卡死：9 分钟只有 11 行输出，进程不退出、不报错，只能强杀。

### 定位

单文件可复现（两次独立执行，均阻塞到超时被 SIGTERM）：

```
bun test src/channels/__tests__/approvals.test.ts      # >90s 未结束
cd src/channels/__tests__ && bun test ./approvals.test.ts   # >60s 未结束
```

后台重定向日志 20 秒采样：stdout 只有 `bun test v1.3.14 (0d9b296a)`，stderr 有 4 条 `[channels] 审批请求 #ap1 已发往 s1`。前 3 个用例加第 4 个（`times out into a denial`）各发一次请求 → **卡在第 4 个用例的超时等待**。

最小复现（Bun 1.3.14 / Windows x64）：

```js
const p = new Promise((r) => { const t = setTimeout(() => r('x'), 20); t.unref(); });
console.log(await p);   // 永不打印，进程也不退出
```

对照（证明 unref 定时器本身没坏，坏的是「没有 ref 句柄」这一状态）：

```js
const t = setTimeout(() => console.log('unref-fired'), 20); t.unref();
setTimeout(() => console.log('ref-fired'), 200);   // 两个都打印
```

即：进程里只要还有一个 ref 句柄，unref 定时器照常到期；一旦唯一待办就是那个 unref 定时器，Bun 的事件循环不再被唤醒，promise 永不 settle。

### 代码锚点

`src/channels/approvals.ts`

```ts
const timer = setTimeout(() => { /* 超时默认拒绝 */ resolve(decision); }, this.timeoutMs);  // :83
// 超时计时器不应阻止进程退出。
if (typeof timer.unref === 'function') timer.unref();                                     // :90
```

`timer.unref()` 的注释意图是「别让审批超时拖住进程退出」，但代价是**审批期间进程本来就没有 ref 句柄**（网关侧等答复时无其他活动），超时因此永不触发。

### 影响

- 通道审批超时（默认 120s）在网关进程里失效 → 会话无限等待一条永远不会来的答复，对外表现正是「没有任何反馈」。
- `bun test` 全量在当前环境不可用；`src/channels/__tests__/remoteControl.test.ts:254`、`src/channels/__tests__/router.test.ts:65` 同样用 `timeoutMs: 50`，属同一雷区。
- GUI 渲染进程不受影响：审批走 `src/cliChannels.ts` → `Gateway`（:127）→ `ChannelApprovalBroker`，跑在独立的 Bun 网关进程里。GUI 内的权限拦截是另一条链路。

### 建议修法

1. 去掉 `timer.unref()`（审批 pending 期间进程本就不该退出）；`handleReply` / `cancelSession` / 超时回调三处已有 `clearTimeout`，没有泄漏风险。
2. 若确实要保留「不拖住退出」的语义，改为「有 pending 时 ref、pending 清空时 unref」——现有代码里 ref 永远成立，等价于直接删掉 unref。
3. 补一条回归测试：只有 unref 定时器的 `await` 必须能 resolve（跨 Bun 版本跑，防止上游行为变化静默复现）。

### 修复记录（2026-11-14）

采用建议 1 + 3：删掉 `timer.unref()`（approvals.ts，判例注释就地保留）；`approvals.test.ts` 新增回归哨兵「timeout denial fires with nothing else keeping the process alive」——若 unref 回归，用例 5 秒后经 guard 报明确错误而不是无声挂死测试进程。验证：`bun test src/channels/__tests__/approvals.test.ts` 从卡死（>90s）变为 11 pass / 83ms；同雷区的 `remoteControl.test.ts` / `router.test.ts` 随目录全量一并复跑通过。

## 三、问题 2：进程退出的两种成因，外部无法区分

### 事实

三次长跑（都用同一个 `monitor.ps1` 后台启动，只有交互方式不同）：

| 跑次 | 时长 | 交互 | 结局 | 审计 |
|---|---|---|---|---|
| r1 | 1500s | 全程 CDP 高频交互 + 多轮长流式 | 监视结束后约 3–7 分钟进程消失 | **无任何记录** |
| r2 | 13m10s | 一次工具密集型任务 + 收尾检查 | 11:00:07 退出，退出码 0 | 三行完整记录 |
| r3 | 900s | 零 CDP 交互、纯挂机 | 存活，监视结束后仍在 | 无退出记录 |

r2 的审计：

```
~/.pure/exit_audit.log
1794625207108 close-requested quit (idle, windows: 1)
1794625207108 exit-requested code=Some(0)
1794625207109 run-exit
```

对应 `src-tauri/src/lib.rs:19347` 的 `CloseDisposition::Quit`：`running=0`、`webview_windows=1` → `app.exit(0)`。退出码 0，WebView2 子进程全部回收，无 dump、无 WER 事件，stderr 仅一行 Chromium 关闭噪声（`Failed to unregister class Chrome_WidgetWin_0. Error = 1412`）。

### 已排除

- **空闲自动退出**：r3 零交互挂机 900s（pump max 17ms、p99 0、失败 0、内存 19→33MB、CPU 总量 0.2s）全程存活，监视 shell 退出后仍然存活 → 不存在「空闲若干分钟自动 Quit」。
- **启动 shell 结束即回收**：r3 的监视进程已退出，应用仍在 → 不成立。
- **托盘退出**：那条会先写 `tray-quit exit(0)`，日志里没有。
- **崩溃**：退出码 0、无 dump、无 WER、无 RestartManager 会话。
- **崩溃或挂起的连带关闭**：`IsHungAppWindow` 全程 0，pump 无失败（r2 采样 1277 次、r3 采样 1726 次）。

### 结论与剩余疑点

- 两种退出模式都不影响数据：r2 退出发生在任务完成后、空闲期，会话与交付文件完整落盘。
- r1 的「无审计消失」是**硬杀**（进程未走消息路径），与 r2 的**正常 Quit** 是两码事；r3 在相同启动方式下未复现硬杀，说明它依赖外部条件而非应用自身。
- 未定位：r2 那条 WM_CLOSE 的发送方。可排期的一次取证：复现时用窗口消息钩子/ETW 记录发送进程，或在 `CloseRequested` 里把 `GetForegroundWindow`/调用栈写进审计。
- 对用户侧的可操作含义：`~/.pure/exit_audit.log` 有记录 = 正常退出路径；无记录 = 被强杀。两者都不等于「卡死」，但现象上都是「应用不见了」。

## 四、问题 3：超宽屏阅读列无宽度上限

3200px 级窗口下 `#chat` 消息列没有 `max-width`，正文一行 200+ 字符，阅读需要摇头。属可读性缺陷，不影响功能。

建议：给消息列加 `max-width: min(920px, 100%)`（或按 `ch` 计的 72 字宽），窗口缩放与 max-width 无耦合。

### 复核记录（2026-11-14）——疑似误报，未改代码

源码与构建产物都不支持「无 max-width」的观察：

- `src/ui/styles.css`（`#chat`）：`max-width: 948px` + 居中，2026-09-20（`2864434a`）起就在，远早于 4.8.0；
- `src/ui/critical.css`（首绘内联）：`max-width: 1120px; margin: 0 auto`；
- 重建产物（vite build）核实打包后规则完整：首绘 1120px → deferred 948px，`#input-bar` 同宽对齐；
- 无运行时 JS 覆盖（`style.width` / `style.maxWidth` 写入零命中）；多会话模式的 `.session-transcript` 宿主也挂在 `#chat` 内，同受约束；
- 948px 不是随手值：tool-grid 三列 264px 布局按「948 − 32px padding × 2 = 884px 内容」推导（styles.css 内注释）。

当时建议的 `min(920px, 100%)` 与现状语义相同。若能再拿到当时的截图/复现步骤，值得核对观察的是否为别的表面（工作台/overlay/图表卡），否则此条按误报结案。

## 五、问题 4：工具侧两处可观测性缺陷

1. **`read_file` 把 UTF-16 文本判成二进制。**
   证据：`~/.pure/gui_errors.log` ts `1794624661781` —
   `read_file: 'verify.txt' 是二进制文件（未知二进制文件），不是文本文件`。
   `verify.txt` 是 PowerShell `>` 重定向产物（UTF-16LE）。模型因此多跑一轮 `--out` 改写。
   建议：`read_file` 识别 `FF FE` / `FE FF` BOM 后按 UTF-16 解码，或在判二进制前先试解码。

2. **`execute_command` 的 stderr 混入 CLIXML 进度对象。**
   证据：同日志 `1794624641825`、`1794624660427`、`1794624666497`，错误正文被
   `<Objs Version="1.1.0.1" …><Obj S="progress" …>` 淹没，真实报错（脚本输出）反而要翻半天。
   建议：PowerShell 包装加 `-NoProfile -NonInteractive` 并抑制进度流（`$ProgressPreference='SilentlyContinue'`），或从 stderr 剥离 CLIXML。

这两条不改功能正确性，但直接抬高长任务的往返次数，属可控成本。

### 修复记录（2026-11-14）

- **UTF-16**：`extract_file_text`（lib.rs）在 `looks_binary` 判定前先认 `FF FE` / `FE FF` BOM 并按 UTF-16 解码——PowerShell `>` 重定向产物（UTF-16LE，ASCII 段高字节全 0）不再被判成二进制。无 BOM 的 UTF-16 无从可靠识别，维持启发式原样。新增测试 `extract_file_text_decodes_utf16_bom_before_binary_verdict`（LE/BE 双向）。
- **CLIXML**：三层。源头（Rust + TS 同刀）——`powershell_command_wrapped`（lib.rs）与 `encodePowerShellCommand`（NodeToolAdapter，execute_command 的 TS 镜像）、`userHookRunner`（hook 的 stderr 是 veto reason 来源）统一前置 `$ProgressPreference='SilentlyContinue';`，进度流不再序列化进 stderr；兜底（Rust）——`unwrap_clixml` 重写，支持「真实报错在前 + progress envelope 粘在尾部」形态（旧逻辑要求整条 stderr 以 `#< CLIXML` 开头才剥，这正是判例里错误正文被淹没的漏网路径），只从 `<S S="…">` 流记录回收文本，无流记录的 envelope 整体丢弃（原 zh-CN 启动噪声判例的等价物），识别不了的结构透传不吞，原 `strip_powershell_startup_progress` 职责被覆盖、已移除。TS 侧 `stripPowerShellStartupProgress`（powershellOutput.ts）仍只认英文 warm-up 文案——源头抑制后正常路径不再触达，暂不动它的 hooks veto 契约；若第三方 spawn 场景再漏再通用化。Rust 新增测试 4 条（clixml 7 全过）；TS 侧 `runs Windows audit and verification without CLIXML`（真跑 PowerShell 的集成测试，基线上 zh-CN 首次模块加载场景必失败）修复后转绿。

## 六、问题 5：正常流程的日志级别

`gui_errors.log` 里 `[ctx-shape] 交付门禁进入: needsDeliveryGate=true …` 以 `kind:"error"` + 完整 stack 落盘（ts `1794624868096`、`1794624279078`）。这是设计内的正常路径，却和真正的 `panic` / `tool_error` 混在同一个台账里。建议降为 `kind:"info"`/`"trace"` 或独立台账，保留 `panic`/`error` 的可检索性。

### 修复记录（2026-11-14）

台账（`errorLedger.ts`）新增 `kind:"info"` + 模块级诊断通道（`setGuiDiagnosticSink` 在 main.ts 装配、`recordGuiDiagnostic` 供 chat.ts 调用，避免 chat→main 循环 import）。chat.ts 两处设计内正常路径改走 info：`[ctx-shape] 交付门禁进入`、`[ctx-shape] 修复轮启动`——不再带 stack 灌台账。两处**非数组守卫**（`runDeliveryFixRound` / `send` 主回合）是真异常信号，保持 `kind:"error"` 不动。新增测试 `records info-kind diagnostics without stack noise`。

## 七、排除项（本轮验证「不是问题」的结论）

| 观察 | 结论 | 证据 |
|---|---|---|
| 卡死 / 假死 | 未复现 | r1 1500s / 2856 采样：pump max 15ms、p99 3ms、失败 0、`IsHungAppWindow` 0、CDP 断连 0，内存 18→32MB；r2 1277 采样：pump max 18ms、p99 5ms、失败 0、hung 0，CPU 0→9s，内存 18→44MB；r3 900s 纯挂机 1726 采样：pump max 17ms、p99 0、失败 0、内存 19→33MB |
| 工具密集型长流式 | 不卡 | 46 轮 / 377s / 15 次命令 / 13 次读 / 2 次写 / 160 万 prompt tok，TTFT 2.2s；期间帧 p95 10ms、max 11–40ms、longtask 0；结束输出「✅ 交付验证通过」，输入框立即恢复可用 |
| 20k–65k 字符流式 | 不卡 | 帧 p95 10ms、max 37–91ms、longtask 0；流式中拖窗（1054,244→834,367）pump 0–8ms |
| 最小化 / 恢复 / 关闭 | 正常 | 最小化期间内容继续增长（58099→61680）；关闭有任务时按设计最小化并写审计；连续 3 轮 close→reopen 全部正常 |
| 最大化 / 缩放 | 正常 | 3456×1408 最大化与 900×640 来回，`innerWidth` 精确跟随（1400×850 / 884×631），pump max 21–30ms |
| 会话切换竞态 | 正常 | 12M tok / 205,705 字符会话加载 1.7s，heap 106MB，4 次 longtask（max 80ms）；加载中新建会话并发送，回复正常 |
| 「窗口看起来被放大」 | 测量误判 | `innerWidth 1400×850`、`devicePixelRatio 1`、`visualViewport.scale 1`、`zoom 1`、body 16px —— 页面无缩放，是注入滚轮/截图缩放造成的观感 |
| OS 键盘打不进字 | 环境问题 | 搜狗输入法把所有合成键变成 `VK_PROCESSKEY`（`key:"Process"`）；用 CDP `Input.insertText` 粘贴通道一切正常 |
| panic | 本轮无新增 | `gui_errors.log` 无新 `panic`；旧的 `cannot move state from Destroyed`（tao 0.35.3）是 2026-11-12 旧账 |

## 八、下一步

1. ~~修问题 1（去掉 unref + 回归测试），修完跑全量 `bun test` 确认不再卡。~~ 已修（2026-11-14），approvals 单文件 11 pass / 83ms（修前卡死 >90s）；channels 17 文件 140 pass / 2.3s。另有发现：本机 Bun 1.3.14 的 test runner 在大文件数批量场景（`bun test src/channels` 父目录过滤 / 无参全量）自身挂死，与测试代码无关（逐文件全绿）——升级到 CI 同版 **bun 1.4.3** 后全量 `bun test` 85s 跑完（5386 测试 / 365 文件）。
2. 问题 2 的剩余动作是「抓发送方」：复现时用窗口消息钩子/ETW，或在 `CloseRequested` 里记录调用方上下文；当前已能区分正常退出与硬杀，不再阻塞结论。
3. ~~问题 3/4/5 择机修，成本都在单点。~~ 4/5 已修（2026-11-14）；3 复核为疑似误报（见第四节），按误报结案或待补充观察面。

## 九、修复轮收尾状态（2026-11-14）

- 全量 `bun test`（bun 1.4.3）：5381 pass / 3 fail / 2 skip，85s。3 个 fail 为基线共有、与本轮改动无关的环境类问题：`skillDistill` 的 HOME-missing subprocess（本机 bun 走 npm `.cmd` shim，bun 1.4.3 拒绝向 .bat/.cmd 传含换行参数；CI 的原生 bun.exe 无此限制）、`browser.test.ts` ×2（真实 headless Chrome 端到端，退出异步后 `rmSync` 临时 profile 撞 EBUSY）。基线对拍：改动前 4 fail（含 `runs Windows audit and verification without CLIXML`），改动后 3 fail，净减 1、零新增。
- `cargo test --lib`：与基线失败名单完全一致（22 个既有 Windows 平台测试债务：路径分隔符假设、`Instant` 减法溢出、sidecar 文件名非法等），本轮零回归；新增/改动测试（clixml ×7、UTF-16 BOM ×2）全绿。
- `tsc --noEmit` 绿。

## 附：取证脚本（临时目录，未入库）

`%TEMP%\opencode\pureqa\`

- `monitor.ps1`：后台启动应用 + 采样（pump、`IsHungAppWindow`、CPU/内存、CDP 存活）+ 捕获 ExitCode；
- `sample.ps1`：独立 pump/CPU/内存采样；
- `cdp.ts`：CDP 驱动（eval / insert / key / click / shot / rect / wait）；
- `probe.js`：页面内帧间隔、timer 抖动、longtask 探针（`window.__qa.snapshot(ms)`）；
- `lib.ps1`：Win32 封装（按类名 `Tauri Window` 找窗口、pump 测量、DOM 坐标点击、强制前台、焦点探测）。
