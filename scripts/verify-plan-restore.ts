#!/usr/bin/env bun
// scripts/verify-plan-restore.ts
// Real-browser verification of session restore and the in-chat plan-card
// projection (src/ui/chat.ts loadFromStorage → main.ts createRestoredPlanCard).
// It seeds sessions into the browser store, reloads the app, clicks sessions in
// the sidebar (the real restore/switch path), then asserts the transcript plan
// card renders the persisted state — and that the removed floating outline
// never comes back.
//
// Self-contained: it starts `bun run dev` and a headless Chrome when they are
// not already running, and stops only the processes it started. Requires a
// desktop Chrome binary (defaults to the standard macOS path).
//
// Usage:
//   bun run scripts/verify-plan-restore.ts [--scenario=restore|session|progress|gates|all] [--state=complete|active|waiting|all] [--gate=review|delivery|all] [--out=DIR] [--app-url=URL] [--cdp-port=PORT] [--chrome=PATH] [--keep]

import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Progress goes to the console AND a log file, so a run that gets killed
// (e.g. by an external timeout) still leaves a readable trace behind.
const LOG_FILE = '/tmp/pure-verify-plans.log';
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
const scenario = argValue('--scenario') ?? 'all';
const gateScenario = argValue('--gate') ?? 'all';
const outDir = argValue('--out') ?? '/tmp/pure-plan-verify';
const appUrl = argValue('--app-url') ?? 'http://localhost:1420/';
const cdpPort = Number(argValue('--cdp-port') ?? 9222);
const chromePath = argValue('--chrome') ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const keepServers = argv.includes('--keep');

const projectRoot = new URL('../', import.meta.url).pathname;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

type PlanState = 'complete' | 'active' | 'waiting';

const STATES: PlanState[] = requestedStates.includes('all')
  ? ['complete', 'active', 'waiting']
  : (requestedStates as PlanState[]);

