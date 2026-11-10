# Windows 无边框窗口卡死判例（2026-11-10）

> 现场：Windows 11 + tauri 2.11.5 / tauri-runtime-wry 2.11.4 / tao 0.35.3 / wry 0.55.1 / WebView2 157。
> 症状：pure 窗口不可点击、不可输入、不可关闭；主线程 `Responding=False`、`IsHungAppWindow=True`，CPU 与内存占用都不高，桌面其他应用正常。
> 本文分三块：复核现场报告的结论、在代码里落到的实锤机制、本次施工与后续取证步骤。

## 一、现场报告复核

采信（证据链自洽，无需重做）：

- 主线程状态 `Running` + 指令指针在 `win32u.dll` 的 `NtUserSetWindowPos` / `NtUserMessageCall` / `NtUserShowWindow` 三点往复 + `RSP` 多次完全相同 → 排除死锁，确认是**同深度、可反复进入的窗口消息处理路径**，不是递归、不是阻塞。
- 同样的采样排除内存泄漏、句柄泄漏、网络阻塞、子进程卡住、DPI 冲突、窗口几何震荡。
- 「宿主忙、渲染进程也在跑」= 消息泵被反复占用，不是渲染停摆。

**要修正的两处**（这两处直接决定修法，不能留）：

1. **「流式重渲染 → 容器高度变化 → Tauri 调 WebView2 同步窗口布局 → 重排正反馈」这条链在当前代码里不存在。**
   前端没有任何 `setSize` / `setPosition` / `innerSize` 写入（全仓只有 `startResizeDragging` 与建窗时的 `inner_size`）；长回复的流式渲染早已是合批 + rAF 收口（`chat.ts` 的 50ms/16KB 批、`scrollPin.ts` 的单 rAF 滚动）。DOM 变化不会让顶层窗口发 `SetWindowPos`。
   → 所以「66KB 长消息」最多是**放大器**（它让渲染进程满载、让重绘更密），不是机制。把修法押在「流式渲染降频」上是打偏的。

2. **2026-11-09 的修法（顶层窗口过程 `WM_NCHITTEST` 一律答 `HTCLIENT`）落在错的对象上。**
   顶边那条原生热区并不是顶层窗口答的，而是 `tauri-runtime-wry` 往窗口里塞的一个**铺满客户区的子窗**答的（见下节）。顶层过程根本收不到那条命中——热区一直还在，11-10 的复现正好证明这一点。

## 二、代码里的实锤机制

`decorations: false` 在 Windows 上会让 `tauri-runtime-wry` 走 `undecorated_resizing`（`src/undecorated_resizing.rs`）：

| 位置 | 行为 | 后果 |
| --- | --- | --- |
| `attach_resize_handler`（:117） | 创建一个 `WS_CHILD｜WS_VISIBLE`、铺满客户区、用 `SetWindowRgn` 挖掉中间的 `TAURI_DRAG_RESIZE_BORDERS` 子窗，并 `SetWindowSubclass` 顶层窗口 | 客户区边条被这个子窗接管 |
| 子窗 `WM_NCHITTEST`（:277） | `has_undecorated_shadows`（tauri 默认 `shadow: true`）时**恒答 `HTTOP`** | 顶边连点必落进 `DefWindowProc` 的模态 sizing 循环（`WM_ENTERSIZEMOVE`）：输入被系统循环吞掉、光标变 `SIZENS` |
| 子窗 `WM_NCLBUTTONDOWN`（:324/:374） | `PostMessageW(parent, WM_NCLBUTTONDOWN, HTTOP, POINTS{客户端坐标})` | **异步投递 + 把客户区坐标当屏幕坐标用**。连点时投递还在队列里鼠标已抬起，循环拿到的是一次「按着却永远等不到抬起」的 sizing —— 窗口钉死在循环里，正是「只有 pure 死、其他应用正常」 |
| 顶层 `WM_SIZE`（:207） | 每个 `WM_SIZE` 都 `GetWindowPlacement` + `SetWindowPos(child, HWND_TOP, w, h, …)` + `set_drag_hwnd_rgn`→`CreateRectRgn/CombineRgn/SetWindowRgn(bRedraw=true)`（:231/:413/:437） | 主线程窗口链路上**常年挂着 win32u 的 SetWindowPos/SetWindowRgn**。tauri#15569 记的正是这段代码的 `WM_SIZE` 吞吐逐帧退化，#15614 才把 `SetWindowRgn` 降频 |

