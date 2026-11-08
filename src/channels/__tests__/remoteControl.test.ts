// 手机遥控面测试：控制词解析、附着注册表（含持久化与快照 TTL）、
// /sessions /attach /detach /status 的磁盘事实渲染，以及 router 挂缝的拦截语义。
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseControlCommand, RemoteControl } from '../remoteControl';
import { AttachRegistry } from '../remoteControl';
import { SessionRouter } from '../router';
import { ChannelApprovalBroker } from '../approvals';
import { ChannelSessionIndex } from '../sessionIndex';
import { defaultChannelsConfig } from '../config';
import type { ChannelCapabilities, InboundEvent, OutboundMessage } from '../types';
import type { BuildSessionSpec, ChannelHarness, HarnessBundle } from '../agentSession';
import type { EngineEvent } from '../../shared/types';

const CAPS: ChannelCapabilities = { chatTypes: ['dm', 'group'], media: {}, streaming: 'none', maxTextLength: 4000, markdown: 'none' };

function inbound(text: string, overrides: Partial<InboundEvent> = {}): InboundEvent {
  return {
    kind: 'message',
    channelId: 'qq',
    accountId: 'default',
    peer: { id: 'p1', kind: 'dm' },
    messageId: `m${Math.random()}`,
    text,
    attachments: [],
    receivedAt: 0,
    ...overrides,
  };
}

describe('parseControlCommand', () => {
  it('recognizes the five control words with optional args (case-insensitive)', () => {
    expect(parseControlCommand('/sessions')).toEqual({ kind: 'sessions' });
    expect(parseControlCommand('  /STATUS 2 ')).toEqual({ kind: 'status', target: '2' });
    expect(parseControlCommand('/attach 3')).toEqual({ kind: 'attach', target: '3' });
    expect(parseControlCommand('/Detach')).toEqual({ kind: 'detach' });
    expect(parseControlCommand('/stop')).toEqual({ kind: 'stop' });
    expect(parseControlCommand('/status')).toEqual({ kind: 'status' });
  });

  it('returns null for non-commands and unknown slash words', () => {
    expect(parseControlCommand('帮我跑个测试')).toBeNull();
    expect(parseControlCommand('/unknown cmd')).toBeNull();
    expect(parseControlCommand('运行 /status 看看')).toBeNull();
  });
});