// Expected outcomes per state, matching loadFromStorage's branches and the
// restored transcript card rendered by main.ts:
//  - complete → plan card fully done (all steps done, no active step)
//  - started  → plan card active with the cursor on planNumber
//  - !started → plan card showing the cursor on plan 1
const EXPECTED: Record<PlanState, {
  planState: { planNumber: number; todoNumber: number; started: boolean; complete: boolean };
  planCard: { currentPlan: number; currentTodo: number; complete: boolean };
  cardDoneSteps: number;
  cardActiveSteps: number;
  cardStepClasses: string[];
}> = {
  complete: {
    planState: { planNumber: 3, todoNumber: 2, started: true, complete: true },
    planCard: { currentPlan: 3, currentTodo: 2, complete: true },
    cardDoneSteps: 3, cardActiveSteps: 0,
    cardStepClasses: ['done', 'done', 'done'],
  },
  active: {
    planState: { planNumber: 2, todoNumber: 1, started: true, complete: false },
    planCard: { currentPlan: 2, currentTodo: 1, complete: false },
    cardDoneSteps: 1, cardActiveSteps: 1,
    cardStepClasses: ['done', 'active', 'pending'],
  },
  waiting: {
    planState: { planNumber: 1, todoNumber: 1, started: false, complete: false },
    planCard: { currentPlan: 1, currentTodo: 1, complete: false },
    cardDoneSteps: 0, cardActiveSteps: 1,
    cardStepClasses: ['active', 'pending', 'pending'],
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
  if (STATES.length === 0 || !['restore', 'session', 'progress', 'gates', 'all'].includes(scenario)) {
    console.error('Usage: bun run scripts/verify-plan-restore.ts [--scenario=restore|session|progress|gates|all] [--gate=review|delivery|all] [--state=complete|active|waiting|all] [--out=DIR] [--app-url=URL] [--cdp-port=PORT] [--chrome=PATH] [--keep]');
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
  if (scenario === 'restore' || scenario === 'all') for (const state of STATES) {
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
      const n = await evaluate("(() => { const card = document.querySelector('.plan-progress-text-plan'); return card ? card.querySelectorAll('.plan-progress-step').length : 0; })()");
      return Number(n) === 3;
    }, 25000, `${label} restored plan card`);

    const stateResult = JSON.parse(await evaluate(`(() => {
      const card = document.querySelector('.plan-progress-text-plan');
      const steps = card ? Array.from(card.querySelectorAll('.plan-progress-step')) : [];
      const doneSteps = steps.filter((s) => s.classList.contains('done')).length;
      const activeSteps = steps.filter((s) => s.classList.contains('active')).length;
      return JSON.stringify({
        cardRendered: !!card,
        cardStepClasses: steps.map((s) => [...s.classList].find((c) => c === 'done' || c === 'active' || c === 'pending') ?? ''),
        cardDone: doneSteps, cardActive: activeSteps,
        noOutline: document.querySelector('.plan-overview') === null,
      });
    })()`));

    const checks: Array<[string, unknown, unknown]> = [
      ['plan card rendered', stateResult.cardRendered, true],
      ['card step classes', stateResult.cardStepClasses, expected.cardStepClasses],
      ['card done steps', stateResult.cardDone, expected.cardDoneSteps],
      ['card active steps', stateResult.cardActive, expected.cardActiveSteps],
      ['no floating outline', stateResult.noOutline, true],
    ];
    let stateOk = true;
    for (const [name, actual, want] of checks) {
      const pass = JSON.stringify(actual) === JSON.stringify(want);
      if (!pass) stateOk = false;
      log(`  [${pass ? 'PASS' : 'FAIL'}] ${label} → ${name}: ${JSON.stringify(actual)}${pass ? '' : ` (expected ${JSON.stringify(want)})`}`);
    }
    if (!stateOk) failures++;
    log(`[verify] ${label} plan card: ${stateOk ? 'OK' : 'MISMATCH'}`);

    const shot = await send('Page.captureScreenshot', { format: 'png' });
    const shotPath = join(outDir, `${state}.png`);
    writeFileSync(shotPath, Buffer.from(shot.data, 'base64'));
    log(`[verify] screenshot: ${shotPath}`);
  }

  // ── Browser-level refresh + session-switch regression ──
  // This deliberately uses two distinct plans rather than only checking that
  // a card is present: stale model subscriptions would otherwise pass the
  // presence assertion while still showing session A after switching to B.
  if (scenario === 'session' || scenario === 'all') {
    const planA = {
      steps: [
        { id: 'a-1', action: 'A-需求', description: '读取会话 A 的目标', expectedOutcome: 'A 目标明确' },
        { id: 'a-2', action: 'A-实现', description: '执行会话 A 的实现', expectedOutcome: 'A 完成' },
        { id: 'a-3', action: 'A-验证', description: '验证会话 A 的结果', expectedOutcome: 'A 可交付' },
      ],
      reasoning: 'browser session A',
    };
    const planB = {
      steps: [
        { id: 'b-1', action: 'B-需求', description: '读取会话 B 的目标', expectedOutcome: 'B 目标明确' },
        { id: 'b-2', action: 'B-实现', description: '执行会话 B 的实现', expectedOutcome: 'B 完成' },
        { id: 'b-3', action: 'B-验证', description: '验证会话 B 的结果', expectedOutcome: 'B 可交付' },
      ],
      reasoning: 'browser session B',
    };
    const makeData = (id: string, title: string, plan: typeof planA, progress: { currentPlan: number; currentTodo: number; status: 'active' | 'complete' }) => {
      const complete = progress.status === 'complete';
      const snapshot = {
        version: 2,
        modelContext: { messages: [{ role: 'user', content: title }] },
        transcript: [{
          id: `${id}-plan`, modelMessageIndex: 0, role: 'assistant', content: `${title} 执行中。`,
          planCard: { plan, currentPlan: complete ? plan.steps.length + 1 : progress.currentPlan, currentTodo: progress.currentTodo, complete },
        }],
        uiState: {
          planProgress: { plan, currentPlan: complete ? plan.steps.length + 1 : progress.currentPlan, currentTodo: progress.currentTodo, status: progress.status },
          planState: { plan, planNumber: complete ? plan.steps.length + 1 : progress.currentPlan, todoNumber: progress.currentTodo, started: true, ...(complete ? { complete: true } : {}) },
        },
      };
      return { id, title, createdAt: Date.now(), updatedAt: Date.now(), messageCount: 1, workspace: '', snapshot };
    };
    const sessionA = makeData('browser-session-a', '浏览器会话 A', planA, { currentPlan: 2, currentTodo: 1, status: 'active' });
    const sessionB = makeData('browser-session-b', '浏览器会话 B', planB, { currentPlan: 4, currentTodo: 1, status: 'complete' });
    const seedSessions = `(() => {
      const entries = ${JSON.stringify([sessionA, sessionB])};
      localStorage.setItem('pure_sessions', JSON.stringify(entries.map(({ snapshot: _snapshot, ...meta }) => meta)));
      for (const entry of entries) {
        localStorage.setItem('pure_session:' + entry.id, JSON.stringify({ snapshot: entry.snapshot, updatedAt: entry.updatedAt, messageCount: entry.messageCount, workspace: entry.workspace }));
      }
      localStorage.setItem('pure_last_session', 'browser-session-a');
      return entries.map((entry) => entry.id);
    })()`;
    await evaluate(seedSessions);

    const reload = async (label: string): Promise<void> => {
      await send('Page.reload');
      await waitFor(async () => {
        const href = await evaluate('location.href');
        return typeof href === 'string' && href.startsWith(appUrl) && (await evaluate('document.readyState')) === 'complete';
      }, 25000, `${label} reload`);
      await waitFor(async () => {
        const count = await evaluate(`document.querySelectorAll('.sidebar-session-item[data-sid="browser-session-a"], .sidebar-session-item[data-sid="browser-session-b"]').length`);
        return Number(count) === 2;
      }, 25000, `${label} session list`);
    };
    const readSessionView = async (): Promise<{ chat: string; chatDone: number; chatActive: number; noOutline: boolean }> => JSON.parse(String(await evaluate(`(() => {
      const card = document.querySelector('.plan-progress-text-plan');
      const steps = card ? Array.from(card.querySelectorAll('.plan-progress-step')) : [];
      return JSON.stringify({
        chat: card?.textContent?.trim() ?? '',
        chatDone: steps.filter((s) => s.classList.contains('done')).length,
        chatActive: steps.filter((s) => s.classList.contains('active')).length,
        noOutline: document.querySelector('.plan-overview') === null,
      });
    })()`)));
    const assertSessionView = async (sid: string, expectedLabel: string, expected: { done: number; active: number }): Promise<boolean> => {
      await waitFor(async () => {
        const view = await readSessionView();
        return view.chat.includes(expectedLabel) && view.chatDone === expected.done && view.chatActive === expected.active;
      }, 25000, `${sid} restored plan card`);
      const view = await readSessionView();
      const pass = view.chat.includes(expectedLabel)
        && view.chatDone === expected.done
        && view.chatActive === expected.active
        && view.noOutline === true;
      log(`  [${pass ? 'PASS' : 'FAIL'}] ${sid} → refresh/switch shared projection: ${JSON.stringify(view)}`);
      if (!pass) failures++;
      return pass;
    };

    await reload('session seed');
    await evaluate(`document.querySelector('.sidebar-session-item[data-sid="browser-session-a"]').click()`);
    await assertSessionView('browser-session-a', 'A-实现', { done: 1, active: 1 });

    // Reload after selecting A, then take the normal sidebar restore path.
    await reload('selected A');
    await evaluate(`document.querySelector('.sidebar-session-item[data-sid="browser-session-a"]').click()`);
    await assertSessionView('browser-session-a', 'A-实现', { done: 1, active: 1 });

    // Switching to B must replace the projection; A's model/subscription
    // must no longer be able to keep the old plan in the transcript.
    await evaluate(`document.querySelector('.sidebar-session-item[data-sid="browser-session-b"]').click()`);
    await assertSessionView('browser-session-b', 'B-验证', { done: 3, active: 0 });
    log('[verify] browser refresh + session switch: OK');
  }

  // ── Browser-level multi-Todo / phase-jump / completion regression ──
  if (scenario === 'progress' || scenario === 'all') {
    const progressPlan = {
      steps: [
        {
          id: 'p-1', action: '多 Todo 阶段', description: '验证 Todo 顺序', expectedOutcome: 'Todo 状态一致',
          todosRequired: true,
          substeps: [
            { id: 'p-1-1', action: 'Todo 一', description: '已完成 Todo', expectedOutcome: '完成' },
            { id: 'p-1-2', action: 'Todo 二', description: '当前 Todo', expectedOutcome: '执行中' },
            { id: 'p-1-3', action: 'Todo 三', description: '待处理 Todo', expectedOutcome: '待处理' },
          ],
        },
        { id: 'p-2', action: '中间阶段', description: '用于验证跳阶段', expectedOutcome: '可跳过' },
        {
          id: 'p-3', action: '跳阶段后的验证', description: '当前阶段和完成态', expectedOutcome: '验证完成',
          todosRequired: true,
          substeps: [{ id: 'p-3-1', action: '验证 Todo', description: '当前验证项', expectedOutcome: '通过' }],
        },
      ],
      reasoning: 'browser plan progress states',
    };
    const makeProgressData = (
      id: string,
      title: string,
      currentPlan: number,
      currentTodo: number,
      status: 'active' | 'complete',
    ) => {
      const complete = status === 'complete';
      const cursor = complete ? progressPlan.steps.length + 1 : currentPlan;
      const snapshot = {
        version: 2,
        modelContext: { messages: [{ role: 'user', content: title }] },
        transcript: [{
          id: `${id}-plan`, modelMessageIndex: 0, role: 'assistant', content: `${title}。`,
          planCard: { plan: progressPlan, currentPlan: cursor, currentTodo, complete },
        }],
        uiState: {
          planProgress: { plan: progressPlan, currentPlan: cursor, currentTodo, status },
          planState: { plan: progressPlan, planNumber: cursor, todoNumber: currentTodo, started: true, ...(complete ? { complete: true } : {}) },
        },
      };
      return { id, title, createdAt: Date.now(), updatedAt: Date.now(), messageCount: 1, workspace: '', snapshot };
    };
    const progressSessions = [
      makeProgressData('progress-session-todos', '多 Todo GUI 验证', 1, 2, 'active'),
      makeProgressData('progress-session-jump', '跳阶段 GUI 验证', 3, 1, 'active'),
      makeProgressData('progress-session-complete', '完成态 GUI 验证', 4, 2, 'complete'),
    ];
    await evaluate(`(() => {
      const entries = ${JSON.stringify(progressSessions)};
      localStorage.setItem('pure_sessions', JSON.stringify(entries.map(({ snapshot: _snapshot, ...meta }) => meta)));
      for (const entry of entries) {
        localStorage.setItem('pure_session:' + entry.id, JSON.stringify({ snapshot: entry.snapshot, updatedAt: entry.updatedAt, messageCount: entry.messageCount, workspace: entry.workspace }));
      }
      localStorage.setItem('pure_last_session', entries[0].id);
      return entries.map((entry) => entry.id);
    })()`);

    await send('Page.reload');
    await waitFor(async () => {
      const href = await evaluate('location.href');
      return typeof href === 'string' && href.startsWith(appUrl) && (await evaluate('document.readyState')) === 'complete';
    }, 25000, 'progress scenario reload');
    await waitFor(async () => {
      const count = await evaluate(`document.querySelectorAll('.sidebar-session-item[data-sid="progress-session-todos"], .sidebar-session-item[data-sid="progress-session-jump"], .sidebar-session-item[data-sid="progress-session-complete"]').length`);
      return Number(count) === 3;
    }, 25000, 'progress scenario session list');

    const readProgressView = async (): Promise<{
      cardTopSteps: string[];
      visibleTodos: string[];
      allTodos: string[];
      noOutline: boolean;
    }> => JSON.parse(String(await evaluate(`(() => {
      const card = document.querySelector('.plan-progress-text-plan');
      const row = card?.parentElement;
      const classes = (selector, root = card) => Array.from(root?.querySelectorAll(selector) ?? []).map((el) => el.className);
      return JSON.stringify({
        cardTopSteps: classes('.plan-progress-steps > .plan-progress-step'),
        visibleTodos: classes('.plan-progress-text-todos:not(.plan-progress-todo-hidden) .plan-progress-substep', row),
        allTodos: classes('.plan-progress-text-todos .plan-progress-substep', row),
        noOutline: document.querySelector('.plan-overview') === null,
      });
    })()`)));
    const assertProgressView = async (
      sid: string,
      action: string,
      expected: { cardTopSteps: string[]; visibleTodos: string[]; allTodos: string[] },
    ): Promise<void> => {
      await evaluate(`document.querySelector('.sidebar-session-item[data-sid="${sid}"]').click()`);
      await waitFor(async () => {
        const view = await readProgressView();
        return view.cardTopSteps.length === 3;
      }, 25000, `${sid} progress render`);
      const view = await readProgressView();
      const actual = {
        cardTopSteps: view.cardTopSteps,
        visibleTodos: view.visibleTodos,
        allTodos: view.allTodos,
        noOutline: view.noOutline,
      };
      const pass = JSON.stringify(actual) === JSON.stringify({ ...expected, noOutline: true });
      log(`  [${pass ? 'PASS' : 'FAIL'}] ${sid} → ${action}: ${JSON.stringify(actual)}`);
      if (!pass) failures++;
    };

    await assertProgressView('progress-session-todos', '多 Todo 当前项同步', {
      cardTopSteps: ['plan-progress-step active', 'plan-progress-step pending', 'plan-progress-step pending'],
      visibleTodos: ['plan-progress-substep plan-progress-todo-row done', 'plan-progress-substep plan-progress-todo-row active', 'plan-progress-substep plan-progress-todo-row pending'],
      allTodos: ['plan-progress-substep plan-progress-todo-row done', 'plan-progress-substep plan-progress-todo-row active', 'plan-progress-substep plan-progress-todo-row pending', 'plan-progress-substep plan-progress-todo-row pending'],
    });
    await assertProgressView('progress-session-jump', '跳阶段后卡片同步', {
      cardTopSteps: ['plan-progress-step done', 'plan-progress-step done', 'plan-progress-step active'],
      visibleTodos: ['plan-progress-substep plan-progress-todo-row active'],
      allTodos: ['plan-progress-substep plan-progress-todo-row done', 'plan-progress-substep plan-progress-todo-row done', 'plan-progress-substep plan-progress-todo-row done', 'plan-progress-substep plan-progress-todo-row active'],
    });
    await assertProgressView('progress-session-complete', '完成态全部同步', {
      cardTopSteps: ['plan-progress-step done', 'plan-progress-step done', 'plan-progress-step done'],
      visibleTodos: [],
      allTodos: ['plan-progress-substep plan-progress-todo-row done', 'plan-progress-substep plan-progress-todo-row done', 'plan-progress-substep plan-progress-todo-row done', 'plan-progress-substep plan-progress-todo-row done'],
    });
    log(`[verify] browser multi-Todo + phase jump + completion: ${failures === 0 ? 'OK' : 'MISMATCH'}`);
  }

  // ── Browser-level gate assertions ──
  // The review-pause gate (shouldPauseForRequestReview → decision card) and
  // the plan-continuation delivery gate (continuingProjectBuild →
  // needsDeliveryGate → continuation prompt) are turn-time logic, so they are
  // exercised against the app's OWN compiled modules inside the live page
  // (same Vite module graph the browser is running) with realistic seeded
  // inputs, then the DOM consequences are asserted on real rendered cards.
  if (scenario === 'gates' || scenario === 'all') {
    const gate = gateScenario;
    const gatesOk = async (): Promise<boolean> => {
      // 1) Review gate decisions + real card DOM.
      if (gate === 'all' || gate === 'review') {
        const review = await evaluate(`(async () => {
          const { shouldShowRequestReview, shouldPauseForRequestReview, createRequestReviewCard } = await import('/src/ui/requestReview.ts');
          const buildAssessment = { intent: 'build', riskLevel: 'low', reversibility: 'reversible', impact: '', recommendation: '', requiresProbe: false, requiresConfirmation: false };
          const destructiveAssessment = { ...buildAssessment, intent: 'delete', riskLevel: 'high', reversibility: 'irreversible', requiresConfirmation: true };
          const subjective = [{ part: '需求范围较大', verdict: 'questionable', reason: '需要更长时间', suggestion: '先做核心部分' }];
          const unreasonable = [{ part: '直接删除被引用的目录', verdict: 'unreasonable', reason: '迁移脚本还在引用它', suggestion: '先归档再删除' }];
          const trap = [{ part: '同时保持旧版接口', verdict: 'questionable', reason: '与删除旧模块互相矛盾' }];

          // Render the real card for the subjective concern (show-only: no pause).
          const host = document.createElement('div');
          host.id = 'gate-review-show';
          const card = createRequestReviewCard(subjective);
          host.appendChild(card.el);
          document.body.appendChild(host);

          // Render the real card for the unreasonable concern (pause: buttons).
          const host2 = document.createElement('div');
          host2.id = 'gate-review-pause';
          const card2 = createRequestReviewCard(unreasonable);
          host2.appendChild(card2.el);
          document.body.appendChild(host2);

          return {
            showSubjective: shouldShowRequestReview(subjective),
            pauseSubjective: shouldPauseForRequestReview(subjective, buildAssessment, false),
            pauseTrap: shouldPauseForRequestReview(trap, buildAssessment, true),
            pauseDestructive: shouldPauseForRequestReview(subjective, destructiveAssessment, false),
            pauseUnreasonable: shouldPauseForRequestReview(unreasonable, buildAssessment, false),
            pauseAllReasonable: shouldPauseForRequestReview([{ part: '保留新接口', verdict: 'reasonable', reason: '一致' }], destructiveAssessment, true),
          };
        })()`);

        // Subjective concern renders the card, but WITHOUT decision buttons
        // (the turn does not pause for an opinion).
        const showDom = await evaluate(`(() => {
          const host = document.getElementById('gate-review-show');
          const item = host?.querySelector('.request-review-item');
          return {
            card: !!host?.querySelector('.request-review-card'),
            itemClass: item?.className ?? '',
            actions: !!host?.querySelector('.request-review-actions'),
          };
        })()`);

        // Unreasonable concern pauses: the same card gains the decision bar
        // only when chat.ts calls enableDecisions (the pause path). Assert the
        // real wiring: no bar on the show-only card, bar + buttons on the
        // paused card after enableDecisions runs.
        const pauseDom = await evaluate(`(async () => {
          const { createRequestReviewCard } = await import('/src/ui/requestReview.ts');
          const host = document.getElementById('gate-review-pause');
          const card = createRequestReviewCard([{ part: '直接删除被引用的目录', verdict: 'unreasonable', reason: '迁移脚本还在引用它', suggestion: '先归档再删除' }]);
          host.appendChild(card.el);
          const before = !!host.querySelector('.request-review-actions');
          card.enableDecisions(() => true, () => true);
          const after = !!host.querySelector('.request-review-actions');
          const buttons = Array.from(host.querySelectorAll('.request-review-actions button')).map((b) => b.textContent);
          card.setDecided('已决策');
          const afterDecide = !!host.querySelector('.request-review-actions');
          return { before, after, buttons, afterDecide };
        })()`);

        const checks: Array<[string, boolean]> = [
          ['主观担忧 → 展示', review.showSubjective, true],
          ['主观担忧 → 不暂停', !review.pauseSubjective, true],
          ['逻辑陷阱 → 暂停', review.pauseTrap, true],
          ['破坏性/高风险 → 暂停', review.pauseDestructive, true],
          ['不合理判定 → 暂停', review.pauseUnreasonable, true],
          ['全合理 → 不暂停（即使高风险）', !review.pauseAllReasonable, true],
          ['主观卡渲染（含存疑样式）', showDom.card && showDom.itemClass.includes('request-review-questionable'), true],
          ['主观卡不渲染决策按钮', !showDom.actions, true],
          ['暂停卡初始无决策按钮', !pauseDom.before, true],
          ['暂停卡 enableDecisions 后出现决策按钮', pauseDom.after, true],
          ['决策按钮文案正确', pauseDom.buttons.length === 2 && pauseDom.buttons[0]?.includes('采纳建议') && pauseDom.buttons[1]?.includes('仍按原诉求'), true],
          ['决策后按钮移除', !pauseDom.afterDecide, true],
        ];
        let ok = true;
        for (const [name, actual, want] of checks) {
          const pass = actual === want;
          if (!pass) ok = false;
          log(`  [${pass ? 'PASS' : 'FAIL'}] review gate → ${name}: ${JSON.stringify(actual)}`);
        }
        log(`[verify] review gate (shouldPauseForRequestReview + card DOM): ${ok ? 'OK' : 'MISMATCH'}`);
        if (!ok) return false;
      }

      // 2) Plan-continuation delivery gate: continuingProjectBuild decides
      // needsDeliveryGate, and the continuation prompt carries the delivery
      // requirement only for build plans.
      if (gate === 'all' || gate === 'delivery') {
        const delivery = await evaluate(`(async () => {
          const { compileRequestWorkflow } = await import('/src/shared/requestWorkflow.ts');
          const { formatPlanContinuation } = await import('/src/ui/plan.ts');
          const plan = { steps: [
            { id: '1', action: 'A-需求', description: '读目标', expectedOutcome: '明确' },
            { id: '2', action: 'A-实现', description: '写代码', expectedOutcome: '完成' },
            { id: '3', action: 'A-验证', description: '跑验证', expectedOutcome: '通过' },
          ], reasoning: 'browser gate delivery' };
          const continuation = '继续执行';
          const ordinary = compileRequestWorkflow(continuation, { continuingPlan: true, continuingProjectBuild: false });
          const build = compileRequestWorkflow(continuation, { continuingPlan: true, continuingProjectBuild: true });
          const newTurn = compileRequestWorkflow('继续执行', { continuingPlan: false, continuingProjectBuild: false });
          const contPlain = formatPlanContinuation(plan, 2, 1, false);
          const contBuild = formatPlanContinuation(plan, 2, 1, true);
          return {
            ordinaryGate: ordinary.needsDeliveryGate,
            buildGate: build.needsDeliveryGate,
            newTurnGate: newTurn.needsDeliveryGate,
            plainHasRequirement: contPlain.includes('项目级交付仍需提供真实验证证据'),
            buildHasRequirement: contBuild.includes('项目级交付仍需提供真实验证证据'),
            buildHasMarker: contBuild.includes('## 计划 n：'),
          };
        })()`);

        const checks: Array<[string, boolean]> = [
          ['普通续跑 → 不开启交付门槛', !delivery.ordinaryGate, true],
          ['构建续跑 → 开启交付门槛', delivery.buildGate, true],
          ['首轮非构建 → 不开启交付门槛', !delivery.newTurnGate, true],
          ['普通续跑提示词 → 无交付要求', !delivery.plainHasRequirement, true],
          ['构建续跑提示词 → 含交付要求', delivery.buildHasRequirement, true],
          ['构建续跑提示词 → 保留阶段标记指令', delivery.buildHasMarker, true],
        ];
        let ok = true;
        for (const [name, actual, want] of checks) {
          const pass = actual === want;
          if (!pass) ok = false;
          log(`  [${pass ? 'PASS' : 'FAIL'}] delivery gate → ${name}: ${JSON.stringify(actual)}`);
        }
        log(`[verify] plan-continuation delivery gate (continuingProjectBuild → needsDeliveryGate): ${ok ? 'OK' : 'MISMATCH'}`);
        if (!ok) return false;
      }
      return true;
    };

    const pass = await gatesOk();
    if (!pass) failures++;
    log(`[verify] browser gate checks: ${pass ? 'OK' : 'MISMATCH'}`);
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
  log('[verify] all requested browser checks OK');
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
