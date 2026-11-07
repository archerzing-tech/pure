// src/shared/network/__tests__/ledger.test.ts
// P0a 账本契约测试：入账形状、EWMA 口径、TTL、cache 拒收、合并语义。
// 进程级单例每用例清场（flaky-quartet 判例）。

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { GlobalRegistrator } from '@happy-dom/global-registrator';
import type { Attempt, Destination, Stat } from '../types';

let ledger: typeof import('../ledger');
let types: typeof import('../types');

beforeAll(async () => {
  GlobalRegistrator.register();
  ledger = await import('../ledger');
  types = await import('../types');
});

beforeEach(() => ledger.resetNetLedgerForTests());
afterAll(() => GlobalRegistrator.unregister());

const llmDest = (key = 'open.bigmodel.cn'): Destination => ({
  key,
  class: 'llm-api',
  idempotent: false,
  replayable: true,
  mirrorable: false,
  expect: 'stream',
});

const attempt = (over: Partial<Attempt> = {}): Attempt => ({
  transport: 'direct',
  ok: true,
  ms: 200,
  msScope: 'headers',
  ...over,
});

describe('netLedger record/read', () => {
  it('records an attempt and reads it back on both scopes', () => {
    ledger.recordAttempt(llmDest(), attempt({ ms: 100 }));
    const snap = ledger.ledgerSnapshot();
    expect(snap.host['open.bigmodel.cn']?.direct?.n).toBe(1);
    expect(snap.host['open.bigmodel.cn']?.direct?.ok).toBe(1);
    expect(snap.host['open.bigmodel.cn']?.direct?.headersEwma).toBe(100);
    expect(snap.class['llm-api']?.direct?.n).toBe(1);
    expect(ledger.hostStat(snap, 'open.bigmodel.cn', 'direct')).toBeDefined();
    expect(ledger.classStat(snap, 'llm-api', 'direct')).toBeDefined();
  });

  it('ewma is α=0.3 over successive header samples', () => {
    ledger.recordAttempt(llmDest(), attempt({ ms: 100 }));
    ledger.recordAttempt(llmDest(), attempt({ ms: 300 }));
    const ewma = ledger.ledgerSnapshot().host['open.bigmodel.cn']?.direct?.headersEwma!;
    expect(ewma).toBeCloseTo(100 * 0.7 + 300 * 0.3, 5);
  });

  it('total-scope and failed samples do NOT pollute headersEwma (but count in n/ok)', () => {
    ledger.recordAttempt(llmDest(), attempt({ ms: 100 }));
    ledger.recordAttempt(llmDest(), attempt({ ms: 5000, msScope: 'total' })); // body 传输慢不代表路慢
    ledger.recordAttempt(llmDest(), attempt({ ok: false, ms: 9000 }));
    const s = ledger.ledgerSnapshot().host['open.bigmodel.cn']?.direct!;
    expect(s.n).toBe(3);
    expect(s.ok).toBe(2); // 两个成功样本（100 headers + 5000 total）都算 ok
    expect(s.headersEwma).toBe(100); // 但只有首个 headers 口径样本入 EWMA
  });

  it('cache transport is refused outright (invariant 2: cache never produces evidence)', () => {
    ledger.recordAttempt(llmDest(), attempt({ transport: 'cache', ms: 1 }));
    expect(ledger.ledgerSnapshot().host['open.bigmodel.cn']).toBeUndefined();
    expect(ledger.ledgerSnapshot().class['llm-api']).toBeUndefined();
  });

  it('malformed samples (negative/NaN ms) are refused', () => {
    ledger.recordAttempt(llmDest(), attempt({ ms: -5 }));
    ledger.recordAttempt(llmDest(), attempt({ ms: Number.NaN }));
    expect(ledger.ledgerSnapshot().host['open.bigmodel.cn']).toBeUndefined();
  });

  it('local-class destinations never enter the ledger (invariant 6)', () => {
    ledger.recordAttempt({ ...llmDest('127.0.0.1'), class: 'local' }, attempt());
    const snap = ledger.ledgerSnapshot();
    expect(snap.host['127.0.0.1']).toBeUndefined();
    expect(snap.class['local']).toBeUndefined();
  });

  it('stale rows (no successful sample within TTL) read as undefined', () => {
    const t0 = 1_700_000_000_000;
    ledger.recordAttempt(llmDest(), attempt({ ok: false, ms: 100 }), t0); // 只有失败样本
    let snap = ledger.ledgerSnapshot();
    expect(ledger.hostStat(snap, 'open.bigmodel.cn', 'direct', t0 + 1000)).toBeUndefined();
    ledger.recordAttempt(llmDest(), attempt({ ms: 100 }), t0);
    snap = ledger.ledgerSnapshot();
    expect(ledger.hostStat(snap, 'open.bigmodel.cn', 'direct', t0 + 1000)).toBeDefined();
    expect(ledger.hostStat(snap, 'open.bigmodel.cn', 'direct', t0 + ledger.LEDGER_ENTRY_TTL_MS + 1)).toBeUndefined();
  });
});

describe('netLedger merge semantics', () => {
  it('field-level merge: remote wins on ewma, deadUntil takes the max', () => {
    const local: Stat = { n: 5, ok: 4, headersEwma: 300, deadUntil: 1000, lastOkAt: 50 };
    const remote: Stat = { n: 3, ok: 3, headersEwma: 900, deadUntil: 5000, lastOkAt: 40 };
    const m = ledger.mergeStat(local, remote)!;
    expect(m.headersEwma).toBe(900); // 远端是最后写者
    expect(m.deadUntil).toBe(5000); // 旧快照较晚的死期压过新快照已过期的——防死路复活
    expect(m.lastOkAt).toBe(50);
    expect(m.n).toBe(5);
  });

  it('merge handles missing sides and zero deadUntil honestly', () => {
    expect(ledger.mergeStat(undefined, { n: 1, ok: 1 })).toEqual({ n: 1, ok: 1 });
    const onlyLocal = ledger.mergeStat({ n: 2, ok: 1, deadUntil: 100 }, undefined)!;
    expect(onlyLocal.deadUntil).toBe(100);
    const noDead = ledger.mergeStat({ n: 1, ok: 1 }, { n: 1, ok: 1 })!;
    expect(noDead.deadUntil).toBeUndefined();
  });
});

describe('failureFromNetGuardClass mapping', () => {
  it('maps the guard classes onto Attempt failure families', () => {
    expect(ledger.failureFromNetGuardClass('dns')).toBe('dns');
    expect(ledger.failureFromNetGuardClass('timeout')).toBe('tcp');
    expect(ledger.failureFromNetGuardClass('hijack')).toBe('hijack');
    expect(ledger.failureFromNetGuardClass('auth')).toBe('policy');
    expect(ledger.failureFromNetGuardClass('context')).toBeUndefined(); // 对话超窗不是路的错
    expect(ledger.failureFromNetGuardClass('generic')).toBe('http');
  });
});
