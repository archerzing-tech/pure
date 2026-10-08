// scripts/tmp-gui-testset.ts
// GUI 版本测试集驱动器（10 条精选）：驱动**真 Tauri 壳**里的 pure——osascript
// 激活窗口 + 剪贴板粘贴输入 + Cmd+N 新会话，判分数据取两路：
//   1. ~/.pure/sessions/<id>/session.json —— 模型行为/工具调用的结构化真相
//   2. screencapture 全屏截图 —— 气泡/卡片投影质量的目检证据
// 本脚本只收集不判分（与 CLI 回放器同口径）；评分由评测者对照 expect/failIf 另行做。
//
// 前置：`bun run gui` 已把真壳跑起来（窗口标题 pure，进程 target/debug/pure）。
// 用法：bun scripts/tmp-gui-testset.ts --only B1-01,B2-07
//      bun scripts/tmp-gui-testset.ts            # 全部 10 条
//
// 安全边界：B2-06（批量删除）的 prepare 文件落在独立沙箱目录，跑前把该目录
// 作为 GUI 工作区（--workspace-dir 语义由人工在 GUI 里选定；脚本只准备文件并
// 提示）。绝不指向真实项目目录。

import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { execSync } from 'node:child_process';
import { join, basename } from 'node:path';
import { AGENT_TEST_CASES, buildLongText, getOrderScript, type AgentTestCase } from './tmp-agent-testset-cases';

// ── 参数 ─────────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const flagValue = (name: string): string | undefined => {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : undefined;
};
const only = flagValue('--only')?.split(',').map((v) => v.trim().toUpperCase());
const outPath = flagValue('--out') ?? join(process.cwd(), 'tmp', 'gui-testset', 'gui-results.json');
const appendMode = argv.includes('--append');
const settleMs = Number(flagValue('--settle-ms') ?? 90_000); // 单条等待模型收尾的上限

// ── GUI 精选 10 条（偏 GUI 暴露面：输入框/确认卡/渲染/红线）────────────────
const GUI_TEN = ['B1-01', 'B1-03', 'B1-04', 'B1-06', 'B2-01', 'B2-03', 'B2-06', 'B2-07', 'B4-01', 'B5-01#A1-01'];

interface GuiRun {
  caseId: string;
  sessionId?: string;   // ~/.pure/sessions/<id>
  sentText: string;
  replyText?: string;   // 存档里最后一条 assistant 文本
  toolCalls: Array<{ toolName: string; success?: boolean }>;
  screenshot?: string;
  elapsedMs: number;
  fatal?: string;
}

// ── shell 帮手 ───────────────────────────────────────────────────────────────
function sh(cmd: string, input?: string): string {
  return execSync(cmd, { input, encoding: 'utf8', timeout: 30_000 });
}

/** 激活 pure 窗口并把文本经剪贴板粘贴进输入框，回车发送。 */
function sendIntoGui(text: string): void {
  sh(`osascript <<'OSA'
tell application "System Events"
  set pureProc to first process whose name is "pure"
  set frontmost of pureProc to true
  delay 0.4
  keystroke "v" using command down
  delay 0.3
  key code 36
end tell
OSA`, text);
}

function newGuiSession(): void {
  sh(`osascript <<'OSA'
tell application "System Events"
  set pureProc to first process whose name is "pure"
  set frontmost of pureProc to true
  delay 0.3
  keystroke "n" using command down
  delay 0.5
end tell
OSA`);
}

function screenshot(path: string): void {
  try { execSync(`screencapture -x ${path}`, { timeout: 15_000 }); } catch { /* 截图失败不挡收集 */ }
}

// ── 会话存档轮询：pure 每次发送都落 ~/.pure/sessions/<id>/session.json ────────
interface ArchiveTurn { role: string; content?: string }
function readArchive(sessionId: string): { turns: ArchiveTurn[]; toolCalls: Array<{ toolName: string; success?: boolean }> } | undefined {
  const file = join(homedir(), '.pure', 'sessions', sessionId, 'session.json');
  if (!existsSync(file)) return undefined;
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8')) as { messages?: Array<Record<string, unknown>> };
    const messages = raw.messages ?? [];
    const turns: ArchiveTurn[] = messages.map((m) => ({ role: String(m.role), content: typeof m.content === 'string' ? m.content : undefined }));
    const toolCalls: Array<{ toolName: string; success?: boolean }> = [];
    for (const m of messages) {
      const calls = (m.toolCalls ?? []) as Array<{ name?: string; toolName?: string }>;
      for (const c of calls) toolCalls.push({ toolName: c.name ?? c.toolName ?? '?' });
    }
    return { turns, toolCalls };
  } catch { return undefined; }
}

function sessionDirsSnapshot(): Set<string> {
  const root = join(homedir(), '.pure', 'sessions');
  if (!existsSync(root)) return new Set();
  return new Set(readdirSync(root, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name));
}

/** 发送后出现的新会话目录 = 本次会话（取 mtime 最新的新目录）。 */
function newestNewSession(before: Set<string>): string | undefined {
  const fresh = [...sessionDirsSnapshot()].filter((id) => !before.has(id));
  if (fresh.length === 0) return undefined;
  const root = join(homedir(), '.pure', 'sessions');
  return fresh.sort((a, b) => {
    const ma = existsSync(join(root, a, 'session.json')) ? execSync(`stat -f %m ${JSON.stringify(join(root, a, 'session.json'))}`).toString().trim() : '0';
    const mb = existsSync(join(root, b, 'session.json')) ? execSync(`stat -f %m ${JSON.stringify(join(root, b, 'session.json'))}`).toString().trim() : '0';
    return Number(mb) - Number(ma);
  })[0];
}

