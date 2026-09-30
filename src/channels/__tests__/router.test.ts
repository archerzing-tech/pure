import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildSessionKey, isAddressed, SessionRouter } from '../router';
import { ChannelApprovalBroker } from '../approvals';
import { ChannelSessionIndex } from '../sessionIndex';
import { defaultChannelsConfig } from '../config';
import type { ChannelCapabilities, InboundEvent, OutboundMessage } from '../types';
import type { BuildSessionSpec, ChannelHarness, HarnessBundle } from '../agentSession';
import type { EngineEvent } from '../../shared/types';

const CAPS: ChannelCapabilities = { chatTypes: ['dm', 'group'], media: {}, streaming: 'edit', maxTextLength: 4000, markdown: 'basic', requiresMentionInGroup: true };

function inbound(overrides: Partial<InboundEvent> = {}): InboundEvent {
  return {
    kind: 'message',
    channelId: 'webchat',
    accountId: 'default',
    peer: { id: 'p1', kind: 'dm' },
    messageId: `m${Math.random()}`,
    text: 'hello',
    attachments: [],
    receivedAt: 0,
    ...overrides,
  };
}

function completed(text: string): EngineEvent {
  return { type: 'Completed', payload: { finalOutput: text, isComplete: true, interrupted: false, turnCount: 1, messages: [] }, timestamp: 0 };
}

describe('router helpers', () => {
  it('builds a per-channel-peer session key with an optional thread', () => {
    expect(buildSessionKey(inbound())).toBe('webchat:default:dm:p1');
    expect(buildSessionKey(inbound({ peer: { id: '-100', kind: 'group' }, threadId: '7' }))).toBe('webchat:default:group:-100:7');
  });

  it('detects addressed group messages', () => {
    expect(isAddressed('@bot please help')).toBe(true);
    expect(isAddressed('/help')).toBe(true);
    expect(isAddressed('just chatting')).toBe(false);
  });
});

describe('SessionRouter', () => {
  let dir: string;
  let index: ChannelSessionIndex;
  let specs: BuildSessionSpec[];
  let frames: OutboundMessage[];
  let deliveredTargets: string[];

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'pure-chrouter-'));
    index = new ChannelSessionIndex(join(dir, 'sessions.json'));
    specs = [];
    frames = [];
    deliveredTargets = [];
  });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  function makeRouter(overrides: Partial<ConstructorParameters<typeof SessionRouter>[0]> = {}) {
    const config = defaultChannelsConfig();
    config.groupPolicy.mentionRequired = true;
    const broker = new ChannelApprovalBroker(async () => {}, { timeoutMs: 50 });
    const router = new SessionRouter({
      config,
      factory: async (spec) => {
        specs.push(spec);
        const harness: ChannelHarness = {
          async *run(_sys, user) { yield completed(`echo:${user}`); },
          async *continueTurn(_sys, _msgs, user) { yield completed(`echo:${user}`); },
        };
        return { harness, systemPrompt: 'sys', sessionId: spec.sessionId, projectPath: spec.workspace ?? '' } satisfies HarnessBundle;
      },
      capabilitiesFor: () => CAPS,
      broker,
      deliver: async (_c, target, message) => { frames.push(message); deliveredTargets.push(target.peerId); return 'm1'; },
      index,
      log: () => {},
      ...overrides,
    });
    return { router, broker, config };
  }

  it('runs a dm turn and delivers a final frame', async () => {
    const { router } = makeRouter();
    await router.handle(inbound({ text: 'hi there' }));
    expect(specs).toHaveLength(1);
    expect(frames.some((f) => f.kind === 'final' && f.text === 'echo:hi there')).toBe(true);
    expect(router.sessionCount).toBe(1);
  });

  it('drops group messages that do not address the bot', async () => {
    const { router } = makeRouter();
    await router.handle(inbound({ peer: { id: 'g1', kind: 'group' }, text: 'unrelated chatter' }));
    expect(specs).toHaveLength(0);
    expect(router.sessionCount).toBe(0);
  });

  it('answers group messages that mention the bot', async () => {
    const { router } = makeRouter();
    await router.handle(inbound({ peer: { id: 'g1', kind: 'group' }, text: '@bot summarize this' }));
    expect(specs).toHaveLength(1);
  });

  it('uses the binding workspace and permission mode', async () => {
    const { router, config } = makeRouter();
    config.bindings = [{ match: { channel: 'webchat', peer: 'p1' }, workspace: '/w', permissionMode: 'NORMAL', toolProfile: 'coding' }];
    await router.handle(inbound({ text: 'work' }));
    expect(specs[0].workspace).toBe('/w');
    expect(specs[0].permissionMode).toBe('NORMAL');
    expect(specs[0].toolProfile).toBe('coding');
  });

  it('reuses a persisted session id after a restart', async () => {
    index.set('webchat:default:dm:p1', { sessionId: 'chan_existing', lastActivityAt: 0, workspace: null });
    const { router } = makeRouter();
    await router.handle(inbound({ text: 'continue' }));
    expect(specs[0].sessionId).toBe('chan_existing');
  });

  it('consumes an approval reply instead of starting a turn', async () => {
    const { router, broker } = makeRouter();
    const decision = broker.request({ accountId: 'default', peerId: 'p1', peerKind: 'dm' }, 'webchat:default:dm:p1', { tool: 'write_file', description: 'd', dangerLevel: 'caution', riskLevel: 'medium' });
    await router.handle(inbound({ text: 'y' }));
    expect(specs).toHaveLength(0);
    expect((await decision).allowed).toBe(true);
  });

  it('serializes two turns on the same session', async () => {
    const { router } = makeRouter();
    await Promise.all([router.handle(inbound({ text: 'first' })), router.handle(inbound({ text: 'second' }))]);
    expect(specs).toHaveLength(1);
    const finals = frames.filter((f) => f.kind === 'final').map((f) => f.text);
    expect(finals).toEqual(['echo:first', 'echo:second']);
  });

  it('evicts an idle session and stops it', async () => {
    const { router } = makeRouter();
    await router.handle(inbound({ text: 'hi' }));
    const evicted = await router.evictIdle(Date.now() + 60_000, 1000);
    expect(evicted).toEqual(['webchat:default:dm:p1']);
    expect(router.sessionCount).toBe(0);
  });
});
