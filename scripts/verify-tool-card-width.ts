#!/usr/bin/env bun
// scripts/verify-tool-card-width.ts
// Real-engine width regression for tool / sub-agent card headers.
//
// Why this exists: card header width CANNOT be unit-tested — it is a function
// of real font metrics, flex shrink rules and the grid's auto-fit column count.
// 2026-09-20 user report: three parallel sub-agent cards shared one row, each
// card was ~255px, and the CJK role label (资料调研) collapsed into a vertical
// stack of single characters (measured 11.8px × 68px) while the args summary
// was squeezed to 0. The name guard added for that (`.tool-row-name`:
// nowrap + `flex: 0 0 auto`) is asserted here against the REAL stylesheet at
// the widths the transcript actually produces, including the exact minimum
// column the CSS declares.
//
// What it checks per card, at every width:
//   1. the name renders on ONE line box (no vertical CJK column);
//   2. the name is not clipped (clientWidth >= scrollWidth);
//   3. the header does not overflow its card horizontally;
//   4. the status stays on one line (`✓ 123.4s` is part of the fixed budget);
//   5. on the pale-blue web surface the delegation trace keeps >= 4.5:1
//      contrast against its own background (the other 2026-09-20 report:
//      console-white trace text on the pale-blue surface measured 1.1:1).
//
// Usage:
//   bun run verify:tool-card-width [--app-url=URL] [--cdp-port=PORT]
//       [--chrome=PATH] [--keep]
// Exits non-zero when any assertion fails.

import { mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const argv = process.argv.slice(2);
const argValue = (name: string): string | undefined => {
  const flag = argv.find((a) => a.startsWith(`${name}=`));
  return flag ? flag.slice(name.length + 1) : undefined;
};

/** Explicit --chrome wins, then the macOS bundle, then common Linux names. */
function resolveChromePath(explicit?: string): string {
  const candidates = [
    explicit,
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    'google-chrome',
    'chromium',
    'chromium-browser',
  ].filter(Boolean) as string[];
  for (const candidate of candidates) {
    if (candidate.includes('/')) {
      if (Bun.file(candidate).size > 0) return candidate;
      continue;
    }
    const found = Bun.spawnSync(['which', candidate], { stdout: 'pipe' }).stdout.toString().trim();
    if (found) return found;
  }
  throw new Error('no Chrome binary found; pass --chrome=/path/to/chrome');
}

const appUrl = argValue('--app-url') ?? 'http://localhost:1420/';
const cdpPort = Number(argValue('--cdp-port') ?? 9237);
const chrome = resolveChromePath(argValue('--chrome'));
const keepServers = argv.includes('--keep');
const projectRoot = process.cwd();

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

// Transcript content widths. 876 is the regular maximum (#chat max-width 940
// minus 2 × 32px padding), 862 the narrowest width at which the agent grid
// still fits three columns, 700 / 520 the two narrower regimes.
const WIDTHS = [876, 862, 700, 520];
// The longest status the app formats is `✓ <seconds>s` with one decimal.
const LONG_STATUS_MS = 123_400;
const PENDING_MS = 0;

let viteProc: import('bun').Subprocess | null = null;
if (!(await urlResponds(appUrl))) {
  console.log('[probe] starting vite…');
  viteProc = Bun.spawn(['bun', 'run', 'dev'], { detached: true, cwd: projectRoot, stdout: 'ignore', stderr: 'ignore' });
  await waitFor(() => urlResponds(appUrl), 40000, 'vite');
}

const profile = join(tmpdir(), `pure-card-width-${Date.now()}`);
mkdirSync(profile, { recursive: true });
const chromeProc = Bun.spawn([
  chrome, '--headless=new', `--remote-debugging-port=${cdpPort}`,
  `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check',
  '--window-size=1400,900', 'about:blank',
], { stdout: 'ignore', stderr: 'ignore' });
await waitFor(async () => {
  try { const r = await fetch(`http://127.0.0.1:${cdpPort}/json/version`); return r.ok; } catch { return false; }
}, 20000, 'chrome CDP');

let failures = 0;
const fail = (message: string): void => {
  failures++;
  console.log(`  ✗ ${message}`);
};

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
  // The real stylesheet must be live before anything is measured: the name
  // guard itself is the signal (an unstyled page reports white-space: normal).
  await waitFor(async () => {
    const href = await evaluate('location.href');
    if (typeof href !== 'string' || !href.startsWith(appUrl)) return false;
    const guard = await evaluate(`(() => {
      const el = document.createElement('span');
      el.className = 'tool-row-name';
      document.body.appendChild(el);
      const ws = getComputedStyle(el).whiteSpace;
      el.remove();
      return ws;
    })()`);
    return guard === 'nowrap';
  }, 25000, 'app + styles');

  // Build the SAME cards the transcript builds (real createToolRow classes:
  // .subagent-row / .web-tool / .tool-row-name …) — never hand-written markup.
  await evaluate(`(async () => {
    const { createToolRow, finalizeToolRow, toolGridClass } = await import('/src/ui/toolRow.ts');
    const host = document.createElement('div');
    host.id = 'width-probe-host';
    host.style.cssText = 'position:fixed;top:0;left:0;z-index:9999;background:var(--bg)';
    const agents = document.createElement('div');
    agents.id = 'width-probe-agents';
    agents.className = toolGridClass('agent');
    const tools = document.createElement('div');
    tools.id = 'width-probe-tools';
    tools.className = toolGridClass('tool');
    // Three parallel sub-agents: CJK role labels + one long status + one
    // still-pending card (spinner) + one finished with a live trace.
    const agentCalls = [
      { tool: 'researcher', ask: '调研当前 AI Agent 的技术方向与大模型前沿进展', ms: ${LONG_STATUS_MS}, trace: true },
      { tool: 'deep_thinker', ask: '智能体架构演技比较', ms: 72_000, trace: false },
      { tool: 'ui_designer', ask: '设计变体探索', ms: ${PENDING_MS}, trace: false },
    ];
    for (const call of agentCalls) {
      const row = createToolRow(call.tool, { prompt: call.ask });
      if (call.ms > 0) {
        finalizeToolRow(row, {
          success: true,
          duration: call.ms,
          resultText: '结论：…',
          subagentTrace: call.trace ? ['▶ researcher 接活：调研当前 AI Agent 的技术方向', '→ read_file', '✓ read_file 完成'] : undefined,
        });
      }
      row.details.open = true;
      agents.appendChild(row.el);
    }
    // Tool cards with the longest friendly labels this app ships.
    const toolCalls = [
      { tool: 'generate_image', args: { prompt: '一张 16:9 的架构图', path: 'docs/agent-architecture.png' } },
      { tool: 'create_directory', args: { path: 'src/experiments/agent-benchmarks/2026-09' } },
      { tool: 'code_searcher', args: { query: 'toolGridClass' } },
    ];
    for (const call of toolCalls) {
      const row = createToolRow(call.tool, call.args);
      finalizeToolRow(row, { success: true, duration: 1_200, resultText: 'ok' });
      row.details.open = true;
      tools.appendChild(row.el);
    }
    host.append(agents, tools);
    document.body.appendChild(host);
    return true;
  })()`);

  const measure = async (width: number) => evaluate(`(() => {
    const host = document.getElementById('width-probe-host');
    host.style.width = '${width}px';
    const cards = [];
    for (const grid of [document.getElementById('width-probe-agents'), document.getElementById('width-probe-tools')]) {
      for (const row of grid.querySelectorAll('.tool-row-row')) {
        const details = row.querySelector('.tool-row');
        const summary = row.querySelector('.tool-row-summary');
        const name = row.querySelector('.tool-row-name');
        const status = row.querySelector('.tool-row-status');
        const nameBox = name.getBoundingClientRect();
        const nameStyle = getComputedStyle(name);
        cards.push({
          kind: details.classList.contains('subagent-row') ? 'agent' : 'tool',
          tool: details.title || name.textContent,
          label: name.textContent,
          cardW: Math.round(details.getBoundingClientRect().width * 10) / 10,
          nameW: Math.round(nameBox.width * 10) / 10,
          nameH: Math.round(nameBox.height * 10) / 10,
          nameLines: name.getClientRects().length,
          nameClipped: name.clientWidth + 1 < name.scrollWidth,
          nameWhiteSpace: nameStyle.whiteSpace,
          nameFlex: nameStyle.flex,
          statusText: status.textContent,
          statusLines: status.getClientRects().length,
          statusWhiteSpace: getComputedStyle(status).whiteSpace,
          summaryOverflow: summary.scrollWidth - summary.clientWidth,
          argsDisplay: getComputedStyle(row.querySelector('.tool-row-args')).display,
        });
      }
    }
    // Contrast of the delegation trace on its own surface (the pale-blue
    // .web-tool body in light mode).
    const lum = (rgb) => {
      const [r, g, b] = rgb.map((v) => {
        const s = v / 255;
        return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
      });
      return 0.2126 * r + 0.7152 * g + 0.0722 * b;
    };
    const parse = (color) => color.match(/\\d+(\\.\\d+)?/g).slice(0, 3).map(Number);
    const ratio = (fg, bg) => {
      const a = lum(parse(fg));
      const b = lum(parse(bg));
      return Math.round(((Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05)) * 100) / 100;
    };
    const surface = document.querySelector('#width-probe-agents .tool-row.web-tool .tool-row-body');
    const traces = [];
    if (surface) {
      const bg = getComputedStyle(surface).backgroundColor;
      for (const line of surface.querySelectorAll('.tool-row-stream-line')) {
        traces.push({
          text: line.textContent.slice(0, 24),
          color: getComputedStyle(line).color,
          bg,
          ratio: ratio(getComputedStyle(line).color, bg),
          isError: line.classList.contains('stderr'),
        });
      }
    }
    return { width: ${width}, cards, traces };
  })()`);

  for (const width of WIDTHS) {
    const result = await measure(width) as any;
    console.log(`\n[width ${width}px]`);
    for (const card of result.cards) {
      console.log(`  ${card.kind === 'agent' ? 'AGENT' : 'TOOL '} ${card.label.padEnd(14)} card=${card.cardW} name=${card.nameW}×${card.nameH} lines=${card.nameLines} status="${card.statusText}"`);
      if (card.nameLines !== 1) fail(`${width}px ${card.label}: name rendered on ${card.nameLines} line boxes (vertical text)`);
      if (card.nameClipped) fail(`${width}px ${card.label}: name is clipped (${card.nameW}px box)`);
      if (card.nameWhiteSpace !== 'nowrap') fail(`${width}px ${card.label}: white-space is ${card.nameWhiteSpace}`);
      if (card.summaryOverflow > 1) fail(`${width}px ${card.label}: header overflows its card by ${card.summaryOverflow}px`);
      if (card.statusLines !== 1) fail(`${width}px ${card.label}: status "${card.statusText}" wrapped onto ${card.statusLines} lines`);
      if (card.statusWhiteSpace !== 'nowrap') fail(`${width}px ${card.label}: status white-space is ${card.statusWhiteSpace}`);
      if (card.kind === 'agent' && card.nameH > 24) fail(`${width}px ${card.label}: CJK name box is ${card.nameH}px tall`);
    }
    for (const trace of result.traces) {
      const floor = 4.5;
      console.log(`  TRACE "${trace.text}…" ${trace.color} on ${trace.bg} = ${trace.ratio}:1`);
      if (trace.ratio < floor) fail(`${width}px trace line "${trace.text}" contrast ${trace.ratio}:1 < ${floor}:1`);
    }
  }

  ws.close();
} catch (e) {
  failures++;
  console.error('probe failed:', (e as Error).message);
} finally {
  try { killByPort(cdpPort); } catch {}
  rmSync(profile, { recursive: true, force: true });
  if (viteProc && !keepServers) { try { viteProc.kill(); } catch {} killByPort(1420); }
  console.log(failures === 0 ? '\ntool-card width OK' : `\ntool-card width FAILED (${failures})`);
  process.exit(failures === 0 ? 0 : 1);
}
