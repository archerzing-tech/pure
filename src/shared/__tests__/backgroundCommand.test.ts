// src/shared/__tests__/backgroundCommand.test.ts
// execute_command background:true — the launch plan must produce wrapper
// scripts that survive arbitrary user commands (quoting, multi-line, CJK) and
// always land output in the log file, on both platforms.

import { describe, expect, it } from 'bun:test';
import {
  buildBackgroundLaunchPlan,
  buildWrapperScript,
  parseBackgroundPid,
  buildBackgroundResult,
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
    expect(r.hint).toContain('kill <pid>');
    const failed = JSON.parse(buildBackgroundResult(null, '/tmp/l.log'));
    expect(failed.started).toBe(false);
    expect(failed.note).toBeTruthy();
  });
});
