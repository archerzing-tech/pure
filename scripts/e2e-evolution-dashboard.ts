#!/usr/bin/env bun
// scripts/e2e-evolution-dashboard.ts
// E4.2 — Settings → 进化（进化仪表盘）的真实浏览器回归。驱动未改动的 app 走
// CDP（与 e2e-settings-apikey.ts 同一套管道，不引入 playwright/puppeteer）：
//
//   1. 打开设置 → 进化：每个区块都得挂载（7 个汇总块 / 3 张趋势卡 / 错误簇 /
//      策略 / 经验条目 / 观测统计），页面上不许出现未翻译的 i18n key；
//   2. 浏览器模式没有本地观测日志 —— 空状态文案必须自己说清楚（"没有数据"
//      不等于"你从没跑过"），这条同时兜住"innerHTML 崩了但页面还在"的情况；
//   3. 种一条 procedure 记忆 → 经验区出现该条 + 删除按钮 → 点删除 → 确认弹窗
//      → 确认后条目从记忆库消失（直达清理的整条链路）；
//   4. 周/月切换重渲染不影响其它区块（窗口标签跟着变）。
//
// 用法：
//   bun run scripts/e2e-evolution-dashboard.ts [--app-url=URL] [--cdp-port=PORT] [--chrome=PATH] [--out=DIR] [--keep]

import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const argv = process.argv.slice(2);
const argValue = (name: string): string | undefined => {
  const flag = argv.find((a) => a.startsWith(`${name}=`));
  return flag ? flag.slice(name.length + 1) : undefined;
};

const appUrl = argValue('--app-url') ?? 'http://localhost:1420/';
const cdpPort = Number(argValue('--cdp-port') ?? 9226);
const outDir = argValue('--out') ?? '/tmp/pure-e2e-evolution';
const keepServers = argv.includes('--keep');

const projectRoot = new URL('../', import.meta.url).pathname;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function log(message: string): void {
  console.log(message);
}

async function urlResponds(url: string): Promise<boolean> {
  try {
    const r = await fetch(url);
    return r.ok;
  } catch {
    return false;
  }
}

function spawnDetached(command: string[], label: string): import('bun').Subprocess {
  const proc = Bun.spawn(command, { detached: true, cwd: projectRoot, stdout: 'ignore', stderr: 'ignore' });
  log(`[e2e] started ${label} (pid ${proc.pid})`);
  return proc;
}

function killByPort(port: number): void {
  try {
    const out = Bun.spawnSync(['lsof', '-ti', `:${port}`], { stdout: 'pipe' }).stdout.toString().trim();
    for (const pid of out.split(/\s+/).filter(Boolean)) {
      const n = Number(pid);
      if (n === process.pid) continue;
      try { process.kill(n, 'SIGKILL'); } catch {}
    }
  } catch {}
}

function resolveChromePath(explicit?: string): string {
  if (explicit) return explicit;
  const candidates = [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium-browser',
    '/usr/bin/chromium',
  ];
  for (const c of candidates) {
    try {
      if (require('node:fs').existsSync(c)) return c;
    } catch {}
  }
  throw new Error('no Chrome binary found; pass --chrome=/path/to/chrome');
}

const MEMORY_KEY = 'pure_memories_v2';
const SEEDED_ID = 'e2e-procedure-1';
const SEEDED_CONTENT = 'E2E seeded procedure: search before editing';
/** 未翻译 key 会以 `evolution.xxx` 字面量出现在页面上。 */
const RAW_KEY_PATTERN = /evolution\.(title|desc|chart|tile|errors|experience|stats|table|roles|dimension|level|strategy|advice)/;

/**
 * 种给仪表盘的观测记录：两条 agent_run，五个策略维度各有两个档位 —— 逐维
 * 切换时才能看出"表里只该有选中维度的档位"。时间放在现在附近，周/月窗口都进。
 */
