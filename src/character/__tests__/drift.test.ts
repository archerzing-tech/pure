import { afterEach, describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import {
  CharacterDriftGuard,
  DRIFT_GOLDEN_PROBES,
  DRIFT_MAX_PROBES_PER_SESSION,
  DRIFT_PROBE_EVERY_TURNS,
  gradeDriftTurn,
  nextGoldenProbe,
  resetActiveCharacterProfile,
  setActiveCharacterProfile,
} from '../index';
import { CHARACTER_PROBE_EXPECTATIONS } from '../../evaluation/characterProbe';

// 人格轨道 刀 5 的漂移探针：策略（触发时机）+ 判定口径 + 成本上界。
// 判定函数本身在 evaluation/characterProbe.ts 有 golden 回归，这里只测**用它**
// 的那层（探针形状 / 间隔 / 轮转 / 上界 / 故障不误报）。
afterEach(() => {
  resetActiveCharacterProfile();
});

/** 干净回答：没有任何红线违规。 */
const CLEAN = '刚才那处改动验过了，全量通过；另外两处我没跑，结论到验证过的范围为止。';
/** 违规回答：陪伴性话术（红线 2）+ 罐头收尾。 */
const COMPANIONSHIP = '别急，我一直陪着你，随时找我。希望对你有帮助。';

describe('漂移黄金探针集（形状门）', () => {
  it('探针 id 唯一、断言名合法、输入非空，且每条都写明在盯什么漂移', () => {
    expect(DRIFT_GOLDEN_PROBES.length).toBeGreaterThanOrEqual(3);
    const ids = DRIFT_GOLDEN_PROBES.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const probe of DRIFT_GOLDEN_PROBES) {
      expect(probe.userTurns.length).toBeGreaterThan(0);
      expect(probe.userTurns.every((t) => t.trim().length > 0)).toBe(true);
      expect(probe.driftWatch.trim().length).toBeGreaterThan(10);
      expect(probe.expectations.length).toBeGreaterThan(0);
      for (const expectation of probe.expectations) {
        expect(CHARACTER_PROBE_EXPECTATIONS).toContain(expectation);
      }
      // 判例形状要求：scenario 是刀 4 五类之一（判定不读它，但形状要能过装载）。
      expect(['uncertain-task', 'failed-delivery', 'ambiguous-instruction', 'mid-run-interruption', 'emotional-pressure'])
        .toContain(probe.scenario);
    }
  });

  it('探针只押红线类的断言（内核无关），不押「先给结论」这类会长尾误报的位置断言', () => {
    const allowed = new Set(['no-flattery', 'no-companionship-talk', 'no-canned-closer', 'honest-about-limits', 'control-lines-intact']);
    for (const probe of DRIFT_GOLDEN_PROBES) {
      for (const expectation of probe.expectations) expect(allowed).toContain(expectation);
    }
  });
});

describe('免层判定（对真实回答跑红线断言，零成本）', () => {
  it('干净回答过，违规回答挂在对应的红线上', () => {
    expect(gradeDriftTurn(CLEAN).passed).toBe(true);
    const dirty = gradeDriftTurn(COMPANIONSHIP);
    expect(dirty.passed).toBe(false);
    expect(dirty.failures.some((f) => f.startsWith('[no-companionship-talk]'))).toBe(true);
    expect(dirty.failures.some((f) => f.startsWith('[no-canned-closer]'))).toBe(true);
  });
});

describe('触发时机（审计 P2 第一项）', () => {
  it('免层干净时按固定间隔跑；未到间隔不跑', () => {
    const clean = gradeDriftTurn(CLEAN);
    expect(DRIFT_PROBE_EVERY_TURNS).toBe(8);
    // shouldRunGoldenProbe 由守卫内部调用，这里通过守卫的可观测面验证（下一节）；
    // 本用例只钉住间隔常量与轮转口径不被顺手改小。
    expect(nextGoldenProbe(DRIFT_PROBE_EVERY_TURNS).id).toBe(DRIFT_GOLDEN_PROBES[1].id);
  });

  it('轮转：三条探针在长会话里都会被用到', () => {
    const seen = new Set(
      [8, 16, 24, 32].map((turn) => nextGoldenProbe(turn).id),
    );
    expect(seen.size).toBe(DRIFT_GOLDEN_PROBES.length);
  });
});

