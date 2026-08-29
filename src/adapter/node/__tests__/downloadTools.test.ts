// src/adapter/node/__tests__/downloadTools.test.ts
// End-to-end download_file coverage against a real local HTTP server (all
// loopback, no public network): the native path (HEAD + Range + stream),
// Content-Disposition file-name inference, and Referer header delivery.

import { describe, expect, it, beforeAll, afterAll } from 'bun:test';
import { createServer, type Server } from 'node:http';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
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
