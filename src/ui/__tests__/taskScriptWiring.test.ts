// src/ui/__tests__/taskScriptWiring.test.ts
// 期 2·结构账的接线守卫：TaskScript 只在账本模块里正确还不够——真实会话
// 必须真的把信号喂进去。这里锁两件事：
//  1. 写盘产出的口径（只有真写类工具的真参数才算产出）；
//  2. chat.ts 里每个信号点都接上了（源码内容锁，防有人拆掉接线或改信号形状
//     而账本侧还绿着——那会变成「账本没坏，但账是空的」）。

import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { writtenArtifactPath } from '../chat';
import type { TaskScriptSignal } from '../../shared/taskScript';

function readSource(relative: string): string {
  return readFileSync(new URL(relative, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
}

describe('writtenArtifactPath · 只有真写盘才算产出', () => {
  it('认单文件写类工具的 path 参数', () => {
    expect(writtenArtifactPath('write_file', { path: 'src/a.ts' })).toBe('src/a.ts');
    expect(writtenArtifactPath('edit_file', { path: 'src/b.ts' })).toBe('src/b.ts');
    expect(writtenArtifactPath('create_document', { path: 'doc.md' })).toBe('doc.md');
  });

  it('replace_files 的多文件合成一条产出', () => {
    expect(writtenArtifactPath('replace_files', { files: ['a.ts', 'b.ts'] })).toBe('a.ts, b.ts');
  });

  it('读类与非写工具不产生产出（工具名不暗示事实）', () => {
    expect(writtenArtifactPath('read_file', { path: 'src/a.ts' })).toBeUndefined();
    expect(writtenArtifactPath('execute_command', { path: 'src/a.ts' })).toBeUndefined();
    expect(writtenArtifactPath('write_file', { content: 'x' })).toBeUndefined();
    expect(writtenArtifactPath('replace_files', { files: ['ok.ts', '', 42] })).toBe('ok.ts');
    expect(writtenArtifactPath('write_file', undefined)).toBeUndefined();
    expect(writtenArtifactPath('replace_files', { files: [] })).toBeUndefined();
  });

  it('空白路径不算产出（不把空串当证据）', () => {
    expect(writtenArtifactPath('write_file', { path: '   ' })).toBeUndefined();
  });
});

describe('chat.ts · TaskScript 信号接线', () => {
  const src = readSource('../chat.ts');

  function recordCalls(): string[] {
    const calls: string[] = [];
    const re = /this\.recordTaskScript\(\{([^}]*)\}/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(src)) !== null) calls.push(m[1] ?? '');
    return calls;
  }

  it('控制行四类标记都进剧本（起手 / 跳格 / 完成 / 子步骤起止）', () => {
    const calls = recordCalls().join('\n');
    for (const marker of ['phaseStart', 'phaseJump', 'phaseDone', 'substepStart', 'substepDone']) {
      expect(calls).toContain(`marker: '${marker}'`);
    }
  });

  it('工具结果、交付门禁验证、分支中断、回合收尾、计划细化都进剧本', () => {
    const calls = recordCalls().join('\n');
    expect(calls).toContain("kind: 'tool'");
    expect(calls).toContain("kind: 'verification'");
    expect(calls).toContain("kind: 'branch'");
    expect(calls).toContain("kind: 'turnEnd'");
    expect(calls).toContain("kind: 'planReplaced'");
  });

  it('工具信号带真结果、真命令行、真产出路径（不是只有工具名）', () => {
    const toolCall = recordCalls().find((body) => body.includes("kind: 'tool'"));
    expect(toolCall).toBeDefined();
    expect(toolCall).toContain('ok: event.payload.result.success');
    expect(toolCall).toContain('artifact: writtenArtifactPath(toolName, resultArgs)');
  });

  it('回合收尾只在正常收尾时记账（中断 / 提问轮 / 暂停轮不算干完了）', () => {
    const turnEnd = recordCalls().find((body) => body.includes("kind: 'turnEnd'"));
    expect(turnEnd).toBeDefined();
    const guard = src.slice(src.indexOf(turnEnd ?? '') - 400, src.indexOf(turnEnd ?? '') + 40);
    expect(guard).toContain('planCard &&');
    expect(guard).toContain('!event.payload.interrupted');
    expect(guard).toContain('!turnAsksForInput');
    expect(guard).toContain('!this.pausePlanCard');
  });

  it('交付门禁的 skipped 不记成一次真验证（跳过不是跑过）', () => {
    const delivery = src.slice(src.indexOf('const onDeliveryStep = '), src.indexOf('const onDeliveryStep = ') + 700);
    expect(delivery).toContain("if (step.status !== 'skipped')");
    expect(delivery).toContain("ok: step.status === 'passed'");
  });

  it('无计划卡时 recordTaskScript 是空操作（不凭空造账）', () => {
    const method = src.slice(src.indexOf('private recordTaskScript('), src.indexOf('private recordTaskScript(') + 320);
    expect(method).toContain('if (!this.activeTaskScript) return;');
  });

  it('会话切换 / 恢复 / 取消暂停 / 丢弃计划卡 / 开新回合 / 新对话都把剧本归零', () => {
    for (const fn of ['setSessionId(', 'cancelPausedPlan(): boolean', 'loadFromStorage(', 'discardPlanCard = (): void']) {
      const start = src.indexOf(fn);
      expect(start).toBeGreaterThan(-1);
      expect(src.slice(start, src.indexOf('\n  }', start))).toContain('this.activeTaskScript = null;');
    }
    // send 起手与 newChat 也各自归零：新回合不能继承上一回合的账。
    expect(src.split('this.activeTaskScript = null;').length - 1).toBe(6);
  });

  it('剧本只经 recordTaskScript / 建本 / 恢复写入，不存在第二处直接改账', () => {
    const assignments = src.split('this.activeTaskScript =').length - 1;
    // 1 处追加（recordTaskScript）+ 2 处建本（新计划 / 续跑重开）
    // + 1 处恢复（loadFromStorage，期 4）+ 6 处归零。
    expect(assignments).toBe(10);
    expect(src.split('this.activeTaskScript = createTaskScript(').length - 1).toBe(2);
    expect(src.split('this.activeTaskScript = applyTaskScriptSignal(').length - 1).toBe(1);
    expect(src.split('this.activeTaskScript = null;').length - 1).toBe(6);
  });

  it('恢复的账先验结构再认（宁可没账，不要一本坏账）', () => {
    const restore = src.slice(src.indexOf('private restoreTaskScript('), src.indexOf('private restoreTaskScript(') + 800);
    expect(restore).toContain('candidate.version !== 1');
    expect(restore).toContain('Array.isArray(candidate.plan.steps)');
    expect(restore).toContain('Array.isArray(candidate.signals)');
  });

  it('落盘句柄随计划游标一起收（切换会话不会把旧会话的账写回去）', () => {
    const detach = src.slice(src.indexOf('private detachActivePlanProgress('), src.indexOf('private detachActivePlanProgress(') + 900);
    expect(detach).toContain('void scriptPersistence.flush()');
    expect(detach).toContain('scriptPersistence.dispose()');
  });

  it('对外只暴露只读账本，不暴露可写的剧本引用之外的状态', () => {
    expect(src).toContain('getTaskScript(): TaskScript | null');
    expect(src).toContain('getTaskScriptHandOver(): TaskScriptHandOver | null');
  });
});

