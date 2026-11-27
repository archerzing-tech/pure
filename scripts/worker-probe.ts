#!/usr/bin/env bun
// scripts/worker-probe.ts
// P0-3 探针的 CLI 面：拉起 dev GUI（VITE_WORKER_PROBE=1）→ 等日志里出现
// worker_probe 行 → 打印矩阵 → 杀掉整棵进程树；或离线 --summarize 读日志。
//
// 为什么让 Vite 的编译期变量当开关，而不是 query/Rust 参数：
//   - 不用改 Rust 壳，也不用为了探针多一条生产代码路径；
//   - `tauri dev` 的 beforeDevCommand 继承环境变量，Vite 在 transform 时把
//     import.meta.env.VITE_WORKER_PROBE 内联成 "1"；
//   - release 构建没有这个变量，探针代码恒为死分支。
//
// 日志路径必须和 Rust 的 pure_home_dir() 一致（HOME → USERPROFILE）。

import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  formatProbeTable,
  latestPerPlatform,
  parseProbeLines,
  type WorkerProbeReport,
} from '../src/shared/workerProbeReport';

interface CliOptions {
  run: boolean;
  summarize: boolean;
  json: boolean;
  keep: boolean;
  timeoutMs: number;
  logPath: string;
}

function homeDir(): string {
  // 与 src-tauri/src/lib.rs pure_home_dir() 同序：Windows 只设 USERPROFILE。
  return process.env.HOME || process.env.USERPROFILE || '.';
}

function defaultLogPath(): string {
  return join(homeDir(), '.pure', 'gui_perf.log');
}

function usage(): void {
  console.log(`用法：
  bun run probe:worker                 # 等价 --summarize
  bun run probe:worker -- --run        # 拉起 dev GUI 测一轮并杀进程
  bun run probe:worker -- --summarize  # 只读日志、按平台打印最新结果
  bun run probe:worker -- --json       # 机器可读（最新一份/平台）

选项：
  --run            拉起 GUI（bun run gui）跑探针；默认 5 分钟超时
  --keep           跑完不杀进程（自己手动关窗口）
  --timeout <秒>    --run 的等待上限（默认 300）
  --log <path>      gui_perf.log 路径（默认 ~/.pure/gui_perf.log）
`);
}

function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = {
    run: false,
    summarize: false,
    json: false,
    keep: false,
    timeoutMs: 300_000,
    logPath: defaultLogPath(),
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--run') options.run = true;
    else if (arg === '--summarize') options.summarize = true;
    else if (arg === '--json') options.json = true;
    else if (arg === '--keep') options.keep = true;
    else if (arg === '--help' || arg === '-h') {
      usage();
      process.exit(0);
    } else if (arg === '--timeout') {
      const seconds = Number(argv[++i]);
      if (!Number.isFinite(seconds) || seconds <= 0) throw new Error('--timeout 需要正整数秒');
      options.timeoutMs = seconds * 1000;
    } else if (arg === '--log') {
      const next = argv[++i];
      if (!next) throw new Error('--log 需要一个路径');
      options.logPath = next;
    } else {
      throw new Error(`未知参数：${arg}`);
    }
  }
  if (!options.run) options.summarize = true;
  return options;
}

function readReports(path: string): WorkerProbeReport[] {
  if (!existsSync(path)) return [];
  return parseProbeLines(readFileSync(path, 'utf8'));
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
    // 进程可能已经自己退出。
  }
}

function printReports(reports: WorkerProbeReport[], options: CliOptions): void {
  const latest = latestPerPlatform(reports);
  if (options.json) {
    console.log(JSON.stringify(latest, null, 2));
    return;
  }
  console.log(`日志：${options.logPath}`);
  console.log(formatProbeTable(latest));
  console.log('');
  console.log('说明：load = new Worker → ready；rtt = 小消息往返；1MB/event/checkpoint = postMessage 单向克隆 + 回执；');
  console.log('      timer = 前台 setTimeout(50ms) 漂移（后台节流需窗口隐藏时另测）；checkpoint 标 (synth) 表示无会话、用合成 200 条。');
}

function tail(path: string, lines: number): string {
  if (!existsSync(path)) return `（没有 ${path}）`;
  const all = readFileSync(path, 'utf8').split('\n');
  return all.slice(-lines).join('\n');
}

async function runProbe(options: CliOptions): Promise<number> {
  const runLog = join(tmpdir(), 'pure-worker-probe-run.log');
  mkdirSync(dirname(runLog), { recursive: true });
  writeFileSync(runLog, '');
  const startedAt = Date.now();

  // 两个覆盖都是必须的：
  // - devUrl 带 query：环境变量未必穿透 tauri dev 的 beforeDevCommand，而 devUrl 一定被加载；
  // - 换 identifier/productName：用户常开着已安装的 pure.app，单实例锁会把 dev 实例
  //   转交给它后直接退出（实测：日志里没有新 boot 行）。探针实例必须是独立身份，
  //   否则要么测不到，要么得杀掉用户正在用的窗口。
  const probeConfig = JSON.stringify({
    productName: 'pure-worker-probe',
    identifier: 'com.pure.agent.workerprobe',
    build: { devUrl: 'http://localhost:1420/?worker_probe=1' },
  });
  console.log(`拉起 dev GUI（devUrl 带 worker_probe=1），日志 ${runLog}`);
  console.log('首次运行需要编译 Rust，可能超过一分钟；探针在窗口 ready 约 2.5s 后自动跑。');

  const child = spawn(process.execPath, ['run', 'tauri', 'dev', '--config', probeConfig], {
    cwd: process.cwd(),
    env: { ...process.env, VITE_WORKER_PROBE: '1' },
    detached: process.platform !== 'win32',
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const pipe = (chunk: Buffer) => writeFileSync(runLog, chunk, { flag: 'a' });
  child.stdout?.on('data', pipe);
  child.stderr?.on('data', pipe);

  let exitCode = 1;
  try {
    while (Date.now() - startedAt < options.timeoutMs) {
      if (child.exitCode !== null && child.exitCode !== 0) {
        console.error(`GUI 进程提前退出（code ${child.exitCode}），最后 40 行：`);
        console.error(tail(runLog, 40));
        return 1;
      }
      const fresh = readReports(options.logPath).filter((report) => report.ts >= startedAt);
      if (fresh.length > 0) {
        const report = fresh[fresh.length - 1];
        console.log(`\n收到 ${report.platform} 结果：`);
        printReports([report], options);
        if (options.json) console.log(JSON.stringify({ raw: report }, null, 2));
        exitCode = 0;
        break;
      }
      await sleep(500);
    }
    if (exitCode !== 0) {
      console.error(`等待 ${Math.round(options.timeoutMs / 1000)}s 没有等到 worker_probe 行。最后 40 行：`);
      console.error(tail(runLog, 40));
    }
  } finally {
    if (!options.keep) {
      killTree(child.pid);
      // SIGTERM 后给 tauri dev 两秒收尾；仍在就强杀进程组。
      await sleep(2_000);
      if (child.exitCode === null && process.platform !== 'win32') {
        try {
          process.kill(-child.pid, 'SIGKILL');
        } catch {
          // 已退出。
        }
      }
    } else {
      console.log(`--keep：GUI 仍在运行，进程 pid=${child.pid}，测完请手动关闭。`);
    }
  }
  return exitCode;
}

async function main(): Promise<void> {
  let options: CliOptions;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    usage();
    process.exit(2);
  }
  if (options.run) {
    process.exitCode = await runProbe(options);
    return;
  }
  printReports(readReports(options.logPath), options);
}

void main();
