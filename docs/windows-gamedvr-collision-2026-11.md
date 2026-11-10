# Windows 启动弹「ms-gamingoverlay」空窗：pure.exe 撞微软游戏名单（2026-11 判例）

## 现象

每次启动 Windows 版 GUI（`pure.exe`），弹出一个不消失的空白小方块：

> 获取打开此 "ms-gamingoverlay" 链接的应用 —— 你的电脑没有可打开此链接的应用。

## 根因（真机取证确证，2026-11-10）

**Windows 把 `pure.exe` 误判成一款同名游戏，GameDVR 对它的窗口发「游戏启动提示」，
而提示依赖的 `ms-gamingoverlay://` 协议在卸掉 Xbox Game Bar 的机器上没有处理程序。**

四重证据闭环：

1. **内置名单撞名**：`C:\Windows\bcastdvr\KnownGameList.bin`（Windows 内置游戏识别库）
   含一条记录：exe 名 `pure.exe`、游戏名 PURE、GUID `505d55f1-9ae5-4023-b519-7c8fb8eea3c3`。
   本机 AI Agent 应用与这款游戏**同名文件撞车**。
2. **GameDVR 已按名单建档**：`HKCU\System\GameConfigStore\Children\6727d9ea-…` 的
   `MatchedExeFullPath = D:\applications\pure\pure.exe`、`GameDVR_GameGUID` 与名单 GUID
   **精确一致**——是按内置名单匹配，不是启发式。
3. **弹窗 URL 由系统模板拼出**：`twinui.pcshell.dll` 硬编码
   `ms-gamingoverlay://startuptips?pid=%lu&WindowId=%llu`；`%APPDATA%\Microsoft\Windows\Recent\`
   下每次启动一条实例，PID 与 HWND 与 pure 进程/主窗口双向核对一致（当日 29 条全覆盖）。
4. **闭环复现**：直接 `ShellExecute` 该协议 URL → OpenWith.exe「选取应用」对话框，
   特征与 pure 启动时观察到的一致。

弹窗呈「空白小方块」且不消失：四个协议键（`ms-gamingoverlay` 等）全部缺失 +
`Microsoft.XboxGamingOverlay` 包已被卸载/取消预置 + `GameDVR_Enabled=1` 仍在——
系统找不到协议处理程序 → 回退 OpenWith 对话框，宿主窗口被放在屏幕外，只剩空壳。

**pure 自身从不发起该协议调用**（`pure.exe`/`pure-cli.exe` 二进制 0 命中该字符串）——
全部由系统 GameDVR 发起。

## 修复（产品侧，根治）

**GUI 主二进制改名，退出名单匹配**——匹配键是 exe 文件名，名字不撞即免疫：

- `src-tauri/tauri.windows.conf.json`（Windows 平台覆盖配置，macOS 不受影响）：
  `"mainBinaryName": "pure-app"` → Windows GUI 主二进制 `pure-app.exe`；
- `src-tauri/windows-installer-hooks.nsh`：NSIS `NSIS_HOOK_POSTINSTALL`
  `Delete "$INSTDIR\pure.exe"`——升级安装后清掉孤儿旧 exe，防残留继续被名单匹配。

为什么 CLI（`pure.exe` 下载名 / `~/.pure/bin/pure.exe`）不改：弹窗需要带窗口的
「游戏」进程（URL 携带 `WindowId`）；CLI 是无窗口控制台进程，不触发启动提示。
CLI 身份（Release 下载名、安装路径、gateway 用法）原样保留，用户习惯零变化。

Rust 代码零改动：GUI 从不硬编码自己的 exe 名（一律 `current_exe`）；
活代码里的 `pure.exe` 字面量全部是 CLI 身份。测试夹具里的 `pure.exe` 是
名字无关的仿真路径，不受影响。

## 机器侧立即止损（已装旧版的 Windows 机器）

```cmd
reg add "HKCU\System\GameConfigStore" /v GameDVR_Enabled /t REG_DWORD /d 0 /f
reg delete "HKCU\System\GameConfigStore\Children\6727d9ea-b0d4-4c8c-a78c-a3e758dad466" /f
```

副作用说明：`GameDVR_Enabled=0` 全局关闭 GameDVR（本机已卸 Xbox Game Bar，
通常正合意；需要录制游戏画面的机器别关）。删除的 Children 条目在旧版
`pure.exe` 还在运行期间可能重建，装上改名版后断根。

## 排查中顺带发现（独立缺陷，非本弹窗主因）

`.ts` 等十余个扩展名的 `UserChoice\ProgId` 指向未安装的 AppX 包，
`AssocQueryString` 返回 `ERROR_NO_ASSOCIATION`——双击这些文件会弹「选取应用」。
与 pure 无关（弹窗 URL 携带的是 pid+WindowId，pure 二进制也不含相关字符串），
属系统/其他软件遗留，建议在系统侧单独修复。

## 复验标准

1. 安装改名版（4.7.3+）后，安装目录只有 `pure-app.exe`（旧 `pure.exe` 被钩子清除）；
2. 反复启动 GUI，不再出现 `ms-gamingoverlay` 弹窗，
   `%APPDATA%\Microsoft\Windows\Recent\` 不再新增 `ms-gamingoverlay://` 条目；
3. `HKCU\System\GameConfigStore\Children\` 不再为 `pure-app.exe` 建档（名单不匹配）；
4. gateway/侧车（`pure-cli.exe`）、CLI 安装面板、自动更新链路行为不变。
