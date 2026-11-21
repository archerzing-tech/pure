// scripts/lib/axDump.swift
// 一次性把某个进程窗口的 AX 文本与输入框导出成 JSON，供 scripts/gui-probe.ts 判断
// 回复是否落屏。为什么不用 AppleScript：System Events 每读一个属性都是一次 AX IPC，
// 遍历一棵 WKWebView 的树要 60s 上下；这里直连 AXUIElement API，同样的树 ~100ms。
//
// 编译：swiftc -O scripts/lib/axDump.swift -o /tmp/pure-ax-dump
// 用法：/tmp/pure-ax-dump <appName>
// 输出：{"texts":["..."],"areas":[{"x":0,"y":0,"w":0,"h":0,"focused":false,"value":"..."}]}
//
// 窗口被别的 app 盖住时 WKWebView 的 AX 树会疲劳（偶尔整棵读空），调用方需要在每次
// 读之前把目标 app 抬到前台——这份工具只负责读，不负责抢焦点。

import AppKit
import ApplicationServices
import Foundation

func attribute(_ element: AXUIElement, _ name: String) -> CFTypeRef? {
    var value: CFTypeRef?
    guard AXUIElementCopyAttributeValue(element, name as CFString, &value) == .success else { return nil }
    return value
}

func stringAttribute(_ element: AXUIElement, _ name: String) -> String? {
    attribute(element, name) as? String
}

func pointAttribute(_ element: AXUIElement, _ name: String) -> CGPoint? {
    guard let value = attribute(element, name), CFGetTypeID(value) == AXValueGetTypeID() else { return nil }
    var point = CGPoint.zero
    guard AXValueGetValue(value as! AXValue, .cgPoint, &point) else { return nil }
    return point
}

func sizeAttribute(_ element: AXUIElement, _ name: String) -> CGSize? {
    guard let value = attribute(element, name), CFGetTypeID(value) == AXValueGetTypeID() else { return nil }
    var size = CGSize.zero
    guard AXValueGetValue(value as! AXValue, .cgSize, &size) else { return nil }
    return size
}

func boolAttribute(_ element: AXUIElement, _ name: String) -> Bool? {
    (attribute(element, name) as? NSNumber)?.boolValue
}

var texts: [String] = []
var areas: [[String: Any]] = []
/// 窗口外框。AX 会把隐藏的设置面板、离屏会话列表也报上来，只有带真实 frame 的节点
/// 才算「屏幕上看得见」；设置面板收起后没有几何信息，正好被这条挡掉。
var windowBounds = CGRect.zero

func isOnScreen(_ element: AXUIElement) -> Bool {
    guard let point = pointAttribute(element, kAXPositionAttribute),
          let size = sizeAttribute(element, kAXSizeAttribute) else { return false }
    if size.width <= 0 || size.height <= 0 { return false }
    return windowBounds.intersects(CGRect(origin: point, size: size))
}

func walk(_ element: AXUIElement, depth: Int) {
    if depth < 0 { return }
    let role = stringAttribute(element, kAXRoleAttribute) ?? ""
    if role == kAXStaticTextRole {
        if isOnScreen(element), let value = stringAttribute(element, kAXValueAttribute) { texts.append(value) }
    } else if role == kAXTextAreaRole {
        let point = pointAttribute(element, kAXPositionAttribute) ?? .zero
        let size = sizeAttribute(element, kAXSizeAttribute) ?? .zero
        areas.append([
            "x": Double(point.x),
            "y": Double(point.y),
            "w": Double(size.width),
            "h": Double(size.height),
            "focused": boolAttribute(element, kAXFocusedAttribute) ?? false,
            "value": stringAttribute(element, kAXValueAttribute) ?? "",
        ])
    }
    if let children = attribute(element, kAXChildrenAttribute) as? [AXUIElement] {
        for child in children { walk(child, depth: depth - 1) }
    }
}

let args = CommandLine.arguments
guard args.count > 1 else {
    FileHandle.standardError.write("usage: axDump <appName>\n".data(using: .utf8)!)
    exit(2)
}
let appName = args[1]
guard let app = NSWorkspace.shared.runningApplications.first(where: { $0.localizedName == appName }),
      let pid = Optional(app.processIdentifier) else {
    FileHandle.standardError.write("app not running: \(appName)\n".data(using: .utf8)!)
    exit(3)
}

let appElement = AXUIElementCreateApplication(pid)
AXUIElementSetAttributeValue(appElement, "AXManualAccessibility" as CFString, kCFBooleanTrue)
AXUIElementSetAttributeValue(appElement, "AXEnhancedUserInterface" as CFString, kCFBooleanTrue)

guard let windows = attribute(appElement, kAXWindowsAttribute) as? [AXUIElement], let window = windows.first else {
    print("{\"texts\":[],\"areas\":[]}")
    exit(0)
}
if let point = pointAttribute(window, kAXPositionAttribute), let size = sizeAttribute(window, kAXSizeAttribute) {
    windowBounds = CGRect(origin: point, size: size)
}
walk(window, depth: 20)

// WKWebView 里同一段文字会被 AX 拆成多份上报（单词级节点），这里按行去重保持顺序。
var seen = Set<String>()
let uniqueTexts = texts.filter { seen.insert($0).inserted }

let payload: [String: Any] = ["texts": uniqueTexts, "areas": areas]
guard let data = try? JSONSerialization.data(withJSONObject: payload),
      let json = String(data: data, encoding: .utf8) else {
    FileHandle.standardError.write("failed to encode json\n".data(using: .utf8)!)
    exit(4)
}
print(json)
