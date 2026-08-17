#!/usr/bin/env bun
// scripts/verify-outline-restore.ts
// Real-browser verification of the session-restore floating-outline states
// (src/ui/chat.ts loadFromStorage → planOverview().show). Seeds a finished /
// in-progress / paused session into localStorage, reloads the app, clicks the
// session in the sidebar (the real restore path), then asserts the floating
// outline and the in-transcript plan card render the expected state.
//
// Self-contained: it starts `bun run dev` and a headless Chrome when they are
// not already running, and stops only the processes it started. Requires a
// desktop Chrome binary (defaults to the standard macOS path).
//
// Usage:
//   bun run scripts/verify-outline-restore.ts [--state=complete|active|waiting|all] [--out=DIR] [--app-url=URL] [--cdp-port=PORT] [--chrome=PATH] [--keep]

import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Progress goes to the console AND a log file, so a run that gets killed
// (e.g. by an external timeout) still leaves a readable trace behind.
const LOG_FILE = '/tmp/pure-verify-outlines.log';
function log(message: string): void {
  console.log(message);
  try { appendFileSync(LOG_FILE, `${message}\n`); } catch {}
}

const argv = process.argv.slice(2);
const argValue = (name: string): string | undefined => {
  const flag = argv.find((a) => a.startsWith(`${name}=`));
  return flag ? flag.slice(name.length + 1) : undefined;
};
const requestedStates = (argValue('--state') ?? 'all').split(',');
const outDir = argValue('--out') ?? '/tmp/pure-outline-verify';
const appUrl = argValue('--app-url') ?? 'http://localhost:1420/';
const cdpPort = Number(argValue('--cdp-port') ?? 9222);
const chromePath = argValue('--chrome') ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const keepServers = argv.includes('--keep');

const projectRoot = new URL('../', import.meta.url).pathname;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

type OutlineState = 'complete' | 'active' | 'waiting';

const STATES: OutlineState[] = requestedStates.includes('all')
  ? ['complete', 'active', 'waiting']
  : (requestedStates as OutlineState[]);

// Expected DOM outcomes per state, matching loadFromStorage's branches:
//  - complete → planOverview().show(plan, 'complete', …) — all steps done
//  - started  → planOverview().show(plan, 'active', …) — cursor on planNumber
//  - !started → planOverview().show(plan, 'waiting', …) — cursor on plan 1
const EXPECTED: Record<OutlineState, {
  planState: { planNumber: number; todoNumber: number; started: boolean; complete: boolean };
  planCard: { currentPlan: number; currentTodo: number; complete: boolean };
  cardClass: string;
  doneSteps: number;
  activeSteps: number;
  awaitingSteps: number;
  progress: string;
  checks: string[];
  cardDoneSteps: number;
  cardActiveSteps: number;
}> = {
  complete: {
    planState: { planNumber: 3, todoNumber: 2, started: true, complete: true },
    planCard: { currentPlan: 3, currentTodo: 2, complete: true },
    cardClass: 'plan-overview-card complete',
    doneSteps: 3, activeSteps: 0, awaitingSteps: 0,
    progress: '3/3',
    checks: ['✓', '✓', '✓'],
    cardDoneSteps: 3, cardActiveSteps: 0,
  },
  active: {
    planState: { planNumber: 2, todoNumber: 1, started: true, complete: false },
    planCard: { currentPlan: 2, currentTodo: 1, complete: false },
    cardClass: 'plan-overview-card active',
    doneSteps: 1, activeSteps: 1, awaitingSteps: 0,
    progress: '1/3',
    checks: ['✓', '2', '3'],
    cardDoneSteps: 1, cardActiveSteps: 1,
  },
  waiting: {
    planState: { planNumber: 1, todoNumber: 1, started: false, complete: false },
    planCard: { currentPlan: 1, currentTodo: 1, complete: false },
    cardClass: 'plan-overview-card awaiting',
    doneSteps: 0, activeSteps: 0, awaitingSteps: 1,
    progress: '0/3',
    checks: ['1', '2', '3'],
    cardDoneSteps: 0, cardActiveSteps: 1,
  },
};

