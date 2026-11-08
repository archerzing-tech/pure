// src/__tests__/cliErrorLog.test.ts
// 错误台账 CLI 面：append+轮转、JSONL 解析健壮性、pure errors 渲染。
import { describe, it, expect, beforeEach, afterAll } from 'bun:test';
import { mkdtempSync, realpathSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  appendCliErrorLogLine,
  rotateCliErrorLogIfNeeded,
  parseErrorLog,
  formatErrorRows,
  runErrorLogCommand,
} from '../cliErrorLog';

const dir = realpathSync(mkdtempSync(join(tmpdir(), 'pure-errlog-cli-')));
const logPath = join(dir, 'errors.log');

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('append + rotate', () => {
  it('appends JSONL lines and rotates the whole file to .old past the threshold', () => {
    appendCliErrorLogLine('{"ts":1,"source":"cli","kind":"probe","message":"a"}', logPath);
    appendCliErrorLogLine('{"ts":2,"source":"cli","kind":"probe","message":"b"}', logPath);
    expect(readFileSync(logPath, 'utf8')).toContain('"message":"a"');
    // 现 86 字节 > 40：整文件让位 .old，新文件从空开始。
    rotateCliErrorLogIfNeeded(logPath, 40);
    expect(existsSync(`${logPath}.old`)).toBe(true);
    expect(readFileSync(`${logPath}.old`, 'utf8')).toContain('"message":"b"');
    appendCliErrorLogLine('{"ts":3,"source":"cli","kind":"probe","message":"c"}', logPath);
    expect(readFileSync(logPath, 'utf8')).toContain('"message":"c"');
    expect(readFileSync(logPath, 'utf8')).not.toContain('"message":"a"');
  });

  it('never throws on unwritable paths', () => {
    // 目录不存在 → append 失败静默；台账永不成为故障源。
    expect(() => appendCliErrorLogLine('{"ts":0}', join(dir, 'no-such-dir', 'x.log'))).not.toThrow();
  });
});

describe('parseErrorLog / formatErrorRows', () => {
  beforeEach(() => {
    rmSync(logPath, { force: true });
  });

  it('parses four-source rows and keeps corrupt lines readable', () => {
    const rows = parseErrorLog(
      [
        '{"ts":1794111206832,"source":"webview","kind":"error","message":"ReferenceError x"}',
        '{"ts":1794111206833,"source":"rust","kind":"panic","message":"unwrap on None","stack":"lib.rs:1:2"}',
        '{"ts":1794111206834,"source":"tool","kind":"tool_error","message":"web_fetch: 404","detail":"durationMs=120"}',
        'not json at all',
        '{"legacy without source":true}',
      ].join('\n'),
    );
    expect(rows).toHaveLength(5);
    expect(rows[0].source).toBe('webview');
    expect(rows[2].detail).toBe('durationMs=120');
    expect(rows[3].source).toBe('(corrupt)');
    // 旧格式行（v4.6.0 前只有 webview 源、无 source 键）标 legacy，不丢。
    expect(rows[4].source).toBe('(legacy)');
  });

  it('renders human-readable rows newest-last with detail indent', () => {
    const rows = parseErrorLog(
      '{"ts":1794111206834,"source":"tool","kind":"tool_error","message":"web_fetch: 404","detail":"durationMs=120"}',
    );
    const text = formatErrorRows(rows);
    expect(text).toContain('[tool/tool_error] web_fetch: 404');
    expect(text).toContain('    durationMs=120');
  });

  it('says empty instead of printing nothing', () => {
    expect(formatErrorRows([])).toContain('台账为空');
  });
});

describe('runErrorLogCommand', () => {
  beforeEach(() => {
    rmSync(logPath, { force: true });
  });

  it('tails N entries and counts the total', () => {
    const lines = Array.from({ length: 5 }, (_, i) => `{"ts":${1000 + i},"source":"cli","kind":"probe","message":"e${i}"}`).join('\n');
    writeFileSync(logPath, `${lines}\n`);
    const buffer: string[] = [];
    const original = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((chunk: string) => {
      buffer.push(chunk);
      return true;
    }) as typeof process.stdout.write;
    const code = runErrorLogCommand(['2'], logPath);
    process.stdout.write = original;
    expect(code).toBe(0);
    const out = buffer.join('');
    expect(out).toContain('最近 2 条 / 共 5 条');
    expect(out).toContain('e4');
    expect(out).not.toContain('e2\n');
  });

  it('clears the ledger only with an explicit flag', () => {
    writeFileSync(logPath, '{"ts":1,"source":"cli","kind":"probe","message":"x"}\n');
    const buffer: string[] = [];
    const original = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((chunk: string) => {
      buffer.push(chunk);
      return true;
    }) as typeof process.stdout.write;
    expect(runErrorLogCommand(['--clear'], logPath)).toBe(0);
    process.stdout.write = original;
    expect(readFileSync(logPath, 'utf8')).toBe('');
    expect(buffer.join('')).toContain('已清空');
  });

  it('handles a missing file gracefully', () => {
    const buffer: string[] = [];
    const original = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((chunk: string) => {
      buffer.push(chunk);
      return true;
    }) as typeof process.stdout.write;
    expect(runErrorLogCommand([], join(dir, 'missing.log'))).toBe(0);
    process.stdout.write = original;
    expect(buffer.join('')).toContain('台账为空');
  });
});
