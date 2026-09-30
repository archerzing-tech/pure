import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PairingGate, pairingNotice } from '../pairing';

describe('PairingGate', () => {
  let dir: string;
  let pendingPath: string;
  let peersPath: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'pure-pairing-'));
    pendingPath = join(dir, 'pending-pairings.json');
    peersPath = join(dir, 'peers.json');
  });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  function gate() {
    return new PairingGate({ pendingPath, peersPath, log: () => {} });
  }

  it('lets everyone through under the open policy', () => {
    expect(gate().check('feishu', 'oc_1', 'open').allowed).toBe(true);
  });

  it('refuses unpaired peers under allowlist without issuing a code', () => {
    const check = gate().check('feishu', 'oc_1', 'allowlist');
    expect(check.allowed).toBe(false);
    expect(check.code).toBeUndefined();
  });

  it('issues one stable code per peer under pairing', () => {
    const g = gate();
    const first = g.check('feishu', 'oc_1', 'pairing', 'Ann');
    const second = g.check('feishu', 'oc_1', 'pairing', 'Ann');
    expect(first.allowed).toBe(false);
    expect(first.isNew).toBe(true);
    expect(first.code).toBeTruthy();
    expect(second.code).toBe(first.code);
    expect(second.isNew).toBeFalsy();
    expect(g.listPending()).toHaveLength(1);
  });

  it('approves a code into the peer list and persists across instances', () => {
    const g = gate();
    const { code } = g.check('feishu', 'oc_1', 'pairing', 'Ann');
    const peer = g.approve(code!);
    expect(peer).toMatchObject({ channelId: 'feishu', peerId: 'oc_1', name: 'Ann' });

    const restarted = gate();
    expect(restarted.isPaired('feishu', 'oc_1')).toBe(true);
    expect(restarted.check('feishu', 'oc_1', 'pairing').allowed).toBe(true);
    expect(restarted.listPending()).toHaveLength(0);
  });

  it('picks up an approval written by ANOTHER process without restart', () => {
    // 真实场景：gateway 常驻持有 PairingGate，用户在另一个终端跑
    // `pure channels approve`——只改磁盘文件。gateway 的下一次决策必须看到它。
    const gw = gate();
    const requester = gate();
    const { code } = requester.check('feishu', 'oc_9', 'pairing');
    expect(gw.check('feishu', 'oc_9', 'pairing').allowed).toBe(false);

    const approver = gate();
    expect(approver.approve(code!)).not.toBeNull();

    // mtime 精度足够时同毫秒内也可能不触发；显式 bump 保证 mtime 变化。
    const now = Date.now() / 1000 + 5;
    try { require('node:fs').utimesSync(peersPath, now, now); } catch { /* best-effort */ }

    expect(gw.isPaired('feishu', 'oc_9')).toBe(true);
    expect(gw.check('feishu', 'oc_9', 'pairing').allowed).toBe(true);
  });

  it('accepts a lower-case code and rejects unknown ones', () => {
    const g = gate();
    const { code } = g.check('feishu', 'oc_1', 'pairing');
    expect(g.approve(code!.toLowerCase())).not.toBeNull();
    expect(g.approve('NOPE1234')).toBeNull();
  });

  it('revokes a paired peer', () => {
    const g = gate();
    const { code } = g.check('feishu', 'oc_1', 'pairing');
    g.approve(code!);
    expect(g.revoke('feishu', 'oc_1')).toBe(true);
    expect(g.isPaired('feishu', 'oc_1')).toBe(false);
    expect(g.revoke('feishu', 'oc_1')).toBe(false);
  });

  it('explains how to approve in the notice text', () => {
    expect(pairingNotice('ABCD1234')).toContain('pure channels approve ABCD1234');
  });
});
