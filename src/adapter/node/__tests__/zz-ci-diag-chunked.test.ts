// CI 诊断专用（debug/ci-chunked-diag 分支临时文件，诊断完即删）：
// downloadTools 的 chunked fallback 两测试在 ubuntu runner 稳定 20s 超时而
// macOS 本地 3.6s 全绿。本文件把可疑环节逐段拆开各测一次并打时间戳，
// 一轮 CI 定位挂点：env 代理变量 → 命令存在性 → 裸 curl → 删残件后
// curl -C - → fetch 分块 → adapter.execute 完整链。
import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import { createServer, type Server } from 'node:http';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { unlink } from 'node:fs/promises';
import { NodeToolAdapter } from '../NodeToolAdapter';

const TOTAL = 2 * 1024 * 1024;
const body = Buffer.alloc(TOTAL);
for (let i = 0; i < TOTAL; i++) body[i] = (i * 31 + 7) % 256;
const log = (...a: unknown[]): void => console.log('[diag]', ...a);

function curlOnce(args: string[], killAfterMs: number): Promise<{ code: number | null; killed: boolean; stderr: string }> {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const child = spawn('curl', args);
    let stderr = '';
    let killed = false;
    child.stderr.on('data', (d: Buffer) => { stderr += d.toString(); });
    const timer = setTimeout(() => { killed = true; child.kill('SIGKILL'); }, killAfterMs);
    timer.unref?.();
    child.on('error', (e) => { clearTimeout(timer); resolve({ code: null, killed, stderr: `${stderr}\nspawn-error: ${e.message}` }); });
    child.on('close', (code) => {
      clearTimeout(timer);
      log(`curl args=${JSON.stringify(args)} -> code=${code} killed=${killed} in ${Date.now() - t0}ms`);
      resolve({ code, killed, stderr: stderr.slice(-2000) });
    });
  });
}

