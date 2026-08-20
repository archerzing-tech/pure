#!/usr/bin/env bun
// scripts/measure-paste-image.ts
// Real-browser measurement of the image-paste payload and session-snapshot
// sizes. It loads the real app (Vite + headless Chrome via CDP), generates a
// large photo-sized canvas (default 4000×3000 ≈ 12MP), synthesizes a paste
// event on the real prompt textarea, and lets the app's OWN paste pipeline
// (consumePaste → handleImagePaste → downscaleImageDataUrl) process it.
// It then measures:
//   • the model payload the app would attach (MessageImage.dataUrl)
//   • the persisted session snapshot JSON the localStorage fallback writes
// Both are measured with the ORIGINAL base64 and with the DOWNSCALED base64.
//
// Usage:
//   bun run scripts/measure-paste-image.ts [--w=4000] [--h=3000] [--type=png|jpeg]
//       [--app-url=URL] [--cdp-port=PORT] [--chrome=PATH] [--keep]

import { appendFileSync } from 'node:fs';

const LOG_FILE = '/tmp/pure-measure-paste-image.log';
function log(message: string): void {
  console.log(message);
  try { appendFileSync(LOG_FILE, `${message}\n`); } catch {}
}

const argv = process.argv.slice(2);
const argValue = (name: string): string | undefined => {
  const flag = argv.find((a) => a.startsWith(`${name}=`));
  return flag ? flag.slice(name.length + 1) : undefined;
};
const W = Number(argValue('--w') ?? 4000);
const H = Number(argValue('--h') ?? 3000);
const IMG_TYPE = argValue('--type') ?? 'png';
const appUrl = argValue('--app-url') ?? 'http://localhost:1420/';
const cdpPort = Number(argValue('--cdp-port') ?? 9222);
const chromePath = argValue('--chrome') ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const keepServers = argv.includes('--keep');

const projectRoot = new URL('../', import.meta.url).pathname;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

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
  log(`[measure] started ${label} (pid ${proc.pid})`);
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