function buildStrategyFeed(): string {
  const now = Date.now();
  const base = {
    schemaVersion: 1,
    type: 'agent_run',
    sessionId: 'e2e-obs',
    eventCounts: {},
    toolCalls: [] as Array<{ toolName: string; success: boolean; durationMs: number }>,
    reasoningChars: 0,
    outputChars: 0,
  };
  const strategy = (overrides: Record<string, unknown>) => ({
    exploration: 'broad',
    verification: 'thorough',
    delegation: 'parallel',
    autonomy: 'assisted',
    recovery: 'continue-with-evidence',
    complexity: 'complex',
    confidence: 0.82,
    intentTags: ['build'],
    recommendedRoles: ['code_editor'],
    parallelRoles: ['researcher'],
    priorArtHint: true,
    ...overrides,
  });
  return [
    {
      ...base,
      traceId: 'e2e-obs-1',
      startedAt: now - 120_000,
      endedAt: now - 110_000,
      durationMs: 10_000,
      outcome: { isComplete: true, interrupted: false },
      verification: { status: 'passed', evidence: [] },
      strategy: strategy({}),
    },
    {
      ...base,
      traceId: 'e2e-obs-2',
      startedAt: now - 60_000,
      endedAt: now - 55_000,
      durationMs: 5_000,
      outcome: { isComplete: true, interrupted: false },
      verification: { status: 'passed', evidence: [] },
      toolCalls: [{ toolName: 'researcher', success: true, durationMs: 900 }],
      strategy: strategy({
        verification: 'standard',
        delegation: 'targeted',
        recovery: 'switch-approach',
        complexity: 'simple',
        confidence: 0.6,
        intentTags: ['quick'],
        priorArtHint: false,
      }),
    },
  ].map((record) => JSON.stringify(record)).join('\n');
}

interface StepFailure extends Error {
  step?: string;
}

const consoleLogs: string[] = [];
mkdirSync(outDir, { recursive: true });

let viteProc: import('bun').Subprocess | null = null;
if (!(await urlResponds(appUrl))) {
  viteProc = spawnDetached(['bun', 'run', 'dev'], 'vite dev server');
  const start = Date.now();
  while (!(await urlResponds(appUrl)) && Date.now() - start < 40000) await sleep(300);
  if (!(await urlResponds(appUrl))) throw new Error(`timeout waiting for vite on ${appUrl}`);
  log('[e2e] vite ready');
} else {
  log('[e2e] reusing already-running app server');
}

const chromePath = resolveChromePath(argValue('--chrome'));
const cdpVersionUrl = `http://127.0.0.1:${cdpPort}/json/version`;
let chromeProfile: string | null = null;
if (!(await urlResponds(cdpVersionUrl))) {
  chromeProfile = mkdtempSync(join(tmpdir(), 'pure-e2e-evolution-chrome-'));
  spawnDetached([
    chromePath,
    '--headless=new',
    `--remote-debugging-port=${cdpPort}`,
    `--user-data-dir=${chromeProfile}`,
    '--no-first-run',
    '--no-default-browser-check',
    'about:blank',
  ], 'headless Chrome');
  const start = Date.now();
  while (!(await urlResponds(cdpVersionUrl)) && Date.now() - start < 30000) await sleep(300);
  if (!(await urlResponds(cdpVersionUrl))) throw new Error('timeout waiting for Chrome CDP port');
  log('[e2e] Chrome ready');
} else {
  log(`[e2e] reusing Chrome on CDP port ${cdpPort}`);
}

let ws: WebSocket | null = null;
let send: (method: string, params?: any) => Promise<any> = async () => { throw new Error('CDP not connected'); };

