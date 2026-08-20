#!/usr/bin/env bun
// scripts/repro-expand.ts
// Frame-by-frame measurement of the tool-row maximize/collapse FLIP transition
// in a real headless Chrome. Self-contained: starts Vite + Chrome itself and
// cleans up what it started. Waits for the app stylesheets to actually load
// (the `.tool-row-scroll` cap must be active) before creating any rows.
import { mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const projectRoot = process.cwd();
const appUrl = 'http://localhost:1420/';
const cdpPort = 9236;
const chrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function urlResponds(url: string): Promise<boolean> {
  try { const r = await fetch(url); return r.ok; } catch { return false; }
}

async function waitFor(fn: () => Promise<boolean>, timeoutMs: number, label: string): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try { if (await fn()) return; } catch {}
    await sleep(200);
  }
  throw new Error(`timeout waiting for ${label}`);
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

let viteProc: import('bun').Subprocess | null = null;
if (!(await urlResponds(appUrl))) {
  viteProc = Bun.spawn(['bun', 'run', 'dev'], { detached: true, cwd: projectRoot, stdout: 'ignore', stderr: 'ignore' });
  await waitFor(() => urlResponds(appUrl), 40000, 'vite');
}

const profile = join(tmpdir(), `pure-expand-${Date.now()}`);
mkdirSync(profile, { recursive: true });
const chromeProc = Bun.spawn([chrome, '--headless=new', `--remote-debugging-port=${cdpPort}`, `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check', '--window-size=1400,900', 'about:blank'], { stdout: 'ignore', stderr: 'ignore' });
await waitFor(async () => {
  try { const r = await fetch(`http://127.0.0.1:${cdpPort}/json/version`); return r.ok; } catch { return false; }
}, 20000, 'chrome CDP');

let failures = 0;
try {
  const tab = await fetch(`http://127.0.0.1:${cdpPort}/json/new?about:blank`, { method: 'PUT' }).then((r) => r.json() as any);
  const ws = new WebSocket(tab.webSocketDebuggerUrl);
  await new Promise<void>((resolve, reject) => { ws.onopen = () => resolve(); ws.onerror = () => reject(new Error('ws error')); });
  let id = 0;
  const pending = new Map<number, (v: any) => void>();
  const send = (method: string, params: any = {}) => new Promise<any>((resolve) => {
    const msgId = ++id;
    pending.set(msgId, resolve);
    ws.send(JSON.stringify({ id: msgId, method, params }));
  });
  ws.onmessage = (ev) => {
    const msg = JSON.parse(String(ev.data));
    if (msg.id && pending.has(msg.id)) { pending.get(msg.id)!(msg.result); pending.delete(msg.id); }
  };
  const evaluate = async (expression: string) => {
    const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error('evaluate threw: ' + (r.exceptionDetails.exception?.description ?? r.exceptionDetails.text).slice(0, 400));
    return r.result?.value;
  };

  await send('Page.enable');
  await send('Runtime.enable');
  await send('Page.navigate', { url: appUrl });
  // Wait for BOTH the app and its stylesheets: the `.tool-row-scroll` max-height
  // cap must be live, otherwise the measured boxes are unstyled garbage.
  await waitFor(async () => {
    const href = await evaluate('location.href');
    if (typeof href !== 'string' || !href.startsWith(appUrl)) return false;
    const sheets = await evaluate('document.styleSheets.length');
    if (Number(sheets) === 0) return false;
    const maxH = await evaluate(`(() => {
      const el = document.createElement('div');
      el.className = 'tool-row-scroll';
      document.body.appendChild(el);
      const mh = getComputedStyle(el).maxHeight;
      el.remove();
      return mh;
    })()`);
    return String(maxH).endsWith('px');
  }, 25000, 'app + styles');

  const setup = await evaluate(`(async () => {
    const { createToolRow, setToolRowExpanded } = await import('/src/ui/toolRow.ts');
    const grid = document.createElement('div');
    grid.className = 'bubble-row tool-grid';
    grid.style.width = '1000px';
    grid.style.position = 'fixed';
    grid.style.top = '100px';
    grid.style.left = '50px';
    document.body.appendChild(grid);
    // TWO rows — the real user scenario (a single-card round hides the button)
    const rowA = createToolRow('web_search', { query: '四川 旅游 推荐 住宿' });
    const rowB = createToolRow('web_search', { query: '成都 景点' });
    grid.append(rowA.el, rowB.el);
    window.__rowA = rowA;
    window.__setToolRowExpanded = setToolRowExpanded;
    const a = rowA.el.getBoundingClientRect();
    const b = rowB.el.getBoundingClientRect();
    return {
      a: { w: Math.round(a.width), h: Math.round(a.height), x: Math.round(a.x), y: Math.round(a.y) },
      b: { w: Math.round(b.width), h: Math.round(b.height), x: Math.round(b.x), y: Math.round(b.y) },
      scrollMaxH: (() => { const s = rowA.el.querySelector('.tool-row-scroll'); return s ? getComputedStyle(s).maxHeight : '?'; })(),
    };
  })()`);
  console.log('setup:', JSON.stringify(setup));

  const expand = await evaluate(`(async () => {
    const row = window.__rowA;
    const out = [];
    const t0 = performance.now();
    const before = row.el.getBoundingClientRect();
    out.push({ t: 0, w: Math.round(before.width), h: Math.round(before.height), x: Math.round(before.x), y: Math.round(before.y), transform: row.el.style.transform || '(none)' });
    window.__setToolRowExpanded(row, true);
    for (let i = 0; i < 30; i++) {
      await new Promise((r2) => requestAnimationFrame(r2));
      const r = row.el.getBoundingClientRect();
      out.push({ t: Math.round(performance.now() - t0), w: Math.round(r.width), h: Math.round(r.height), x: Math.round(r.x), y: Math.round(r.y), transform: row.el.style.transform.slice(0, 90) || '(none)' });
    }
    return out;
  })()`);
  console.log('expand frames:');
  for (const f of expand as Array<Record<string, unknown>>) console.log(' ', JSON.stringify(f));

  await sleep(400);
  const collapse = await evaluate(`(async () => {
    const row = window.__rowA;
    const out = [];
    const t0 = performance.now();
    window.__setToolRowExpanded(row, false);
    for (let i = 0; i < 30; i++) {
      await new Promise((r2) => requestAnimationFrame(r2));
      const r = row.el.getBoundingClientRect();
      out.push({ t: Math.round(performance.now() - t0), w: Math.round(r.width), h: Math.round(r.height), x: Math.round(r.x), y: Math.round(r.y), transform: row.el.style.transform.slice(0, 90) || '(none)' });
    }
    return out;
  })()`);
  console.log('collapse frames:');
  for (const f of collapse as Array<Record<string, unknown>>) console.log(' ', JSON.stringify(f));

  ws.close();
} catch (e) {
  failures++;
  console.error('repro failed:', (e as Error).message);
} finally {
  try { killByPort(cdpPort); } catch {}
  rmSync(profile, { recursive: true, force: true });
  if (viteProc) { try { viteProc.kill(); } catch {} killByPort(1420); }
  console.log(failures === 0 ? 'repro OK' : `repro FAILED (${failures})`);
  process.exit(failures === 0 ? 0 : 1);
}