const fmtBytes = (n: number): string => {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(2)} MB`;
};

async function main(): Promise<number> {
  log(`\n=== measure paste image ${W}×${H} ${IMG_TYPE} ${new Date().toISOString()} ===`);
  let viteProc: import('bun').Subprocess | null = null;
  let chromeProc: import('bun').Subprocess | null = null;
  let chromeProfile: string | null = null;
  try {
    // ── Vite ──
    if (!(await urlResponds(appUrl))) {
      viteProc = spawnDetached(['bun', 'run', 'dev'], 'vite');
      await waitFor(() => urlResponds(appUrl), 40000, 'vite on ' + appUrl);
    } else {
      log('[measure] vite already running — reusing');
    }

    // ── Chrome ──
    const cdpVersionUrl = `http://127.0.0.1:${cdpPort}/json/version`;
    if (!(await urlResponds(cdpVersionUrl))) {
      chromeProfile = (await import('node:fs')).mkdtempSync((await import('node:os')).tmpdir() + '/pure-measure-chrome-');
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
    }

    // ── CDP ──
    const tab = await fetch(`http://127.0.0.1:${cdpPort}/json/new?about:blank`, { method: 'PUT' }).then((r) => r.json() as any);
    const ws = new WebSocket(tab.webSocketDebuggerUrl);
    await new Promise<void>((resolve, reject) => {
      ws.onopen = () => resolve();
      ws.onerror = () => reject(new Error('ws error'));
    });
    let msgId = 0;
    const pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
    ws.onmessage = (event: any) => {
      const msg = JSON.parse(String(event.data));
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

    await send('Page.enable');
    await send('Runtime.enable');
    await send('Page.navigate', { url: appUrl });
    await waitFor(async () => {
      const href = await evaluate('location.href');
      return typeof href === 'string' && href.startsWith(appUrl) && (await evaluate('document.readyState')) === 'complete';
    }, 25000, 'app load');
    log('[measure] app loaded');

    // ── Generate the large image + drive the REAL paste path ──
    const result = await evaluate(`(async () => {
      const canvas = document.createElement('canvas');
      canvas.width = ${W};
      canvas.height = ${H};
      const ctx = canvas.getContext('2d');
      // Photo-like noise so JPEG/PNG encoding has real data to chew on.
      const grad = ctx.createLinearGradient(0, 0, ${W}, ${H});
      grad.addColorStop(0, '#3b82f6');
      grad.addColorStop(0.5, '#8b5cf6');
      grad.addColorStop(1, '#ec4899');
      ctx.fillStyle = grad;
      ctx.fillRect(0, 0, ${W}, ${H});
      for (let i = 0; i < 8000; i++) {
        ctx.fillStyle = 'rgba(' + Math.floor(Math.random()*256) + ',' + Math.floor(Math.random()*256) + ',' + Math.floor(Math.random()*256) + ',0.5)';
        ctx.fillRect(Math.random()*${W}, Math.random()*${H}, 2 + Math.random()*6, 2 + Math.random()*6);
      }
      const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/${IMG_TYPE}', 0.92));
      const originalFile = new File([blob], 'photo-${W}x${H}.${IMG_TYPE === 'jpeg' ? 'jpg' : IMG_TYPE}', { type: 'image/${IMG_TYPE}' });
      const reader = new FileReader();
      const rawDataUrl = await new Promise((resolve, reject) => {
        reader.onload = () => resolve(reader.result);
        reader.onerror = () => reject(reader.error);
        reader.readAsDataURL(originalFile);
      });

      // Dispatch a real paste event on the app's textarea (the app's own
      // consumePaste → handleImagePaste → downscaleImageDataUrl pipeline runs).
      const ta = document.getElementById('prompt') || document.getElementById('landing-prompt');
      const dt = new DataTransfer();
      dt.items.add(originalFile);
      ta.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));

      // Wait until the chip thumbnail carries the downscaled URL.
      const deadline = Date.now() + 20000;
      let downscaled = '';
      while (Date.now() < deadline) {
        const img = document.querySelector('.paste-chip-thumb');
        if (img && img.src && img.src.startsWith('data:image/')) { downscaled = img.src; break; }
        await new Promise((r) => setTimeout(r, 150));
      }
      if (!downscaled) throw new Error('paste chip did not render a downscaled thumbnail');
      return { rawDataUrl: String(rawDataUrl), downscaled };
    })()`);

    const raw = result.rawDataUrl as string;
    const scaled = result.downscaled as string;
    const rawBytes = Math.floor((raw.length - raw.indexOf(',') - 1) * 3 / 4);
    const scaledBytes = Math.floor((scaled.length - scaled.indexOf(',') - 1) * 3 / 4);
    const rawMime = /^data:([^;,]+)/.exec(raw)?.[1] ?? '';
    const scaledMime = /^data:([^;,]+)/.exec(scaled)?.[1] ?? '';

    // Decode dimensions of the downscaled payload in-page for the report.
    const dims = await evaluate(`(async () => {
      const img = new Image();
      await new Promise((resolve, reject) => { img.onload = resolve; img.onerror = reject; img.src = ${JSON.stringify(scaled)}; });
      return { w: img.naturalWidth, h: img.naturalHeight };
    })()`);

    // ── Snapshot simulation: exactly what store.ts lsSave writes ──
    // pure_session:<id> = JSON.stringify({ snapshot, updatedAt, messageCount, workspace }),
    // where snapshot = { version, modelContext: { messages }, transcript, uiState } and
    // the image data URL appears in BOTH modelContext.messages[0].images[0].dataUrl and
    // transcript[0].images[0].dataUrl (see createSessionSnapshot, store.ts:270/278).
    const snapshotSize = (dataUrl: string): number => {
      const image = { dataUrl, mimeType: dataUrl.startsWith('data:image/jpeg') ? 'image/jpeg' : dataUrl.startsWith('data:image/webp') ? 'image/webp' : 'image/png', name: 'photo.jpg', path: '', sizeBytes: Math.floor((dataUrl.length - dataUrl.indexOf(',') - 1) * 3 / 4) };
      const userMessage = { role: 'user', content: '分析这张图', images: [image] };
      const snapshot = {
        version: 2,
        modelContext: { messages: [userMessage] },
        transcript: [{ id: 'message-1', modelMessageIndex: 0, role: 'user', content: '分析这张图', images: [image] }],
        uiState: { planState: null },
      };
      const entry = { snapshot, updatedAt: 1750000000000, messageCount: 1, workspace: '' };
      return JSON.stringify(entry).length;
    };

    log('');
    log(`图片：${W}×${H}（${(W * H / 1e6).toFixed(1)}MP），源编码 image/${IMG_TYPE}`);
    log('');
    log('── 模型负载（MessageImage.dataUrl）──');
    log(`  原始 base64    : ${fmtBytes(rawBytes)}  (${rawMime})`);
    log(`  发送 base64    : ${fmtBytes(scaledBytes)}  (${scaledMime}, ${dims.w}×${dims.h})`);
    log(`  体积缩减       : ${(100 * (1 - scaledBytes / rawBytes)).toFixed(1)}%`);
    log('');
    log('── 会话快照（localStorage pure_session:<id> 的 JSON 体积）──');
    const withRaw = snapshotSize(raw);
    const withScaled = snapshotSize(scaled);
    log(`  原始图快照     : ${fmtBytes(withRaw)}`);
    log(`  缩放后快照     : ${fmtBytes(withScaled)}`);
    log(`  快照缩减       : ${fmtBytes(withRaw - withScaled)} (${(100 * (1 - withScaled / withRaw)).toFixed(1)}%)`);
    log('');

    ws.close();
    await fetch(`http://127.0.0.1:${cdpPort}/json/close/${tab.id}`, { method: 'PUT' }).catch(() => {});
    return 0;
  } catch (err) {
    console.error('[measure] failed:', err);
    return 1;
  } finally {
    if (!keepServers) {
      killGroup(viteProc as any);
      killGroup(chromeProc as any);
      if (chromeProfile) {
        try { (await import('node:fs')).rmSync(chromeProfile, { recursive: true, force: true }); } catch {}
      }
      // Grandchildren (vite) outlive the parent — sweep the ports.
      killByPort(1420);
      killByPort(cdpPort);
    }
  }
}

process.exit(await main());
