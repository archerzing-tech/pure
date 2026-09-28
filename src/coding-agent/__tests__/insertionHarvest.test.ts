// 疑点句收割：诊断区审计标出的句子要能变成语料，且期望只从「为何被标疑点」反推。

import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { harvestCasesFromLog, renderHarvestedModule } from '../insertionHarvest';
import { HARVESTED_CASES } from '../insertionCorpusHarvested';
import type { InputDecision } from '../inputDecision';
import type { Case } from '../insertionCorpus';

function decision(overrides: Partial<InputDecision> = {}): InputDecision {
  return {
    source: 'mid-run-insert',
    kind: 'task',
    action: 'queue',
    confidence: 0.9,
    timing: { mode: 'after-current' },
    scope: ['plan'],
    shouldAbort: false,
    reason: '',
    signals: { via: 'judge' },
    ...overrides,
  };
}

const NO_EXISTING: Case[] = [];

describe('疑点句收割', () => {
  it('取消味但没报 cancels_part 的句子被收成 steer + cancels_part 期望', () => {
    // 这正是审计的两条疑点之一：宿主已经不嗅措辞了，漏报只有审计看得见；
    // 收割把它变成「下次回放还得再判一遍」的语料。
    const { added } = harvestCasesFromLog(
      [decision({ inputText: '把知乎那项也取消掉', kind: 'task', signals: { via: 'judge' } })],
      NO_EXISTING,
      '2026-09-28',
    );
    expect(added).toHaveLength(1);
    expect(added[0]).toMatchObject({
      text: '把知乎那项也取消掉',
      kind: 'steer',
      cancels: true,
      expectation: 'suspected',
    });
    expect(added[0].addsAlong).toBeUndefined();
    expect(added[0].source).toContain('cancels-missed');
  });

  it('报了取消又在加活的句子收成 cancels + adds_along 期望', () => {
    const { added } = harvestCasesFromLog(
      [decision({ inputText: '不要只查均价，把区间也查了', signals: { via: 'judge', cancelsPart: true } })],
      NO_EXISTING,
      '2026-09-28',
    );
    expect(added).toHaveLength(1);
    expect(added[0]).toMatchObject({ cancels: true, addsAlong: true, expectation: 'suspected' });
    expect(added[0].source).toContain('adds-along-missed');
  });

  it('没疑点的句子不进语料——收割不是把日志整个搬进来', () => {
    const { added, skipped } = harvestCasesFromLog(
      [decision({ inputText: '记得跑测试', signals: { via: 'judge' } })],
      NO_EXISTING,
      '2026-09-28',
    );
    expect(added).toEqual([]);
    expect(skipped).toEqual([{ text: '记得跑测试', why: 'clean' }]);
  });

  it('机械命令快路径不收割——契约字段对它本来就不适用', () => {
    const { added } = harvestCasesFromLog(
      [decision({ inputText: '停掉竞品那支', kind: 'steer', signals: { via: 'rule', rule: 'BRANCH_STOP_RE' } })],
      NO_EXISTING,
      '2026-09-28',
    );
    expect(added).toEqual([]);
  });

  it('已经在语料里的句子只收一次，同一批里的重复也只收一次', () => {
    const entry = decision({ inputText: 'X 就不调研了' });
    const existing: Case[] = [{ text: 'X 就不调研了', kind: 'steer', cancels: true, source: '人工' }];
    const againstExisting = harvestCasesFromLog([entry], existing, '2026-09-28');
    expect(againstExisting.added).toEqual([]);
    expect(againstExisting.skipped).toEqual([{ text: 'X 就不调研了', why: 'duplicate' }]);

    const withinBatch = harvestCasesFromLog([entry, entry], NO_EXISTING, '2026-09-28');
    expect(withinBatch.added).toHaveLength(1);
  });

  it('没有原话的记录不进语料', () => {
    const { added, skipped } = harvestCasesFromLog([decision({ inputText: '' })], NO_EXISTING, '2026-09-28');
    expect(added).toEqual([]);
    expect(skipped).toEqual([{ text: '', why: 'no-text' }]);
  });

  it('渲染出的模块自带 suspected 标记与出处', () => {
    const rendered = renderHarvestedModule([
      { text: '把知乎那项也取消掉', kind: 'steer', cancels: true, expectation: 'suspected', source: '诊断区审计 2026-09-28（cancels-missed）' },
      { text: '不要只查均价，把区间也查了', kind: 'steer', cancels: true, addsAlong: true, expectation: 'suspected', source: '诊断区审计 2026-09-28（adds-along-missed）' },
    ]);
    expect(rendered).toContain("expectation: 'suspected'");
    expect(rendered).toContain('cancels: true');
    expect(rendered).toContain('addsAlong: true');
    expect(rendered).toContain("text: \"不要只查均价，把区间也查了\"");
    expect(rendered).toContain('诊断区审计 2026-09-28');
    // 空列表也要是合法模块（下一句断言是更强的那一条：这函数生成的文本就是
    // 磁盘上那个文件，所以它必然可编译）。
    expect(renderHarvestedModule([])).toContain('export const HARVESTED_CASES: Case[] = []');
  });

  it('磁盘上的生成文件与渲染器逐字一致——手改会在 CI 现形', () => {
    // 两个收割入口（设置页按钮 / 命令行脚本）都产这份文件，所以「文件就是渲染器
    // 的输出」是它们互相信得过的唯一前提；手改它等于让两条入口分家。
    const onDisk = readFileSync(new URL('../insertionCorpusHarvested.ts', import.meta.url), 'utf8');
    expect(onDisk).toBe(renderHarvestedModule(HARVESTED_CASES));
    // 而那个文件确实被 import 进来了（HARVESTED_CASES 从它来），所以「渲染器
    // 的输出是可编译模块」不是推测。
  });
});