const PLAN_JSON = `{
  steps: [
    { id: '1', action: '了解需求', description: '先明确目标和边界', expectedOutcome: '范围清晰' },
    { id: '2', action: '设计方案', description: '确定实现路径', expectedOutcome: '方案确定' },
    { id: '3', action: '实现功能', description: '完成代码与验证', expectedOutcome: '功能可用' },
  ],
  reasoning: '这是一个需要分步完成的复杂任务',
}`;

async function waitFor(fn: () => Promise<boolean>, timeoutMs = 25000, label = 'condition'): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      if (await fn()) return;
    } catch {}
    await sleep(200);
  }
  throw new Error(`timeout waiting for ${label}`);
}

async function urlResponds(url: string): Promise<boolean> {
  try {
    const r = await fetch(url);
    return r.ok;
  } catch {
    return false;
  }
}

// Spawn a detached child so it outlives nothing important and can be killed
// independently. Returns the Subprocess itself so callers can pass it to
// killGroup (direct-child kill) and rely on killByPort for grandchildren.
function spawnDetached(command: string[], label: string): import('bun').Subprocess {
  const proc = Bun.spawn(command, { detached: true, cwd: projectRoot, stdout: 'ignore', stderr: 'ignore' });
  log(`[verify] started ${label} (pid ${proc.pid})`);
  return proc;
}

// Kill the direct child (never a negative-pid group kill: a detached `bun run
// dev` can share THIS script's own process group, so kill(-pid) would SIGTERM
// the script itself). Grandchildren that outlive the parent (vite) are caught
// by killByPort at the call sites.
function killGroup(proc: import('bun').Subprocess): void {
  try { proc.kill(); } catch {}
}

// Robust fallback: SIGKILL whatever is listening on a port, regardless of the
// process tree (detached grandchildren like vite can outlive their parent).
// Never kills this script's own pid: its readiness fetch() to the app holds a
// keep-alive connection to the same port, so lsof would otherwise report the
// script itself and the cleanup would SIGKILL the run.
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

