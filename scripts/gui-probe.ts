#!/usr/bin/env bun
// scripts/gui-probe.ts
// 桌面 GUI 真机探针：往打包后的 pure.app 里发一句话，等回复落屏，断言并截图回读。
//
// 为什么不用 CDP：macOS 的 Tauri 跑在 WKWebView 里，没有 Chrome 那套远程调试协议。
// 能用的通道是系统级输入（辅助功能 AX + cliclick）加整屏截图。
//
// 四个真机判例（都踩过，别再踩）：
//   1) System Events 的 `entire contents` 不会递归进 AXWebArea——在 pure 上永远返回 0，
//      但逐层 UI elements 能看到完整 web 树（AXWebArea 下面 100+ 元素）。
//   2) 用 AppleScript 遍历那棵树要 60s（每个属性一次 AX IPC）。scripts/lib/axDump.swift
//      直连 AX API，同样的树约 100ms；AppleScript 版本只留作 swiftc 不可用时的兜底。
//   3) 窗口被遮挡时键盘事件会打到别人身上（真机上直接粘进了终端窗口）。每次读写前都先
//      把目标窗口抢回前台。
//   4) AX 对 web 元素可能报 position 0,0。0 坐标一律不点（会点到菜单栏），改用窗口宽高
//      比例兜底。
//   5) AX 导出的是整棵 DOM 的文字，侧边栏会话列表与隐藏的设置面板也在里面。所以 --expect
//      要选只可能出现在回复里的词，别拿会话标题级别的词当断言；errorHits 也得掐掉长句，
//      要不然设置里的「直连失败会自动改走加速节点」会被当成报错。
//
// 前置：宿主（终端 / IDE）需要「辅助功能」与「屏幕录制」权限，首次运行 macOS 会弹窗。
//
// 用法：
//   bun run scripts/gui-probe.ts --prompt "只回复四个字：桌面成功" --expect 桌面成功
//     [--out tmp/gui.png] [--timeout 240000] [--app pure] [--new-chat] [--no-shot]
//
// 退出码：0 = expect 命中；1 = 超时/未命中；2 = 参数错误。stdout 是一行 JSON。

import { existsSync, mkdirSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, resolve } from 'node:path';

const argv = process.argv.slice(2);
const argValue = (name: string): string | undefined => {
  // 两种写法都认：`--out=x.png` 和 `--out x.png`（手敲时后者更自然）。
  const eq = argv.find((a) => a.startsWith(`${name}=`));
  if (eq) return eq.slice(name.length + 1);
  const i = argv.indexOf(name);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : undefined;
};
const hasFlag = (name: string): boolean => argv.includes(name);

const prompt = argValue('--prompt');
const expect = argValue('--expect');
const appName = argValue('--app') ?? 'pure';
const outPath = resolve(argValue('--out') ?? 'tmp/gui-probe.png');
const timeoutMs = Number(argValue('--timeout') ?? 240_000);
const settleMs = Number(argValue('--settle') ?? 1_500);
const wantShot = !hasFlag('--no-shot');

