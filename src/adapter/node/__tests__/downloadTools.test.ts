// src/adapter/node/__tests__/downloadTools.test.ts
// End-to-end download_file coverage against a real local HTTP server (all
// loopback, no public network): the native path (HEAD + Range + stream),
// Content-Disposition file-name inference, and Referer header delivery.

import { describe, expect, it, beforeAll, afterAll } from 'bun:test';
import { createServer, type Server } from 'node:http';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NodeToolAdapter } from '../NodeToolAdapter';
import { DownloadController } from '../../../shared/downloadHub';
import type { ToolResult } from '../../../shared/types';

const FILE_BODY = 'hello from the download test\n';
const DISPOSITION = 'attachment; filename="custom-name.txt"';

let server: Server;
let baseUrl = '';
let lastHeaders: Record<string, string | undefined> = {};

function start(): Promise<void> {
  return new Promise((resolve) => {
    server = createServer((req, res) => {
      lastHeaders = req.headers as Record<string, string | undefined>;
      if (req.url === '/file') {
        res.writeHead(200, {
          'Content-Type': 'application/octet-stream',
          'Content-Length': String(Buffer.byteLength(FILE_BODY)),
          'Content-Disposition': DISPOSITION,
          'Accept-Ranges': 'bytes',
        });
        res.end(FILE_BODY);
        return;
      }
      res.writeHead(404);
      res.end();
    });
    server.listen(0, '127.0.0.1', () => {
      baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
      resolve();
    });
  });
}

function stop(): Promise<void> {
  return new Promise((resolve) => {
    if (server) server.close(() => resolve());
    else resolve();
  });
}

describe('download_file (real local HTTP server)', () => {
  let workspace: string;
  let adapter: NodeToolAdapter;

  beforeAll(async () => {
    await start();
    workspace = mkdtempSync(join(tmpdir(), 'pure-download-'));
    adapter = new NodeToolAdapter({ workspace });
  });

  afterAll(async () => {
    await stop();
    rmSync(workspace, { recursive: true, force: true });
  });

  function dl(url: string, args: Record<string, unknown> = {}) {
    return adapter.execute({
      id: `dl_${Math.random().toString(36).slice(2)}`,
      index: 0,
      function: { name: 'download_file', arguments: JSON.stringify({ url, ...args }) },
    });
  }

  it('downloads via the native path and infers the Content-Disposition name', async () => {
    const result = await dl(`${baseUrl}/file`, { destination: workspace });
    expect(result.success).toBe(true);
    const summary = JSON.parse(String(result.result)) as { path: string; via: string; size: number };
    expect(summary.path).toContain('custom-name.txt');
    expect(readFileSync(summary.path, 'utf8')).toBe(FILE_BODY);
    expect(summary.size).toBe(Buffer.byteLength(FILE_BODY));
    expect(summary.via).toBe('native');
  });

  it('honors an explicit filename over the Content-Disposition header', async () => {
    const result = await dl(`${baseUrl}/file`, { destination: workspace, filename: 'explicit.txt' });
    expect(result.success).toBe(true);
    const summary = JSON.parse(String(result.result)) as { path: string };
    expect(summary.path).toContain('explicit.txt');
    expect(readFileSync(summary.path, 'utf8')).toBe(FILE_BODY);
  });

  it('sends a same-origin Referer header to the server', async () => {
    lastHeaders = {};
    const result = await dl(`${baseUrl}/file`, { destination: workspace, filename: 'referer.txt' });
    expect(result.success).toBe(true);
    expect(lastHeaders['referer']).toBe(baseUrl);
  });

  it('bypasses the proxy for private/loopback hosts (never routes internal traffic through a proxy)', async () => {
    // A deliberately unreachable proxy: if internal hosts were wrongly routed
    // through it, the download would fail — this proves the internal bypass.
    const prev = process.env['HTTPS_PROXY'];
    process.env['HTTPS_PROXY'] = 'http://127.0.0.1:9';
    try {
      const result = await dl(`${baseUrl}/file`, { destination: workspace, filename: 'internal-bypass.txt' });
      expect(result.success).toBe(true);
      const summary = JSON.parse(String(result.result)) as { path: string };
      expect(readFileSync(summary.path, 'utf8')).toBe(FILE_BODY);
    } finally {
      if (prev === undefined) delete process.env['HTTPS_PROXY'];
      else process.env['HTTPS_PROXY'] = prev;
    }
  });
});