// ── 主流程 ───────────────────────────────────────────────────────────────────
// GUI_TEN 里的组合名（B5-01#A1-01）映射回源用例 id 再过滤。
const guiCaseIds = new Set(GUI_TEN.map((id) => id.split('#')[0]));
let cases = AGENT_TEST_CASES.filter((c) => guiCaseIds.has(c.id));
if (only) cases = cases.filter((c) => only.includes(c.id));
if (cases.length === 0) { console.error('no GUI cases selected'); process.exit(2); }

// B5-01#A1-01：一致性抽源题 A1-01 单轮
const b5Source = AGENT_TEST_CASES.find((c) => c.id === 'A1-01');
interface Planned { caseId: string; test: AgentTestCase; turns: string[] }
const planned: Planned[] = [];
for (const test of cases) {
  if (test.id === 'B5-01') {
    if (b5Source) planned.push({ caseId: 'B5-01#A1-01', test: b5Source, turns: b5Source.turns });
    continue;
  }
  if (test.variants) {
    // B1-01 三变体各一个会话：' '（GUI UI 层空白守卫样本）、'。。。'/'???'（引擎轮）。
    test.variants.forEach((turn, index) => {
      planned.push({ caseId: test.variants!.length > 1 ? `${test.id}#${index + 1}` : test.id, test, turns: [turn] });
    });
    continue;
  }
  planned.push({ caseId: test.id, test, turns: test.turns });
}

mkdirSync(join(outPath, '..'), { recursive: true });
const results: GuiRun[] = appendMode && existsSync(outPath) ? JSON.parse(readFileSync(outPath, 'utf8')) as GuiRun[] : [];
console.log(`pure GUI testset — ${planned.length} case(s)`);

for (const plan of planned) {
  console.log(`\n== ${plan.caseId} ==`);
  const run: GuiRun = { caseId: plan.caseId, sentText: plan.turns.join(' | '), toolCalls: [], elapsedMs: 0 };
  const started = Date.now();
  try {
    // 工作区用例（B1-04/B2-01/B2-06）：文件已预置在 GUI 实际工作区
    // /tmp/pure-gui-ws（仓库外——仓库内会触发 pure 的 worktree 隔离，未跟踪
    // 文件不随 worktree 走）。脚本只记录路径，不再另建沙箱。
    if (plan.test.prepare) {
      const ws = '/tmp/pure-gui-ws';
      for (const [path, content] of Object.entries(plan.test.prepare)) {
        const target = join(ws, path);
        if (!existsSync(target)) {
          mkdirSync(join(target, '..'), { recursive: true });
          writeFileSync(target, content);
          if (path === 'get_order') chmodSync(target, 0o755);
        }
      }
      (run as GuiRun & { workspace?: string }).workspace = ws;
      console.log(`   workspace: ${ws}`);
    }
    newGuiSession();
    // 逐轮发送（本轮只收单轮用例；多轮用例轮间等收尾）
    const dirsBefore = sessionDirsSnapshot();
    for (let i = 0; i < plan.turns.length; i++) {
      const text = plan.turns[i];
      writeFileSync('/tmp/pure-gui-clip.txt', text);
      sh('pbcopy < /tmp/pure-gui-clip.txt');
      sendIntoGui(text);
      // 等模型收尾：轮询新会话存档，assistant 末条连续两个采样点不变才算收尾
      // （流式中途的 assistant 工具消息非空但不稳定，不能当最终回复）。
      const deadline = Date.now() + settleMs;
      let done = false;
      let sid: string | undefined;
      let lastSnapshot = '';
      let stableCount = 0;
      while (Date.now() < deadline) {
        execSync('sleep 5');
        sid = sid ?? newestNewSession(dirsBefore);
        const archive = sid ? readArchive(sid) : undefined;
        if (!archive) continue;
        const last = archive.turns[archive.turns.length - 1];
        const signature = `${last?.role ?? ''}:${(last?.content ?? '').length}:${archive.toolCalls.length}`;
        if (signature === lastSnapshot) stableCount++; else { stableCount = 0; lastSnapshot = signature; }
        if (last?.role === 'assistant' && (last.content?.length ?? 0) > 0 && stableCount >= 2) {
          run.sessionId = sid;
          run.replyText = last.content;
          run.toolCalls = archive.toolCalls;
          done = true;
          break;
        }
      }
      if (!done) {
        // 无新会话归档 ≠ 引擎卡死：GUI 输入框对纯空白/无效输入在 UI 层静默拦截
        // （normalizeDraft trim 守卫），消息根本不进引擎——这是有效行为证据。
        run.fatal = sid
          ? `settle timeout after ${settleMs}ms (turn ${i + 1})`
          : 'no new session archive — message blocked at UI layer (blank/invalid guard)';
        if (sid) { run.sessionId = sid; const a = readArchive(sid); if (a) { run.replyText = a.turns[a.turns.length - 1]?.content; run.toolCalls = a.toolCalls; } }
      }
    }
    run.elapsedMs = Date.now() - started;
    const shot = join(process.cwd(), 'tmp', 'gui-testset', `${plan.caseId.replace(/[^A-Za-z0-9-]/g, '_')}.png`);
    screenshot(shot);
    run.screenshot = shot;
  } catch (error) {
    run.fatal = error instanceof Error ? error.message : String(error);
  }
  results.push(run);
  writeFileSync(outPath, JSON.stringify(results, null, 2));
  console.log(`   done in ${(run.elapsedMs / 1000).toFixed(1)}s${run.fatal ? ` FATAL(${run.fatal.slice(0, 80)})` : ''} reply=${run.replyText?.length ?? 0} chars`);
}

console.log(`\ncollected ${results.length} → ${outPath}`);