try {
  const tab = await fetch(`http://127.0.0.1:${cdpPort}/json/new?about:blank`, { method: 'PUT' }).then((r) => r.json() as any);
  if (!tab?.webSocketDebuggerUrl) throw new Error('CDP did not return a page websocket');
  ws = new WebSocket(tab.webSocketDebuggerUrl);
  await new Promise<void>((resolve, reject) => {
    ws!.onopen = () => resolve();
    ws!.onerror = () => reject(new Error('ws error'));
    setTimeout(() => reject(new Error('ws open timeout')), 15000);
  });

  let msgId = 0;
  const pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
  ws.onmessage = (event: any) => {
    const msg = JSON.parse(String(event.data));
    if (msg.method === 'Runtime.consoleAPICalled' || msg.method === 'Log.entryAdded') {
      const entry = msg.method === 'Log.entryAdded' ? msg.params.entry : msg.params;
      const text = (entry?.args ?? []).map((a: any) => a?.value ?? a?.description ?? '').join(' ').slice(0, 300) || entry?.text || '';
      consoleLogs.push(`[${entry?.type ?? 'log'}] ${text}`.slice(0, 400));
      if (consoleLogs.length > 100) consoleLogs.shift();
      return;
    }
    if (msg.method === 'Runtime.exceptionThrown') {
      const d = msg.params?.exceptionDetails;
      consoleLogs.push(`[exception] ${(d?.exception?.description ?? d?.text ?? '').slice(0, 400)}`);
      if (consoleLogs.length > 100) consoleLogs.shift();
      return;
    }
    if (msg.id && pending.has(msg.id)) {
      const p = pending.get(msg.id)!;
      pending.delete(msg.id);
      if (msg.error) p.reject(new Error(msg.error.message));
      else p.resolve(msg.result);
    }
  };
  send = (method: string, params: any = {}) => Promise.race([
    new Promise<any>((resolve, reject) => {
      const id = ++msgId;
      pending.set(id, { resolve, reject });
      ws!.send(JSON.stringify({ id, method, params }));
    }),
    new Promise<any>((_, reject) => setTimeout(() => reject(new Error(`CDP ${method} timeout`)), 20000)),
  ]);
  const evaluate = async (expression: string) => {
    const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) {
      throw new Error('evaluate threw: ' + (r.exceptionDetails.exception?.description ?? r.exceptionDetails.text).slice(0, 500));
    }
    return r.result?.value;
  };
  const waitFor = async (expression: string, timeoutMs = 10000, label = 'condition'): Promise<void> => {
    const start = Date.now();
    let last: any;
    while (Date.now() - start < timeoutMs) {
      last = await evaluate(expression);
      if (last && last.ok) return;
      await sleep(200);
    }
    throw new Error(`timeout waiting for ${label}: ${JSON.stringify(last)}\npage console (tail):\n${consoleLogs.slice(-12).join('\n') || '(empty)'}`);
  };
  const clickUntil = async (actionExpr: string, assertExpr: string, timeoutMs: number, label: string): Promise<void> => {
    const start = Date.now();
    let last: any;
    while (Date.now() - start < timeoutMs) {
      last = await evaluate(`(() => { ${actionExpr} return ${assertExpr}; })()`);
      if (last && last.ok) return;
      await sleep(400);
    }
    throw new Error(`timeout waiting for ${label}: ${JSON.stringify(last)}\npage console (tail):\n${consoleLogs.slice(-12).join('\n') || '(empty)'}`);
  };

  log('[e2e] CDP connected');
  await send('Page.enable');
  await send('Runtime.enable');

  await send('Page.navigate', { url: appUrl });
  await waitFor('({ ok: document.readyState === "complete" })', 25000, 'app load');
  // 清库 + 种一条 procedure：经验区必须有东西可删，删除链路才有得测。
  await evaluate(`(() => {
    localStorage.clear();
    localStorage.setItem(${JSON.stringify(MEMORY_KEY)}, JSON.stringify([{
      id: ${JSON.stringify(SEEDED_ID)},
      type: "procedure",
      content: ${JSON.stringify(SEEDED_CONTENT)},
      timestamp: Date.now() - 3600000,
      sessionId: "e2e",
      projectPath: "/tmp/e2e-evolution",
      hitCount: 1,
      lastUsedAt: Date.now() - 1800000,
    }]));
    return "seeded";
  })()`);
  await send('Page.navigate', { url: `${appUrl}?_nocache=${Date.now()}` });
  await send('Page.enable');
  await send('Runtime.enable');
  await waitFor('({ ok: document.readyState === "complete" && !!document.getElementById("sidebar-settings-btn") })', 25000, 'app boot');
  await sleep(1200);
  log('[e2e] app loaded (fresh profile + seeded procedure)');

  // ── 1. 打开设置 → 进化 ──
  await clickUntil(
    `document.getElementById("sidebar-settings-btn")?.click();`,
    `({ ok: document.getElementById("settings-view")?.classList.contains("expanded") })`,
    15000,
    'settings open',
  );
  await clickUntil(
    `document.querySelector('.settings-nav-item[data-category="evolution"]')?.click();`,
    `({ ok: document.querySelector('.settings-page[data-page="evolution"]')?.classList.contains("active") })`,
    15000,
    'evolution page active',
  );

  // ── 2. 区块齐活 + 没有漏翻的 key + 空状态说人话 ──
  await waitFor(`(() => {
    const page = document.querySelector('.settings-page[data-page="evolution"]');
    const tiles = page?.querySelectorAll('#evolution-totals .evo-tile').length ?? 0;
    const charts = page?.querySelectorAll('#evolution-charts .evo-chart-card').length ?? 0;
    const sections = ['#evolution-errors', '#evolution-strategy', '#evolution-advice', '#evolution-experience', '#evolution-stats']
      .every((sel) => (page?.querySelector(sel)?.childElementCount ?? 0) > 0);
    const text = page?.textContent ?? "";
    return {
      ok: tiles === 7 && charts === 3 && sections && !${RAW_KEY_PATTERN}.test(text),
      tiles, charts, sections,
      rawKey: ${RAW_KEY_PATTERN}.test(text),
    };
  })()`, 15000, 'dashboard sections mounted (7 tiles / 3 charts / no raw i18n keys)');

  const emptyStates = await evaluate(`(() => {
    const page = document.querySelector('.settings-page[data-page="evolution"]');
    return {
      ok: !!page?.querySelector("#evolution-errors .evo-empty")
        && !!page?.querySelector("#evolution-charts .evo-chart-empty")
        && !!page?.querySelector("#evolution-advice .evo-empty")
        && !!page?.querySelector("#evolution-strategy .evo-empty")
        && !page?.querySelector("#evolution-strategy-tabs .evo-range-btn")
        && !!page?.querySelector("#evolution-stats .evo-empty"),
      errors: page?.querySelector("#evolution-errors .evo-empty")?.textContent ?? null,
      stats: page?.querySelector("#evolution-stats .evo-empty")?.textContent ?? null,
    };
  })()`);
  if (!emptyStates.ok) {
    const err = new Error(`empty states missing in browser mode: ${JSON.stringify(emptyStates)}`) as StepFailure;
    err.step = 'empty-states';
    throw err;
  }
  log(`[e2e] empty states ok — errors="${emptyStates.errors}" stats="${emptyStates.stats}"`);

  // ── 3. 种下的 procedure 出现在经验区，且删除按钮就位 ──
  await waitFor(`(() => {
    const rows = document.querySelectorAll('#evolution-experience [data-evo-del]');
    return { ok: rows.length === 1 && rows[0].getAttribute("data-evo-del") === ${JSON.stringify(SEEDED_ID)}, rows: rows.length };
  })()`, 15000, 'seeded lesson row + delete button');

  // ── 4. 周/月切换：窗口标签跟着变，区块还在 ──
  await clickUntil(
    `document.querySelector('#evolution-range [data-range="month"]')?.click();`,
    `({ ok: (document.getElementById("evolution-window")?.textContent ?? "").includes("30") })`,
    10000,
    'month range applied',
  );
  await clickUntil(
    `document.querySelector('#evolution-range [data-range="week"]')?.click();`,
    `({ ok: (document.getElementById("evolution-window")?.textContent ?? "").includes("7") })`,
    10000,
    'week range applied',
  );

  // ── 5. 直达清理：删除 → 确认弹窗 → 记忆库真的少了一条 ──
  await evaluate(`document.querySelector('#evolution-experience [data-evo-del]')?.click()`);
  await waitFor(
    `({ ok: !!document.querySelector(".modal-dialog .setting-btn.danger") })`,
    10000,
    'delete confirmation modal',
  );
  await evaluate(`document.querySelector(".modal-dialog .setting-btn.danger")?.click()`);
  await waitFor(`(() => {
    let stored = [];
    try { stored = JSON.parse(localStorage.getItem(${JSON.stringify(MEMORY_KEY)}) ?? "[]"); } catch {}
    return {
      ok: !stored.some((e) => e.id === ${JSON.stringify(SEEDED_ID)}) && !document.querySelector('#evolution-experience [data-evo-del]'),
      remaining: stored.length,
    };
  })()`, 10000, 'lesson removed from the memory store');

  // ── 6. 种一份观测记录（浏览器里没有 Rust 尾巴读）→ 五个策略维度都要能渲染 ──
  // 注入走 observationSource 的 __PURE_OBSERVATION_FEED__（JSONL 文本，与 Rust
  // 尾巴读同一条解析器）；点一下周/月切换触发重读，再逐维点过去验证渲染。
  await evaluate(`(() => { window.__PURE_OBSERVATION_FEED__ = ${JSON.stringify(buildStrategyFeed())}; return 'fed'; })()`);
  await clickUntil(
    `document.querySelector('#evolution-range [data-range="month"]')?.click();`,
    `(() => {
      const btns = [...document.querySelectorAll('#evolution-strategy-tabs .evo-range-btn')];
      const first = btns[0];
      return {
        ok: btns.length === 5 && first?.dataset.strategyDim === 'verification' && first?.classList.contains('active'),
        n: btns.length,
      };
    })()`,
    15000,
    'five strategy dimension tabs (default verification)',
  );

  // 每个维度点一下：只有选中维度的那几个档位值能出现在表里。
  const dimensionCases = [
    { dimension: 'verification', expect: ['全面', '常规'], absent: ['广泛'] },
    { dimension: 'delegation', expect: ['并行', '定向'], absent: ['全面'] },
    { dimension: 'exploration', expect: ['广泛'], absent: ['全面'] },
    { dimension: 'recovery', expect: ['带证据继续', '换思路'], absent: ['广泛'] },
    { dimension: 'complexity', expect: ['复杂', '简单'], absent: ['全面'] },
  ];
  for (const testCase of dimensionCases) {
    await clickUntil(
      `document.querySelector('#evolution-strategy-tabs [data-strategy-dim="${testCase.dimension}"]')?.click();`,
      `(() => {
        const text = document.getElementById('evolution-strategy')?.textContent ?? '';
        const hasAll = ${JSON.stringify(testCase.expect)}.every((s) => text.includes(s));
        const hasNone = ${JSON.stringify(testCase.absent)}.every((s) => !text.includes(s));
        return { ok: hasAll && hasNone && !!document.querySelector('#evolution-strategy .evo-table'), text: text.slice(0, 100) };
      })()`,
      15000,
      `${testCase.dimension} dimension rendered`,
    );
  }
  await waitFor(
    `({ ok: (document.getElementById('evolution-strategy')?.textContent ?? '').includes('子 Agent 角色') })`,
    10000,
    'role slices stay visible next to the dimension table',
  );
  log('[e2e] strategy dimensions ok — five tabs, one dimension table at a time, roles still sliced');

  const exceptions = consoleLogs.filter((line) => line.startsWith('[exception]'));
  if (exceptions.length > 0) {
    const err = new Error(`page threw during the dashboard flow:\n${exceptions.join('\n')}`) as StepFailure;
    err.step = 'console';
    throw err;
  }

  log('[e2e] PASS — dashboard mounts every section, says why it is empty in browser mode, switches week/month, slices all five strategy dimensions, and deletes a lesson end to end');
  ws.close();
  process.exit(0);
} catch (err) {
  const failure = err as StepFailure;
  log(`[e2e] FAIL${failure.step ? ` @ ${failure.step}` : ''}: ${failure.message}`);
  log(`page console (tail):\n${consoleLogs.slice(-15).join('\n') || '(empty)'}`);
  try {
    const shot = await send('Page.captureScreenshot', { format: 'png' });
    if (shot?.data) {
      const { writeFileSync } = await import('node:fs');
      const path = join(outDir, `failure-${Date.now()}.png`);
      writeFileSync(path, Buffer.from(shot.data, 'base64'));
      log(`[e2e] screenshot: ${path}`);
    }
  } catch {}
  process.exitCode = 1;
} finally {
  try { ws?.close(); } catch {}
  if (!keepServers) {
    killByPort(cdpPort);
    if (viteProc) {
      try { viteProc.kill(); } catch {}
    }
    if (chromeProfile) {
      try { rmSync(chromeProfile, { recursive: true, force: true }); } catch {}
    }
  }
}