if (!prompt) {
  console.error('用法：bun run scripts/gui-probe.ts --prompt "..." [--expect 子串] [--out 截图路径] [--timeout ms] [--app pure] [--new-chat] [--no-shot]');
  process.exit(2);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const t0 = Date.now();
const occurrences = (hay: string, needle: string): number => (needle ? hay.split(needle).length - 1 : 0);

// ── AppleScript ────────────────────────────────────────────────────────────
// 应用名来自命令行，进 AppleScript 字面量前必须转义，否则带引号的进程名会截断脚本。
const asLit = (s: string): string => `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;

function osa(script: string): string {
  const r = Bun.spawnSync(['osascript', '-e', script]);
  const out = r.stdout.toString();
  if (r.exitCode !== 0) throw new Error(`osascript 失败：${r.stderr.toString().trim() || out.trim()}`);
  return out;
}

// 按钮缺失 / AX 暂时读不到都不该让整个探针抛错，走这条不抛的通道。
function softOsa(script: string): string {
  const r = Bun.spawnSync(['osascript', '-e', script]);
  return r.exitCode === 0 ? r.stdout.toString() : '';
}

/**
 * 抢回前台。窗口被别的 app 盖住时键盘会打到别人身上；每次读 AX 或敲键之前都确认一遍，
 * 成本只有一次 osascript（~30ms）。
 */
function ensureFront(): void {
  const front = softOsa(`tell application "System Events" to tell process ${asLit(appName)} to get frontmost`).trim();
  if (front === 'true') return;
  softOsa(`tell application "System Events" to set frontmost of process ${asLit(appName)} to true`);
  Bun.spawnSync(['sleep', '0.25']);
}

type TextArea = { x: number; y: number; w: number; h: number; focused: boolean; value: string };
type AxDump = { texts: string[]; areas: TextArea[] };

/** Swift 导出器按源码内容哈希缓存，改 axDump.swift 会自动重编，不用手工清 /tmp。 */
function axHelperPath(): string | undefined {
  const source = resolve('scripts/lib/axDump.swift');
  try {
    const st = statSync(source);
    const bin = `/tmp/pure-ax-dump-${createHash('sha1').update(`${st.size}:${st.mtimeMs}`).digest('hex').slice(0, 10)}`;
    if (existsSync(bin)) return bin;
    const build = Bun.spawnSync(['swiftc', '-O', source, '-o', bin]);
    if (build.exitCode !== 0) {
      console.error(`[gui-probe] swiftc 编译失败，退回 AppleScript（每次读约 60s）：${build.stderr.toString().trim().slice(0, 300)}`);
      return undefined;
    }
    return bin;
  } catch {
    return undefined;
  }
}

/** AppleScript BFS 兜底：慢，但只依赖系统自带组件。 */
function dumpAxViaAppleScript(): AxDump {
  const raw = softOsa(`
tell application "System Events"
  tell process ${asLit(appName)}
    set out to ""
    set nodes to {window 1}
    set depths to {0}
    repeat while (count of nodes) > 0
      set el to item 1 of nodes
      set d to item 1 of depths
      set nodes to rest of nodes
      set depths to rest of depths
      try
        set r to role of el as text
        if r is "AXStaticText" then
          try
            set v to value of el
            if v is not missing value then set out to out & "ST" & tab & (v as text) & linefeed
          end try
        else if r is "AXTextArea" then
          set px to -1
          set py to -1
          set pw to -1
          set ph to -1
          set fo to 0
          try
            set p to position of el
            set px to item 1 of p
            set py to item 2 of p
          end try
          try
            set s to size of el
            set pw to item 1 of s
            set ph to item 2 of s
          end try
          try
            if focused of el then set fo to 1
          end try
          set v to ""
          try
            set vv to value of el
            if vv is not missing value then set v to (vv as text)
          end try
          set out to out & "TA" & tab & px & tab & py & tab & pw & tab & ph & tab & fo & tab & v & linefeed
        end if
        if d < 14 then
          try
            set kids to UI elements of el
            repeat with k in kids
              copy k to end of nodes
              copy (d + 1) to end of depths
            end repeat
          end try
        end if
      end try
    end repeat
    return out
  end tell
end tell`);
  const texts: string[] = [];
  const areas: TextArea[] = [];
  for (const line of raw.split('\n')) {
    const parts = line.split('\t');
    if (parts[0] === 'ST' && parts[1] !== undefined) texts.push(parts[1]);
    else if (parts[0] === 'TA') {
      const [x, y, w, h] = parts.slice(1, 5).map(Number);
      areas.push({ x, y, w, h, focused: parts[5] === '1', value: parts[6] ?? '' });
    }
  }
  return { texts, areas };
}

function dumpAx(): AxDump {
  ensureFront();
  const helper = axHelperPath();
  if (helper) {
    const r = Bun.spawnSync([helper, appName]);
    if (r.exitCode === 0) {
      try {
        const parsed = JSON.parse(r.stdout.toString()) as AxDump;
        return { texts: parsed.texts ?? [], areas: parsed.areas ?? [] };
      } catch {}
    }
  }
  return dumpAxViaAppleScript();
}

function windowRect(): TextArea | undefined {
  const raw = softOsa(`
tell application "System Events"
  tell process ${asLit(appName)}
    if (count of windows) is 0 then return ""
    set p to position of window 1
    set s to size of window 1
    return ((item 1 of p) as text) & "," & ((item 2 of p) as text) & "," & ((item 1 of s) as text) & "," & ((item 2 of s) as text)
  end tell
end tell`).trim();
  const [x, y, w, h] = raw.split(',').map(Number);
  if (![x, y, w, h].every(Number.isFinite) || w <= 0 || h <= 0) return undefined;
  return { x, y, w, h, focused: false, value: '' };
}

/** 用 AX 直接给输入框焦点，不依赖坐标——坐标不可信时这是唯一干净的落点方式。 */
function focusFirstTextArea(): boolean {
  return softOsa(`
tell application "System Events"
  tell process ${asLit(appName)}
    set nodes to {window 1}
    repeat while (count of nodes) > 0
      set el to item 1 of nodes
      set nodes to rest of nodes
      try
        if role of el is "AXTextArea" then
          set focused of el to true
          return "ok"
        end if
        set nodes to nodes & (UI elements of el)
      end try
    end repeat
    return "missing"
  end tell
end tell`).trim() === 'ok';
}

/** 按名字片段点按钮（「+ 新对话」这类）。找不到返回 false，调用方决定算不算致命。 */
function pressButton(namePart: string): boolean {
  ensureFront();
  return softOsa(`
tell application "System Events"
  tell process ${asLit(appName)}
    set nodes to {window 1}
    repeat while (count of nodes) > 0
      set el to item 1 of nodes
      set nodes to rest of nodes
      try
        if role of el is "AXButton" then
          set n to name of el
          if n is not missing value and (n as text) contains ${asLit(namePart)} then
            click el
            return "ok"
          end if
        end if
        set nodes to nodes & (UI elements of el)
      end try
    end repeat
    return "missing"
  end tell
end tell`).trim() === 'ok';
}

function clickAt(x: number, y: number): void {
  ensureFront();
  const cliclick = Bun.spawnSync(['bash', '-lc', 'command -v cliclick']).stdout.toString().trim();
  if (cliclick) {
    Bun.spawnSync([cliclick, `c:${Math.round(x)},${Math.round(y)}`]);
    return;
  }
  softOsa(`tell application "System Events" to click at {${Math.round(x)}, ${Math.round(y)}}`);
}

/** 中文键击在 macOS 上打不出来（除非切输入法），一律走剪贴板粘贴。 */
function pasteText(text: string): void {
  ensureFront();
  const r = Bun.spawnSync(['pbcopy'], { stdin: new TextEncoder().encode(text) });
  if (r.exitCode !== 0) throw new Error('pbcopy 失败');
  softOsa('tell application "System Events" to keystroke "v" using command down');
}

/** 清掉草稿：上一次没发出去的文本会和不认识的新 prompt 粘成一句。 */
function clearComposer(): void {
  ensureFront();
  softOsa('tell application "System Events" to keystroke "a" using command down');
  softOsa('tell application "System Events" to key code 51');
}

function composerValue(): string {
  const { areas } = dumpAx();
  const focused = areas.find((a) => a.focused);
  return (focused ?? areas[0])?.value ?? '';
}

// ── 流程 ───────────────────────────────────────────────────────────────────

async function waitForWindow(): Promise<void> {
  const end = Date.now() + 20_000;
  while (Date.now() < end) {
    if (windowRect()) return;
    await sleep(500);
  }
  throw new Error(`等不到 ${appName} 的窗口——应用没启动，或宿主没有「辅助功能」权限`);
}

/**
 * 把 prompt 放进输入框。候选顺序：AX 给焦点 → AX 矩形（只信非零坐标）→ 窗口比例
 * （首屏居中 0.545 / 有对话贴底 0.90）。每次尝试后回读输入框，命中了才继续回车。
 */
async function placePrompt(text: string, chatOpen: boolean): Promise<string> {
  const head = text.slice(0, Math.min(6, text.length));
  const { areas } = dumpAx();
  const attempts: Array<{ label: string; act: () => void }> = [];
  if (areas.length) attempts.push({ label: 'ax-focus', act: () => void focusFirstTextArea() });

  for (const r of areas) {
    // 0 坐标是 AX 对 web 内容的常见谎报：点下去会落在菜单栏或别的窗口上。
    if (r.x > 1 && r.y > 1) {
      attempts.push({ label: `ax-rect(${Math.round(r.x)},${Math.round(r.y)})`, act: () => clickAt(r.x + r.w / 2, r.y + Math.min(r.h / 2, 18)) });
    }
  }
  const win = windowRect();
  if (win) {
    const fractions = chatOpen ? [0.9, 0.88, 0.92] : [0.545, 0.52, 0.57];
    for (const fy of fractions) {
      attempts.push({ label: `window(${fy})`, act: () => clickAt(win.x + win.w / 2, win.y + win.h * fy) });
    }
  }

  for (const attempt of attempts) {
    try {
      attempt.act();
    } catch {
      continue;
    }
    await sleep(250);
    clearComposer();
    await sleep(120);
    pasteText(text);
    const until = Date.now() + 2_500;
    while (Date.now() < until) {
      if (composerValue().includes(head)) return attempt.label;
      await sleep(200);
    }
  }
  throw new Error('粘贴没进输入框——焦点拿不到（弹层挡着 / 窗口不在前台 / 宿主缺辅助功能权限）');
}

async function main(): Promise<void> {
  softOsa(`tell application "System Events" to set frontmost of process ${asLit(appName)} to true`);
  await waitForWindow();
  await sleep(300);

  if (hasFlag('--new-chat')) {
    pressButton('新对话');
    await sleep(800);
  }

  const before = dumpAx().texts.join('\n');
  const chatOpen = /(^|\n)YOU(\n|$)/.test(before) || before.includes('PURE\n');
  const landedVia = await placePrompt(prompt, chatOpen);

  ensureFront();
  softOsa('tell application "System Events" to key code 36');

  // 回显的 prompt 与思考块都会重复 prompt 里的词，所以两重判据：
  //   a) expect 出现次数比 prompt 本身多（消息确实落屏了，而不是只看到回显）；
  //   b) 两次采样的 AX 文本完全一致（流式输出停了，而不是半句话就通过）。
  const expectedCount = occurrences(prompt, expect ?? '') + 1;
  const deadline = Date.now() + timeoutMs;
  let snap = '';
  let prev = '';
  let ok = false;
  while (Date.now() < deadline) {
    await sleep(1_000);
    const texts = dumpAx().texts;
    snap = texts.join('\n');
    const hit = expect
      ? occurrences(snap, expect) >= expectedCount
      : snap.includes(prompt.slice(0, Math.min(6, prompt.length))) && snap.includes('就绪') && Date.now() - t0 > 6_000;
    if (hit && snap === prev) {
      ok = true;
      break;
    }
    prev = snap;
  }

  if (ok) await sleep(settleMs);
  snap = dumpAx().texts.join('\n');
  if (expect) ok = occurrences(snap, expect) >= expectedCount;

  const lines = snap.split('\n').map((s) => s.trim()).filter(Boolean);
  const replyTail = lines.slice(-12).join('\n');
  // 设置面板里「直连失败会自动改走加速节点」这类说明也含「失败」，它不是本次运行的报错。
  const errorHits = lines
    .filter((l) => /错误|失败|Error|error:/.test(l) && !/路由|加速节点|镜像|SLA/.test(l))
    .slice(0, 5);

  let screenshot: string | undefined;
  let screenshotSmall: string | undefined;
  if (wantShot) {
    mkdirSync(dirname(outPath), { recursive: true });
    ensureFront();
    const shot = Bun.spawnSync(['screencapture', '-x', '-o', outPath]);
    if (shot.exitCode !== 0) throw new Error(`screencapture 失败：${shot.stderr.toString().trim()}`);
    screenshot = outPath;
    const small = outPath.replace(/\.png$/, '') + '-small.png';
    Bun.spawnSync(['sips', '-Z', '1200', outPath, '--out', small]);
    screenshotSmall = small;
  }

  console.log(JSON.stringify({
    ok,
    prompt,
    expect: expect ?? null,
    landedVia,
    elapsedMs: Date.now() - t0,
    screenshot: screenshot ?? null,
    screenshotSmall: screenshotSmall ?? null,
    errorHits,
    replyTail,
  }, null, 2));
  process.exit(ok ? 0 : 1);
}

main().catch((err) => {
  console.error(JSON.stringify({ ok: false, error: String(err instanceof Error ? err.message : err) }));
  process.exit(1);
});
