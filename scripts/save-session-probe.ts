#!/usr/bin/env bun
// scripts/save-session-probe.ts
// P0-4：拉起独立身份的 dev GUI，跑 saveProbe，并在主线程冻结期间采样
// ~/.pure/sessions/<id>/session.json 的 size/mtime。
//
// 判读：
//   - 冻结窗口内 size 或 mtime 变化 ⇒ 写入不依赖主线程，超时只是回执丢了；
//   - 解冻后才变化 ⇒ 写请求真正被主线程卡住（丢写），P1-c 必做。

import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

interface SaveProbeLine {
  ts: number;
  kind: string;
  sessionId?: string;
  freezeMs?: number;
  freezeActualMs?: number;
  dispatchMs?: number;
  totalMs?: number;
  snapshotBytes?: number;
  freezeStartedAt?: number;
  freezeEndedAt?: number;
  invokeStartedAt?: number;
  invokeResolvedAt?: number;
  bytes?: number;
  error?: string;
}

interface Sample {
  at: number;
  size: number;
  mtime: number;
}

function homeDir(): string {
  return process.env.HOME || process.env.USERPROFILE || '.';
}

function logPath(): string {
  return join(homeDir(), '.pure', 'gui_perf.log');
}

function readLines(path: string): SaveProbeLine[] {
  if (!existsSync(path)) return [];
  const out: SaveProbeLine[] = [];
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed = JSON.parse(trimmed) as SaveProbeLine;
      if (typeof parsed?.kind === 'string' && parsed.kind.startsWith('save_probe_')) out.push(parsed);
    } catch {
      // 坏行跳过。
    }
  }
  return out;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function killTree(pid: number): void {
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore' });
    return;
  }
  try {
    process.kill(-pid, 'SIGTERM');
  } catch {
    // 已退出。
  }
}

function usage(): void {
  console.log(`用法：bun run probe:save [--freeze 15000] [--timeout 150]

冻结主线程 freeze 毫秒，同时采样 save_session 的落盘文件。
脚本用独立 productName/identifier，避免单实例锁转交给已安装的 pure.app。`);
}

function parseArgs(argv: string[]): { freezeMs: number; timeoutMs: number } {
  let freezeMs = 15_000;
  let timeoutMs = 180_000;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--freeze') freezeMs = Number(argv[++i]) || freezeMs;
    else if (arg === '--timeout') timeoutMs = (Number(argv[++i]) || 180) * 1000;
    else if (arg === '--help' || arg === '-h') {
      usage();
      process.exit(0);
    } else {
      throw new Error(`未知参数：${arg}`);
    }
  }
  return { freezeMs, timeoutMs };
}

async function main(): Promise<void> {
  let args: { freezeMs: number; timeoutMs: number };
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    usage();
    process.exit(2);
  }

  const probeConfig = JSON.stringify({
    productName: 'pure-save-probe',
    identifier: 'com.pure.agent.saveprobe',
    build: { devUrl: `http://localhost:1420/?save_probe=1&freeze_ms=${args.freezeMs}` },
  });
  const runLog = join(tmpdir(), 'pure-save-probe-run.log');
  mkdirSync(dirname(runLog), { recursive: true });
  writeFileSync(runLog, '');

  console.log(`拉起 dev GUI（freeze=${args.freezeMs}ms），进程日志 ${runLog}`);
  const child = spawn(process.execPath, ['run', 'tauri', 'dev', '--config', probeConfig], {
    cwd: process.cwd(),
    detached: process.platform !== 'win32',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env },
  });
  child.stdout?.on('data', (chunk: Buffer) => writeFileSync(runLog, chunk, { flag: 'a' }));
  child.stderr?.on('data', (chunk: Buffer) => writeFileSync(runLog, chunk, { flag: 'a' }));

  const startedAt = Date.now();
  const samples: Sample[] = [];
  let startLine: SaveProbeLine | null = null;
  let doneLine: SaveProbeLine | null = null;
  let exitCode = 1;

  try {
    while (Date.now() - startedAt < args.timeoutMs) {
      const lines = readLines(logPath()).filter((line) => line.ts >= startedAt);
      startLine = lines.find((line) => line.kind === 'save_probe_start') ?? startLine;
      doneLine = lines.find((line) => line.kind === 'save_probe_done') ?? doneLine;

      if (startLine?.sessionId) {
        const file = join(homeDir(), '.pure', 'sessions', startLine.sessionId, 'session.json');
        if (existsSync(file)) {
          const stat = statSync(file);
          const last = samples[samples.length - 1];
          if (!last || last.size !== stat.size || last.mtime !== stat.mtimeMs) {
            samples.push({ at: Date.now(), size: stat.size, mtime: stat.mtimeMs });
          }
        }
      }
      if (doneLine) break;
      // 100ms：3MB 写盘在解冻后可能只有几百 ms，500ms 会把首次出现推后。
      await sleep(100);
    }

    if (!startLine) {
      console.error(`等待 ${args.timeoutMs / 1000}s 没有等到 save_probe_start。最后 40 行：`);
      console.error(existsSync(runLog) ? readFileSync(runLog, 'utf8').split('\n').slice(-40).join('\n') : '');
    } else if (!doneLine) {
      console.error(`拿到 start 但 ${args.timeoutMs / 1000}s 内没有 done（可能仍冻结/崩溃）。已采样 ${samples.length} 次。`);
    } else {
      const freezeEndedAt = doneLine.freezeEndedAt ?? (doneLine.ts - (doneLine.freezeActualMs ?? 0));
      const firstSample = samples[0]?.at;
      const appearedDuringFreeze = firstSample !== undefined && firstSample <= freezeEndedAt;
      console.log(`\nsession: ${doneLine.sessionId}`);
      console.log(`snapshot≈${Math.round((doneLine.snapshotBytes ?? 0) / 1024)}KB · dispatch=${(doneLine.dispatchMs ?? 0).toFixed(1)}ms · freeze=${Math.round(doneLine.freezeActualMs ?? 0)}ms · total=${Math.round(doneLine.totalMs ?? 0)}ms`);
      console.log(`落盘字节: ${doneLine.bytes ?? '—'}${doneLine.error ? ` · error: ${doneLine.error}` : ''}`);
      console.log(`冻结窗口: +${((doneLine.freezeStartedAt ?? startLine.ts) - startLine.ts)}ms → +${(freezeEndedAt - startLine.ts)}ms（相对 start 行）`);
      console.log(`文件首次出现: ${firstSample === undefined ? '未出现' : `+${firstSample - startLine.ts}ms`}（${samples.length} 个样本）`);
      for (const sample of samples.slice(0, 12)) {
        console.log(`  +${sample.at - startLine.ts}ms  ${Math.round(sample.size / 1024)}KB`);
      }
      console.log('');
      if (appearedDuringFreeze) {
        console.log('判读：写入在主线程冻结期间已落盘 ⇒ 超时只可能丢回执（P1-c 非必做）。');
      } else if (doneLine.bytes !== undefined) {
        console.log('判读：文件在解冻后才出现 ⇒ 写请求被主线程队列卡住（丢写），P1-c 升级为必做。');
      } else {
        console.log('判读：未确认落盘，按「丢写」处理（P1-c 升级为必做）。');
      }
      exitCode = 0;
    }
  } finally {
    killTree(child.pid);
    await sleep(2_000);
    if (child.exitCode === null && process.platform !== 'win32') {
      try {
        process.kill(-child.pid, 'SIGKILL');
      } catch {
        // 已退出。
      }
    }
  }
  process.exitCode = exitCode;
}

void main();
