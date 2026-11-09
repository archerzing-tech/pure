//! Windows:灭掉无边框窗口的「顶边系统 resize 热区」。
//!
//! 判例(2026-11-09 真机卡死):tauri 默认 shadow:true + decorations:false 时,
//! tao 在 WM_NCHITTEST 里给客户区顶部注入一条 SM_CYFRAME(~4-8px)的隐形热区
//! (返回 HTTOP)。用户连点标题栏一带即落进 DefWindowProc 的模态 sizing 循环
//! (WM_ENTERSIZEMOVE):输入全被系统循环吞掉——纯窗口移动/关闭/输入全是
//! WebView 自绘,于是「不可移动、不可输入、不可关闭」;光标被切成上下双箭头
//! (SIZENS);而 WebView2 渲染在独立进程照常出帧,流式内容还在动。五个现象
//! 同源。本模块 subclass 窗口过程,把 WM_NCHITTEST 一律答 HTCLIENT,系统热区
//! 从根上消失;边缘 resize 改由 WebView 自绘热区接手(resizeZones.ts →
//! startResizeDragging,与原生热区走同一条 WM_NCLBUTTONDOWN 消息链)。
//!
//! resizable 保持 true 不动:WS_SIZEBOX 还在,Aero snap(Win+方向键)不受影响。

use std::collections::HashMap;
use std::sync::{LazyLock, Mutex};

use windows_sys::Win32::Foundation::{HWND, LPARAM, LRESULT, WPARAM};
use windows_sys::Win32::UI::WindowsAndMessaging::{
    CallWindowProcW, DefWindowProcW, SetWindowLongPtrW, GWLP_WNDPROC, HTCLIENT, WM_NCHITTEST,
    WM_NCDESTROY, WNDPROC,
};

/// hwnd → 前一个窗口过程。subclass 链只有一个环节:窗口关闭(WM_NCDESTROY)
/// 时摘除条目——Windows 会复用句柄值,残留条目会让同值新窗被误判「已 subclass」
/// 而漏掉,且旧 prev 指针指向已销毁的过程。
static PREV_PROCS: LazyLock<Mutex<HashMap<usize, isize>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

/// 对一个 pure 窗口灭活原生 resize 热区。可重复调用(幂等)。
/// SetWindowLongPtrW(GWLP_WNDPROC) 要求在窗口所属线程执行,统一派发主线程。
pub fn disable_native_resize_hotzones(window: &tauri::WebviewWindow) {
    let dispatcher = window.clone();
    let for_closure = window.clone();
    let _ = dispatcher.run_on_main_thread(move || unsafe { subclass_window(&for_closure) });
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
        return;
    }
    PREV_PROCS.lock().unwrap().insert(key, prev);
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
