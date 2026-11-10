//! Windows:灭掉无边框窗口的原生 resize 热区。
//!
//! 判例一(2026-11-09 真机卡死):tauri 默认 shadow:true + decorations:false 时,
//! 运行时(tauri-runtime-wry undecorated_resizing)会往窗口里塞一个铺满客户区
//! 的子窗 `TAURI_DRAG_RESIZE_BORDERS`(区域挖掉中间、只留边条),由它的
//! WM_NCHITTEST 回答 HTTOP/HTLEFT…。顶边热区连点即落进 DefWindowProc 的模态
//! sizing 循环(WM_ENTERSIZEMOVE):输入全被系统循环吞掉——纯窗口移动/关闭/
//! 输入全是 WebView 自绘,于是「不可移动、不可输入、不可关闭」;光标被切成
//! 上下双箭头(SIZENS);而 WebView2 渲染在独立进程照常出帧,流式内容还在动。
//!
//! 判例二(2026-11-10 真机卡死,同一现场复验):上一版只 subclass 了**顶层**
//! 窗口的 WM_NCHITTEST,而顶边那条热区其实由上面那个子窗命中——顶层过程根本
//! 收不到,热区照旧存在;该子窗还在**每个 WM_SIZE** 上被 SetWindowPos +
//! CreateRectRgn/CombineRgn/SetWindowRgn 重修一遍(tauri#15569 记的正是同一段
//! 代码的 WM_SIZE 吞吐退化,#15614 才把 SetWindowRgn 降频)。主线程窗口链路上
//! 于是常年挂着 win32u 的 SetWindowPos/SetWindowRgn,与故障快照里主线程
//! 「Running + 在同一组 win32u 地址往复」的形态同一族。
//!
//! 本版把该子窗整个隐藏:隐藏窗不参与命中测试,HTTOP 无从产生;每个 WM_SIZE 的
//! 重修落在一个不可见窗上,重绘与区域失效一并消失。顶层 subclass 保留(无子窗 /
//! 离屏命中场景的兜底),边缘 resize 仍由 WebView 自绘热区接手
//! (resizeZones.ts → startResizeDragging,与原生热区走同一条 WM_NCLBUTTONDOWN
//! 消息链)。
//!
//! 为什么不是 DestroyWindow:tauri 的 subclass 数据里存着这个子窗句柄,销毁后
//! 每个 WM_SIZE 仍会拿它调 SetWindowPos/SetWindowRgn(句柄值被系统复用时就会
//! 误改别人的窗),而那条 subclass 无法从外部摘除。隐藏保留句柄,代价为零。
//!
//! resizable 保持 true 不动:WS_SIZEBOX 还在,Aero snap(Win+方向键)不受影响。

use std::collections::HashMap;
use std::sync::{LazyLock, Mutex};

use windows_sys::Win32::Foundation::{HWND, LPARAM, LRESULT, WPARAM};
use windows_sys::Win32::UI::WindowsAndMessaging::{
    CallWindowProcW, DefWindowProcW, FindWindowExW, IsWindowVisible, SetWindowLongPtrW, ShowWindow,
    GWLP_WNDPROC, HTCLIENT, SW_HIDE, WM_NCDESTROY, WM_NCHITTEST, WNDPROC,
};

/// tauri-runtime-wry 无边框 resize 子窗的类名与窗口名(undecorated_resizing.rs
/// 里的 CLASS_NAME / WINDOW_NAME)。改名即代表上游换了实现——那时本模块的
/// 灭活会落空,必须让台账说话(见 record_hotzone_log),不能静默。
const DRAG_BORDER_CLASS: &str = "TAURI_DRAG_RESIZE_BORDERS";
const DRAG_BORDER_TITLE: &str = "TAURI_DRAG_RESIZE_WINDOW";

/// hwnd → 前一个窗口过程。subclass 链只有一个环节:窗口关闭(WM_NCDESTROY)
/// 时摘除条目——Windows 会复用句柄值,残留条目会让同值新窗被误判「已 subclass」
/// 而漏掉,且旧 prev 指针指向已销毁的过程。
static PREV_PROCS: LazyLock<Mutex<HashMap<usize, isize>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

