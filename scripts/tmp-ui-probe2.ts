#!/usr/bin/env bun
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const APP = 'http://localhost:4173';

const tab = await fetch(`http://127.0.0.1:9226/json/new?about:blank`, { method: 'PUT' }).then((r) => r.json() as any);
const ws = new WebSocket(tab.webSocketDebuggerUrl);
await new Promise<void>((resolve, reject) => { ws.onopen = () => resolve(); ws.onerror = () => reject(new Error('ws error')); });
let msgId = 0;
const pending = new Map<number, (v: any) => void>();
const logs: string[] = [];
ws.onmessage = (e: any) => {
  const msg = JSON.parse(String(e.data));
  if (msg.method === 'Runtime.consoleAPICalled') logs.push(msg.params.type + ': ' + (msg.params.args ?? []).map((a: any) => a.value ?? a.description ?? '').join(' ').slice(0, 200));
  if (msg.method === 'Runtime.exceptionThrown') logs.push('EXC: ' + String(msg.params.exceptionDetails?.exception?.description ?? msg.params.exceptionDetails?.text ?? '').slice(0, 300));
  if (msg.id && pending.has(msg.id)) { pending.get(msg.id)!(msg.result); pending.delete(msg.id); }
};
const send = (method: string, params: any = {}) => new Promise<any>((resolve) => {
  const id = ++msgId;
  pending.set(id, resolve);
  ws.send(JSON.stringify({ id, method, params }));
});
const evaluate = async (expression: string) => {
  const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  return r.result?.value ?? r.result?.description ?? null;
};

await send('Page.enable');
await send('Runtime.enable');
await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 2, mobile: false });
await send('Page.navigate', { url: APP });
await sleep(3000);
console.log('boot probe:', JSON.stringify(await evaluate(`({
  ready: document.readyState,
  btn: !!document.getElementById('sidebar-settings-btn'),
  view: !!document.getElementById('settings-view'),
  viewClass: document.getElementById('settings-view')?.className ?? null,
  bodyKids: document.body.children.length,
})`)));
console.log('click returns:', JSON.stringify(await evaluate(`(() => { const b = document.getElementById('sidebar-settings-btn'); b?.click(); return { clicked: !!b }; })()`)));
await sleep(1200);
console.log('after click:', JSON.stringify(await evaluate(`({
  viewClass: document.getElementById('settings-view')?.className ?? null,
  expanded: document.getElementById('settings-view')?.classList.contains('expanded') ?? null,
  settingsViewCount: document.querySelectorAll('#settings-view').length,
})`)));
console.log('--- console/exceptions ---');
for (const l of logs.slice(-12)) console.log(l);
ws.close();
