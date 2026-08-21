#!/usr/bin/env bun
// scripts/verify-auto-continue.ts
// Real-browser verification of long-task auto-continue (docs/auto-continue-design.md).
//
// The app's OWN engine runs unmodified against a local stub OpenAI-compatible
// server (this script starts it) that the seeded config points a custom
// provider at. The stub scripts a multi-stage plan: the semantic route, the
// task analysis (plan JSON), then one engine turn per stage that only emits
// `## 计划 n：` / `## 计划 n 已完成` markers (no tool calls — a non-build plan
// advances from markers alone). The verifier then asserts:
//
//   chain  — the plan card advances through every stage, exactly the expected
//            number of auto-continue rounds fire (🔁 bubbles), and the chain
//            STOPS at the terminal state (no extra engine turns).
//   abort  — Escape mid-chain cancels the in-flight round AND any pending
//            continuation; no further rounds fire.
//
// Self-contained: starts `bun run dev` and a headless Chrome when they are not
// already running, and stops only the processes it started.
//
// Usage:
//   bun run scripts/verify-auto-continue.ts [--scenario=chain|abort|all] [--stub-port=14101] [--out=DIR] [--app-url=URL] [--cdp-port=PORT] [--chrome=PATH] [--keep]

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const LOG_FILE = '/tmp/pure-verify-auto-continue.log';
function log(message: string): void {
  console.log(message);
  try { Bun.write(LOG_FILE, `${message}\n`, { append: true }); } catch {}
}

const argv = process.argv.slice(2);
const argValue = (name: string): string | undefined => {
  const flag = argv.find((a) => a.startsWith(`${name}=`));
  return flag ? flag.slice(name.length + 1) : undefined;
};
const scenario = argValue('--scenario') ?? 'all';
const stubPort = Number(argValue('--stub-port') ?? 14101);
const outDir = argValue('--out') ?? '/tmp/pure-auto-continue-verify';
const appUrl = argValue('--app-url') ?? 'http://localhost:1420/';
const cdpPort = Number(argValue('--cdp-port') ?? 9223);
const chromePath = argValue('--chrome') ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const keepServers = argv.includes('--keep');

const projectRoot = new URL('../', import.meta.url).pathname;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ── Stub LLM server ──────────────────────────────────────────────────────────
// OpenAI-compatible chat completions (streaming SSE for llm.stream, plain JSON
// for llm.complete) that script a staged plan by responding to the app's own
// system prompts. `engineTurns` counts the CodingAgent runLoop calls so the
// verifier can prove how many rounds actually fired.

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, POST, OPTIONS',
  'access-control-allow-headers': '*',
};

const THREE_STAGE_PLAN = `[
  {"action":"阶段一：需求确认","description":"确认需求并整理边界","expectedOutcome":"需求明确","todosRequired":false},
  {"action":"阶段二：方案实现","description":"完成核心实现","expectedOutcome":"功能可用","todosRequired":false},
  {"action":"阶段三：收尾验证","description":"检查结果并收尾","expectedOutcome":"全部完成","todosRequired":false}
]`;

const SIX_STAGE_PLAN = `[
  {"action":"阶段一","description":"第一阶段","expectedOutcome":"一完成","todosRequired":false},
  {"action":"阶段二","description":"第二阶段","expectedOutcome":"二完成","todosRequired":false},
  {"action":"阶段三","description":"第三阶段","expectedOutcome":"三完成","todosRequired":false},
  {"action":"阶段四","description":"第四阶段","expectedOutcome":"四完成","todosRequired":false},
  {"action":"阶段五","description":"第五阶段","expectedOutcome":"五完成","todosRequired":false},
  {"action":"阶段六","description":"第六阶段","expectedOutcome":"六完成","todosRequired":false}
]`;

const stubState = {
  stages: 3,
  engineTurns: 0,
  /** 3rd engine turn (abort scenario) responds slowly so Escape can land mid-stream. */
  slowTurn: -1,
  /** >0 while a turn's response is stalled — lets the driver wait on the stall
   *  being IN PROGRESS (streaming=true) instead of racing its completion. */
  stallingTurn: 0,
  calls: [] as string[],
};

