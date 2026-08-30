#!/usr/bin/env bun
// scripts/e2e-settings-apikey.ts
// Real-browser regression for the settings API-key field (issue: pasting a key
// made it vanish ~300ms later). The debounced autoSave() rebuilds the provider
// panel and the rebuilt #cfg-apikey renders value-less by design (raw secrets
// never persist in markup), so the save path MUST carry the in-progress value,
// touched flag and focus across the re-render.
//
// Drives the unmodified app over CDP (no playwright/puppeteer dependency —
// same plumbing as verify-auto-continue.ts): open Settings → LLM → expand the
// DeepSeek card → enter a key into #cfg-apikey → wait past the 300ms debounce
// window → assert the field keeps the masked value, keeps focus, and persists
// the key (browser mode stores it under pure_config.providerOverrides) → then
// clear the field and assert the stored key is revoked.
//
// Self-contained: starts `bun run dev` and a headless Chrome when they are not
// already running, and stops only the processes it started.
//
// Usage:
//   bun run scripts/e2e-settings-apikey.ts [--app-url=URL] [--cdp-port=PORT] [--chrome=PATH] [--out=DIR] [--keep]

import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const argv = process.argv.slice(2);
const argValue = (name: string): string | undefined => {
  const flag = argv.find((a) => a.startsWith(`${name}=`));
  return flag ? flag.slice(name.length + 1) : undefined;
};

const appUrl = argValue('--app-url') ?? 'http://localhost:1420/';
const cdpPort = Number(argValue('--cdp-port') ?? 9224);
const outDir = argValue('--out') ?? '/tmp/pure-e2e-apikey';
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

/** First existing Chrome binary: explicit --chrome wins, then the macOS
 *  bundle, then common Linux names (GitHub runners ship Google Chrome). */
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

const PROVIDER_ID = 'deepseek-openai';
const FAKE_KEY = 'sk-e2e-abc123def456ghi789xyz';

interface StepFailure extends Error {
  step?: string;
}