另有一处同族入口在前端：tao 的 `begin_resize_drag` 是 `PostMessageW(hwnd, WM_NCLBUTTONDOWN, HT方向, 光标点)`（`tao-0.35.3/src/platform_impl/windows/window.rs:997`）。也就是说**自绘热区「按下即发」和原生热区是同一个消息链**，连点同样能把窗口钉进 sizing 循环——11-09 之后前端接手热区，等于把旧入口原样搬了一遍。

## 三、本次施工

1. **`src-tauri/src/hotzone.rs`：把上游那个 resize 子窗隐藏**（`hide_native_resize_child`）。
   - 隐藏窗不参与命中测试 → `HTTOP` 无从产生，模态 sizing 循环的第一入口消失；
   - 每个 `WM_SIZE` 的 `SetWindowPos` + `SetWindowRgn` 落在不可见窗上 → 重绘与区域失效一并消失，主线程窗口链路只剩顶层 subclass 的一次判断；
   - 顶层 `WM_NCHITTEST` 答 `HTCLIENT` 的 subclass **保留**（离屏/无子窗命中场景的兜底）；
   - 找不到子窗（上游改类名/标题、或将来版本不再需要它）时写一行 `kind:"resize_hotzone"` 到 `~/.pure/gui_errors.log`，不让「已灭活」变成无头案；成功是常态，不刷账。
   - **为什么不 `DestroyWindow`**：tauri 的 subclass 数据里存着这个子窗句柄，销毁后每个 `WM_SIZE` 仍会拿它调 `SetWindowPos`/`SetWindowRgn`——句柄值被系统复用（本进程里 WebView2 会动态建窗）时就会误改别人的窗，而那条 subclass 无法从外部摘除。隐藏保留句柄，代价为零。

2. **`src/ui/resizeZones.ts`：边缘 resize 加「真拖拽」闸门**。
   按下只登记起点，指针位移超过 `RESIZE_DRAG_THRESHOLD_PX`(3px) 才 `startResizeDragging`；纯点击、连点、手抖永远不进模态循环；松手/移出/左键已抬一律拆监听，一次拖拽只发起一次。鼠标移动走捕获阶段、监听挂在 `window` 上，指针移出热区也跟得住。

3. **测试**：`src/ui/__tests__/resizeZones.test.ts`（8 例）钉住阈值语义、点击/抖动/迟到 move/非左键不进循环、方向透传、一次拖拽只发一次，以及 boot 时确实调了 `disable_resize_hotzones`。

4. **验证**：`cargo check --target x86_64-pc-windows-gnu --lib` 过；`bun run typecheck` 过；`bun test src/ui/__tests__/resizeZones.test.ts` 8/8 过；`bun test src/ui` 1762 pass / 0 fail。

5. **通知不再占主线程**（2026-11-10 追加，见第五节）：`send_turn_notification` 的 `show + wait_for_action` 整段进线程，失败落台账。

## 四、尚未确证的部分（别当成已修）

11-10 那次是**忙碌循环**（主线程烧 CPU），11-09 那次是**模态循环等待**（不烧 CPU）。本次两笔只覆盖「模态 sizing 循环」这一族入口，以及「每帧 `SetWindowPos`+`SetWindowRgn`」这条常驻开销；**忙碌循环的确切发起者仍未确定**——现场报告的推断（流式重绘驱动窗口同步）不成立，需要真机取证。建议按顺序做：

1. **先要符号再要转储**：用该版本构建产出的 `pure.pdb`（流水线 artifact `gui-windows-pdb`，见 4.1），`procdump -ma -t` 抓主线程全量转储，`kv` 看到底是哪一层（`pure.exe+0x406F80` 应当能解析成 tao/wry 的窗口过程），并把**当前分发的消息号**（`GetMessage` 返回后 `uMsg`）一起记下来——决定是 `WM_SIZE` / `WM_WINDOWPOSCHANGED` / `WM_PAINT`，这一条就能把剩下的假设砍到一两个。
2. **ETW**：`wpr` 同时开 CPU 采样 + 窗口管理器提供程序，看 `SetWindowPos` 的调用频率与调用者，确认循环里被反复调用的到底是哪一个窗口。
3. **A/B 两件对照**（只做实验、不直接发版）：WebView2 从 157 回退 156 看复现率；用 `tauri.windows.conf.json` 覆写 `transparent: false` 看复现率（透明窗口走的是 WebView2 另一条宿主路径）。`shadow: false` **只可作对照**——那会把四边热区全部复活，正式版别开。
4. 若确认为 tao/wry 的布局反馈：升级 `tauri-runtime-wry` 到含 #15614 的版本，或 `[patch.crates-io]` 打最小补丁（上游修法即 `SetWindowRgn` 降频）。

