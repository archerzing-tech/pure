// src/harness/__tests__/toolQuarantine.test.ts
// 阶段 13.4 验收口径 4 后半句「连续失败自动停用出卡」的判据测试。
//
// 判据是纯函数，毫秒级跑完，不需要 provider。真正难钉的是**不该停用的情形**：
// 生成工具大量是 grep / diff / test 的包装，而「没有匹配」就是 exit 1。按「非零
// 即失败」计数的门会连按三次 Stop 就把健康工具毙掉——那比没有门更糟。

import { describe, expect, it } from 'bun:test';
import {
  QUARANTINE_COUNT_TTL_MS,
  QUARANTINE_CONSECUTIVE_FAILURES,
  QUARANTINE_MARKER_FILE,
  QUARANTINE_MIN_CALLS,
  buildQuarantineCard,
  classifyExternalToolOutcome,
  emptyQuarantineState,
  looksTimedOut,
  parseQuarantineMarker,
  quarantineVerdict,
  quarantinedToolResult,
  renderQuarantineMarker,
  tallyToolOutcome,
  type ExternalToolOutcome,
  type ToolQuarantineState,
} from '../toolQuarantine';

const NOW = 1_700_000_000_000;

/** 连续 n 次同样结局的调用。 */
function run(outcome: ExternalToolOutcome, times: number): ToolQuarantineState {
  let state = emptyQuarantineState();
  for (let i = 0; i < times; i++) state = tallyToolOutcome(state, { outcome, now: NOW + i });
  return state;
}

function quarantined(times = 4): ToolQuarantineState {
  return { ...run('broken', times), quarantined: true, quarantinedAt: NOW };
}

describe('结局分类：只有「工具跑不起来」才算它的错', () => {
  it('退出码 0 → ok', () => {
    expect(classifyExternalToolOutcome({ success: true, result: { exitCode: 0 } })).toBe('ok');
  });

  it('非零但说了话 → ran（运行本身是成功的）', () => {
    // grep 没匹配：exit 1，stdout 空，stderr 空。
    expect(classifyExternalToolOutcome({ success: false, result: { exitCode: 1, stdout: '', stderr: '' } })).toBe('ran');
    // diff 有差异：exit 1，差异在 stdout。
    expect(classifyExternalToolOutcome({ success: false, result: { exitCode: 1, stdout: '-a\n+b', stderr: '' } })).toBe('ran');
    // 测试挂了：一屏报错在 stderr。
    expect(classifyExternalToolOutcome({ success: false, result: { exitCode: 1, stdout: '', stderr: '3 fail' } })).toBe('ran');
  });

  it('退出码是「命令跑不起来」那两档且静默 → broken', () => {
    expect(classifyExternalToolOutcome({ success: false, result: { exitCode: 127, stdout: '', stderr: '' } })).toBe('broken');
    expect(classifyExternalToolOutcome({ success: false, result: { exitCode: 126, stdout: '', stderr: '' } })).toBe('broken');
  });

  it('用户按 Stop / 暂停 / 超时 → inert，工具根本没轮到表态', () => {
    expect(classifyExternalToolOutcome({ success: false }, { aborted: true })).toBe('inert');
    expect(classifyExternalToolOutcome({ success: false, outcome: 'paused' })).toBe('inert');
    expect(classifyExternalToolOutcome({ success: false, outcome: 'stopped' })).toBe('inert');
    expect(classifyExternalToolOutcome({ success: false, error: 'Command timed out after 120000ms' }, { timedOut: true })).toBe('inert');
  });

  it('abort 优先于一切——用户的手不该被算成工具的错', () => {
    // exit 127 + 静默本来是 broken，但用户按了 Stop：那次运行不作数。
    expect(classifyExternalToolOutcome({ success: false, result: { exitCode: 127, stdout: '', stderr: '' } }, { aborted: true })).toBe('inert');
  });

  it('looksTimedOut 只认超时文案，不猜', () => {
    expect(looksTimedOut({ error: 'Command timed out after 5ms' })).toBe(true);
    expect(looksTimedOut({ error: 'Command failed with exit code 1' })).toBe(false);
    expect(looksTimedOut({})).toBe(false);
  });
});

