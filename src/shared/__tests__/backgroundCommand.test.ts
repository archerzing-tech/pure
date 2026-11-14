// src/shared/__tests__/backgroundCommand.test.ts
// execute_command background:true — the launch plan must produce wrapper
// scripts that survive arbitrary user commands (quoting, multi-line, CJK) and
// always land output in the log file, on both platforms.

import { describe, expect, it } from 'bun:test';
import {
  BACKGROUND_LOG_MISS_HINT,
  buildBackgroundLaunchPlan,
  buildWrapperScript,
  parseBackgroundPid,
  buildBackgroundResult,
  isBackgroundLogPath,
} from '../backgroundCommand';

describe('buildBackgroundLaunchPlan', () => {
  it('plans unix .sh script + log file and a detach incantation echoing the PID', () => {
    const plan = buildBackgroundLaunchPlan('npm run dev', { isWindows: false });
    expect(plan.scriptFile.endsWith('.sh')).toBe(true);
    expect(plan.logFile).toContain('pure-bg-');
    // Heredoc writer + detached nohup + PID echo.
    expect(plan.detachCommand).toContain("cat > \"$__pure_bg\" <<'PURE_BG_EOF_");
    expect(plan.detachCommand).toContain('\nnpm run dev\n');
    expect(plan.detachCommand).toContain('nohup sh "$__pure_bg" >/dev/null 2>&1 &');
    expect(plan.detachCommand).toContain('echo PURE_BG_PID=$!');
  });

  it('plans windows .ps1 script with a base64 PowerShell launcher', () => {
    const plan = buildBackgroundLaunchPlan('npm run dev', { isWindows: true });
    expect(plan.scriptFile.endsWith('.ps1')).toBe(true);
    expect(plan.detachCommand).toContain('FromBase64String');
    expect(plan.detachCommand).toContain('Start-Process powershell');
    expect(plan.detachCommand).toContain("'PURE_BG_PID=' + $__p.Id");
  });

  it('expands $env:TEMP in double quotes, not single quotes (single quotes keep it literal)', () => {
    // Windows 判例 2026-11-14：单引号里 $env:TEMP 不展开，`*>> '$env:TEMP\...'`
    // 会砸出字面 '$env:TEMP' 目录 → 重定向打不开 → 后台启动实质失效但
    // started:true 照报。双引号内才展开。wrapper 走 base64，双引号形态要
    // 解码后验证；明文只有 $__f 赋值段。
    const plan = buildBackgroundLaunchPlan('npm run dev', { isWindows: true });
    expect(plan.detachCommand).toContain('$__f="$env:TEMP\\pure-bg-');
    const b64 = plan.detachCommand.match(/FromBase64String\('([^']+)'\)/)?.[1] ?? '';
    const wrapper = Buffer.from(b64, 'base64').toString('utf8');
    expect(wrapper).toContain('*>> "$env:TEMP\\pure-bg-');
    expect(wrapper).not.toContain("*>> '$env:TEMP");
  });

  it('writes the wrapper .ps1 with a BOM so PS 5.1 reads it as UTF-8, and quotes -File against spaces', () => {
    // Windows 判例 2026-11-14：PS 5.1 对无 BOM 的 .ps1 按 ANSI(GBK) 解码，
    // 中文后台命令整段乱码；TEMP 路径含空格时 -ArgumentList 不自动加引号，
    // -File 会被劈开。
    const plan = buildBackgroundLaunchPlan('echo 你好', { isWindows: true });
    expect(plan.detachCommand).toContain('[Text.UTF8Encoding]::new($true)');
    expect(plan.detachCommand).toContain("'-File',\"$__f\"");
  });

  it('keeps hostile command content verbatim inside the quoted heredoc', () => {
    const nasty = `rm -rf "$HOME/; evil'quote" # comment\necho done`;
    const plan = buildBackgroundLaunchPlan(nasty, { isWindows: false });
    expect(plan.detachCommand).toContain(`\n${nasty}\n`);
  });
});

describe('buildWrapperScript (Node adapter path)', () => {
  it('self-redirects all streams into the log on unix', () => {
    const s = buildWrapperScript('python3 -m http.server 8000', '/tmp/x.log', { isWindows: false });
    expect(s.startsWith('{\n')).toBe(true);
    expect(s).toContain("} >> '/tmp/x.log' 2>&1");
  });

  it('wraps in a cmd group with redirect + unconditional exit on windows', () => {
    const s = buildWrapperScript('npm run dev', 'C:\\Temp\\x.log', { isWindows: true });
    expect(s.startsWith('@echo off')).toBe(true);
    // chcp 65001 前置（Windows 判例 2026-11-14）：cmd 按 OEM 逐行读批处理，
    // UTF-8 写盘的中文命令行 zh-CN 下必乱；切 65001 后后续行按 UTF-8 解析。
    expect(s).toContain('chcp 65001 >nul');
    expect(s).toContain('(\r\nnpm run dev\r\n) >> "C:\\Temp\\x.log" 2>&1');
    expect(s.trimEnd().endsWith('exit /b 0')).toBe(true);
  });
});

describe('parseBackgroundPid', () => {
  it('extracts the echoed PID', () => {
    expect(parseBackgroundPid('PURE_BG_PID=4242\n')).toBe(4242);
    expect(parseBackgroundPid('noise\nPURE_BG_PID=0')).toBe(null);
    expect(parseBackgroundPid('nothing here')).toBe(null);
  });
});

describe('buildBackgroundResult', () => {
  it('returns structured JSON with pid, log and stop instructions', () => {
    const r = JSON.parse(buildBackgroundResult(1234, '/tmp/l.log'));
    expect(r.kind).toBe('background');
    expect(r.started).toBe(true);
    expect(r.pid).toBe(1234);
    expect(r.hint).toContain('task_list / task_kill');
    const failed = JSON.parse(buildBackgroundResult(null, '/tmp/l.log'));
    expect(failed.started).toBe(false);
    expect(failed.note).toBeTruthy();
  });
});

describe('isBackgroundLogPath (E3 引用悬空识别)', () => {
  it('matches the pure-bg-*.log basename pattern on both path flavors', () => {
    expect(isBackgroundLogPath('/tmp/pure-bg-mx1abc-7-k3.log')).toBe(true);
    expect(isBackgroundLogPath('C:\\Temp\\pure-bg-mx1abc-7-k3.log')).toBe(true);
    expect(isBackgroundLogPath('/tmp/pure-bg-mx1abc-7-k3.sh')).toBe(false);
    expect(isBackgroundLogPath('/tmp/other.log')).toBe(false);
    expect(isBackgroundLogPath('/tmp/pure-bg-not-a-log')).toBe(false);
    expect(isBackgroundLogPath('')).toBe(false);
  });

  it('miss hint names the outer cause and gives the model a way out, not a retry loop', () => {
    // 提示必须回答模型排查时真正需要的三件事：为什么没了（外力清理，不是
    // 任务失败）、先做什么（验证任务实际效果）、别做什么（重试同一路径）。
    expect(BACKGROUND_LOG_MISS_HINT).toContain('定期清理');
    expect(BACKGROUND_LOG_MISS_HINT).toContain('不代表任务失败');
    expect(BACKGROUND_LOG_MISS_HINT).toContain('别重试同一路径');
  });
});
