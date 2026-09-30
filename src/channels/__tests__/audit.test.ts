import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ChannelAuditLog, hashId } from '../audit';

interface Row {
  ts: number;
  channelId: string;
  peerHash: string;
  decision: string;
  tool?: string;
  argsHash?: string;
  text?: string;
  textLength?: number;
}

describe('ChannelAuditLog', () => {
  let dir: string;
  let path: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'pure-audit-'));
    path = join(dir, 'audit.jsonl');
  });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  function rows(): Row[] {
    if (!existsSync(path)) return [];
    return readFileSync(path, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line) as Row);
  }

  it('never stores the raw peer id or the message text by default', () => {
    const audit = new ChannelAuditLog({ path, now: () => 42, log: () => {} });
    audit.record({ channelId: 'feishu', peerId: 'oc_secret', sessionKey: 'feishu:main:dm:oc_secret', decision: 'routed', text: '机密内容', textLength: 4 });
    const [row] = rows();
    expect(row.ts).toBe(42);
    expect(row.peerHash).toBe(hashId('oc_secret'));
    expect(row.peerHash).not.toContain('oc_secret');
    expect(row.text).toBeUndefined();
    expect(row.textLength).toBe(4);
    expect(JSON.stringify(row)).not.toContain('机密内容');
  });

  it('includes the text only in full mode', () => {
    const audit = new ChannelAuditLog({ path, full: true, now: () => 1, log: () => {} });
    audit.record({ channelId: 'feishu', peerId: 'p', decision: 'routed', text: 'hello' });
    expect(rows()[0].text).toBe('hello');
  });

  it('defaults full mode from PURE_CHANNEL_AUDIT', () => {
    const previous = process.env.PURE_CHANNEL_AUDIT;
    process.env.PURE_CHANNEL_AUDIT = 'full';
    try {
      const audit = new ChannelAuditLog({ path, now: () => 1, log: () => {} });
      expect(audit.full).toBe(true);
    } finally {
      if (previous === undefined) delete process.env.PURE_CHANNEL_AUDIT;
      else process.env.PURE_CHANNEL_AUDIT = previous;
    }
  });

  it('records tool and args hash for approval decisions', () => {
    const audit = new ChannelAuditLog({ path, now: () => 7, log: () => {} });
    audit.record({ channelId: 'feishu', peerId: 'p', decision: 'approved', tool: 'write_file', argsHash: hashId('/tmp/a.txt') });
    const [row] = rows();
    expect(row.decision).toBe('approved');
    expect(row.tool).toBe('write_file');
    expect(row.argsHash).toBe(hashId('/tmp/a.txt'));
  });

  it('appends one JSON object per line', () => {
    const audit = new ChannelAuditLog({ path, now: () => 1, log: () => {} });
    audit.record({ channelId: 'a', peerId: 'p', decision: 'routed' });
    audit.record({ channelId: 'a', peerId: 'p', decision: 'denied' });
    expect(rows()).toHaveLength(2);
  });
});