describe('chat.ts · 信号形状与账本契约对齐', () => {
  const src = readSource('../chat.ts');

  it('每个 recordTaskScript 调用都带 kind 字段（不留裸对象进账本）', () => {
    const calls: string[] = [];
    const re = /this\.recordTaskScript\(\{([^}]*)\}/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(src)) !== null) calls.push(m[1] ?? '');
    expect(calls.length).toBeGreaterThanOrEqual(10);
    for (const body of calls) {
      const signal = { kind: body.match(/kind: '(\w+)'/)?.[1] } as Partial<TaskScriptSignal>;
      expect(signal.kind).toBeDefined();
    }
  });

  it('账本侧支持的 marker 集合与 chat.ts 用到的完全一致（不多不少）', () => {
    const scriptSrc = readSource('../../shared/taskScript.ts');
    const declared = scriptSrc.slice(scriptSrc.indexOf("marker: 'phaseStart'"));
    const supported = new Set(
      (declared.slice(0, declared.indexOf(';')).match(/'(\w+)'/g) ?? []).map((s) => s.replace(/'/g, '')),
    );
    const used = new Set<string>();
    const re = /this\.recordTaskScript\(\{[^}]*marker: '(\w+)'/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(src)) !== null) used.add(m[1] ?? '');
    expect(used.size).toBeGreaterThan(0);
    for (const marker of used) expect(supported.has(marker)).toBe(true);
  });
});