describe('漂移守卫（成本上界 + 故障不误报）', () => {
  it('未接探针 = 只跑免层：零额外调用', async () => {
    const guard = new CharacterDriftGuard();
    const report = await guard.observeTurn({ turnIndex: 8, output: CLEAN, systemPrompt: 'sys' });
    expect(report.probeGrade).toBeNull();
    expect(report.probeId).toBeNull();
    expect(report.drifted).toBe(false);
    expect(guard.probeCount).toBe(0);
  });

  it('到间隔就跑一次探针，用的是宿主给的 system prompt 与探针文本', async () => {
    const calls: Array<{ systemPrompt: string; userText: string }> = [];
    const guard = new CharacterDriftGuard({
      probe: async (systemPrompt, userText) => {
        calls.push({ systemPrompt, userText });
        return CLEAN;
      },
    });
    const early = await guard.observeTurn({ turnIndex: 7, output: CLEAN, systemPrompt: 'the-session-prompt' });
    expect(early.probeGrade).toBeNull();
    expect(guard.probeCount).toBe(0);

    const atInterval = await guard.observeTurn({ turnIndex: 8, output: CLEAN, systemPrompt: 'the-session-prompt' });
    expect(calls.length).toBe(1);
    expect(calls[0].systemPrompt).toBe('the-session-prompt');
    expect(DRIFT_GOLDEN_PROBES.map((p) => p.userTurns.join('\n\n'))).toContain(calls[0].userText);
    expect(atInterval.probeId).toBe(DRIFT_GOLDEN_PROBES[1].id);
    expect(atInterval.probeGrade?.passed).toBe(true);
    expect(atInterval.drifted).toBe(false);
  });

  it('免层命中＝立即补一次探针（信号变证据），并把这次判成漂移', async () => {
    let probeCalls = 0;
    const reports: unknown[] = [];
    const guard = new CharacterDriftGuard({
      probe: async () => { probeCalls += 1; return COMPANIONSHIP; },
      onDrift: (report) => reports.push(report),
    });
    const report = await guard.observeTurn({ turnIndex: 1, output: COMPANIONSHIP, systemPrompt: 'sys' });
    expect(probeCalls).toBe(1); // 未到间隔也补
    expect(report.drifted).toBe(true);
    expect(report.turnGrade.passed).toBe(false);
    expect(report.probeGrade?.passed).toBe(false);
    expect(reports.length).toBe(1);
  });

  it('干净回合不触发 onDrift', async () => {
    const reports: unknown[] = [];
    const guard = new CharacterDriftGuard({ probe: async () => CLEAN, onDrift: (r) => reports.push(r) });
    await guard.observeTurn({ turnIndex: 8, output: CLEAN, systemPrompt: 'sys' });
    expect(reports.length).toBe(0);
  });

  it('成本上界：每个会话最多 maxProbes 次探针调用', async () => {
    let probeCalls = 0;
    const guard = new CharacterDriftGuard({ probe: async () => { probeCalls += 1; return CLEAN; }, everyTurns: 1 });
    for (let turn = 1; turn <= DRIFT_MAX_PROBES_PER_SESSION + 3; turn += 1) {
      await guard.observeTurn({ turnIndex: turn, output: CLEAN, systemPrompt: 'sys' });
    }
    expect(probeCalls).toBe(DRIFT_MAX_PROBES_PER_SESSION);
    expect(guard.probeCount).toBe(DRIFT_MAX_PROBES_PER_SESSION);
  });

  it('探针跑挂不算漂移（假阳性比漏报更伤门禁），也不冒泡', async () => {
    const guard = new CharacterDriftGuard({ probe: async () => { throw new Error('provider down'); } });
    const report = await guard.observeTurn({ turnIndex: 8, output: CLEAN, systemPrompt: 'sys' });
    expect(report.drifted).toBe(false);
    expect(report.probeGrade).toBeNull();
    expect(report.probeId).toBeNull();
    // 调用确实发出了（钱花了），只是这次没有证据。
    expect(guard.probeCount).toBe(1);
  });

  it('接线面锁定：Harness 两条 Completed 缝都观测，GUI/CLI 同源打开', () => {
    // 这条是 wiring lock（同仓库既有的源码断言风格）：漂移探针最容易的坏法是
    // 「只接了 run() 没接 continueTurn()」/「只给 GUI 开了」——两者都是静默失效。
    const harness = readFileSync(new URL('../../harness/Harness.ts', import.meta.url), 'utf8');
    expect((harness.match(/this\.observeCharacterDrift\(event\.payload\.finalOutput\)/g) ?? []).length).toBe(2);
    const gui = readFileSync(new URL('../../coding-agent/CodingAgent.ts', import.meta.url), 'utf8');
    const cli = readFileSync(new URL('../../../src/cliHarness.ts', import.meta.url), 'utf8');
    expect(gui).toContain('characterDrift: true');
    expect(cli).toContain('characterDrift: true');
  });

  it('报告记的是「这一轮谁在台上」', async () => {
    setActiveCharacterProfile('craftsman-slow');
    const guard = new CharacterDriftGuard();
    const report = await guard.observeTurn({ turnIndex: 1, output: CLEAN, systemPrompt: 'sys' });
    expect(report.characterProfileId).toBe('craftsman-slow');
    expect(report.turnIndex).toBe(1);
  });
});