describe('失败计数：只有 broken 累加', () => {
  it('ok / ran / inert 都清零连续失败', () => {
    let state = run('broken', 2);
    expect(state.consecutiveFailures).toBe(2);
    for (const outcome of ['ok', 'ran', 'inert'] as const) {
      state = tallyToolOutcome(state, { outcome, now: NOW });
      expect(state.consecutiveFailures).toBe(0);
    }
    expect(state.totalCalls).toBe(5);
  });

  it('broken 累加，总数与最近失败时间都记', () => {
    const state = run('broken', 3);
    expect(state.consecutiveFailures).toBe(3);
    expect(state.totalCalls).toBe(3);
    expect(state.lastFailureAt).toBe(NOW + 2);
  });

  it('不修改入参（调用方持有的状态不被就地改写）', () => {
    const before = emptyQuarantineState();
    tallyToolOutcome(before, { outcome: 'broken', now: NOW });
    expect(before.totalCalls).toBe(0);
    expect(before.consecutiveFailures).toBe(0);
  });
});

describe('停用裁决', () => {
  it('连续 broken 到线才停用', () => {
    expect(quarantineVerdict('t', run('broken', QUARANTINE_CONSECUTIVE_FAILURES)).kind).toBe('quarantine');
  });

  it('差一次不到线就不停', () => {
    expect(quarantineVerdict('t', run('broken', QUARANTINE_CONSECUTIVE_FAILURES - 1)).kind).toBe('keep');
  });

  it('样本不足时即便全挂也不停——1 次失败不构成任何结论', () => {
    const state = run('broken', QUARANTINE_MIN_CALLS - 1);
    expect(state.totalCalls).toBeLessThan(QUARANTINE_MIN_CALLS);
    expect(quarantineVerdict('t', state).kind).toBe('keep');
  });

  it('误伤回归：连按三次 Stop 不停用，连跑三次 grep 没匹配也不停用', () => {
    // 这两条是这道门最容易犯的错，且都会把健康工具毙掉。
    expect(quarantineVerdict('t', run('inert', 5)).kind).toBe('keep');
    expect(quarantineVerdict('t', run('ran', 5)).kind).toBe('keep');
  });

  it('计数会过期：上个月攒下的失败不该在修好后第一次调用时引爆', () => {
    // 过期必须在 tally 里判：裁决时 lastFailureAt 刚被刷成 now，裁决侧永远看不到差值。
    const stale = run('broken', 3);
    expect(quarantineVerdict('t', stale).kind).toBe('quarantine');
    const afterTTL = NOW + 2 + QUARANTINE_COUNT_TTL_MS + 1; // run() 把 lastFailureAt 推到 NOW+2
    const revived = tallyToolOutcome(stale, { outcome: 'broken', now: afterTTL });
    // 过期后的第一次失败从 1 重新数起，不是 4。
    expect(revived.consecutiveFailures).toBe(1);
    expect(quarantineVerdict('t', revived).kind).toBe('keep');
    // TTL 内的连续失败照常累加。
    const withinTTL = tallyToolOutcome(stale, { outcome: 'broken', now: NOW + 1000 });
    expect(withinTTL.consecutiveFailures).toBe(4);
    expect(quarantineVerdict('t', withinTTL).kind).toBe('quarantine');
  });

  it('阈值可注入（调参不必改源码）', () => {
    const state = run('broken', 3);
    expect(quarantineVerdict('t', state, { consecutiveFailures: 4 }).kind).toBe('keep');
    expect(quarantineVerdict('t', state, { minCalls: 2, consecutiveFailures: 3 }).kind).toBe('quarantine');
  });

  it('已停用的一律不再重复裁决（幂等，否则每次调用都出一次卡）', () => {
    expect(quarantineVerdict('t', quarantined()).kind).toBe('keep');
  });

  it('理由里带得上工具名与证据', () => {
    const verdict = quarantineVerdict('my_tool', run('broken', 3));
    expect(verdict.kind).toBe('quarantine');
    if (verdict.kind !== 'quarantine') return;
    expect(verdict.reason).toContain('my_tool');
    expect(verdict.reason).toContain('连续 3 次');
    expect(verdict.evidence).toContain('共调用 3 次');
  });
});

