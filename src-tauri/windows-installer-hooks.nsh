; Windows NSIS 安装钩子（tauri bundle > windows > nsis > installerHooks 接线）。
;
; 根因（docs/windows-gamedvr-collision-2026-11.md）：GUI 主二进制旧名
; `pure.exe` 与微软 KnownGameList.bin 内置游戏 PURE 撞名，GameDVR 把每次
; 启动当成游戏启动、向窗口发 `ms-gamingoverlay://` 启动提示；卸掉 Xbox
; Game Bar 的机器没有该协议处理程序，弹出不消失的空「选取应用」窗。
; 主二进制自 4.7.3 起改名 `pure-app.exe`；本钩子负责清掉升级安装后残留的
; 旧名 exe——孤儿 pure.exe 留在安装目录会继续被名单匹配、继续弹窗。
!macro NSIS_HOOK_POSTINSTALL
  Delete "$INSTDIR\pure.exe"
!macroend
