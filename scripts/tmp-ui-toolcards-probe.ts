#!/usr/bin/env bun
// One-off probe: Settings → 外观 → 工具卡片 toggle — exists? default on?
// Does toggling it off persist to the config and collapse open tool rows?
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const APP = 'http://localhost:4173';

const tab = await fetch(`http://127.0.0.1:9226/json/new?${APP}`, { method: 'PUT' }).then((r) => r.json() as any);
const ws = new WebSocket(tab.webSocketDebuggerUrl);
await new Promise<void>((resolve, reject) => { ws.onopen = () => resolve(); ws.onerror = () => reject(new Error('ws error')); });
let msgId = 0;
const pending = new Map<number, (v: any) => void>();
ws.onmessage = (e: any) => {
  const msg = JSON.parse(String(e.data));
  if (msg.id && pending.has(msg.id)) { pending.get(msg.id)!(msg.result); pending.delete(msg.id); }
};
const send = (method: string, params: any = {}): Promise<any> =>
  new Promise((resolve) => { const id = ++msgId; pending.set(id, resolve); ws.send(JSON.stringify({ id, method, params })); });
const evaluate = async (expression: string) => (await send('Runtime.evaluate', { expression, returnByValue: true }))?.result?.value;

await send('Page.enable');
await send('Page.navigate', { url: APP });
await sleep(3000);
await evaluate(`document.getElementById('sidebar-settings-btn')?.click()`);
await sleep(1200);
await evaluate(`document.querySelector('.settings-nav-item[data-category="appearance"]')?.click()`);
await sleep(400);

const report: any = await evaluate(`(() => {
  const el = document.getElementById('cfg-tool-cards-expanded');
  if (!el) return { found: false };
  const r = el.getBoundingClientRect();
  return {
    found: true,
    visible: r.height > 0,
    checked: el.checked,
    rowVisible: !!el.closest('.setting-row') && el.closest('.setting-row').getBoundingClientRect().height > 0,
  };
})()`);

// Toggle OFF → autoSave should persist, and any open details.tool-row in the
// live transcript should be swept shut. Inject a fake open row to watch it.
await evaluate(`(() => {
  const d = document.createElement('details');
  d.className = 'tool-row'; d.open = true; d.id = 'probe-fake-row';
  document.body.appendChild(d);
})()`);
await evaluate(`document.getElementById('cfg-tool-cards-expanded').click()`);
await sleep(600);
report.afterToggleOff = await evaluate(`(() => {
  const el = document.getElementById('cfg-tool-cards-expanded');
  let cfg = null;
  try { cfg = JSON.parse(localStorage.getItem('pure_config') || 'null'); } catch {}
  return {
    checked: el.checked,
    storedToolCardsExpanded: cfg ? cfg.toolCardsExpanded : 'config-key-not-found',
    fakeRowStillOpen: document.getElementById('probe-fake-row')?.open ?? 'row-gone',
  };
})()`);
// cleanup the probe row and restore the default (on)
await evaluate(`document.getElementById('probe-fake-row')?.remove()`);
await evaluate(`document.getElementById('cfg-tool-cards-expanded').click()`);
await sleep(400);
report.restoredChecked = await evaluate(`document.getElementById('cfg-tool-cards-expanded').checked`);

console.log(JSON.stringify(report, null, 2));
ws.close();