/// 灭活一个 pure 窗口的原生 resize 热区(顶层 WM_NCHITTEST + 上游 resize 子窗)。
/// 可重复调用(幂等)。两个 SetWindowLong/Show 都需要窗口所属线程,统一派发主线程。
pub fn disable_native_resize_hotzones(window: &tauri::WebviewWindow) {
    let dispatcher = window.clone();
    let for_closure = window.clone();
    let _ = dispatcher.run_on_main_thread(move || unsafe {
        subclass_window(&for_closure);
        hide_native_resize_child(&for_closure);
    });
}

unsafe fn subclass_window(window: &tauri::WebviewWindow) {
    let Ok(hwnd) = window.hwnd() else { return };
    let key = hwnd.0 as usize;
    if PREV_PROCS.lock().unwrap().contains_key(&key) {
        return; // 已 subclass,再叠一层只会让 prev 链多绕一跳
    }
    let prev = SetWindowLongPtrW(hwnd.0, GWLP_WNDPROC, hotzone_wndproc as isize);
    // 0 = 失败(合法的窗口过程地址不可能为 0);失败就不动,行为退回原生热区。
    if prev == 0 {
        record_hotzone_log("subclass_window failed: SetWindowLongPtrW returned 0");
        return;
    }
    PREV_PROCS.lock().unwrap().insert(key, prev);
}

/// 隐藏上游那个铺满客户区的 resize 子窗。找不到 = 上游换了类名/标题(或该版本
/// 压根没有这个子窗),必须记账:热区来源变了,别让「已灭活」变成无头案。
unsafe fn hide_native_resize_child(window: &tauri::WebviewWindow) {
    let Ok(hwnd) = window.hwnd() else { return };
    let class: Vec<u16> = DRAG_BORDER_CLASS.encode_utf16().chain(std::iter::once(0)).collect();
    let title: Vec<u16> = DRAG_BORDER_TITLE.encode_utf16().chain(std::iter::once(0)).collect();
    let child = FindWindowExW(hwnd.0, std::ptr::null_mut(), class.as_ptr(), title.as_ptr());
    if child.is_null() {
        record_hotzone_log(
            "native resize child not found (tauri runtime class/title changed?) — top-edge hotzone may be live",
        );
        return;
    }
    if IsWindowVisible(child) == 0 {
        return; // 已隐藏(幂等:前端每次 boot 都会再调一次)
    }
    ShowWindow(child, SW_HIDE);
    if IsWindowVisible(child) != 0 {
        record_hotzone_log("hide native resize child failed — top-edge hotzone is still live");
    }
}

/// 落一行到四源错误台账(~/.pure/gui_errors.log),source:"rust"。只在灭活
/// 失败/落空时写:成功是常态,不该在台账里刷屏。永不 panic。
fn record_hotzone_log(message: &str) {
    let ts = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0);
    let line = serde_json::json!({
        "ts": ts,
        "source": "rust",
        "kind": "resize_hotzone",
        "message": message,
    })
    .to_string();
    let path = format!("{}/.pure/gui_errors.log", crate::pure_home_dir());
    crate::append_error_log_line(&line, &path);
}

unsafe extern "system" fn hotzone_wndproc(hwnd: HWND, msg: u32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
    // 整窗皆客户区:系统不再答 HTTOP/HTBOTTOM 等非客户区码,模态 sizing 循环
    // 无从进入。resize 由前端自绘热区显式发起(同一条消息链,不经过这里)。
    if msg == WM_NCHITTEST {
        return HTCLIENT as LRESULT;
    }
    let key = hwnd as usize;
    let prev = if msg == WM_NCDESTROY {
        PREV_PROCS.lock().unwrap().remove(&key)
    } else {
        PREV_PROCS.lock().unwrap().get(&key).copied()
    };
    match prev {
        Some(p) if p != 0 => CallWindowProcW(std::mem::transmute::<isize, WNDPROC>(p), hwnd, msg, wparam, lparam),
        _ => DefWindowProcW(hwnd, msg, wparam, lparam),
    }
}