// ── S2 单请求改写：下载网络失败时自动换到字节一致的镜像端点 ──────────────────
// 桩替 downloadChain（真实下载链要打公网），只验证「换不换、换到哪、结果标不标」
// 这层编排；规则集本身由 sourceRewrite.test 锁。
function stubChain(adapter: NodeToolAdapter, calls: string[], behavior: 'network-then-ok' | 'not-found'): void {
  (adapter as unknown as { downloadChain: (url: string, outPath: string) => Promise<unknown> }).downloadChain =
    async (url: string, outPath: string) => {
      calls.push(url);
      if (behavior === 'network-then-ok' && url.startsWith('https://registry.npmmirror.com/')) {
        writeFileSync(outPath, 'mirrored bytes');
        return { ok: true, size: 14, via: 'stub' };
      }
      return { ok: false, error: behavior === 'network-then-ok' ? 'ECONNRESET' : 'HTTP 404' };
    };
}

describe('download_file · S2 单请求改写（镜像端点）', () => {
  const NPM = 'https://registry.npmjs.org/left-pad/-/left-pad-1.3.0.tgz';
  const MIRROR = 'https://registry.npmmirror.com/left-pad/-/left-pad-1.3.0.tgz';

  it('原站网络失败时换到镜像端点，并在结果里标注改写来源', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pure-mirror-'));
    const adapter = new NodeToolAdapter({ workspace: dir });
    const calls: string[] = [];
    stubChain(adapter, calls, 'network-then-ok');
    const result = await adapter.execute({
      id: 'dl_mirror',
      index: 0,
      function: { name: 'download_file', arguments: JSON.stringify({ url: NPM, destination: dir, filename: 'left-pad-1.3.0.tgz' }) },
    });
    expect(result.success).toBe(true);
    expect(calls).toEqual([NPM, MIRROR]);
    const summary = JSON.parse(String(result.result)) as { path: string; rewrite?: { from: string; to: string; rule: string } };
    expect(summary.rewrite).toEqual({ from: NPM, to: MIRROR, rule: 'npm-tarball-to-npmmirror' });
    expect(readFileSync(summary.path, 'utf8')).toBe('mirrored bytes');
    rmSync(dir, { recursive: true, force: true });
  });

  it('非网络类失败（404）不换镜像——换端点答不出同一份字节', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pure-mirror404-'));
    const adapter = new NodeToolAdapter({ workspace: dir });
    const calls: string[] = [];
    stubChain(adapter, calls, 'not-found');
    const result = await adapter.execute({
      id: 'dl_404',
      index: 0,
      function: { name: 'download_file', arguments: JSON.stringify({ url: NPM, destination: dir, filename: 'left-pad-1.3.0.tgz' }) },
    });
    expect(result.success).toBe(false);
    expect(calls).toEqual([NPM]);
    expect(String(result.result)).not.toContain('npmmirror');
    rmSync(dir, { recursive: true, force: true });
  });

});

