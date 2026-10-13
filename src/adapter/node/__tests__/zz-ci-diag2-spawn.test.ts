// CI 诊断第二轮（debug/ci-chunked-diag 分支临时文件，诊断完即删）：
// 第一轮已锁定 adapter 的 downloadViaCurl 在 ubuntu+Bun1.4.3 上永不落定，
// 裸 spawn('curl') 却成功。二者只差三个变量：env、signal、进度轮询器。
// 本轮逐变量分离，锁定致命组合。
import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import { createServer, type Server } from 'node:http';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { DownloadController } from '../../../shared/downloadHub';

const TOTAL = 2 * 1024 * 1024;
const body = Buffer.alloc(TOTAL, 7);
const log = (...a: unknown[]): void => console.log('[diag2]', ...a);

/** spawn curl 下载全量，12s 未退出则 SIGKILL 并报 hang。 */
function probe(label: string, opts: { signal?: AbortSignal; env?: NodeJS.ProcessEnv; stdio?: 'pipe' | 'ignore'; poller?: boolean }): Promise<string> {
  return new Promise((resolve) => {
    const dir = mkdtempSync(join(tmpdir(), 'diag2-'));
    const out = join(dir, 'out.bin');
    const args = ['-L', '--retry', '3', '--retry-delay', '1', '-C', '-', '-o', out, serverUrl()];
    const child = spawn('curl', args, {
      ...(opts.signal ? { signal: opts.signal } : {}),
      ...(opts.env !== undefined ? { env: opts.env } : {}),
      ...(opts.stdio ? { stdio: opts.stdio } : {}),
    } as Parameters<typeof spawn>[2]);
    let pollTimer: ReturnType<typeof setInterval> | undefined;
    if (opts.poller) {
      pollTimer = setInterval(() => {
        try { statSync(out).size; } catch { /* not yet */ }
      }, 300);
    }
    const t0 = Date.now();
    const finish = (verdict: string): void => {
      if (pollTimer) clearInterval(pollTimer);
      const size = (() => { try { return statSync(out).size; } catch { return -1; } })();
      rmSync(dir, { recursive: true, force: true });
      log(`${label} -> ${verdict} in ${Date.now() - t0}ms size=${size}`);
      resolve(`${label}: ${verdict}`);
    };
    const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* gone */ } }, 12_000);
    timer.unref?.();
    child.on('error', (e) => { clearTimeout(timer); finish(`spawn-error ${e.message}`); });
    child.on('close', (code) => { clearTimeout(timer); finish(`exit ${code}`); });
  });
}

let server: Server;
let port = 0;
function serverUrl(): string { return `http://127.0.0.1:${port}/f.bin`; }

describe('CI diag2: spawn option matrix', () => {
  beforeAll(async () => {
    server = createServer((req, res) => {
      res.writeHead(200, { 'Content-Length': String(TOTAL) });
      res.end(body);
    });
    await new Promise<void>((resolve) => {
      server.listen(0, '127.0.0.1', () => { port = (server.address() as { port: number }).port; resolve(); });
    });
  });
  afterAll(() => { server?.close(); });

  it('spawn option matrix', async () => {
    const results: string[] = [];
    results.push(await probe('F1 plain', {}));
    results.push(await probe('F2 env-undefined', { env: undefined as unknown as NodeJS.ProcessEnv }));
    results.push(await probe('F3 bare-AbortController-signal', { signal: new AbortController().signal }));
    results.push(await probe('F4 DownloadController-signal', { signal: new DownloadController().signal }));
    results.push(await probe('F5 signal+poller', { signal: new AbortController().signal, poller: true }));
    results.push(await probe('F6 signal+stdio-ignore', { signal: new AbortController().signal, stdio: 'ignore' }));
    results.push(await probe('F7 env-undefined+signal', { env: undefined as unknown as NodeJS.ProcessEnv, signal: new AbortController().signal }));
    // F8: downloadViaCurl 的前置 which 探测（无选项 spawn）之后再跑 curl。
    await new Promise<void>((resolve) => {
      const w = spawn('which', ['curl']);
      w.on('error', () => resolve());
      w.on('close', () => resolve());
    });
    results.push(await probe('F8 which-probe-then-curl', { signal: new AbortController().signal }));
    // F9: close 后再 await fs/promises stat（downloadViaCurl 的收尾动作）。
    results.push(await new Promise<string>((resolve) => {
      void (async () => {
        const dir = mkdtempSync(join(tmpdir(), 'diag2-'));
        const out = join(dir, 'out.bin');
        const t0 = Date.now();
        const child = spawn('curl', ['-s', '-o', out, serverUrl()], { signal: new AbortController().signal } as Parameters<typeof spawn>[2]);
        child.on('error', () => { rmSync(dir, { recursive: true, force: true }); resolve('F9: spawn-error'); });
        child.on('close', async () => {
          try {
            const st = await (await import('node:fs/promises')).stat(out);
            log(`F9 close+stat -> size=${st.size} in ${Date.now() - t0}ms`);
            rmSync(dir, { recursive: true, force: true });
            resolve('F9: exit 0');
          } catch (e) {
            log(`F9 stat failed: ${String(e)}`);
            rmSync(dir, { recursive: true, force: true });
            resolve('F9: stat-error');
          }
        });
      })();
    }));
    // F10: 完整复刻 downloadViaCurl 的组合链（which → spawn(signal+env:undefined+poller) → close → await stat）。
    results.push(await new Promise<string>((resolve) => {
      void (async () => {
        const dir = mkdtempSync(join(tmpdir(), 'diag2-'));
        const out = join(dir, 'out.bin');
        const t0 = Date.now();
        const hasCurl = await new Promise<boolean>((res) => {
          const p = spawn('which', ['curl']);
          p.on('error', () => res(false));
          p.on('close', (c) => res(c === 0));
        });
        log(`F10 which curl -> ${hasCurl}`);
        const ctl = new DownloadController();
        const child = spawn('curl', ['-L', '--retry', '3', '--retry-delay', '1', '-C', '-', '-o', out, serverUrl()], {
          signal: ctl.signal,
          env: undefined,
        } as Parameters<typeof spawn>[2]);
        const poll = setInterval(() => { try { statSync(out).size; } catch { /* not yet */ } }, 300);
        const done = (v: string): void => {
          clearInterval(poll);
          rmSync(dir, { recursive: true, force: true });
          log(`F10 full-chain -> ${v} in ${Date.now() - t0}ms`);
          resolve(`F10: ${v}`);
        };
        const tm = setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* gone */ } }, 12_000);
        tm.unref?.();
        child.on('error', (e) => { clearTimeout(tm); done(`spawn-error ${e.message}`); });
        child.on('close', async (code) => {
          clearTimeout(tm);
          try {
            await (await import('node:fs/promises')).stat(out);
            done(`exit ${code}`);
          } catch { done(`exit ${code} stat-failed`); }
        });
      })();
    }));
    const hung = results.filter((r) => !r.includes('exit 0'));
    log(`hung variants: ${hung.length ? hung.join(' | ') : 'NONE'}`);
    expect(hung).toEqual([]);
  }, 110_000);
});
