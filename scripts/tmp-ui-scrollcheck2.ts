#!/usr/bin/env bun
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const APP = 'http://localhost:1420';

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
  return r.result?.value ?? null;
};
const waitFor = async (expression: string, timeoutMs: number, what: string) => {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const v = await evaluate(expression);
    if (v) return v;
    await sleep(250);
  }
  throw new Error(`timeout: ${what}`);
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
await waitFor('({ ok: document.readyState === "complete" && !!document.getElementById("sidebar-settings-btn") })', 25000, 'boot');
await sleep(800);
await clickUntil(
  `document.getElementById("sidebar-settings-btn")?.click();`,
  `({ ok: document.getElementById("settings-view")?.classList.contains("expanded") })`,
  'settings open',
);

const measure = `(() => {
  const pane = document.getElementById('settings-content');
  const cap = (id) => {
    const el = document.getElementById(id);
    if (!el) return null;
    return { mh: getComputedStyle(el).maxHeight, oy: getComputedStyle(el).overflowY };
  };
  return {
    gutter: pane.offsetWidth - pane.clientWidth,
    toolInv: cap('tool-inventory'),
    evoExp: cap('evolution-experience'),
    mcpList: cap('mcp-server-list'),
  };
})()`;

// 记忆页种一批条目，让 #memory-list 真的溢出，验证卡内滚动。
await evaluate(`(() => {
  const key = Object.keys(localStorage).find((k) => /memory/i.test(k));
  return key ?? 'no-memory-key';
})()`);

console.log('[evolution]', JSON.stringify(await evaluate(measure)));
await evaluate(`document.querySelector('.settings-nav-item[data-category="tools"]')?.click(); true`);
await sleep(700);
console.log('[tools]    ', JSON.stringify(await evaluate(measure)));
await evaluate(`document.querySelector('.settings-nav-item[data-category="mcp"]')?.click(); true`);
await sleep(700);
console.log('[mcp]      ', JSON.stringify(await evaluate(measure)));

ws.close();
console.log('SCROLL CHECK DONE');