// ── 分块下载 fd 收口（2026-10 审计 P0 回归）─────────────────────────────────
// 分块路径（>1MB + Accept-Ranges + connections>1）曾有两处洞：Promise.all
// 早退跳过 fd.close()（句柄泄漏），残余 worker 与 fallback 双写同一文件
// （静默损坏）。失败路径直测 downloadChunked（桩掉 getRangeBuffer，不与
// curl 兜底缠斗——curl -C - 会从残缺文件续传，端到端复现注定不稳）：
// 分块成功必须字节一致；中途失败必须等全部在飞分片落定才返回，且返回后
// fd 已关、迟到写入被丢弃、文件内容永不再变。
describe('download_file · chunked fd teardown', () => {
  const TOTAL = 2 * 1024 * 1024;
  const mk = (f: (i: number) => number): Buffer => {
    const b = Buffer.alloc(TOTAL);
    for (let i = 0; i < TOTAL; i++) b[i] = f(i);
    return b;
  };
  const body = mk((i) => (i * 31 + 7) % 256);

  let server: Server;
  let baseUrl = '';

  beforeAll(async () => {
    server = createServer((req, res) => {
      if (req.method === 'HEAD') {
        res.writeHead(200, { 'Content-Length': String(body.length), 'Accept-Ranges': 'bytes' });
        res.end();
        return;
      }
      const m = /bytes=(\d+)-(\d*)/.exec(String(req.headers.range ?? ''));
      const s = m ? Number(m[1]) : 0;
      const e = m && m[2] ? Math.min(Number(m[2]), body.length - 1) : body.length - 1;
      // 越界 range 按真服务器语义回 416（curl -C - 在文件已满时会发
      // bytes=<size>-，本机 curl 对 416 退出码为 0，视为「无需续传」）。
      if (s >= body.length || s > e) {
        res.writeHead(416, { 'Content-Range': `bytes */${body.length}` });
        res.end();
        return;
      }
      res.writeHead(206, {
        'Content-Type': 'application/octet-stream',
        'Content-Range': `bytes ${s}-${e}/${body.length}`,
        'Content-Length': String(e - s + 1),
        'Accept-Ranges': 'bytes',
      });
      res.end(body.subarray(s, e + 1));
    });
    await new Promise<void>((resolve) => {
      server.listen(0, '127.0.0.1', () => {
        baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
        resolve();
      });
    });
  });

  afterAll(async () => {
    server?.close();
  });

  it('chunks assemble byte-identically on the happy path', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pure-chunked-ok-'));
    try {
      const adapter = new NodeToolAdapter({ workspace: dir });
      const result = await adapter.execute({
        id: 'dl_chunked_ok',
        index: 0,
        function: { name: 'download_file', arguments: JSON.stringify({ url: `${baseUrl}/chunked.bin`, destination: dir, filename: 'ok.bin', connections: 3, resume: false }) },
      });
      expect(result.success).toBe(true);
      const summary = JSON.parse(String(result.result)) as { via: string; size: number };
      expect(summary.via).toBe('native-chunked');
      expect(summary.size).toBe(TOTAL);
      expect(readFileSync(join(dir, 'ok.bin')).equals(body)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 15_000);

  it('a mid-flight chunk failure waits for in-flight chunks, closes the fd, and lets no late write through', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pure-chunked-fail-'));
    try {
      const adapter = new NodeToolAdapter({ workspace: dir });
      const outPath = join(dir, 'unit.bin');
      const CHUNK = 1000;
      const chunk = (n: number): Buffer => Buffer.alloc(CHUNK, n);
      let lastSettleAt = 0;
      (adapter as unknown as { getRangeBuffer: (url: string, s: number, e: number) => Promise<Buffer> }).getRangeBuffer =
        async (_url: string, s: number) => {
          const i = s / CHUNK;
          if (i === 0) throw new Error('boom-chunk0');
          await new Promise((r) => setTimeout(r, 300));
          lastSettleAt = Date.now();
          return chunk(i);
        };
      const t0 = Date.now();
      let err: unknown;
      await (adapter as unknown as { downloadChunked: (...a: unknown[]) => Promise<number> })
        .downloadChunked('http://stub/', outPath, 3 * CHUNK, 3, new DownloadController(), () => {}, 'unit.bin')
        .catch((e: unknown) => { err = e; });

      // 错误原样传播，不被吞掉也不被换掉。
      expect((err as Error).message).toBe('boom-chunk0');
      // 失败也必须等全部在飞分片收尾：旧代码在 ~0ms 就返回，把两个 300ms
      // 后才落地的分片留在无人 await 的 promise 上、往已半死的 fd 里写。
      expect(Date.now() - t0).toBeGreaterThanOrEqual(250);
      // fd 已关、迟到写入被丢弃：返回之后的文件内容必须永远不再变化。
      const snap1 = readFileSync(outPath);
      await new Promise((r) => setTimeout(r, 400));
      const snap2 = readFileSync(outPath);
      expect(snap2.equals(snap1)).toBe(true);
      // 已落盘的部分各就各位：块 1、2 在自己的偏移上，块 0 失败留洞。
      expect(snap1.length).toBe(3 * CHUNK);
      expect(snap1.subarray(CHUNK, 2 * CHUNK).equals(chunk(1))).toBe(true);
      expect(snap1.subarray(2 * CHUNK, 3 * CHUNK).equals(chunk(2))).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 10_000);
});