describe('AttachRegistry', () => {
  it('attaches, swaps, detaches and lists chats for a session', () => {
    const registry = new AttachRegistry();
    registry.attach('qq:default:dm:a', 'session_1');
    registry.attach('qq:default:dm:b', 'session_1');
    expect(registry.attachedSession('qq:default:dm:a')).toBe('session_1');
    expect(registry.chatsFor('session_1').sort()).toEqual(['qq:default:dm:a', 'qq:default:dm:b']);
    registry.attach('qq:default:dm:a', 'session_2');
    expect(registry.chatsFor('session_1')).toEqual(['qq:default:dm:b']);
    expect(registry.detach('qq:default:dm:a')).toBe('session_2');
    expect(registry.detach('qq:default:dm:a')).toBeUndefined();
  });

  it('persists attaches across instances but keeps snapshots in memory', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pure-attach-'));
    try {
      const path = join(dir, 'attach.json');
      let clock = 1000;
      const first = new AttachRegistry(path, () => clock);
      first.rememberSnapshot('qq:default:dm:a', ['session_1', 'session_2']);
      first.attach('qq:default:dm:a', 'session_1');
      expect(first.resolveIndex('qq:default:dm:a', '2')).toBe('session_2');

      const second = new AttachRegistry(path, () => clock);
      expect(second.attachedSession('qq:default:dm:a')).toBe('session_1');
      expect(second.resolveIndex('qq:default:dm:a', '1')).toBeUndefined();

      clock += 11 * 60_000;
      expect(first.resolveIndex('qq:default:dm:a', '2')).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

function makePureDir(): string {
  return mkdtempSync(join(tmpdir(), 'pure-remote-'));
}

function seedGuiSession(pureDir: string, id: string, opts: { title?: string; settled?: boolean; text?: string; ts?: number }): void {
  const dir = join(pureDir, 'sessions', id);
  mkdirSync(dir, { recursive: true });
  const ts = opts.ts ?? 1_700_000_000_000;
  const events: Array<Record<string, unknown>> = [
    { ts, kind: 'user_input', actor: 'gui', origin: { surface: 'gui' }, payload: { text: opts.text ?? '把测试跑一下' } },
  ];
  if (opts.settled) {
    events.push({ ts: ts + 3000, kind: 'turn_settled', actor: 'gui', payload: { totalMs: 3200, failed: false } });
  }
  writeFileSync(join(dir, 'events.jsonl'), events.map((e) => JSON.stringify(e)).join('\n') + '\n', 'utf8');
  if (opts.title) {
    const indexPath = join(pureDir, 'sessions', 'index.json');
    let metas: Array<{ id: string; title: string }> = [];
    try {
      metas = JSON.parse(readFileSync(indexPath, 'utf8')) as Array<{ id: string; title: string }>;
    } catch {
      metas = [];
    }
    metas.push({ id, title: opts.title });
    writeFileSync(indexPath, JSON.stringify(metas), 'utf8');
  }
}

describe('RemoteControl', () => {
  let pureDir: string;
  let control: RemoteControl;
  let now: number;

  beforeEach(() => {
    pureDir = makePureDir();
    now = 1_700_000_400_000;
    control = new RemoteControl({ pureDir, now: () => now });
  });
  afterEach(() => rmSync(pureDir, { recursive: true, force: true }));

  it('returns null for plain messages', async () => {
    expect(await control.handle(inbound('跑个测试'), 'qq:default:dm:p1')).toBeNull();
  });

  it('/sessions lists disk views with titles and remembers the snapshot', async () => {
    seedGuiSession(pureDir, 'session_aaa', { title: '重构错误台账', settled: true, ts: now - 120_000 });
    seedGuiSession(pureDir, 'session_bbb', { text: '生成日报', ts: now - 60_000 });
    const reply = await control.handle(inbound('/sessions'), 'qq:default:dm:p1');
    expect(reply?.kind).toBe('notice');
    expect(reply?.text).toContain('pure 会话（共 2 个 · 1 个跑动中）');
    expect(reply?.text).toContain('重构错误台账');
    // 无标题会话按设计用会话 id 兜底（标题只有 index.json 里的才有）。
    expect(reply?.text).toContain('1. session_bbb · ▶ 跑动中');
    expect(reply?.text).toContain('2. 重构错误台账');
    // 编号可被随后的 /attach /status 引用。
    // session_bbb 无标题，按 id 兜底。
    expect((await control.handle(inbound('/attach 1'), 'qq:default:dm:p1'))?.text).toContain('已附着');
    expect(control.registry.attachedSession('qq:default:dm:p1')).toBe('session_bbb');
  });

  it('/sessions with no sessions says so honestly', async () => {
    const reply = await control.handle(inbound('/sessions'), 'qq:default:dm:p1');
    expect(reply?.text).toContain('还没有会话记录');
  });

  it('/attach resolves snapshot indexes, tolerates raw ids, rejects stale or bad targets', async () => {
    seedGuiSession(pureDir, 'session_aaa', { title: '重构错误台账', settled: true });
    await control.handle(inbound('/sessions'), 'qq:default:dm:p1');
    expect((await control.handle(inbound('/attach 1'), 'qq:default:dm:p1'))?.text).toContain('已附着');
    expect((await control.handle(inbound('/attach session_raw1'), 'qq:default:dm:p1'))?.text).toContain('已改附到');
    expect((await control.handle(inbound('/attach 99'), 'qq:default:dm:p1'))?.text).toContain('无效');
    expect((await control.handle(inbound('/attach'), 'qq:default:dm:p1'))?.text).toContain('用法');
  });

  it('/detach reports honestly when nothing is attached', async () => {
    expect((await control.handle(inbound('/detach'), 'qq:default:dm:p1'))?.text).toContain('没有附着');
  });

  it('/status resolves attached session from disk timeline', async () => {
    seedGuiSession(pureDir, 'session_aaa', { title: '重构错误台账', settled: true, ts: now - 30_000 });
    await control.handle(inbound('/sessions'), 'qq:default:dm:p1');
    await control.handle(inbound('/attach 1'), 'qq:default:dm:p1');
    const reply = await control.handle(inbound('/status'), 'qq:default:dm:p1');
    expect(reply?.text).toContain('重构错误台账');
    expect(reply?.text).toContain('空闲');
    expect(reply?.text).toContain('回合落定');
  });

  it('/status without attach or index explains usage', async () => {
    expect((await control.handle(inbound('/status'), 'qq:default:dm:p1'))?.text).toContain('用法');
  });

  it('/stop tells the truth before the GUI bridge exists', async () => {
    seedGuiSession(pureDir, 'session_aaa', { title: '重构错误台账', settled: true });
    await control.handle(inbound('/sessions'), 'qq:default:dm:p1');
    await control.handle(inbound('/attach 1'), 'qq:default:dm:p1');
    const reply = await control.handle(inbound('/stop'), 'qq:default:dm:p1');
    expect(reply?.text).toContain('尚未接通');
  });

  it('/stop without attach points at /attach first', async () => {
    expect((await control.handle(inbound('/stop'), 'qq:default:dm:p1'))?.text).toContain('/attach');
  });

  it('attached chat plain messages reroute to inject, not the channel session', async () => {
    seedGuiSession(pureDir, 'session_aaa', { title: '重构错误台账', settled: true });
    const injected: Array<{ sessionId: string; text: string }> = [];
    const wired = new RemoteControl({
      pureDir,
      now: () => now,
      inject: async (sessionId, text) => {
        injected.push({ sessionId, text });
      },
    });
    await wired.handle(inbound('/sessions'), 'qq:default:dm:p1');
    await wired.handle(inbound('/attach 1'), 'qq:default:dm:p1');
    const reply = await wired.handle(inbound('方向不对，改成优先跑单测'), 'qq:default:dm:p1');
    expect(reply?.text).toContain('已送达');
    expect(injected).toEqual([{ sessionId: 'session_aaa', text: '方向不对，改成优先跑单测' }]);
  });

  it('attached chat inject fails honestly when the desktop is offline', async () => {
    seedGuiSession(pureDir, 'session_aaa', { title: '重构错误台账', settled: true });
    const wired = new RemoteControl({
      pureDir,
      now: () => now,
      inject: async () => {
        throw new Error('desktop offline');
      },
    });
    await wired.handle(inbound('/sessions'), 'qq:default:dm:p1');
    await wired.handle(inbound('/attach 1'), 'qq:default:dm:p1');
    const reply = await wired.handle(inbound('继续跑'), 'qq:default:dm:p1');
    expect(reply?.text).toContain('没能送达');
    expect(reply?.text).toContain('未执行');
  });

  it('unattached plain messages still pass through (null)', async () => {
    expect(await control.handle(inbound('普通消息'), 'qq:default:dm:p1')).toBeNull();
  });
});

describe('SessionRouter × RemoteControl', () => {
  let dir: string;
  let index: ChannelSessionIndex;
  let specs: BuildSessionSpec[];
  let frames: OutboundMessage[];

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'pure-chrouter-rc-'));
    index = new ChannelSessionIndex(join(dir, 'sessions.json'));
    specs = [];
    frames = [];
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  function makeRouter(control: RemoteControl | undefined) {
    const config = defaultChannelsConfig();
    const broker = new ChannelApprovalBroker(async () => {}, { timeoutMs: 50 });
    return new SessionRouter({
      config,
      factory: async (spec) => {
        specs.push(spec);
        const harness: ChannelHarness = {
          async *run(_sys, user) {
            yield { type: 'Completed', payload: { finalOutput: `echo:${user}`, isComplete: true, interrupted: false, turnCount: 1, messages: [] }, timestamp: 0 } as EngineEvent;
          },
          async *continueTurn(_sys, _msgs, user) {
            yield { type: 'Completed', payload: { finalOutput: `echo:${user}`, isComplete: true, interrupted: false, turnCount: 1, messages: [] }, timestamp: 0 } as EngineEvent;
          },
        };
        return { harness, systemPrompt: 'sys', sessionId: spec.sessionId, projectPath: spec.workspace ?? '' } satisfies HarnessBundle;
      },
      capabilitiesFor: () => CAPS,
      broker,
      deliver: async (_c, _t, message) => {
        frames.push(message);
        return 'm1';
      },
      index,
      log: () => {},
      remoteControl: control ? { handle: (i, k) => control.handle(i, k) } : undefined,
    });
  }

  it('intercepts control words without creating an agent session', async () => {
    const router = makeRouter(new RemoteControl({ pureDir: makePureDir() }));
    await router.handle(inbound('/sessions'));
    expect(frames).toHaveLength(1);
    expect(frames[0].kind).toBe('notice');
    expect(specs).toHaveLength(0);
    await router.stopAll();
    rmSync(join(dir, 'unused'), { recursive: true, force: true });
  });

  it('routes plain messages as before when control is wired', async () => {
    const pure = makePureDir();
    try {
      const router = makeRouter(new RemoteControl({ pureDir: pure }));
      await router.handle(inbound('hello'));
      expect(specs).toHaveLength(1);
      await router.stopAll();
    } finally {
      rmSync(pure, { recursive: true, force: true });
    }
  });

  it('routes everything as before when control is absent', async () => {
    const router = makeRouter(undefined);
    await router.handle(inbound('/sessions'));
    expect(specs).toHaveLength(1);
    await router.stopAll();
  });
});