describe('出卡', () => {
  it('载荷带齐证据与恢复路径；没有「一键删除」按钮是刻意的', () => {
    // 裁决必须在「还没停用」的状态上取：已停用过的按设计返回 keep（幂等）。
    const counted = run('broken', 4);
    const verdict = quarantineVerdict('t', counted);
    if (verdict.kind !== 'quarantine') throw new Error('verdict should be quarantine');
    const card = buildQuarantineCard('t', quarantined(), verdict);
    expect(card.toolName).toBe('t');
    expect(card.evidence).toContain('连续 4 次');
    expect(card.totalCalls).toBe(4);
    expect(card.toolDir).toBe('~/.pure/tools/t/');
    // 递归删除目录是这道门之外新增的破坏性面，真要删照路径手删即可。
    expect('actions' in card).toBe(false);
  });
});

describe('标记文件', () => {
  it('往返：渲染后再解析得到同一个状态', () => {
    const state = { ...quarantined(4), totalCalls: 9, lastFailureAt: NOW };
    expect(parseQuarantineMarker(renderQuarantineMarker(state))).toEqual(state);
  });

  it('未停用的标记也保留计数——否则「连续」只在单次运行内连续', () => {
    const counted = run('broken', 2);
    const parsed = parseQuarantineMarker(renderQuarantineMarker(counted));
    expect(parsed.quarantined).toBe(false);
    expect(parsed.consecutiveFailures).toBe(2);
    expect(parsed.totalCalls).toBe(2);
    expect(parsed.lastFailureAt).toBe(NOW + 1);
  });

  it('收 Rust 发来的对象形态（serde_json::Value），不只是字符串', () => {
    // 这条是跨语言契约：Rust 发对象、TS 曾按 string 消费，结果
    // `text.trim is not a function` 把整条加载路径抛掉，仪表盘永远显示「没有停用」，
    // 重新启用按钮一个都渲染不出来——功能在界面上是死的，而 tsc 抓不到。
    const asObject = parseQuarantineMarker({ quarantined: true, reason: '坏了', consecutiveFailures: 3, totalCalls: 4, lastFailureAt: NOW, quarantinedAt: NOW });
    expect(asObject.quarantined).toBe(true);
    expect(asObject.reason).toBe('坏了');
    expect(asObject.consecutiveFailures).toBe(3);
    const asText = parseQuarantineMarker(JSON.stringify({ quarantined: true, reason: '坏了', consecutiveFailures: 3, totalCalls: 4, lastFailureAt: NOW, quarantinedAt: NOW }));
    expect(asText).toEqual(asObject);
  });

  it('坏内容一律读成「全新状态」——标记坏了不许把工具永久死锁', () => {
    for (const content of ['{ not json', '', null, undefined, '{"quarantined": false}', '[]', 'null'] as const) {
      expect(parseQuarantineMarker(content as string | null | undefined)).toEqual(emptyQuarantineState());
    }
  });

  it('标记文件名与工具目录同级，删目录即连带删标记', () => {
    expect(QUARANTINE_MARKER_FILE).toBe('QUARANTINED.json');
  });
});

describe('停用后的调用回执', () => {
  it('失败 + 说清为什么 + 说清怎么恢复，且不带 outcome', () => {
    const state = { ...quarantined(3), reason: '连续 3 次调用「跑不起来」' };
    const result = quarantinedToolResult('call_1', 'my_tool', state);
    expect(result.id).toBe('call_1');
    expect(result.success).toBe(false);
    expect(result.error).toContain('my_tool');
    expect(result.error).toContain('自动停用');
    expect(result.error).toContain('重新启用');
    // outcome 只有 paused|stopped，都表示「用户按了暂停/停掉」；塞第三个值会给
    // UI 上色 / 引擎同参去重 / 失败策略三处都掺一个它们不认识的新语义。
    expect('outcome' in result).toBe(false);
  });

  it('没有理由时也读得通（不出现 undefined 字样）', () => {
    const result = quarantinedToolResult('c', 't', quarantined(3));
    expect(result.error).not.toContain('undefined');
    expect(result.error).toContain('连续 3 次');
  });
});
