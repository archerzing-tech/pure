#!/usr/bin/env bun
// One-shot UI audit of the settings-page CSS rework (scrollbars, alignment,
// contrast) over CDP: screenshots in both themes + measured gutter/metrics.
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const APP = 'http://localhost:1420';
const OUT = '/tmp/pure-ui-audit';

const tab = await fetch(`http://127.0.0.1:9226/json/new?about:blank`, { method: 'PUT' }).then((r) => r.json() as any);
const ws = new WebSocket(tab.webSocketDebuggerUrl);
await new Promise<void>((resolve, reject) => { ws.onopen = () => resolve(); ws.onerror = () => reject(new Error('ws error')); });
let msgId = 0;
const pending = new Map<number, (v: any) => void>();
ws.onmessage = (e: any) => {
  const msg = JSON.parse(String(e.data));
  if (msg.id && pending.has(msg.id)) { pending.get(msg.id)!(msg.result); pending.delete(msg.id); }
};
const send = (method: string, params: any = {}) => new Promise<any>((resolve) => {
  const id = ++msgId;
  pending.set(id, resolve);
  ws.send(JSON.stringify({ id, method, params }));
});
const evaluate = async (expression: string) => {
  const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  return r.result?.value;
};
const waitFor = async (expression: string, timeoutMs: number, what: string) => {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const v = await evaluate(expression);
    if (v) return v;
    await sleep(250);
  }
  throw new Error(`timeout waiting for ${what}`);
};
const shot = async (name: string) => {
  const r = await send('Page.captureScreenshot', { format: 'png' });
  await Bun.write(`${OUT}/${name}.png`, Buffer.from(r.data, 'base64'));
  console.log(`  shot: ${OUT}/${name}.png`);
};
const clickUntil = async (click: string, check: string, what: string) => {
  for (let i = 0; i < 40; i++) {
    const v = await evaluate(`${click} ${check}`);
    if (v?.ok) return;
    await sleep(300);
  }
  throw new Error(`timeout: ${what}`);
};

await send('Page.enable');
await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 2, mobile: false });
await send('Page.navigate', { url: APP });
await sleep(1500);
await evaluate(`localStorage.setItem('pure-onboarding-v1', 'done'); true`);
await send('Page.navigate', { url: `${APP}?_nocache=${Date.now()}` });
await waitFor('({ ok: document.readyState === "complete" && !!document.getElementById("sidebar-settings-btn") })', 25000, 'app boot');
await sleep(1000);

await clickUntil(
  `document.getElementById("sidebar-settings-btn")?.click();`,
  `({ ok: document.getElementById("settings-view")?.classList.contains("expanded") })`,
  'settings open',
);
await clickUntil(
  `document.querySelector('.settings-nav-item[data-category="evolution"]')?.click();`,
  `({ ok: document.querySelector('.settings-page[data-page="evolution"]')?.classList.contains("active") })`,
  'evolution page active',
);
await sleep(800);

const grabMetrics = `(() => {
  const pane = document.getElementById('settings-content');
  const gutter = pane ? pane.offsetWidth - pane.clientWidth : null;
  const rows = document.querySelectorAll('.setting-row');
  const rowLeft = rows.length ? Math.round(rows[0].getBoundingClientRect().left) : null;
  const dropped = document.querySelector('.settings-section > :not(.setting-row)');
  const droppedLeft = dropped ? Math.round(dropped.getBoundingClientRect().left) : null;
  const lists = ['tool-inventory','tool-corrections','skills-dir-rows','app-skills-list','hub-grouped','hub-installed','evolution-errors','evolution-advice','evolution-experience','mcp-server-list'];
  const found = lists.filter((id) => document.getElementById(id));
  return { gutter, rowLeft, droppedLeft, listIdsPresent: found.length };
})()`;

const btnColors = `(() => {
  const probe = (sel) => { const el = document.querySelector(sel); return el ? getComputedStyle(el).color : null; };
  return { primaryBtn: probe('.setting-btn.primary'), dangerBtn: probe('.setting-btn.danger'), hint: probe('.setting-hint') };
})()`;

for (const theme of ['light', 'dark'] as const) {
  await evaluate(`(() => { document.documentElement.setAttribute('data-theme', '${theme}'); localStorage.setItem('pure-theme', '${theme}'); return document.documentElement.getAttribute('data-theme'); })()`);
  await sleep(500);
  console.log(`[${theme}]`, JSON.stringify(await evaluate(grabMetrics)), JSON.stringify(await evaluate(btnColors)));
  await shot(`evolution-${theme}`);
  await evaluate(`document.querySelector('.settings-nav-item[data-category="memory"]')?.click(); true`);
  await sleep(600);
  await shot(`memory-${theme}`);
  await evaluate(`document.querySelector('.settings-nav-item[data-category="tools"]')?.click(); true`);
  await sleep(600);
  await shot(`tools-${theme}`);
  await evaluate(`document.querySelector('.settings-nav-item[data-category="evolution"]')?.click(); true`);
  await sleep(400);
}

ws.close();
console.log('AUDIT DONE');