async function main(): Promise<number> {
  if (STATES.length === 0) {
    console.error('Usage: bun run scripts/verify-outline-restore.ts [--state=complete|active|waiting|all] [--out=DIR] [--app-url=URL] [--cdp-port=PORT] [--chrome=PATH] [--keep]');
    return 2;
  }
  try { appendFileSync(LOG_FILE, `\n=== run ${new Date().toISOString()} ===\n`); } catch {}
  mkdirSync(outDir, { recursive: true });

  // ── 1. Ensure vite is up (start it only if nothing is listening yet). ──
  let viteProc: import('bun').Subprocess | null = null;
  if (!(await urlResponds(appUrl))) {
    viteProc = spawnDetached(['bun', 'run', 'dev'], 'vite');
    await waitFor(() => urlResponds(appUrl), 40000, 'vite on ' + appUrl);
    log('[verify] vite ready');
  } else {
    log('[verify] vite already running — reusing');
  }

  // ── 2. Ensure headless Chrome with a CDP port is up. ──
  const cdpVersionUrl = `http://127.0.0.1:${cdpPort}/json/version`;
  let chromeProc: import('bun').Subprocess | null = null;
  let chromeProfile: string | null = null;
  if (!(await urlResponds(cdpVersionUrl))) {
    chromeProfile = mkdtempSync(join(tmpdir(), 'pure-verify-chrome-'));
    chromeProc = spawnDetached([
      chromePath,
      '--headless=new',
      `--remote-debugging-port=${cdpPort}`,
      `--user-data-dir=${chromeProfile}`,
      '--no-first-run',
      '--no-default-browser-check',
      'about:blank',
    ], 'headless Chrome');
    await waitFor(() => urlResponds(cdpVersionUrl), 30000, 'Chrome CDP port');
    log('[verify] Chrome ready');
  } else {
    log(`[verify] Chrome already running on CDP port ${cdpPort} — reusing`);
  }

  // ── 3. CDP client (every step timed so a stuck browser cannot hang the run). ──
  const tab = await fetch(`http://127.0.0.1:${cdpPort}/json/new?about:blank`, { method: 'PUT' }).then((r) => r.json() as any);
  if (!tab?.webSocketDebuggerUrl) throw new Error('CDP did not return a page websocket: ' + JSON.stringify(tab).slice(0, 200));
  const ws = new WebSocket(tab.webSocketDebuggerUrl);
  await Promise.race([
    new Promise<void>((resolve, reject) => {
      ws.onopen = () => resolve();
      ws.onerror = () => reject(new Error('ws error'));
    }),
    new Promise<void>((_, reject) => setTimeout(() => reject(new Error('ws open timeout')), 15000)),
  ]);
  let msgId = 0;
  const pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
  ws.onmessage = (event: any) => {
    const msg = JSON.parse(String(event.data));
    if (msg.id && pending.has(msg.id)) {
      const p = pending.get(msg.id)!;
      pending.delete(msg.id);
      if (msg.error) p.reject(new Error(msg.error.message));
      else p.resolve(msg.result);
    }
  };
  const send = (method: string, params: any = {}) => Promise.race([
    new Promise<any>((resolve, reject) => {
      const id = ++msgId;
      pending.set(id, { resolve, reject });
      ws.send(JSON.stringify({ id, method, params }));
    }),
    new Promise<any>((_, reject) => setTimeout(() => reject(new Error(`CDP ${method} timeout`)), 20000)),
  ]);
  const evaluate = async (expression: string) => {
    const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error('evaluate threw: ' + (r.exceptionDetails.exception?.description ?? r.exceptionDetails.text).slice(0, 400));
    return r.result?.value;
  };

  log('[verify] CDP connected');
  await send('Page.enable');
  await send('Runtime.enable');
  await send('Page.navigate', { url: appUrl });
  await waitFor(async () => {
    const href = await evaluate('location.href');
    return typeof href === 'string' && href.startsWith(appUrl) && (await evaluate('document.readyState')) === 'complete';
  }, 25000, 'app load');
  log('[verify] app loaded');

  // ── 4. Run each requested state. Cleanup runs in a finally so a mid-round
  // failure can never orphan the vite / Chrome this script started. ──
  let failures = 0;
  try {
  for (const state of STATES) {
    const expected = EXPECTED[state];
    const sid = `verify-session-${state}`;
    const label = state === 'complete' ? '已完成' : state === 'active' ? '进行中' : '暂停';
    const seed = `(() => {
      const plan = ${PLAN_JSON};
      const snapshot = {
        version: 2,
        modelContext: { messages: [{ role: 'assistant', content: '执行中。' }] },
        transcript: [{
          id: 'm1', modelMessageIndex: 0, role: 'assistant', content: '执行中。',
          planCard: { plan, currentPlan: ${expected.planCard.currentPlan}, currentTodo: ${expected.planCard.currentTodo}, complete: ${expected.planCard.complete} },
        }],
        uiState: { planState: { plan, planNumber: ${expected.planState.planNumber}, todoNumber: ${expected.planState.todoNumber}, started: ${expected.planState.started}, complete: ${expected.planState.complete} } },
      };
      const data = { snapshot, updatedAt: Date.now(), messageCount: 1, workspace: '' };
      localStorage.setItem('pure_session:${sid}', JSON.stringify(data));
      localStorage.setItem('pure_last_session', '${sid}');
      localStorage.setItem('pure_sessions', JSON.stringify([{ id: '${sid}', title: '${label}', createdAt: Date.now(), updatedAt: Date.now(), messageCount: 1, workspace: '' }]));
      return 'seeded';
    })()`;
    await evaluate(seed);

    await send('Page.reload');
    await waitFor(async () => {
      const href = await evaluate('location.href');
      return typeof href === 'string' && href.startsWith(appUrl) && (await evaluate('document.readyState')) === 'complete';
    }, 25000, 'reload');
    await waitFor(async () => {
      const n = await evaluate(`document.querySelectorAll('.sidebar-session-item[data-sid="${sid}"]').length`);
      return n > 0;
    }, 25000, `${label} session item`);

    await evaluate(`document.querySelector('.sidebar-session-item[data-sid="${sid}"]').click()`);
    await waitFor(async () => {
      const visible = await evaluate("(() => { const o = document.querySelector('.plan-overview'); return o ? o.hidden === false : false; })()");
      return visible === true;
    }, 25000, `${label} outline visible`);

    const stateResult = JSON.parse(await evaluate(`(() => {
      const ov = document.querySelector('.plan-overview');
      const card = ov ? ov.querySelector('.plan-overview-card') : null;
      const steps = ov ? Array.from(ov.querySelectorAll('.plan-overview-step')) : [];
      const doneSteps = steps.filter((s) => s.classList.contains('done')).length;
      const activeSteps = steps.filter((s) => s.classList.contains('active')).length;
      const awaitingSteps = steps.filter((s) => s.classList.contains('awaiting')).length;
      const progress = ov ? (ov.querySelector('.plan-overview-progress')?.textContent ?? null) : null;
      const checks = steps.map((s) => s.querySelector('.plan-overview-step-check')?.textContent ?? '');
      const planCards = Array.from(document.querySelectorAll('.plan-progress-text-plan'));
      const cardDone = planCards[0] ? Array.from(planCards[0].querySelectorAll('.plan-progress-step.done')).length : -1;
      const cardActive = planCards[0] ? Array.from(planCards[0].querySelectorAll('.plan-progress-step.active')).length : -1;
      return JSON.stringify({
        outlineVisible: ov ? ov.hidden === false : null,
        cardClass: card ? card.className : null,
        doneSteps, activeSteps, awaitingSteps, progress, checks, cardDone, cardActive,
      });
    })()`));

    const checks: Array<[string, unknown, unknown]> = [
      ['outline visible', stateResult.outlineVisible, true],
      ['card class', stateResult.cardClass, expected.cardClass],
      ['done steps', stateResult.doneSteps, expected.doneSteps],
      ['active steps', stateResult.activeSteps, expected.activeSteps],
      ['awaiting steps', stateResult.awaitingSteps, expected.awaitingSteps],
      ['progress', stateResult.progress, expected.progress],
      ['step checks', stateResult.checks, expected.checks],
      ['plan card done steps', stateResult.cardDone, expected.cardDoneSteps],
      ['plan card active steps', stateResult.cardActive, expected.cardActiveSteps],
    ];
    let stateOk = true;
    for (const [name, actual, want] of checks) {
      const pass = JSON.stringify(actual) === JSON.stringify(want);
      if (!pass) stateOk = false;
      log(`  [${pass ? 'PASS' : 'FAIL'}] ${label} → ${name}: ${JSON.stringify(actual)}${pass ? '' : ` (expected ${JSON.stringify(want)})`}`);
    }
    if (!stateOk) failures++;
    log(`[verify] ${label} outline: ${stateOk ? 'OK' : 'MISMATCH'}`);

    const shot = await send('Page.captureScreenshot', { format: 'png' });
    const shotPath = join(outDir, `${state}.png`);
    writeFileSync(shotPath, Buffer.from(shot.data, 'base64'));
    log(`[verify] screenshot: ${shotPath}`);
  }
  try { ws.close(); } catch {}
  await fetch(`http://127.0.0.1:${cdpPort}/json/close/${tab.id}`, { method: 'PUT' }).catch(() => {});
  } finally {
    // ── 5. Cleanup only what this script started. ──
    if (keepServers) {
      log('[verify] --keep: leaving servers running');
    } else {
      if (viteProc) { killGroup(viteProc); killByPort(new URL(appUrl).port ? Number(new URL(appUrl).port) : 80); log('[verify] stopped vite'); }
      if (chromeProc) {
        killGroup(chromeProc);
        killByPort(cdpPort);
        log('[verify] stopped Chrome');
        if (chromeProfile) rmSync(chromeProfile, { recursive: true, force: true });
      }
    }
  }

  if (failures > 0) {
    console.error(`[verify] ${failures} state(s) mismatched`);
    return 1;
  }
  log('[verify] all restore states OK');
  return 0;
}

// Force exit: the CDP websocket keeps the event loop alive even after close,
// so a normal return would leave the process hanging after a successful run.
main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error('[verify] FAILED:', err?.stack ?? err?.message ?? String(err));
    try { appendFileSync(LOG_FILE, `[verify] FAILED: ${err?.stack ?? err?.message ?? String(err)}\n`); } catch {}
    process.exit(1);
  });