/** Page console tail — module scope so the catch block can dump it. */
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
let chromeProc: import('bun').Subprocess | null = null;
let chromeProfile: string | null = null;
if (!(await urlResponds(cdpVersionUrl))) {
  chromeProfile = mkdtempSync(join(tmpdir(), 'pure-e2e-apikey-chrome-'));
  chromeProc = spawnDetached([
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

try {
  const tab = await fetch(`http://127.0.0.1:${cdpPort}/json/new?about:blank`, { method: 'PUT' }).then((r) => r.json() as any);
  if (!tab?.webSocketDebuggerUrl) throw new Error('CDP did not return a page websocket');
  const ws = new WebSocket(tab.webSocketDebuggerUrl);
  await new Promise<void>((resolve, reject) => {
    ws.onopen = () => resolve();
    ws.onerror = () => reject(new Error('ws error'));
    setTimeout(() => reject(new Error('ws open timeout')), 15000);
  });

  let msgId = 0;
  const pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
  ws.onmessage = (event: any) => {
    const msg = JSON.parse(String(event.data));
    // Capture page console output so a silent boot failure shows up in the
    // failure report instead of leaving the click doing "nothing".
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
    if (r.exceptionDetails) {
      console.log(`[e2e][debug] exceptionDetails: ${JSON.stringify(r.exceptionDetails).slice(0, 600)}`);
      console.log(`[e2e][debug] expression head: ${expression.slice(0, 200)}`);
      throw new Error('evaluate threw: ' + (r.exceptionDetails.exception?.description ?? r.exceptionDetails.text).slice(0, 500));
    }
    if (process.env.E2E_DEBUG) console.log(`[e2e][debug] raw result: ${JSON.stringify(r).slice(0, 400)}`);
    return r.result?.value;
  };
  /** Poll an in-page assertion until it passes or the budget runs out. */
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

  log('[e2e] CDP connected');
  await send('Page.enable');
  await send('Runtime.enable');

  // Fresh profile state: no seeded config, no restored session — the flow must
  // work from the exact first-run state a user hits when configuring a key.
  await send('Page.navigate', { url: appUrl });
  await waitFor('({ ok: document.readyState === "complete" })', 25000, 'app load');
  await evaluate(`(() => { localStorage.clear(); return "cleared"; })()`);
  // Avoid Page.reload({ ignoreCache: true }) — in headless=new Chrome on CI,
  // a hard reload can detach the CDP target (renderer restart), causing
  // "Inspected target navigated or closed".  Navigating to a cache-busted URL
  // achieves the same fresh-load effect without disrupting the CDP session.
  await send('Page.navigate', { url: `${appUrl}?_nocache=${Date.now()}` });
  // Re-enable domains after cross-document navigation (same as above).
  await send('Page.enable');
  await send('Runtime.enable');
  await waitFor('({ ok: document.readyState === "complete" && !!document.getElementById("sidebar-settings-btn") })', 25000, 'app boot');
  // App modules finish binding listeners shortly after DOM-ready; give the
  // init a settle beat so the first click lands on wired handlers.
  await sleep(1200);
  log('[e2e] app loaded (fresh profile)');

  /** Click-and-poll: retry the action until its effect assertion passes —
   *  immune to a click landing before handlers are wired. */
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

  // ── Drive: Settings → LLM → expand DeepSeek ──
  await clickUntil(
    `document.getElementById("sidebar-settings-btn")?.click();`,
    `{ ok: document.getElementById("settings-view")?.classList.contains("expanded") }`,
    8000, 'settings view opens',
  );
  await clickUntil(
    `const __b = [...document.querySelectorAll("#settings-view button")].find((b) => b.textContent?.trim() === "LLM"); __b?.click();`,
    `{ ok: document.querySelector('[data-page="llm"]')?.classList.contains("active") }`,
    8000, 'LLM page active',
  );
  await clickUntil(
    `document.querySelector('.llm-provider-card[data-provider="${PROVIDER_ID}"]')?.click();`,
    `{ ok: !!document.querySelector('.llm-provider-panel[data-provider="${PROVIDER_ID}"] #cfg-apikey') }`,
    8000, 'provider panel expands',
  );

  // ── Act: paste-equivalent entry of a key (bubbling input event reaches the
  // grid-level delegated listener, arming the 300ms debounced autoSave). ──
  await evaluate(`(() => {
    const el = document.getElementById("cfg-apikey");
    el.focus();
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;
    setter.call(el, ${JSON.stringify(FAKE_KEY)});
    el.dispatchEvent(new InputEvent("input", { bubbles: true }));
    return "typed";
  })()`);

  // Cross the debounce window (300ms) plus render slack, then poll until the
  // saved state settles (CI machines can delay timers unpredictably).
  const waitForState = async (assertExpr: string, label: string): Promise<any> => {
    const start = Date.now();
    let last: any;
    while (Date.now() - start < 8000) {
      last = await evaluate(assertExpr);
      if (last && last.ok) return last;
      await sleep(300);
    }
    return last;
  };

  const afterType = await waitForState(`(() => {
    const el = document.getElementById("cfg-apikey");
    let stored = {};
    try { stored = JSON.parse(localStorage.getItem("pure_config") ?? "{}"); } catch {}
    const ov = (stored.providerOverrides ?? {})["${PROVIDER_ID}"] ?? {};
    return {
      ok: el.value === ${JSON.stringify(FAKE_KEY)}
        && el.type === "password"
        && document.activeElement === el
        && ov.apiKey === ${JSON.stringify(FAKE_KEY)},
      value: el.value,
      masked: el.type === "password",
      focused: document.activeElement === el,
      persistedLen: String(ov.apiKey ?? "").length,
      touchedFlag: el.dataset.touched ?? null,
      debugKeys: Object.keys(localStorage),
      debugOverrides: stored.providerOverrides ? Object.keys(stored.providerOverrides) : null,
    };
  })()`);
  log(`[e2e] after paste:  value=${JSON.stringify(afterType.value)} masked=${afterType.masked} focused=${afterType.focused} persistedLen=${afterType.persistedLen}`);
  if (!afterType.ok) {
    const err = new Error(`paste regression: field lost the key across autoSave re-render (${JSON.stringify(afterType)})`) as StepFailure;
    err.step = 'paste';
    throw err;
  }

  // ── Act: clear the field — the touched flag must survive the earlier
  // re-render so clearing REVOKES the stored key instead of silently keeping it. ──
  await evaluate(`(() => {
    const el = document.getElementById("cfg-apikey");
    el.focus();
    el.select();
    document.execCommand("delete");
    el.dispatchEvent(new InputEvent("input", { bubbles: true }));
    return "cleared";
  })()`);
  const afterClear = await waitForState(`(() => {
    const el = document.getElementById("cfg-apikey");
    let stored = {};
    try { stored = JSON.parse(localStorage.getItem("pure_config") ?? "{}"); } catch {}
    const ov = (stored.providerOverrides ?? {})["${PROVIDER_ID}"] ?? {};
    return {
      ok: el.value === "" && ov.apiKey !== ${JSON.stringify(FAKE_KEY)} && ov.hasApiKey !== true,
      fieldValue: el.value,
      storedApiKey: ov.apiKey ?? null,
      hasApiKeyFlag: ov.hasApiKey ?? null,
    };
  })()`);
  log(`[e2e] after clear:   field=${JSON.stringify(afterClear.fieldValue)} stored=${JSON.stringify(afterClear.storedApiKey)} hasKeyFlag=${afterClear.hasApiKeyFlag}`);
  if (!afterClear.ok) {
    const err = new Error(`revoke regression: cleared field left a stored key behind (${JSON.stringify(afterClear)})`) as StepFailure;
    err.step = 'clear';
    throw err;
  }

  log('[e2e] PASS — key survives the autoSave re-render masked + focused, and clearing revokes it');
  ws.close();
  process.exit(0);
} catch (err) {
  const failure = err as StepFailure;
  log(`[e2e] FAIL${failure.step ? ` @ ${failure.step}` : ''}: ${failure.message}`);
  log(`page console (tail):\n${consoleLogs.slice(-15).join('\n') || '(empty)'}`);
  // Best-effort evidence capture for the CI artifact upload / local triage.
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