### 4.1 符号怎么拿到（2026-11-10 追加）

release 流水线此前只交接安装包与 `.sig`，`pure.pdb` 从不出仓库 → 任何转储都只能停在 `pure.exe+0x406F80`。已补：Windows job 上传 `gui-windows-pdb`（`src-tauri/target/release/pure.pdb`，只作 workflow artifact，不进公开 Release）。拿到与故障构建**同一次**的 exe + pdb 后：

```bat
:: 单点解析（cdb 随 Windows SDK / WinDbg 安装）
cdb -z pure.DMP -c "ln pure+0x406f80; kb; lm; .detach"
:: 或先加载符号再看全栈
cdb -z pure.DMP -c ".sympath <exe+pdb 目录>; .reload /f pure.exe; ~0s; kv; .detach"
```

判读要点：解析出的符号是 **tao/wry 的窗口过程**还是 **`#[tauri::command]` 的处理函数**，直接决定下一刀往哪切（前者=框架布局反馈，后者=应用 IPC 路径）。

## 五、外部建议复核（2026-11-10 追加）

三条建议逐条落到本仓代码上，结论两否一取：

| 建议 | 复核结论 | 证据 |
| --- | --- | --- |
| ① 把涉及窗口布局的同步命令改 async | **本仓无对象**：全仓没有 `set_size` / `set_position` / `set_inner_size` / `set_outer_position` / `set_bounds` 调用；窗口 API 只有 4 处（`show_all_windows` 的 `show/unminimize/set_focus`、`CloseRequested` 的 `hide/minimize`），都不在命令里，`on_window_event` 也不做任何同步等待（通知早已 `thread::spawn`）。44 个同步命令（lib.rs 41 + mcp.rs 3）逐条过：配置/密钥/会话/技能/进程类，没有一条碰窗口几何或 WebView2 布局。 | `rg 'set_size\|set_position\|set_inner_size\|set_bounds' src-tauri/` 零命中 |
| ② 要 PDB 才能定位 `pure.exe+0x406F80` | **对，且是唯一卡点**——已补流水线符号交接与解析命令（见 4.1）。补充：真正判定归属要看**解析出的符号**，不能只看偏移落在哪个 DLL。 | `.github/workflows/release.yml` 新增 `gui-windows-pdb` |
| ③ 警惕 `useLayoutEffect` 里调 `invoke()` | **场景不成立**：pure 前端是原生 TypeScript + DOM，`package.json` 无 React，`src/ui` 里 `useLayoutEffect`/`useEffect` 零命中；rAF 回调里也没有 `invoke`（rAF 只做 `scrollHeight`/`clientHeight` 的滚动收口）。其精神（别在绘制关键路径上做 IPC 往返）本仓早已是纪律：流式渲染 50ms/16KB 合批、命令输出 100ms/8KB 合批、滚动单 rAF。 | `rg 'useLayoutEffect\|useEffect\(' src/ui` 零命中 |

**同族唯一真问题（顺带修掉）**：`send_turn_notification` 是**同步**命令，同步命令跑在 WebView 的 IPC 回调线程（Windows 上就是主线程），而 `notify_rust::Notification::show()` 在 Windows 上是同步 WinRT + shell 调用（注册 AUMID → `ToastNotifier::Show`，整段跨进程 RPC）。2026-09-17 的「关窗提示阻塞主线程」判例只把 `wait_for_action` 挪进了线程，`show()` 漏在主线程上——现在 `show + wait` 整段进同一条线程，命令即发即忘，失败落四源台账（`kind:"notification_error"`），不静默。

留作观察项、本轮不动：44 个同步命令里仍有若干做小体量磁盘 I/O（`load_config` / `secret_*` / `save_session_stats` / `load_session_list`）。它们不是卡死形态（毫秒级、无跨进程 RPC），全量改 async 会引入调用序与错误语义的回归风险；什么时候有实测证据显示某条命令占了主线程，再单条迁 `run_blocking`。

## 六、Windows 11 真机验收清单

- 窗口放在**副屏**：顶边连点 20 次、顶边双击、四边八角拖动、Aero snap（Win+方向键）、最大化/还原；玻璃/圆角/阴影外观与本次改动前一致。
- 流式 66KB 级长回复期间：打字、滚动、切会话不卡顿（本条只验「没变差」）。
- `~/.pure/gui_errors.log`（或 `pure errors`）**不应**出现 `kind:"resize_hotzone"` 行；出现即是灭活失败（上游改了类名或句柄时机不对），按行内文案定位。
- 若仍复现：按第四节取证，本轮改动不背这个锅。
