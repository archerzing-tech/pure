#!/usr/bin/env bun
// One-off probe: why is #cfg-phase-think ~220px tall when it should be ~36px?
// Measures the input, its ancestors, and reports the CSS rules that set
// non-content height on it.
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
await send('Runtime.enable');
await send('Page.navigate', { url: APP });
await sleep(3000);
await evaluate(`document.getElementById('sidebar-settings-btn')?.click()`);
await sleep(1200);
// Actually switch to the LLM category so the subtree is visible and rects are real.
await evaluate(`document.querySelector('.settings-nav-item[data-category="llm"]')?.click()`);
await sleep(400);

const report = await evaluate(`(() => {
  const input = document.getElementById('cfg-phase-think');
  if (!input) return { found: false };
  const cs = getComputedStyle(input);
  const r = input.getBoundingClientRect();
  return {
    found: true,
    visible: r.height > 0,
    inputHeight: r.height,
    inputWidth: r.width,
    flex: cs.flex,
    heightCss: cs.height,
    minWidth: cs.minWidth,
    width: cs.width,
    rowsDisplay: getComputedStyle(document.querySelector('.llm-phase-rows')).gridTemplateColumns,
    datalistChildCount: document.getElementById('llm-phase-model-options')?.children.length ?? null,
    viewport: { w: innerWidth, h: innerHeight },
  };
})()`);
console.log(JSON.stringify(report, null, 2));
ws.close();
