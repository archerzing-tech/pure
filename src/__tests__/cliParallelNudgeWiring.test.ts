// src/__tests__/cliParallelNudgeWiring.test.ts
// 生产侧并行提醒的接线（2026-11-23 收口）：回合账只有引擎一份。此前 GUI 在
// 事件流里记、CLI 在 execute 层再包一层，同名事实两套实现；这个文件锁住
// 「宿主只回答是不是委派」与「拉取口两边都在」这两件事，防止重复记账回流。

import { describe, it, expect } from 'bun:test';
import { readFileSync } from 'node:fs';

const read = (rel: string) => readFileSync(new URL(rel, import.meta.url), 'utf8');

describe('平行提醒接线', () => {
  it('引擎是唯一的回合账记账人', () => {
    const engine = read('../engine/AgentLoopEngine.ts');
    expect(engine).toContain('createTurnWriteTracker()');
    expect(engine).toContain('turnWrites.observe(');
    expect(engine).toContain('ctx.isDelegationCall?.(tr.toolName) === true');
  });

  it('GUI 只提供委派判定，不再自己累加写入账', () => {
    const chat = read('../ui/chat.ts');
    expect(chat).toContain('isDelegationCall: (toolName) => subagentNames.has(toolName)');
    expect(chat).toContain('pullTurnParallelNudge: () => takeBuildParallelNudge()');
    expect(chat).not.toContain('recordMainThreadWriteBytes');
    expect(chat).not.toContain('turnWriteBytes');
  });

  it('CLI 只提供委派判定，工具面不再有写入包装', () => {
    const cli = read('../cliHarness.ts');
    expect(cli).toContain('isDelegationCall: (toolName) => cliSubagentNames.has(toolName)');
    expect(cli).toContain('pullTurnParallelNudge: () => takeBuildParallelNudge()');
    expect(cli).not.toContain('withWriteAccounting');
    expect(cli).not.toContain('recordMainThreadWriteBytes');
  });

  it('两个宿主的下一回合 envFacts 通道都接同一处方', () => {
    expect(read('../cliRepl.ts')).toContain('const parallelNudge = takeBuildParallelNudge()');
    expect(read('../ui/chat.ts')).toContain('takeBuildParallelNudge(), repoMap, verificationEntry');
  });
});

// 2026-11-23 大屏 A/B：非交互模式下命令通道与交付闸都拿不到确认，这条事实
// 过去只在第一个 ✗ 里出现，模型于是把回合花在「换种方式试探权限」上。
describe('非交互模式的前置告知与用量插桩', () => {
  it('开工前就讲清命令通道与交付闸不可用', () => {
    const repl = read('../cliRepl.ts');
    expect(repl).toContain("if (!process.stdin.isTTY) {");
    expect(repl).toContain('<non_interactive_mode>');
    expect(repl).toContain('Do NOT probe for permission');
  });

  it('PURE_USAGE_REPORT 打开时打印本回合聚合用量', () => {
    const repl = read('../cliRepl.ts');
    expect(repl).toContain("process.env.PURE_USAGE_REPORT === '1'");
    expect(repl).toContain('usage: ${parts.join(');
    expect(repl).toContain('usage = event.payload.usage');
  });
});
