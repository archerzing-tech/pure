import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Gateway } from '../gateway';
import { ChannelRegistry } from '../registry';
import { ChannelSessionIndex } from '../sessionIndex';
import { defaultChannelsConfig } from '../config';
import { GatewayLockError } from '../lock';
import { PairingGate } from '../pairing';
import { PeerRateLimiter } from '../limits';
import type { BuildSessionSpec, ChannelHarness, HarnessBundle } from '../agentSession';
import type { ChannelAdapter, ChannelRuntimeContext, InboundEvent, OutboundMessage } from '../types';

interface FakeRecord { stopped: boolean; ctx?: ChannelRuntimeContext; sent: OutboundMessage[] }

function fakeAdapter(record: FakeRecord): ChannelAdapter {
  return {
    id: 'fake',
    capabilities: { chatTypes: ['dm'], media: {}, streaming: 'none', maxTextLength: 4000, markdown: 'none' },
    async send(_t, msg) { record.sent.push(msg); return { messageId: `m${record.sent.length}` }; },
    async start(ctx) { record.ctx = ctx; },
    async stop() { record.stopped = true; },
    listAccountIds() { return ['default']; },
  };
}

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('Gateway', () => {
  let dir: string;
  let lockPath: string;
  let indexPath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'pure-chgw-'));
    lockPath = join(dir, 'gateway.lock');
    indexPath = join(dir, 'sessions.json');
  });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  function makeGateway(record: FakeRecord, specs: BuildSessionSpec[], pairing?: PairingGate, limiter?: PeerRateLimiter) {
    const registry = new ChannelRegistry({ log: () => {} });
    registry.register(fakeAdapter(record));
    return new Gateway({
      config: defaultChannelsConfig(),
      pairing,
      limiter,
      registry,
      factory: async (spec) => {
        specs.push(spec);
        const harness: ChannelHarness = {
          async *run(_s, user) {
            yield { type: 'Completed', payload: { finalOutput: `ok:${user}`, isComplete: true, interrupted: false, turnCount: 1, messages: [] }, timestamp: 0 };
          },
          async *continueTurn(_s, _m, user) {
            yield { type: 'Completed', payload: { finalOutput: `ok:${user}`, isComplete: true, interrupted: false, turnCount: 1, messages: [] }, timestamp: 0 };
          },
        };
        return { harness, systemPrompt: 'sys', sessionId: spec.sessionId, projectPath: '' } satisfies HarnessBundle;
      },
      lockPath,
      index: new ChannelSessionIndex(indexPath),
      evictionIntervalMs: 0,
      log: () => {},
    });
  }

  function inbound(messageId: string): InboundEvent {
    return { kind: 'message', channelId: 'fake', accountId: 'default', peer: { id: 'p1', kind: 'dm' }, messageId, text: 'hi', attachments: [], receivedAt: 0 };
  }

  it('refuses a second instance while one holds the lock', async () => {
    const first = makeGateway({ stopped: false, sent: [] }, []);
    const second = makeGateway({ stopped: false, sent: [] }, []);
    await first.start();
    await expect(second.start()).rejects.toBeInstanceOf(GatewayLockError);
    await first.stop();
  });

  it('releases the lock and stops adapters on stop', async () => {
    const record: FakeRecord = { stopped: false, sent: [] };
    const gateway = makeGateway(record, []);
    await gateway.start();
    expect(existsSync(lockPath)).toBe(true);
    await gateway.stop();
    expect(record.stopped).toBe(true);
    expect(existsSync(lockPath)).toBe(false);
  });

  it('rate-limits a peer and answers with a notice instead of a turn', async () => {
    const record: FakeRecord = { stopped: false, sent: [] };
    const specs: BuildSessionSpec[] = [];
    const gateway = makeGateway(record, specs, undefined, new PeerRateLimiter({ perMinute: 1 }));
    await gateway.start();
    record.ctx!.onInbound(inbound('r1'));
    await delay(40);
    record.ctx!.onInbound(inbound('r2'));
    await delay(40);
    expect(specs).toHaveLength(1);
    expect(record.sent.some((m) => m.kind === 'notice' && m.text.includes('太频'))).toBe(true);
    await gateway.stop();
  });

  it('dedupes repeated platform pushes by message id', async () => {
    const record: FakeRecord = { stopped: false, sent: [] };
    const specs: BuildSessionSpec[] = [];
    const gateway = makeGateway(record, specs);
    await gateway.start();
    record.ctx!.onInbound(inbound('same-id'));
    await delay(50);
    record.ctx!.onInbound(inbound('same-id'));
    await delay(50);
    expect(specs).toHaveLength(1);
    expect(record.sent.filter((m) => m.kind === 'final')).toHaveLength(1);
    await gateway.stop();
  });

  it('blocks unpaired dms, sends a pairing notice, then routes after approve', async () => {
    const record: FakeRecord = { stopped: false, sent: [] };
    const specs: BuildSessionSpec[] = [];
    const gate = new PairingGate({ pendingPath: join(dir, 'pending.json'), peersPath: join(dir, 'peers.json'), log: () => {} });
    const gateway = makeGateway(record, specs, gate);
    await gateway.start();

    record.ctx!.onInbound(inbound('dm-1'));
    await delay(60);
    expect(specs).toHaveLength(0);
    expect(record.sent.some((m) => m.kind === 'notice' && m.text.includes('pure channels approve'))).toBe(true);

    gate.approve(gate.listPending()[0].code);
    record.ctx!.onInbound(inbound('dm-2'));
    await delay(60);
    expect(specs).toHaveLength(1);
    await gateway.stop();
  });

  it('processes distinct messages', async () => {
    const record: FakeRecord = { stopped: false, sent: [] };
    const specs: BuildSessionSpec[] = [];
    const gateway = makeGateway(record, specs);
    await gateway.start();
    record.ctx!.onInbound(inbound('a'));
    record.ctx!.onInbound(inbound('b'));
    await delay(80);
    expect(record.sent.filter((m) => m.kind === 'final')).toHaveLength(2);
    await gateway.stop();
  });
});