const ROUTE_RESPONSE = JSON.stringify({
  intent: 'build',
  complexity: 'complex',
  mode: 'plan',
  requiresPlan: true,
  needsDeliveryGate: false,
  assessment: { riskLevel: 'low', reversibility: 'reversible', impact: 'stub', recommendation: 'stub', requiresProbe: false, requiresConfirmation: false },
});

function analysisResponse(): string {
  const plan = stubState.stages === 6 ? SIX_STAGE_PLAN : THREE_STAGE_PLAN;
  return [
    '这是一个需要分步完成的任务，我先说明思路：按三个阶段推进，每个阶段独立交付。',
    '<request_review>',
    '[]',
    '</request_review>',
    '',
    '```json',
    plan,
    '```',
    '',
    '<intent_assessment>',
    JSON.stringify({ intent: 'build', riskLevel: 'low', reversibility: 'reversible', impact: 'stub', recommendation: 'stub', requiresProbe: false, requiresConfirmation: false }),
    '</intent_assessment>',
  ].join('\n');
}

function stageText(n: number): string {
  return `## 计划 ${n}：执行阶段 ${n}\n这是阶段 ${n} 的工作内容，我正在处理。\n## 计划 ${n} 已完成\n阶段 ${n} 的工作已完成。`;
}

/** One engine turn = two model calls: (A) a sys_info tool_call, (B) after the
 * tool result, the stage markers. sys_info is the one tool that stays
 * available in the plain browser (no Tauri backend, no workspace), and the
 * page-patched adapter makes it succeed. Counting the (A) responses gives the
 * number of engine turns that actually started. */
/** The engine round's FIRST LLM call ends with the user prompt (the new turn
 * or a `继续` continuation). After the model's tool_call, the engine appends
 * the `tool` result as the LAST message, so a stage-text call always ends
 * with role `tool`. Internal hints (verifier retries, degradation notes) are
 * role `user` but flagged `internal` — those are re-THINKs of the SAME round
 * and must not count as a new engine turn. Keying off the LAST message (not
 * "any tool message in history") matters for continuations: the auto round's
 * history contains the previous turn's tool result, so `some(role==='tool')`
 * would wrongly skip the fresh-round tool_call and never advance. */
function isFreshEngineRound(messages: any[]): boolean {
  const last = messages[messages.length - 1];
  return !last || (last.role !== 'tool' && !last.internal);
}

function respondFor(body: any): string {
  const messages: any[] = body?.messages ?? [];
  const sys = messages
    .map((m: any) => (typeof m?.content === 'string' ? m.content : ''))
    .join('\n');
  if (sys.includes('You are the routing layer')) { stubState.calls.push(`route roles=${messages.map((m) => m.role).join(',')}`); return ROUTE_RESPONSE; }
  if (sys.includes('You are a senior engineer thinking through')) { stubState.calls.push(`analysis roles=${messages.map((m) => m.role).join(',')}`); return analysisResponse(); }
  if (sys.includes('strict stage protocol') || sys.includes('<plan_continuation>')) {
    if (isFreshEngineRound(messages)) {
      stubState.engineTurns++;
      stubState.calls.push(`engine:${stubState.engineTurns}:tool (roles ${messages.map((m) => m.role).join(',')})`);
      return JSON.stringify({
        toolCall: { id: `call_stub_${stubState.engineTurns}`, name: 'sys_info', arguments: '{}' },
      });
    }
    const n = Math.min(stubState.engineTurns, stubState.stages);
    stubState.calls.push(`engine:${stubState.engineTurns}:stage${n} (roles ${messages.map((m) => m.role).join(',')})`);
    return stageText(n);
  }
  stubState.calls.push(`generic (roles ${messages.map((m) => m.role).join(',')})`);
  // Background compaction / any other call: neutral filler.
  return '好的。';
}

