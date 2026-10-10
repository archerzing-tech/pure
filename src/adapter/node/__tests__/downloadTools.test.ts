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