describe('CI diag: chunked fallback chain', () => {
  let server: Server;
  let baseUrl = '';
  let failRange0DelayMs = 0;

  beforeAll(async () => {
    for (const k of ['HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy', 'ALL_PROXY', 'all_proxy', 'NO_PROXY', 'no_proxy']) {
      log(`env ${k}=${JSON.stringify(process.env[k] ?? null)}`);
    }
    server = createServer((req, res) => {
      if (req.method === 'HEAD') {
        res.writeHead(200, { 'Content-Length': String(TOTAL), 'Accept-Ranges': 'bytes' });
        res.end();
        return;
      }
      const m = /bytes=(\d+)-(\d*)/.exec(String(req.headers.range ?? ''));
      const s = m ? Number(m[1]) : 0;
      const e = m && m[2] ? Math.min(Number(m[2]), TOTAL - 1) : TOTAL - 1;
      if (m && failRange0DelayMs > 0 && s === 0) {
        log(`[server] range0 delayed ${failRange0DelayMs}ms then destroyed`);
        const t = setTimeout(() => res.destroy(), failRange0DelayMs);
        t.unref?.();
        return;
      }
      if (!m) {
        res.writeHead(200, { 'Content-Length': String(TOTAL) });
        res.end(body);
        return;
      }
      res.writeHead(206, {
        'Content-Range': `bytes ${s}-${e}/${TOTAL}`,
        'Content-Length': String(e - s + 1),
      });
      res.end(body.subarray(s, e + 1));
    });
    await new Promise<void>((resolve) => {
      server.listen(0, '127.0.0.1', () => {
        baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
        log(`server at ${baseUrl}`);
        resolve();
      });
    });
  });

  afterAll(() => { server?.close(); });

  it('A: which curl/aria2c/wget', async () => {
    for (const cmd of ['curl', 'aria2c', 'wget']) {
      const r = await new Promise<string | null>((resolve) => {
        const p = spawn('which', [cmd]);
        let out = '';
        p.stdout.on('data', (d: Buffer) => { out += d.toString(); });
        p.on('error', () => resolve(null));
        p.on('close', (code) => resolve(code === 0 ? out.trim() : null));
      });
      log(`which ${cmd} -> ${r ?? 'NOT FOUND'}`);
    }
    expect(true).toBe(true);
  });

  it('B: raw curl plain download from the local server', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'diag-b-'));
    const out = join(dir, 'b.bin');
    const r = await curlOnce(['-L', '--retry', '3', '--retry-delay', '1', '-o', out, `${baseUrl}/b.bin`], 15_000);
    log(`B size=${(() => { try { return statSync(out).size; } catch { return -1; } })()}`);
    expect(r.killed).toBe(false);
    expect(r.code).toBe(0);
    rmSync(dir, { recursive: true, force: true });
  }, 20_000);

  it('C: raw curl -C - after the partial is deleted', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'diag-c-'));
    const out = join(dir, 'c.bin');
    writeFileSync(out, 'stale partial');
    await unlink(out);
    const r = await curlOnce(['-L', '--retry', '3', '--retry-delay', '1', '-C', '-', '-o', out, `${baseUrl}/c.bin`], 15_000);
    expect(r.killed).toBe(false);
    expect(r.code).toBe(0);
    rmSync(dir, { recursive: true, force: true });
  }, 20_000);

  it('D: raw curl against a holey partial that still exists', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'diag-d-'));
    const out = join(dir, 'd.bin');
    writeFileSync(out, Buffer.alloc(TOTAL, 1)); // 满尺寸残件（带洞）
    const r = await curlOnce(['-L', '--retry', '3', '--retry-delay', '1', '-C', '-', '-o', out, `${baseUrl}/d.bin`], 15_000);
    log(`D stderr tail: ${r.stderr.split('\n').slice(-4).join(' | ')}`);
    expect(r.killed).toBe(false);
    rmSync(dir, { recursive: true, force: true });
  }, 20_000);

  it('E1: downloadNative layer with holey chunk failure returns not-ok', async () => {
    failRange0DelayMs = 100;
    const dir = mkdtempSync(join(tmpdir(), 'diag-e1-'));
    try {
      const adapter = new NodeToolAdapter({ workspace: dir });
      const out = join(dir, 'e1.bin');
      const { DownloadController } = await import('../../../shared/downloadHub');
      const t0 = Date.now();
      const r = await (adapter as unknown as { downloadNative: (...a: unknown[]) => Promise<{ ok: boolean; error?: string; via?: string }> })
        .downloadNative(`${baseUrl}/e1.bin`, out, { connections: 3, resume: false, controller: new DownloadController(), emit: () => {}, filename: 'e1.bin', proxy: '' });
      log(`E1 downloadNative -> ${JSON.stringify(r)} in ${Date.now() - t0}ms, partial exists=${(() => { try { return statSync(out).size; } catch { return false; } })()}`);
      expect(r.ok).toBe(false);
    } finally {
      failRange0DelayMs = 0;
      rmSync(dir, { recursive: true, force: true });
    }
  }, 20_000);

  it('E2: downloadViaCurl layer after unlink lands clean bytes', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'diag-e2-'));
    try {
      const adapter = new NodeToolAdapter({ workspace: dir });
      const out = join(dir, 'e2.bin');
      writeFileSync(out, 'stale');
      await unlink(out);
      const { DownloadController } = await import('../../../shared/downloadHub');
      const t0 = Date.now();
      const r = await (adapter as unknown as { downloadViaCurl: (...a: unknown[]) => Promise<{ ok: boolean; size?: number; error?: string; via?: string }> })
        .downloadViaCurl(`${baseUrl}/e2.bin`, out, { resume: false, controller: new DownloadController(), emit: () => {}, filename: 'e2.bin', proxy: '' });
      log(`E2 downloadViaCurl -> ${JSON.stringify({ ...r, size: r.size ?? -1 })} in ${Date.now() - t0}ms`);
      expect(r.ok).toBe(true);
      expect(readFileSync(out).equals(body)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 20_000);

  it('E3: adapter.execute full chain with holey chunk failure', async () => {
    failRange0DelayMs = 100;
    const dir = mkdtempSync(join(tmpdir(), 'diag-e3-'));
    try {
      const adapter = new NodeToolAdapter({ workspace: dir });
      const t0 = Date.now();
      const result = await adapter.execute({
        id: 'diag_e3',
        index: 0,
        function: { name: 'download_file', arguments: JSON.stringify({ url: `${baseUrl}/e3.bin`, destination: dir, filename: 'e3.bin', connections: 3, resume: false }) },
      });
      log(`E3 execute -> success=${result.success} in ${Date.now() - t0}ms result=${String(result.result).slice(0, 300)}`);
      expect(result.success).toBe(true);
      expect(readFileSync(join(dir, 'e3.bin')).equals(body)).toBe(true);
    } finally {
      failRange0DelayMs = 0;
      rmSync(dir, { recursive: true, force: true });
    }
  }, 20_000);
});
