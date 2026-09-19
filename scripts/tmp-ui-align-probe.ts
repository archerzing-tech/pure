#!/usr/bin/env bun
// One-off probe: do the Tavily / Serper / SearXNG inputs share a left edge?
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
await evaluate(`document.querySelector('.settings-nav-item[data-category="tools"]')?.click()`);
await sleep(400);

const report = await evaluate(`(() => {
  const measure = (id) => {
    const el = document.getElementById(id);
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { left: Math.round(r.left), right: Math.round(r.right), width: Math.round(r.width) };
  };
  return {
    serper: measure('cfg-serper-key'),
    tavily: measure('cfg-tavily-key'),
    searxng: measure('cfg-searxng-url'),
    viewport: { w: innerWidth },
  };
})()`);
console.log(JSON.stringify(report, null, 2));
ws.close();
