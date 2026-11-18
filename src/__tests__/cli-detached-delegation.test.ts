// src/__tests__/cli-detached-delegation.test.ts
// CLI 的两态（2026-11-18 档二）：委派受理收执不能印成 ✓ 完成，后台结果送达
// 也不能印成同一条被重跑一次。这两条都在 consumeTurn 的 ToolResult 分支里，
// 且必须先于默认状态行——顺序错了就是「手里拿着收执说完成」。

import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

function readCliSource(): string {
  // consumeTurn 在 cli.ts 拆分后落在 cliRepl.ts（审计 ①）。
  return readFileSync(fileURLToPath(new URL('../cliRepl.ts', import.meta.url)), 'utf-8');
}

describe('CLI 后台委派两态', () => {
  it('受理收执与结算各有自己的行，且都先于默认 ✓ 状态行', () => {
    const src = readCliSource();
    const settle = src.indexOf("event.payload.backgroundSettle === true");
    const receipt = src.indexOf('toolResult.deferred === true');
    const defaultStatus = src.indexOf('const status = toolResult.success ?');

    expect(settle).toBeGreaterThan(-1);
    expect(receipt).toBeGreaterThan(-1);
    expect(defaultStatus).toBeGreaterThan(-1);
    expect(settle).toBeLessThan(defaultStatus);
    expect(receipt).toBeLessThan(defaultStatus);
  });

  it('两种态各自说明是什么，不借 ✓ 的表达', () => {
    const src = readCliSource();
    expect(src).toContain('后台结果已送达');
    expect(src).toContain('⏳ 后台运行中');
  });
});