const stubServer = Bun.serve({
  port: stubPort,
  async fetch(req) {
    const url = new URL(req.url);
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
    if (url.pathname === '/v1/models') {
      return Response.json({ object: 'list', data: [{ id: 'stub' }] }, { headers: CORS });
    }
    if (url.pathname === '/stub-state') {
      return Response.json({ ...stubState, calls: stubState.calls.slice(-20) }, { headers: CORS });
    }
    if (req.method === 'POST' && url.pathname.endsWith('/chat/completions')) {
      const body = await req.json().catch(() => null);
      const wantsStream = body?.stream === true;
      const messages: any[] = body?.messages ?? [];
      const sys = messages.map((m: any) => (typeof m?.content === 'string' ? m.content : '')).join('\n');
      const isEngineTurn = sys.includes('strict stage protocol') || sys.includes('<plan_continuation>');
      const isToolRound = isEngineTurn && !isFreshEngineRound(messages);
      // Abort scenario: the slowTurn-th engine turn's tool_call response stalls
      // so the CDP driver can Escape while the LLM fetch is in flight. The
      // stage (non-tool) round of that SAME turn also stalls, so once the tool
      // round completes (engineTurns === slowTurn) there is still a wide 4s
      // streaming window for Escape to land mid-turn — instead of a tight race
      // against the next auto round firing (previously flaky under load).
      const isSlowToolRound = !isToolRound && isEngineTurn && stubState.slowTurn > 0 && stubState.engineTurns + 1 === stubState.slowTurn;
      const isSlowStageRound = isToolRound && isEngineTurn && stubState.slowTurn > 0 && stubState.engineTurns === stubState.slowTurn;
      if (wantsStream && (isSlowToolRound || isSlowStageRound)) {
        stubState.stallingTurn = stubState.slowTurn;
        await sleep(4000);
        stubState.stallingTurn = 0;
      }
      const text = respondFor(body);
      const toolCall = (() => {
        try { return JSON.parse(text).toolCall ?? null; } catch { return null; }
      })();
      if (!wantsStream) {
        return Response.json(
          { id: 'stub', object: 'chat.completion', created: Date.now(), model: 'stub', choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 } },
          { headers: CORS },
        );
      }
      const encoder = new TextEncoder();
      const sse = new ReadableStream<Uint8Array>({
        start(controller) {
          const emit = (data: unknown) => controller.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`));
          if (toolCall) {
            emit({ id: 'stub', object: 'chat.completion.chunk', created: Date.now(), model: 'stub', choices: [{ index: 0, delta: { role: 'assistant', content: null, tool_calls: [{ index: 0, id: toolCall.id, type: 'function', function: { name: toolCall.name, arguments: toolCall.arguments } }] }, finish_reason: 'tool_calls' }] });
          } else {
            emit({ id: 'stub', object: 'chat.completion.chunk', created: Date.now(), model: 'stub', choices: [{ index: 0, delta: { role: 'assistant', content: text }, finish_reason: 'stop' }] });
          }
          emit({ id: 'stub', object: 'chat.completion.chunk', created: Date.now(), model: 'stub', choices: [], usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 } });
          controller.enqueue(encoder.encode('data: [DONE]\n\n'));
          controller.close();
        },
      });
      return new Response(sse, { headers: { ...CORS, 'content-type': 'text/event-stream' } });
    }
    return new Response('not found', { status: 404, headers: CORS });
  },
});
log(`[verify] stub LLM on http://127.0.0.1:${stubPort} (pid ${process.pid})`);

// ── Vite + headless Chrome scaffolding (same pattern as verify-plan-restore) ──

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
  log(`[verify] started ${label} (pid ${proc.pid})`);
  return proc;
}

function killGroup(proc: import('bun').Subprocess): void {
  try { proc.kill(); } catch {}
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

if (!['chain', 'abort', 'all'].includes(scenario)) {
  console.error('Usage: bun run scripts/verify-auto-continue.ts [--scenario=chain|abort|all] [--stub-port=14101] [--out=DIR] [--app-url=URL] [--cdp-port=PORT] [--chrome=PATH] [--keep]');
  process.exit(2);
}
mkdirSync(outDir, { recursive: true });

let viteProc: import('bun').Subprocess | null = null;
if (!(await urlResponds(appUrl))) {
  viteProc = spawnDetached(['bun', 'run', 'dev'], 'vite');
  await waitFor(() => urlResponds(appUrl), 40000, 'vite on ' + appUrl);
  log('[verify] vite ready');
} else {
  log('[verify] vite already running — reusing');
}

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

const tab = await fetch(`http://127.0.0.1:${cdpPort}/json/new?about:blank`, { method: 'PUT' }).then((r) => r.json() as any);
if (!tab?.webSocketDebuggerUrl) throw new Error('CDP did not return a page websocket: ' + JSON.stringify(tab).slice(0, 200));
const ws = new WebSocket(tab.webSocketDebuggerUrl);
await Promise.race([
  new Promise<void>((resolve, reject) => { ws.onopen = () => resolve(); ws.onerror = () => reject(new Error('ws error')); }),
  new Promise<void>((_, reject) => setTimeout(() => reject(new Error('ws open timeout')), 15000)),
]);
let msgId = 0;
const pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
const consoleLogs: string[] = [];
ws.onmessage = (event: any) => {
  const msg = JSON.parse(String(event.data));
  if (msg.method === 'Runtime.consoleAPICalled') {
    const text = (msg.params?.args ?? []).map((a: any) => a?.value ?? a?.description ?? '').join(' ').slice(0, 300);
    consoleLogs.push(`[${msg.params?.type ?? 'log'}] ${text}`);
    if (consoleLogs.length > 200) consoleLogs.shift();
    return;
  }
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

const stubStateFetch = async () => (await fetch(`http://127.0.0.1:${stubPort}/stub-state`).then((r) => r.json())) as { stages: number; engineTurns: number };

async function dumpPage(tag: string): Promise<void> {
  try {
    const raw = String(await evaluate(`JSON.stringify((() => {
      const configRaw = localStorage.getItem('pure_config');
      let config = null;
      try { config = configRaw ? JSON.parse(configRaw) : null; } catch {}
      const card = document.querySelector('.plan-progress-text-plan');
      const splash = document.getElementById('boot-splash');
      return {
        config,
        fetches: (window).__pageFetches || [],
        splash: splash ? { cls: splash.className, display: getComputedStyle(splash).display, visibility: getComputedStyle(splash).visibility } : null,
        rows: Array.from(document.querySelectorAll('#chat .bubble-row, #chat-view .bubble-row')).map((el) => ({
          cls: el.className,
          text: (el.textContent || '').slice(0, 400),
        })),
        card: card ? {
          steps: Array.from(card.querySelectorAll('.plan-progress-step')).map((s) => [...s.classList].find((c) => c === 'done' || c === 'active' || c === 'pending')),
          activity: (card.querySelector('.plan-progress-activity, [class*="activity"]') || {}).textContent || '',
        } : null,
        landingPrompt: (document.getElementById('landing-prompt') || {}).value || null,
        modelLabel: (document.getElementById('sidebar-model') || {}).textContent || null,
      };
    })())`));
    log(`[debug] ${tag} stubState: ${JSON.stringify({ ...stubState, calls: stubState.calls.slice(-20) })}`);
    log(`[debug] ${tag} console:\n${consoleLogs.slice(-30).join('\n')}`);
    log(`[debug] ${tag}: ${raw}`);
  } catch (e) {
    log(`[debug] ${tag} dump failed: ${(e as Error)?.message}`);
  }
}

// The seeded config points the app's REAL adapter at the stub provider, turns
// auto-continue ON, and disables the post-turn LLM verifier (code-review) so
// no extra calls confuse the turn counter.
function seedConfig(): string {
  const cfg = {
    provider: 'stub-provider',
    model: 'stub',
    apiKey: 'stub',
    hasApiKey: true,
    customProviders: [{
      id: 'stub-provider', name: 'Stub', baseURL: `http://127.0.0.1:${stubPort}/v1`,
      models: ['stub'], defaultModel: 'stub', apiKey: 'stub', hasApiKey: true, local: true,
    }],
    permissionMode: 'auto',
    autoPermRead: true, autoPermWrite: true, autoPermCmd: true, autoPermGit: true,
    toolFS: true, toolCmd: true, toolGit: true, toolBrowser: false,
    autoContinue: true,
    autoContinueMaxRounds: 8,
    skills: { 'code-review': false, 'web-research': false, memory: false, planning: true },
    taskMode: 'auto',
    language: 'zh-CN',
    configVersion: 13,
  };
  return `(() => {
    localStorage.setItem('pure_config', ${JSON.stringify(JSON.stringify(cfg))});
    localStorage.removeItem('pure_last_session');
    return 'seeded';
  })()`;
}

const readView = () => evaluate(`(() => {
  const card = document.querySelector('.plan-progress-text-plan');
  const steps = card ? Array.from(card.querySelectorAll('.plan-progress-step')) : [];
  const userBubbles = Array.from(document.querySelectorAll('.bubble-row.user')).map((el) => el.textContent ?? '');
  const autoBadge = card?.querySelector('.plan-progress-auto-continue');
  return JSON.stringify({
    card: !!card,
    doneSteps: steps.filter((s) => s.classList.contains('done')).length,
    totalSteps: steps.length,
    stepClasses: steps.map((s) => [...s.classList].find((c) => c === 'done' || c === 'active' || c === 'pending') ?? ''),
    // Row textContent carries the "You" label before the message, so match
    // the auto-continue marker with includes() instead of startsWith().
    autoRounds: userBubbles.filter((t) => t.includes('自动续跑')).length,
    // Live auto-continue badge on the plan card head: 自动续跑中 N/M.
    // Check the computed display, not just the hidden property. An author
    // display rule can override the UA hidden display none, so a buggy
    // badge could be hidden=true yet still visible.
    autoBadge: autoBadge ? { hidden: autoBadge.hidden, display: getComputedStyle(autoBadge).display, text: autoBadge.textContent || '' } : null,
    noOutline: document.querySelector('.plan-overview') === null,
  });
})()`).then((v) => JSON.parse(String(v)));

// The browser (non-Tauri) has no real tool backend, so file tools always fail
// in the page. Patch the adapter BEFORE the engine runs so the stub's write_file
// calls execute successfully — the engine, runLoop and tool pipeline stay real.
const patchTools = async (): Promise<void> => {
  const ok = await evaluate(`(async () => {
    (window).__pageFetches = [];
    const origFetch = window.fetch.bind(window);
    window.fetch = (input, init) => {
      const url = typeof input === 'string' ? input : (input && input.url) || String(input);
      if (url.includes(${JSON.stringify(`:${stubPort}/`)})) {
        (window).__pageFetches.push(url + ' ' + (init?.method ?? 'GET'));
      }
      return origFetch(input, init);
    };
    const wrap = (proto, name) => {
      const orig = proto[name];
      proto[name] = function (...args) {
        const gen = orig.apply(this, args);
        console.log('[probe-call]', name, 'msgs=', (args[1]?.length ?? args[2]?.length ?? 0));
        return (async function* () {
          for await (const ev of gen) {
            console.log('[probe-event]', name, ev.type, ev.payload?.reason || ev.payload?.code || '');
            yield ev;
          }
        })();
      };
    };
    const agentMod = await import('/src/coding-agent/CodingAgent.ts');
    wrap(agentMod.CodingAgent.prototype, 'run');
    wrap(agentMod.CodingAgent.prototype, 'continueTurn');
    const mod = await import('/src/ui/TauriToolAdapter.ts');
    mod.TauriToolAdapter.prototype.execute = async function (toolCall) {
      return { id: toolCall.id, toolName: toolCall.function.name, result: 'stub ok', success: true, duration: 1 };
    };
    return typeof mod.TauriToolAdapter.prototype.execute === 'function';
  })()`);
  if (ok !== true) throw new Error('failed to patch TauriToolAdapter.execute');
  log('[verify] patched TauriToolAdapter.execute (stub tool backend)');
};

const sendTask = async (taskText: string): Promise<void> => {
  // Wait for the landing composer to exist (module init may still be running
  // when readyState flips), then type, then submit through the REAL send
  // button once the input listener enables it — Enter-keydown can race the
  // listener attachment and silently drop the message.
  await waitFor(async () => (await evaluate(`(() => {
    const btn = document.getElementById('landing-send-btn');
    const prompt = document.getElementById('landing-prompt');
    return btn !== null && prompt !== null;
  })()`)) === true, 30000, 'landing composer present');
  await evaluate(`(() => {
    const el = document.getElementById('landing-prompt');
    el.value = ${JSON.stringify(taskText)};
    el.dispatchEvent(new Event('input', { bubbles: true }));
    return el.value;
  })()`);
  await waitFor(async () => (await evaluate(`(() => {
    const btn = document.getElementById('landing-send-btn');
    return btn !== null && !btn.disabled;
  })()`)) === true, 15000, 'landing send enabled');
  await evaluate(`(() => {
    const btn = document.getElementById('landing-send-btn');
    if (btn && !btn.disabled) btn.click();
    return true;
  })()`);
};

let failures = 0;
const check = (name: string, actual: unknown, want: unknown): void => {
  const pass = JSON.stringify(actual) === JSON.stringify(want);
  if (!pass) failures++;
  log(`  [${pass ? 'PASS' : 'FAIL'}] ${name}: ${JSON.stringify(actual)}${pass ? '' : ` (expected ${JSON.stringify(want)})`}`);
};

try {
  // ── Scenario: chain (3 stages → completion, exactly 2 auto rounds) ──
  if (scenario === 'chain' || scenario === 'all') {
    log('[verify] scenario chain — 3 stages, expect exactly 2 auto rounds then a stop');
    stubState.stages = 3;
    stubState.engineTurns = 0;
    stubState.slowTurn = -1;
    await evaluate(seedConfig());
    await send('Page.reload');
    await waitFor(async () => (await evaluate('document.readyState')) === 'complete' && (await evaluate('document.getElementById("landing-prompt") !== null')), 25000, 'chain reload');
    await patchTools();
    await sendTask('帮我做一个三阶段演示任务');
    // The badge appears as soon as turn 1's finally schedules the first auto
    // round — poll for it right away, BEFORE waiting on the engine turns, so
    // the poll can't race past the terminal round's finally (which clears it).
    try {
      await waitFor(async () => {
        const view = await readView();
        // Visible = not hidden AND a real display (not 'none'). Guards against
        // a badge that's hidden=true but visually still showing because an
        // author `display` rule beat the UA [hidden]{display:none}.
        return Boolean(view.autoBadge && !view.autoBadge.hidden && view.autoBadge.display !== 'none' && /自动续跑中 \d+\/8/.test(view.autoBadge.text));
      }, 90000, 'auto-continue badge visible mid-chain');
    } catch (e) {
      await dumpPage('auto badge not visible');
      throw e;
    }
    check('auto-continue badge visible mid-chain', true, true);
    // The engine must make exactly 3 turns: user turn (stage 1) + 2 auto rounds (stages 2-3).
    try {
      const chainDeadline = Date.now() + 90000;
      while (Date.now() < chainDeadline) {
        const st = await stubStateFetch();
        if (st.engineTurns >= 3) break;
        await sleep(3000);
        log(`[verify] waiting for engine turns… now=${st.engineTurns} calls=${JSON.stringify(stubState.calls.slice(-6))}`);
      }
      if ((await stubStateFetch()).engineTurns < 3) throw new Error('timeout waiting for chain engine turns');
    } catch (e) {
      await dumpPage('chain after sendTask');
      throw e;
    }
    try {
      await waitFor(async () => {
        const view = await readView();
        return view.card && view.doneSteps === 3;
      }, 90000, 'chain plan card complete');
    } catch (e) {
      await dumpPage('chain card not complete');
      throw e;
    }
    const view = await readView();
    check('plan card rendered with 3 steps', view.card && view.totalSteps === 3, true);
    check('all steps done', view.doneSteps, 3);
    check('auto-continue rounds fired (🔁 bubbles)', view.autoRounds, 2);
    check('no floating outline', view.noOutline, true);
    // Chain must STOP at the terminal state: no further engine turns or 🔁 bubbles.
    await sleep(3500);
    const after = await stubStateFetch();
    const viewAfter = await readView();
    check('chain stopped (engine turns frozen at 3)', after.engineTurns, 3);
    check('chain stopped (no extra 🔁 bubbles)', viewAfter.autoRounds, 2);
    check('auto-continue badge cleared at terminal', viewAfter.autoBadge === null || (viewAfter.autoBadge.hidden && viewAfter.autoBadge.display === 'none'), true);
    log(`[verify] chain: ${failures === 0 ? 'OK' : 'MISMATCH'}`);
  }

  // ── Scenario: abort (Escape mid-chain cancels the round and the chain) ──
  if (scenario === 'abort' || scenario === 'all') {
    const beforeAbort = failures;
    log('[verify] scenario abort — 6 stages, Escape on the 3rd engine turn');
    stubState.stages = 6;
    stubState.engineTurns = 0;
    stubState.slowTurn = 3; // the 3rd engine turn (stage 3) stalls for 4s
    await evaluate(seedConfig());
    await send('Page.reload');
    await waitFor(async () => (await evaluate('document.readyState')) === 'complete' && (await evaluate('document.getElementById("landing-prompt") !== null')), 25000, 'abort reload');
    await patchTools();
    await sendTask('帮我做一个六阶段演示任务');
    // Wait until the 3rd engine turn's response is STALLING (streaming=true),
    // not until it completes — the stall flag is set before the sleep, so this
    // returns while the LLM fetch is genuinely in flight and Escape is sure to
    // interrupt a live turn (a turn between rounds isn't streaming and Escape
    // would be a no-op).
    await waitFor(async () => (await stubStateFetch()).stallingTurn === 3, 90000, 'abort 3rd turn stalling');
    await sleep(300); // let the fetch settle into the stall
    // Escape cancels the streaming turn AND any pending auto-continue.
    await evaluate(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))`);
    // Wait past the server-side stall (4s) + the auto-continue gap (1.2s): if
    // the chain survived the abort, round 4 would fire in this window. The
    // aborted turn's tool round still completes server-side (engineTurns → 3),
    // but the client interrupted the turn, so no stage text and no round 4.
    await sleep(6000);
    const after = await stubStateFetch();
    const view = await readView();
    check('chain cancelled (engine turns frozen below 6)', after.engineTurns < 6, true);
    check('chain cancelled (frozen at 3, no round after abort)', after.engineTurns, 3);
    check('plan NOT completed after abort', view.doneSteps < 6, true);
    log(`[verify] abort: ${failures === beforeAbort ? 'OK' : 'MISMATCH'}`);
  }

  const shot = await send('Page.captureScreenshot', { format: 'png' });
  const shotPath = join(outDir, 'auto-continue.png');
  writeFileSync(shotPath, Buffer.from(shot.data, 'base64'));
  log(`[verify] screenshot: ${shotPath}`);
} finally {
  try { ws.close(); } catch {}
  if (chromeProc && !keepServers) {
    killGroup(chromeProc);
    killByPort(cdpPort);
    if (chromeProfile) rmSync(chromeProfile, { recursive: true, force: true });
  }
  if (viteProc && !keepServers) killGroup(viteProc);
  if (!keepServers) {
    // The stub is in-process: it dies with this script. Only vite grandchildren
    // may outlive us on the app port.
    killByPort(1420);
  }
  try { stubServer.stop(); } catch {}
  log(`[verify] stopped stub / chrome / vite`);
}

log(failures === 0 ? '[verify] all checks OK' : `[verify] ${failures} check(s) FAILED`);
process.exit(failures === 0 ? 0 : 1);
